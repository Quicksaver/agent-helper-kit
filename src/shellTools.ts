import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';
import { registerShellCommandsPanel } from '@/shellCommandsPanel';
import {
  getFilteredOutput,
  normalizeShellOutput,
  stripShellControlSequences,
} from '@/shellOutputFilter';
import {
  registerShellRiskAssessmentModelCommand,
} from '@/shellRiskAssessment';
import {
  ShellRuntime,
  toPublicCommandId,
} from '@/shellRuntime';
import {
  type AwaitShellInput,
  type GetLastShellCommandInput,
  type GetShellCommandInput,
  type GetShellOutputInput,
  HIDDEN_SHELL_INPUT_LOG_PLACEHOLDER,
  type KillShellInput,
  type RunInShellInput,
  type SendToShellInput,
  SHELL_TOOL_METADATA,
  SHELL_TOOL_NAMES,
  validateAwaitShellInput,
  validateRunInShellInput,
  validateSendToShellInput,
} from '@/shellToolContracts';
import {
  analyzeShellRunRuleDisposition,
  buildShellRunConfirmationMessage,
  decideShellRunApproval,
  type ShellRunApprovalDecision,
} from '@/shellToolSecurity';

const DEFAULT_MEMORY_OUTPUT_LIMIT_KIB = 512;
const DEFAULT_MEMORY_TO_FILE_SPILL_MINUTES = 2;
const DEFAULT_STARTUP_PURGE_MAX_AGE_HOURS = 6;

function getNumericSettingOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

/**
 * Read shell output retention settings and normalize them into bytes and
 * milliseconds so the runtime never has to interpret raw configuration values.
 */
function getShellOutputSettings(): {
  memoryOutputLimitBytes: number;
  memoryToFileDelayMs: number;
  startupPurgeMaxAgeMs: number;
} {
  const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  const memoryOutputLimitKiB = getNumericSettingOrDefault(
    configuration.get<number>('shellOutput.inMemoryOutputLimitKiB'),
    DEFAULT_MEMORY_OUTPUT_LIMIT_KIB,
  );
  const memoryToFileSpillMinutes = getNumericSettingOrDefault(
    configuration.get<number>('shellOutput.memoryToFileSpillMinutes'),
    DEFAULT_MEMORY_TO_FILE_SPILL_MINUTES,
  );
  const startupPurgeMaxAgeHours = getNumericSettingOrDefault(
    configuration.get<number>('shellOutput.startupPurgeMaxAgeHours'),
    DEFAULT_STARTUP_PURGE_MAX_AGE_HOURS,
  );

  return {
    memoryOutputLimitBytes: memoryOutputLimitKiB === 0
      ? 0
      : Math.floor(memoryOutputLimitKiB * 1024),
    memoryToFileDelayMs: memoryToFileSpillMinutes * 60 * 1000,
    startupPurgeMaxAgeMs: startupPurgeMaxAgeHours * 60 * 60 * 1000,
  };
}

function getWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (folder) {
    return folder.uri.fsPath;
  }

  return os.homedir();
}

/**
 * Resolve a tool-provided cwd against the workspace root and verify that the
 * resulting directory exists and is accessible before starting a shell run.
 */
function resolveCommandCwd(inputCwd?: string): string {
  const defaultCwd = getWorkspaceCwd();

  if (inputCwd === undefined) {
    return defaultCwd;
  }

  const trimmedCwd = inputCwd.trim();

  if (trimmedCwd.length === 0) {
    throw new Error('cwd must not be empty');
  }

  const resolvedCwd = path.resolve(defaultCwd, trimmedCwd);

  let stats: fs.Stats;

  try {
    stats = fs.statSync(resolvedCwd);
  }
  catch (error) {
    const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? ` (${error.code})`
      : '';

    throw new Error(`cwd does not exist or is inaccessible: ${resolvedCwd}${errorCode}`, {
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    throw new Error(`cwd is not a directory: ${resolvedCwd}`);
  }

  try {
    fs.accessSync(resolvedCwd, fs.constants.R_OK | fs.constants.X_OK);
  }
  catch (error) {
    const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? ` (${error.code})`
      : '';

    throw new Error(`cwd does not exist or is inaccessible: ${resolvedCwd}${errorCode}`, {
      cause: error,
    });
  }

  return resolvedCwd;
}

function toYamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (
    typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return String(value);
  }

  const serialized = JSON.stringify(value);

  return typeof serialized === 'string'
    ? serialized
    : 'null';
}

function toYaml(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([ key, value ]) => `${key}: ${toYamlScalar(value)}`)
    .join('\n');
}

