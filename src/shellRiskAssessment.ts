import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  logInfo,
  logWarn,
} from '@/logging';
import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';

export const SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY = 'shellTools.riskAssessment.chatModel';
export const SHELL_TOOLS_RISK_ASSESSMENT_TIMEOUT_MS_KEY = 'shellTools.riskAssessment.timeoutMs';
export const SELECT_SHELL_RISK_ASSESSMENT_MODEL_COMMAND = 'agent-helper-kit.shellTools.selectRiskAssessmentModel';

const CLEAR_MODEL_PICK_ID = '__clearRiskAssessmentModel__';
const DEFAULT_RISK_ASSESSMENT_TIMEOUT_MS = 8_000;
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_CHARACTERS = 12_000;
const MAX_TOTAL_CONTEXT_CHARACTERS = 60_000;
const riskAssessmentResultCache = new Map<string, Promise<ShellRiskAssessmentModelResult>>();
// Keep this shortlist intentionally small and revisit it when the validated
// fast models for shell risk assessment change.
const RECOMMENDED_MODEL_MATCHERS = [
  {
    matches: (model: vscode.LanguageModelChat) => model.id === 'gpt-4.1',
    vendor: 'copilot',
  },
  {
    matches: (model: vscode.LanguageModelChat) => model.id.startsWith('claude-sonnet-4.6'),
    vendor: 'copilot',
  },
  {
    matches: (model: vscode.LanguageModelChat) => model.id.startsWith('claude-sonnet-4-6'),
    vendor: 'claude-model-provider',
  },
] as const;

type ModelQuickPickItem = vscode.QuickPickItem & {
  id?: string;
  modelIdWithVendor?: string;
  name?: string;
  vendor?: string;
};

export type ShellRiskAssessmentModelResult
  = | {
    decision: 'allow' | 'deny' | 'request';
    kind: 'response';
    modelId: string;
    reason: string;
  }
  | {
    kind: 'disabled';
  }
  | {
    kind: 'error';
    modelId: string;
    reason: string;
  }
  | {
    kind: 'timeout';
    modelId: string;
    reason: string;
    timeoutMs: number;
  };

type AssessShellCommandRiskOptions = {
  command: string;
  cwd: string;
  explanation?: string;
  goal?: string;
  riskAssessment: string;
  riskAssessmentContext?: string[];
};

type LoadedContextFile = {
  content: string;
  path: string;
};

type NormalizedRiskAssessmentContextEntry
  = | {
    kind: 'file';
    path: string;
    sortKey: string;
  }
  | {
    kind: 'inline';
    sortKey: string;
    value: string;
  };

type LoadedRiskAssessmentContextEntry
  = | {
    checksum: string;
    content: string;
    kind: 'file';
    path: string;
  }
  | {
    checksum: string;
    content: string;
    kind: 'inline';
  };

class ShellRiskAssessmentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = 'ShellRiskAssessmentTimeoutError';
  }
}

function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
}

function getConfiguredRiskAssessmentModelId(): string {
  return getConfiguration().get(SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY, '').trim();
}

function getConfiguredRiskAssessmentTimeoutMs(): number {
  const configuredTimeoutMs = getConfiguration().get<number | undefined>(
    SHELL_TOOLS_RISK_ASSESSMENT_TIMEOUT_MS_KEY,
  );

  if (
    typeof configuredTimeoutMs !== 'number'
    || !Number.isFinite(configuredTimeoutMs)
    || configuredTimeoutMs <= 0
  ) {
    return DEFAULT_RISK_ASSESSMENT_TIMEOUT_MS;
  }

  return Math.floor(configuredTimeoutMs);
}

function createChecksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapePromptAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapePromptText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatModelIdWithVendor(vendor: string | undefined, id: string): string {
  return vendor?.length ? `${vendor}:${id}` : id;
}