function buildYamlToolResult(payload: Record<string, unknown>): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(toYaml(payload)),
  ]);
}

/**
 * Package shell tool results as YAML metadata plus a separate plain-text output
 * part. Output normalization happens here so the runtime can keep raw ANSI for
 * the Shell Runs panel while chat responses stay readable.
 */
function buildSplitOutputToolResult(payload: Record<string, unknown> & {
  output: string;
}): vscode.LanguageModelToolResult {
  const {
    output,
    ...metadata
  } = payload;
  const normalizedOutput = normalizeShellOutput(output);
  const toolOutput = stripShellControlSequences(normalizedOutput);

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(toYaml(metadata)),
    new vscode.LanguageModelTextPart(toolOutput),
  ]);
}

/**
 * Attach optional termination metadata only when it is actually present so the
 * serialized tool payload stays compact and stable for callers.
 */
function addOptionalCompletionMetadata(
  payload: Record<string, unknown>,
  completion: {
    terminationSignal?: NodeJS.Signals | null;
    timedOut?: boolean;
  },
): Record<string, unknown> {
  const nextPayload = {
    ...payload,
  };

  if (completion.terminationSignal) {
    nextPayload.terminationSignal = completion.terminationSignal;
  }

  if (completion.timedOut === true) {
    nextPayload.timedOut = true;
  }

  return nextPayload;
}

let shellRuntime: ShellRuntime | undefined;

/**
 * Lazily create the shared shell runtime so sync and async shell tools use the
 * same command lifecycle, output store, and panel backing state.
 */
function getShellRuntime(): ShellRuntime {
  if (!shellRuntime) {
    const {
      memoryOutputLimitBytes,
      memoryToFileDelayMs,
      startupPurgeMaxAgeMs,
    } = getShellOutputSettings();

    shellRuntime = new ShellRuntime({
      memoryToFileDelayMs,
      outputLimitBytes: memoryOutputLimitBytes,
      startupPurgeMaxAgeMs,
    });
  }

  return shellRuntime;
}

/**
 * Detect whether a waited shell run should return command output in addition
 * to completion metadata.
 */
function hasRunOutputOverrides(input: {
  full_output?: boolean;
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
}): boolean {
  return input.full_output === true
    || typeof input.last_lines === 'number'
    || typeof input.regex === 'string'
    || typeof input.regex_flags === 'string';
}

/**
 * Choose the explicit shell override when provided, otherwise fall back to the
 * same shell resolution the runtime will use for execution.
 */
function getRequestedOrDefaultShell(inputShell?: string): string {
  if (typeof inputShell === 'string' && inputShell.trim().length > 0) {
    return inputShell.trim();
  }

  const vscodeDefaultShell = vscode.env.shell;

  if (typeof vscodeDefaultShell === 'string' && vscodeDefaultShell.trim().length > 0) {
    return vscodeDefaultShell.trim();
  }

  if (os.platform() === 'win32') {
    return globalThis.process.env.ComSpec ?? 'cmd.exe';
  }

  return globalThis.process.env.SHELL ?? '/bin/bash';
}

function getShellInputPreview(input: string, options?: {
  secret?: boolean;
}): string | undefined {
  const trimmedInput = input.trim();

  if (trimmedInput.length === 0) {
    return undefined;
  }

  if (options?.secret === true) {
    return HIDDEN_SHELL_INPUT_LOG_PLACEHOLDER;
  }

  return trimmedInput.split('\n')[0];
}

const PREPARED_RUN_IN_SHELL_RESERVATION_TTL_MS = 5 * 60 * 1000;

type PreparedRunInShellReservation = {
  dispose: () => void;
  id: string;
};

const preparedRunInShellCommandIdsBySignature = new Map<string, PreparedRunInShellReservation[]>();

function buildPreparedRunInShellSignature(input: RunInShellInput, resolvedCwd: string, selectedShell: string): string {
  return JSON.stringify({
    columns: input.columns ?? null,
    command: input.command,
    cwd: resolvedCwd,
    explanation: input.explanation,
    goal: input.goal,
    riskAssessment: input.riskAssessment,
    riskAssessmentContext: input.riskAssessmentContext ?? [],
    shell: selectedShell,
  });
}

function clearPreparedRunInShellReservations(): void {
  for (const reservations of preparedRunInShellCommandIdsBySignature.values()) {
    for (const reservation of reservations) {
      reservation.dispose();
    }
  }

  preparedRunInShellCommandIdsBySignature.clear();
}

export function resetShellRuntimeForTest(): void {
  clearPreparedRunInShellReservations();
  shellRuntime = undefined;
}

function discardPreparedRunInShellCommandId(signature: string, id: string): boolean {
  const reservations = preparedRunInShellCommandIdsBySignature.get(signature);

  if (!reservations) {
    return false;
  }

  const reservationIndex = reservations.findIndex(reservation => reservation.id === id);

  if (reservationIndex < 0) {
    return false;
  }

  const [ reservation ] = reservations.splice(reservationIndex, 1);
  reservation.dispose();

  if (reservations.length === 0) {
    preparedRunInShellCommandIdsBySignature.delete(signature);
  }

  return true;
}

function claimPreparedRunInShellCommandId(signature: string): string | undefined {
  const reservations = preparedRunInShellCommandIdsBySignature.get(signature);
  const reservation = reservations?.shift();

  reservation?.dispose();

  if (!reservations || reservations.length === 0) {
    preparedRunInShellCommandIdsBySignature.delete(signature);
  }

  return reservation?.id;
}

function queuePreparedRunInShellCommandId(
  signature: string,
  id: string,
  options: {
    onDiscard: () => void;
    token: vscode.CancellationToken;
  },
): void {
  let cancellationDisposable: undefined | vscode.Disposable;
  let cleanupTimer: NodeJS.Timeout | undefined;
  const reservation: PreparedRunInShellReservation = {
    dispose: () => {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
      }

      cancellationDisposable?.dispose();
      cancellationDisposable = undefined;
    },
    id,
  };
  const reservations = preparedRunInShellCommandIdsBySignature.get(signature) ?? [];

  reservations.push(reservation);
  preparedRunInShellCommandIdsBySignature.set(signature, reservations);

  const discardReservation = () => {
    if (!discardPreparedRunInShellCommandId(signature, id)) {
      return;
    }

    options.onDiscard();
  };

  cleanupTimer = setTimeout(discardReservation, PREPARED_RUN_IN_SHELL_RESERVATION_TTL_MS);
  cancellationDisposable = typeof options.token.onCancellationRequested === 'function'
    ? options.token.onCancellationRequested(discardReservation)
    : undefined;

  if (options.token.isCancellationRequested) {
    discardReservation();
  }
}

function toShellCommandApprovalDetails(approvalDecision: ShellRunApprovalDecision) {
  return {
    decision: approvalDecision.decision,
    modelAssessment: approvalDecision.modelAssessment,
    reason: approvalDecision.reason,
    riskAssessmentResult: approvalDecision.riskAssessmentResult,
    source: approvalDecision.source,
  } as const;
}

function toShellCommandRequestDetails(input: RunInShellInput) {
  return {
    explanation: input.explanation,
    goal: input.goal,
    riskAssessment: input.riskAssessment,
    riskAssessmentContext: input.riskAssessmentContext,
  } as const;
}

function getApprovalDecisionPhase(approvalDecision: ShellRunApprovalDecision): 'denied' | 'pending-approval' | 'queued' {
  if (approvalDecision.decision === 'allow') {
    return 'queued';
  }

  if (approvalDecision.decision === 'ask') {
    return 'pending-approval';
  }

  return 'denied';
}