function isLikelyFilePointer(pointer: string): boolean {
  if (path.isAbsolute(pointer) || pointer.startsWith('.')) {
    return true;
  }

  if (/[\n\r;&|><`]/u.test(pointer) || /:\s/u.test(pointer)) {
    return false;
  }

  return /[/\\]/u.test(pointer) && !/\s/u.test(pointer);
}

async function normalizePathForCache(targetPath: string): Promise<string> {
  const resolvedPath = path.resolve(targetPath);

  try {
    return path.normalize(await fs.realpath(resolvedPath));
  }
  catch {
    return path.normalize(resolvedPath);
  }
}

function truncateContextContent(content: string, remainingCharacters: number): string {
  const normalizedContent = content.length > MAX_CONTEXT_FILE_CHARACTERS
    ? `${content.slice(0, MAX_CONTEXT_FILE_CHARACTERS)}\n\n[... FILE CONTENT TRUNCATED ...]`
    : content;

  return normalizedContent.length > remainingCharacters
    ? `${normalizedContent.slice(0, remainingCharacters)}\n\n[... ADDITIONAL CONTEXT TRUNCATED ...]`
    : normalizedContent;
}

function parseToSelector(modelIdWithVendor: string): { id: string; vendor?: string } {
  if (!modelIdWithVendor.includes(':')) {
    return {
      id: modelIdWithVendor,
      vendor: undefined,
    };
  }

  const colonIndex = modelIdWithVendor.indexOf(':');

  return {
    id: modelIdWithVendor.slice(colonIndex + 1),
    vendor: modelIdWithVendor.slice(0, colonIndex),
  };
}

/** Read response stream into a string */
async function readResponse(
  responseStream: vscode.LanguageModelChatResponse,
): Promise<string> {
  let text = '';

  for await (const fragment of responseStream.text) {
    text += fragment;
  }

  return text;
}

function isRecommendedModel(model: vscode.LanguageModelChat): boolean {
  return RECOMMENDED_MODEL_MATCHERS.some(matcher => matcher.vendor === model.vendor && matcher.matches(model));
}

function isUnsupportedModel(model: vscode.LanguageModelChat): boolean {
  if (model.vendor === 'copilot') {
    return [
      'auto',
    ].includes(model.id);
  }

  if (model.vendor === 'anthropic' || model.vendor === 'claude-code') {
    return true;
  }

  return false;
}

/**
 * Build a categorized list of model quick pick items (Recommended / Other / Unsupported)
 * with separator headers. Labels contain only the plain model name. Callers are
 * responsible for adding any prefix or suffix decoration they need.
 */
function getModelQuickPickItems(models: vscode.LanguageModelChat[]): ModelQuickPickItem[] {
  const recommendedModels: ModelQuickPickItem[] = [];
  const otherModelsByVendor: Record<string, ModelQuickPickItem[]> = {};
  const unsupportedModels: ModelQuickPickItem[] = [];

  for (const model of models) {
    const modelIdWithVendor = formatModelIdWithVendor(model.vendor, model.id);
    const modelName = model.name;
    const item: ModelQuickPickItem = {
      description: modelIdWithVendor,
      id: model.id,
      label: modelName,
      modelIdWithVendor,
      name: modelName,
      vendor: model.vendor,
    };

    if (isUnsupportedModel(model)) {
      unsupportedModels.push(item);
      continue;
    }

    if (isRecommendedModel(model)) {
      recommendedModels.push(item);
      continue;
    }

    const vendorBucket = item.vendor ?? '';

    otherModelsByVendor[vendorBucket] ??= [];
    otherModelsByVendor[vendorBucket].push(item);
  }

  const otherModels = Object.entries(otherModelsByVendor)
    .sort(([ leftVendor ], [ rightVendor ]) => leftVendor.localeCompare(rightVendor))
    .flatMap(([ vendor, items ]) => {
      items.sort((leftItem, rightItem) => leftItem.label.localeCompare(rightItem.label));

      return [
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: `${vendor ? `${vendor.charAt(0).toUpperCase()}${vendor.slice(1)}` : 'Other'} Models`,
        },
        ...items,
      ];
    });

  if (recommendedModels.length > 0) {
    recommendedModels.unshift({
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Recommended Models',
    });
  }

  if (unsupportedModels.length > 0) {
    unsupportedModels.unshift({
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Unsupported Models',
    });
  }

  return [
    ...recommendedModels,
    ...otherModels,
    ...unsupportedModels,
  ];
}

async function updateConfiguredRiskAssessmentModel(modelId: string): Promise<void> {
  await getConfiguration().update(
    SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY,
    modelId,
    vscode.ConfigurationTarget.Global,
  );
}

/**
 * Prompt the user to select the chat model used for shell risk assessment.
 * Persists the chosen model ID in vendor:id format, or clears the setting if
 * the user chooses to disable model-based risk assessment.
 */
async function handleSelectRiskAssessmentModel(): Promise<void> {
  const models = await vscode.lm.selectChatModels();

  if (models.length === 0) {
    void vscode.window.showWarningMessage('No chat models are available for shell risk assessment.');
    return;
  }

  const currentModelId = getConfiguredRiskAssessmentModelId();
  const clearModelLabel = 'Disable model-based shell risk assessment';
  const quickPickItems: ModelQuickPickItem[] = [
    {
      description: 'Leave the model setting empty and rely on explicit approval rules plus the YOLO flag.',
      label: `${currentModelId.length === 0 ? '$(check)' : '\u2003 '} ${clearModelLabel}`,
      modelIdWithVendor: CLEAR_MODEL_PICK_ID,
      name: clearModelLabel,
    },
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: 'Available Models',
    },
    ...getModelQuickPickItems(models).map(item => {
      if (item.kind === vscode.QuickPickItemKind.Separator) {
        return item;
      }

      const isCurrentModel = item.modelIdWithVendor === currentModelId || item.id === currentModelId;

      return {
        ...item,
        label: `${isCurrentModel ? '$(check)' : '\u2003 '} ${item.label}`,
      };
    }),
  ];

  const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
    placeHolder: 'Select a chat model for shell risk assessment',
  });

  if (selectedItem?.modelIdWithVendor === undefined) {
    return;
  }

  if (selectedItem.modelIdWithVendor === CLEAR_MODEL_PICK_ID) {
    await updateConfiguredRiskAssessmentModel('');
    void vscode.window.showInformationMessage('Shell risk assessment model disabled.');
    return;
  }

  await updateConfiguredRiskAssessmentModel(selectedItem.modelIdWithVendor);
  void vscode.window.showInformationMessage(
    `Shell risk assessment model set to: ${selectedItem.name ?? selectedItem.modelIdWithVendor}`,
  );
}

export function registerShellRiskAssessmentModelCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    SELECT_SHELL_RISK_ASSESSMENT_MODEL_COMMAND,
    handleSelectRiskAssessmentModel,
  );
}

/** Maps the deterministic model response format into a structured decision. */
function parseRiskAssessmentResponse(response: string): undefined | {
  decision: 'allow' | 'deny' | 'request';
  reason: string;
} {
  const lines = response
    .trim()
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0);

  if (lines.length !== 1) {
    return undefined;
  }

  const match = /^(allow|deny|request)\s*::\s*(.+)$/iu.exec(lines[0]);

  if (!match) {
    return undefined;
  }

  const decision = match[1].toLowerCase();
  const reason = match[2].trim();

  if ((decision !== 'allow' && decision !== 'deny' && decision !== 'request') || !reason) {
    return undefined;
  }

  return {
    decision,
    reason,
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function formatRiskAssessmentResponseForLog(responseText: string): string {
  return responseText.trim().length > 0 ? responseText : '(empty response)';
}

function logRiskAssessmentPrompt(modelId: string, timeoutMs: number, prompt: string): void {
  logInfo([
    'Shell risk assessment prompt:',
    `Model: ${modelId}`,
    `Timeout: ${timeoutMs}ms`,
    'Prompt:',
    prompt,
  ].join('\n'));
}

function logRiskAssessmentResult(
  result: ShellRiskAssessmentModelResult,
  options: {
    cached?: boolean;
    rawResponseText?: string;
  } = {},
): void {
  const lines = [ options.cached ? 'Shell risk assessment cached result:' : 'Shell risk assessment result:' ];

  if (result.kind === 'disabled') {
    lines.push('Kind: disabled');
    lines.push('Reason: No risk assessment model is configured.');
  }
  else if (result.kind === 'error') {
    lines.push('Kind: error');
    lines.push(`Model: ${result.modelId}`);
    lines.push(`Reason: ${result.reason}`);
  }
  else if (result.kind === 'timeout') {
    lines.push('Kind: timeout');
    lines.push(`Model: ${result.modelId}`);
    lines.push(`Timeout: ${result.timeoutMs}ms`);
    lines.push(`Reason: ${result.reason}`);
  }
  else {
    lines.push('Kind: response');
    lines.push(`Model: ${result.modelId}`);
    lines.push(`Decision: ${result.decision}`);
    lines.push(`Reason: ${result.reason}`);
  }

  if (options.rawResponseText !== undefined) {
    lines.push('Raw response:');
    lines.push(formatRiskAssessmentResponseForLog(options.rawResponseText));
  }

  logInfo(lines.join('\n'));
}

/** Normalize optional context file pointers by trimming, de-duplicating, and bounding them. */
function normalizeRiskAssessmentContextPointers(pointers: string[] | undefined): string[] {
  if (!pointers) {
    return [];
  }

  return Array.from(new Set(
    pointers
      .map(pointer => pointer.trim())
      .filter(pointer => pointer.length > 0),
  )).slice(0, MAX_CONTEXT_FILES);
}

async function normalizeRiskAssessmentContextEntries(
  pointers: string[] | undefined,
  cwd: string,
): Promise<NormalizedRiskAssessmentContextEntry[]> {
  const normalizedPointers = normalizeRiskAssessmentContextPointers(pointers);
  const normalizedEntries = await Promise.all(normalizedPointers.map(async pointer => {
    const resolvedPath = path.isAbsolute(pointer)
      ? path.normalize(pointer)
      : path.resolve(cwd, pointer);

    if (isLikelyFilePointer(pointer)) {
      const normalizedPath = await normalizePathForCache(resolvedPath);

      return {
        kind: 'file' as const,
        path: normalizedPath,
        sortKey: `file:${normalizedPath}`,
      };
    }

    try {
      const stats = await fs.stat(resolvedPath);

      if (stats.isFile()) {
        const normalizedPath = await normalizePathForCache(resolvedPath);

        return {
          kind: 'file' as const,
          path: normalizedPath,
          sortKey: `file:${normalizedPath}`,
        };
      }
    }
    catch {
      // Inline context is allowed; unreadable non-path-like values stay inline.
    }

    return {
      kind: 'inline' as const,
      sortKey: `inline:${pointer}`,
      value: pointer,
    };
  }));

  return Array.from(new Map(
    normalizedEntries.map(entry => [ entry.sortKey, entry ]),
  ).values())
    .sort((leftEntry, rightEntry) => leftEntry.sortKey.localeCompare(rightEntry.sortKey))
    .slice(0, MAX_CONTEXT_FILES);
}

/**
 * Legacy test helper that mirrors production file truncation while keeping the
 * older file-only return shape used by focused unit tests.
 */
async function loadContextFiles(
  contextPointers: string[],
  cwd: string,
): Promise<LoadedContextFile[]> {
  const loadedFiles = await Promise.all(contextPointers.map(async (pointer): Promise<LoadedContextFile> => {
    const resolvedPath = path.isAbsolute(pointer)
      ? path.normalize(pointer)
      : path.resolve(cwd, pointer);

    try {
      return {
        content: await fs.readFile(resolvedPath, { encoding: 'utf8' }),
        path: resolvedPath,
      };
    }
    catch (error) {
      return {
        content: `[unable to read file: ${summarizeError(error)}]`,
        path: resolvedPath,
      };
    }
  }));
  const files: LoadedContextFile[] = [];
  let remainingCharacters = MAX_TOTAL_CONTEXT_CHARACTERS;

  for (const loadedFile of loadedFiles) {
    if (remainingCharacters <= 0) {
      break;
    }

    const normalizedContent = loadedFile.content.length > MAX_CONTEXT_FILE_CHARACTERS
      ? `${loadedFile.content.slice(0, MAX_CONTEXT_FILE_CHARACTERS)}\n\n[... FILE CONTENT TRUNCATED ...]`
      : loadedFile.content;
    const boundedContent = normalizedContent.length > remainingCharacters
      ? `${normalizedContent.slice(0, remainingCharacters)}\n\n[... ADDITIONAL CONTEXT TRUNCATED ...]`
      : normalizedContent;

    remainingCharacters -= boundedContent.length;
    files.push({
      content: boundedContent,
      path: loadedFile.path,
    });
  }

  return files;
}

async function loadRiskAssessmentContextEntries(
  entries: NormalizedRiskAssessmentContextEntry[],
): Promise<LoadedRiskAssessmentContextEntry[]> {
  const loadedEntries = await Promise.all(entries.map(async (entry): Promise<LoadedRiskAssessmentContextEntry> => {
    if (entry.kind === 'inline') {
      return {
        checksum: createChecksum(entry.value),
        content: entry.value,
        kind: 'inline',
      };
    }

    try {
      const content = await fs.readFile(entry.path, { encoding: 'utf8' });

      return {
        checksum: createChecksum(content),
        content,
        kind: 'file',
        path: entry.path,
      };
    }
    catch (error) {
      const content = `[unable to read file: ${summarizeError(error)}]`;

      return {
        checksum: createChecksum(content),
        content,
        kind: 'file',
        path: entry.path,
      };
    }
  }));
  const boundedEntries: LoadedRiskAssessmentContextEntry[] = [];
  let remainingCharacters = MAX_TOTAL_CONTEXT_CHARACTERS;

  for (const entry of loadedEntries) {
    if (remainingCharacters <= 0) {
      break;
    }

    const boundedContent = truncateContextContent(entry.content, remainingCharacters);

    remainingCharacters -= boundedContent.length;
    boundedEntries.push({
      ...entry,
      content: boundedContent,
    });
  }

  return boundedEntries;
}

async function buildRiskAssessmentCacheKey(
  options: AssessShellCommandRiskOptions,
  modelId: string,
  timeoutMs: number,
  contextEntries: LoadedRiskAssessmentContextEntry[],
): Promise<string> {
  const normalizedCwd = await normalizePathForCache(options.cwd);

  // Cache only on inputs that should materially affect the command's risk.
  // `explanation`, `goal`, and `riskAssessment` are prompt hints for the model,
  // not execution-affecting properties of the command itself, so a correct risk
  // assessment should not change solely because those clues are phrased
  // differently.
  return createChecksum(JSON.stringify({
    command: options.command,
    context: contextEntries.map(entry => {
      if (entry.kind === 'file') {
        return {
          checksum: entry.checksum,
          kind: entry.kind,
          path: entry.path,
        };
      }

      return {
        checksum: entry.checksum,
        kind: entry.kind,
      };
    }),
    cwd: normalizedCwd,
    modelId,
    timeoutMs,
  }));
}

/** Build the prompt sent to the risk-assessment chat model for a single shell command. */
function buildRiskAssessmentPrompt(
  options: AssessShellCommandRiskOptions,
  contextEntries: LoadedRiskAssessmentContextEntry[],
): string {
  const renderedContextEntries = contextEntries.flatMap<string>(entry => {
    if (entry.kind === 'file') {
      return [
        `<file path="${escapePromptAttribute(entry.path)}">`,
        '```',
        entry.content,
        '```',
        '</file>',
      ];
    }

    return [
      '<context_item kind="inline">',
      '```',
      entry.content,
      '```',
      '</context_item>',
    ];
  });
  const contextBlock = contextEntries.length === 0
    ? '<risk_assessment_context>(none provided)</risk_assessment_context>'
    : [
      '<risk_assessment_context>',
      ...renderedContextEntries,
      '</risk_assessment_context>',
    ].join('\n');

  const explanation = options.explanation?.trim().length ? options.explanation.trim() : '(not provided)';
  const goal = options.goal?.trim().length ? options.goal.trim() : '(not provided)';

  return `Assess the following shell command for safety considerations.
Consider at minimum:
- potential destructive side-effects
- leakage of secrets or other sensitive information
- alterations or loss of work or data
- damage to internal or external systems
- account, environment, or infrastructure actions that result in meaningful or irreversible changes
- script-injection, prompt-injection, or fetched-content dangers that could cause a local script, package script, shell snippet, or interpreter entrypoint to execute riskier actions than the visible command alone suggests
- clearly malicious or outright destructive behavior, including catastrophic commands such as fork bombs, destructive root-level deletion, credential exfiltration, or similarly severe actions
- any other potentially damaging effects or meaningful uncertainty
Use the provided explanation, goal, risk pre-assessment, and context to decide whether the command is safe to run without user confirmation, should request user confirmation prior to running, or should be denied outright.
Any meaningful ambiguity or uncertainty must result in a request for user confirmation.
If the command appears to rely on scripts, aliases, package-manager script definitions, generated shell fragments, or fetched/remote content and the provided context does not make it clear what will actually run or what data will be consumed, request user confirmation.
Treat missing or incomplete script definitions, alias expansions, or fetched-content details as insufficient context for auto-approval.
Only deny commands that are clearly malicious or outright destructive, beyond simply changing files, usage of chmod, or similar common operations that could be used in a safe or unsafe way depending on context; consider the default to ask for confirmation in these cases, except in explicitly malicious or catastrophic scenarios where a deny is logically warranted.
Only allow commands when they appear clearly safe to run without confirmation.
<command>${escapePromptText(options.command)}</command>
<cwd>${escapePromptText(options.cwd)}</cwd>
<explanation>${escapePromptText(explanation)}</explanation>
<goal>${escapePromptText(goal)}</goal>
<risk_assessment>${escapePromptText(options.riskAssessment)}</risk_assessment>
${contextBlock}
Use the following template to respond: allow|request|deny::brief-explanation-for-why
Include nothing else in your response.`;
}