const runInShellTool: vscode.LanguageModelTool<RunInShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInShellInput(options.input);
    const resolvedCwd = resolveCommandCwd(input.cwd);
    const selectedShell = getRequestedOrDefaultShell(input.shell);
    const preparedSignature = buildPreparedRunInShellSignature(input, resolvedCwd, selectedShell);
    const preparedCommandId = claimPreparedRunInShellCommandId(preparedSignature);
    // Re-check only hard deny rules here as defense in depth in case policy
    // changes between prepare and invoke. Model-based ask/allow decisions are
    // intentionally resolved during prepareInvocation and, when needed, by the
    // user's explicit confirmation.
    const ruleDisposition = analyzeShellRunRuleDisposition(input.command);

    if (ruleDisposition.decision === 'deny') {
      const deniedApproval = {
        decision: 'deny',
        reason: ruleDisposition.reason ?? 'The shell approval policy denied this command.',
        source: 'rule',
      } as const;

      if (preparedCommandId) {
        getShellRuntime().updateCommandRecord(preparedCommandId, {
          approval: deniedApproval,
          phase: 'denied',
        });
      }
      else {
        getShellRuntime().createPlannedCommandRecord(input.command, {
          approval: deniedApproval,
          cwd: resolvedCwd,
          phase: 'denied',
          request: toShellCommandRequestDetails(input),
          shell: selectedShell,
        });
      }

      throw new Error(ruleDisposition.reason ?? 'The shell approval policy denied this command.');
    }

    const shellRuntimeInstance = getShellRuntime();
    const id = shellRuntimeInstance.startBackgroundCommand(input.command, {
      columns: input.columns,
      cwd: resolvedCwd,
      id: preparedCommandId,
      shell: selectedShell,
    });

    const publicId = toPublicCommandId(id);

    if (input.timeout === undefined) {
      return buildYamlToolResult({
        id: publicId,
        shell: selectedShell,
      });
    }

    const result = await shellRuntimeInstance.awaitBackgroundCommand({
      id,
      timeout: input.timeout,
    });

    if (result.timedOut) {
      return buildYamlToolResult({
        id: publicId,
        shell: result.shell,
        timedOut: true,
      });
    }

    const shouldReturnOutput = hasRunOutputOverrides(input);

    if (!shouldReturnOutput) {
      return buildYamlToolResult(addOptionalCompletionMetadata({
        exitCode: result.exitCode,
        id: publicId,
        shell: result.shell,
      }, {
        terminationSignal: result.terminationSignal,
        timedOut: result.timedOut,
      }));
    }

    const output = input.full_output === true
      ? result.output
      : getFilteredOutput(
        {
          last_lines: input.last_lines,
          regex: input.regex,
          regex_flags: input.regex_flags,
        },
        result.output,
      );

    return buildSplitOutputToolResult(addOptionalCompletionMetadata({
      exitCode: result.exitCode,
      id: publicId,
      output,
      shell: result.shell,
    }, {
      terminationSignal: result.terminationSignal,
    }) as Record<string, unknown> & {
      output: string;
    });
  },
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInShellInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const input = validateRunInShellInput(options.input);
    const commandPreview = getShellInputPreview(input.command) ?? '(empty command)';
    const resolvedCwd = resolveCommandCwd(input.cwd);
    const selectedShell = getRequestedOrDefaultShell(input.shell);
    const preparedSignature = buildPreparedRunInShellSignature(input, resolvedCwd, selectedShell);
    const shellRuntimeInstance = getShellRuntime();
    const commandRecordId = shellRuntimeInstance.createPlannedCommandRecord(input.command, {
      cwd: resolvedCwd,
      phase: 'evaluating',
      request: toShellCommandRequestDetails(input),
      shell: selectedShell,
    });
    let preserveCommandRecord = false;

    try {
      const approvalDecision = await decideShellRunApproval({
        command: input.command,
        cwd: resolvedCwd,
        explanation: input.explanation,
        goal: input.goal,
        riskAssessment: input.riskAssessment,
        riskAssessmentContext: input.riskAssessmentContext,
      }, token);

      shellRuntimeInstance.updateCommandRecord(commandRecordId, {
        approval: toShellCommandApprovalDetails(approvalDecision),
        phase: getApprovalDecisionPhase(approvalDecision),
      });

      if (approvalDecision.decision === 'deny') {
        preserveCommandRecord = true;
        throw new Error(approvalDecision.reason ?? 'The shell approval policy denied this command.');
      }

      queuePreparedRunInShellCommandId(
        preparedSignature,
        commandRecordId,
        {
          onDiscard: () => {
            shellRuntimeInstance.deleteCommandRecord(commandRecordId);
          },
          token,
        },
      );
      preserveCommandRecord = true;

      return {
        confirmationMessages: approvalDecision.decision === 'allow'
          ? undefined
          : {
            message: buildShellRunConfirmationMessage({
              approvalDecision,
              command: input.command,
              cwd: resolvedCwd,
              explanation: input.explanation,
              goal: input.goal,
              riskAssessment: input.riskAssessment,
              riskAssessmentContext: input.riskAssessmentContext,
            }),
            title: SHELL_TOOL_METADATA.runInShell.confirmationTitle,
          },
        invocationMessage: SHELL_TOOL_METADATA.runInShell.invocationMessage(commandPreview),
      };
    }
    catch (error) {
      if (!preserveCommandRecord) {
        shellRuntimeInstance.deleteCommandRecord(commandRecordId);
      }

      throw error;
    }
  },
};

const awaitShellTool: vscode.LanguageModelTool<AwaitShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AwaitShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateAwaitShellInput(options.input);
    const result = await getShellRuntime().awaitBackgroundCommand(input);

    return buildYamlToolResult(addOptionalCompletionMetadata({
      exitCode: result.exitCode,
      shell: result.shell,
    }, {
      terminationSignal: result.terminationSignal,
      timedOut: result.timedOut,
    }));
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AwaitShellInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: SHELL_TOOL_METADATA.awaitShell.invocationMessage(options.input.id),
    };
  },
};

const getShellOutputTool: vscode.LanguageModelTool<GetShellOutputInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetShellOutputInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getShellRuntime().readBackgroundOutput(options.input);
    const exitCodeState = typeof result.exitCode === 'number'
      ? {
        exitCode: result.exitCode,
      }
      : {};
    const runningState = result.isRunning
      ? {
        isRunning: true,
      }
      : {};

    return buildSplitOutputToolResult(addOptionalCompletionMetadata({
      output: result.output,
      shell: result.shell,
      ...exitCodeState,
      ...runningState,
    }, {
      terminationSignal: result.terminationSignal,
    }) as Record<string, unknown> & {
      output: string;
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetShellOutputInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: SHELL_TOOL_METADATA.getShellOutput.invocationMessage(options.input.id),
    };
  },
};

const killShellTool: vscode.LanguageModelTool<KillShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<KillShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const killed = getShellRuntime().killBackgroundCommand(options.input.id);

    return buildYamlToolResult({
      killed,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<KillShellInput>,
  ): vscode.PreparedToolInvocation {
    return {
      confirmationMessages: {
        message: SHELL_TOOL_METADATA.killShell.confirmationMessage(options.input.id),
        title: SHELL_TOOL_METADATA.killShell.confirmationTitle,
      },
      invocationMessage: SHELL_TOOL_METADATA.killShell.invocationMessage(options.input.id),
    };
  },
};

const sendToShellTool: vscode.LanguageModelTool<SendToShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SendToShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateSendToShellInput(options.input);
    const result = await getShellRuntime().sendInputToBackgroundCommand(input);

    return buildYamlToolResult({
      isRunning: result.isRunning,
      sent: result.sent,
      shell: result.shell,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SendToShellInput>,
  ): vscode.PreparedToolInvocation {
    const input = validateSendToShellInput(options.input);
    const commandPreview = getShellInputPreview(input.command, {
      secret: input.secret,
    });

    return {
      confirmationMessages: {
        message: SHELL_TOOL_METADATA.sendToShell.confirmationMessage(input.id, commandPreview, {
          secret: input.secret,
        }),
        title: SHELL_TOOL_METADATA.sendToShell.confirmationTitle,
      },
      invocationMessage: SHELL_TOOL_METADATA.sendToShell.invocationMessage(input.id),
    };
  },
};

const getShellCommandTool: vscode.LanguageModelTool<GetShellCommandInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetShellCommandInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const command = getShellRuntime().getLastCommand(options.input.id);

    return buildYamlToolResult({
      command: command ?? null,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetShellCommandInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: SHELL_TOOL_METADATA.getShellCommand.invocationMessage(options.input.id),
    };
  },
};

const getLastShellCommandTool: vscode.LanguageModelTool<GetLastShellCommandInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetLastShellCommandInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    void options;
    const command = getShellRuntime().getLastCommand();

    return buildYamlToolResult({
      command: command ?? null,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetLastShellCommandInput>,
  ): vscode.PreparedToolInvocation {
    void options;
    return {
      invocationMessage: SHELL_TOOL_METADATA.getLastShellCommand.invocationMessage,
    };
  },
};

/**
 * Register the shell language-model tools together with the risk-assessment
 * model picker command and the Shell Runs panel.
 */
export function registerShellTools(extensionUri?: vscode.Uri): vscode.Disposable {
  const registrations = [
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInShell, runInShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.awaitShell, awaitShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellOutput, getShellOutputTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.sendToShell, sendToShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellCommand, getShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getLastShellCommand, getLastShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.killShell, killShellTool),
    registerShellRiskAssessmentModelCommand(),
    registerShellCommandsPanel(getShellRuntime, extensionUri),
  ];

  return vscode.Disposable.from(...registrations);
}