function createLinkedCancellationTokenSource(
  token: vscode.CancellationToken,
): { dispose: () => void; tokenSource: vscode.CancellationTokenSource } {
  const tokenSource = new vscode.CancellationTokenSource();
  const externalCancellation = typeof token.onCancellationRequested === 'function'
    ? token.onCancellationRequested(() => {
      tokenSource.cancel();
    })
    : undefined;

  if (token.isCancellationRequested) {
    tokenSource.cancel();
  }

  return {
    dispose: () => {
      externalCancellation?.dispose();
      tokenSource.dispose();
    },
    tokenSource,
  };
}

async function readResponseWithTimeout(
  model: vscode.LanguageModelChat,
  prompt: string,
  token: vscode.CancellationToken,
  timeoutMs: number,
): Promise<string> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const { dispose, tokenSource } = createLinkedCancellationTokenSource(token);

  try {
    return await Promise.race([
      (async () => {
        const responseStream = await model.sendRequest(
          [ vscode.LanguageModelChatMessage.User(prompt) ],
          {},
          tokenSource.token,
        );

        return readResponse(responseStream);
      })(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          tokenSource.cancel();
          reject(new ShellRiskAssessmentTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  }
  finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    dispose();
  }
}

export function resetShellRiskAssessmentCacheForTest(): void {
  riskAssessmentResultCache.clear();
}

/**
 * Ask the configured chat model to pre-assess whether a shell command should run
 * without confirmation or should request explicit user approval.
 */
export async function assessShellCommandRisk(
  options: AssessShellCommandRiskOptions,
  token: vscode.CancellationToken,
): Promise<ShellRiskAssessmentModelResult> {
  const configuredModelId = getConfiguredRiskAssessmentModelId();
  let cacheKey: string | undefined;

  if (configuredModelId.length === 0) {
    const result: ShellRiskAssessmentModelResult = {
      kind: 'disabled',
    };

    logRiskAssessmentResult(result);

    return result;
  }

  const timeoutMs = getConfiguredRiskAssessmentTimeoutMs();

  try {
    const normalizedContextEntries = await normalizeRiskAssessmentContextEntries(
      options.riskAssessmentContext,
      options.cwd,
    );
    const loadedContextEntries = await loadRiskAssessmentContextEntries(normalizedContextEntries);
    cacheKey = await buildRiskAssessmentCacheKey(
      options,
      configuredModelId,
      timeoutMs,
      loadedContextEntries,
    );
    const cachedResult = riskAssessmentResultCache.get(cacheKey);

    if (cachedResult) {
      const result = await cachedResult;

      logRiskAssessmentResult(result, { cached: true });

      return result;
    }

    const selector = parseToSelector(configuredModelId);
    const prompt = buildRiskAssessmentPrompt(options, loadedContextEntries);
    const assessmentPromise = (async (): Promise<ShellRiskAssessmentModelResult> => {
      try {
        const models = await vscode.lm.selectChatModels(selector);

        if (models.length === 0) {
          const result: ShellRiskAssessmentModelResult = {
            kind: 'error',
            modelId: configuredModelId,
            reason: `Configured risk assessment model \`${configuredModelId}\` is not available.`,
          };

          logRiskAssessmentResult(result);

          return result;
        }

        const model = models[0];
        logRiskAssessmentPrompt(configuredModelId, timeoutMs, prompt);
        const responseText = await readResponseWithTimeout(model, prompt, token, timeoutMs);
        const parsedResponse = parseRiskAssessmentResponse(responseText);

        if (!parsedResponse) {
          const result: ShellRiskAssessmentModelResult = {
            kind: 'error',
            modelId: configuredModelId,
            reason: `Risk assessment model \`${configuredModelId}\` returned an unrecognized response.`,
          };

          logRiskAssessmentResult(result, { rawResponseText: responseText });
          logWarn(
            `Shell risk assessment model ${configuredModelId} returned an unrecognized response: ${responseText.trim() || '(empty response)'}`,
          );

          return result;
        }

        const result: ShellRiskAssessmentModelResult = {
          decision: parsedResponse.decision,
          kind: 'response',
          modelId: configuredModelId,
          reason: parsedResponse.reason,
        };

        logRiskAssessmentResult(result, { rawResponseText: responseText });

        return result;
      }
      catch (error) {
        if (error instanceof ShellRiskAssessmentTimeoutError) {
          const result: ShellRiskAssessmentModelResult = {
            kind: 'timeout',
            modelId: configuredModelId,
            reason: `Risk assessment model \`${configuredModelId}\` timed out after ${timeoutMs}ms.`,
            timeoutMs,
          };

          logRiskAssessmentResult(result);
          logWarn(`Shell risk assessment timed out for model ${configuredModelId} after ${timeoutMs}ms.`);

          return result;
        }

        const message = summarizeError(error);
        const result: ShellRiskAssessmentModelResult = {
          kind: 'error',
          modelId: configuredModelId,
          reason: `Risk assessment model \`${configuredModelId}\` failed: ${message}`,
        };

        logRiskAssessmentResult(result);
        logWarn(`Shell risk assessment failed for model ${configuredModelId}: ${message}`);

        return result;
      }
    })();

    // Share a single in-flight assessment, but evict non-response results so
    // transient errors and timeouts do not poison later retries.
    riskAssessmentResultCache.set(cacheKey, assessmentPromise);
    const result = await assessmentPromise;

    if (result.kind !== 'response') {
      riskAssessmentResultCache.delete(cacheKey);
    }

    return result;
  }
  catch (error) {
    if (cacheKey !== undefined) {
      riskAssessmentResultCache.delete(cacheKey);
    }

    const message = summarizeError(error);
    const result: ShellRiskAssessmentModelResult = {
      kind: 'error',
      modelId: configuredModelId,
      reason: `Risk assessment model \`${configuredModelId}\` failed: ${message}`,
    };

    logRiskAssessmentResult(result);
    logWarn(`Shell risk assessment failed for model ${configuredModelId}: ${message}`);

    return result;
  }
}

export const shellRiskAssessmentInternals = {
  buildRiskAssessmentCacheKey,
  getConfiguredRiskAssessmentModelId,
  getConfiguredRiskAssessmentTimeoutMs,
  getModelQuickPickItems,
  isRecommendedModel,
  isUnsupportedModel,
  loadContextFiles,
  normalizeRiskAssessmentContextEntries,
  parseRiskAssessmentResponse,
  resetShellRiskAssessmentCacheForTest,
};
