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
  type KillShellInput,
  type RunInAsyncShellInput,
  type RunInSyncShellInput,
  SHELL_TOOL_METADATA,
  SHELL_TOOL_NAMES,
  validateRunInAsyncShellInput,
  validateRunInSyncShellInput,
} from '@/shellToolContracts';
import {
  analyzeShellRunRuleDisposition,
  buildShellRunConfirmationMessage,
  decideShellRunApproval,
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
  if (value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value);
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

export function resetShellRuntimeForTest(): void {
  shellRuntime = undefined;
}

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
 * Detect whether a synchronous shell run should return command output in
 * addition to completion metadata.
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
 * user's VS Code default shell.
 */
function getRequestedOrDefaultShell(inputShell?: string): string | undefined {
  if (typeof inputShell === 'string' && inputShell.trim().length > 0) {
    return inputShell.trim();
  }

  const vscodeDefaultShell = vscode.env.shell;

  if (typeof vscodeDefaultShell === 'string' && vscodeDefaultShell.trim().length > 0) {
    return vscodeDefaultShell.trim();
  }

  return undefined;
}

const runInAsyncShellTool: vscode.LanguageModelTool<RunInAsyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInAsyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInAsyncShellInput(options.input);
    const ruleDisposition = analyzeShellRunRuleDisposition(input.command);

    if (ruleDisposition.decision === 'deny') {
      throw new Error(ruleDisposition.reason ?? 'The shell approval policy denied this command.');
    }

    const resolvedCwd = resolveCommandCwd(input.cwd);
    const id = getShellRuntime().startBackgroundCommand(input.command, {
      columns: input.columns,
      cwd: resolvedCwd,
      shell: getRequestedOrDefaultShell(input.shell),
    });

    return buildYamlToolResult({ id: toPublicCommandId(id) });
  },
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInAsyncShellInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';
    const resolvedCwd = resolveCommandCwd(options.input.cwd);
    const approvalDecision = await decideShellRunApproval({
      command: options.input.command,
      cwd: resolvedCwd,
      explanation: options.input.explanation,
      goal: options.input.goal,
      riskAssessment: options.input.riskAssessment,
      riskAssessmentContext: options.input.riskAssessmentContext,
    }, token);

    if (approvalDecision.decision === 'deny') {
      throw new Error(approvalDecision.reason ?? 'The shell approval policy denied this command.');
    }

    return {
      confirmationMessages: approvalDecision.decision === 'allow'
        ? undefined
        : {
          message: buildShellRunConfirmationMessage({
            approvalDecision,
            command: options.input.command,
            cwd: resolvedCwd,
            explanation: options.input.explanation,
            goal: options.input.goal,
            riskAssessment: options.input.riskAssessment,
            riskAssessmentContext: options.input.riskAssessmentContext,
          }),
          title: SHELL_TOOL_METADATA.runInAsyncShell.confirmationTitle,
        },
      invocationMessage: SHELL_TOOL_METADATA.runInAsyncShell.invocationMessage(commandPreview),
    };
  },
};

const runInSyncShellTool: vscode.LanguageModelTool<RunInSyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInSyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInSyncShellInput(options.input);
    const ruleDisposition = analyzeShellRunRuleDisposition(input.command);

    if (ruleDisposition.decision === 'deny') {
      throw new Error(ruleDisposition.reason ?? 'The shell approval policy denied this command.');
    }

    const shouldReturnOutput = hasRunOutputOverrides(input);
    const shellRuntimeInstance = getShellRuntime();
    const resolvedCwd = resolveCommandCwd(input.cwd);
    const resolvedShell = getRequestedOrDefaultShell(input.shell);

    const id = shellRuntimeInstance.startBackgroundCommand(input.command, {
      columns: input.columns,
      cwd: resolvedCwd,
      shell: resolvedShell,
    });
    let result = await shellRuntimeInstance.awaitBackgroundCommand({
      id,
      timeout: input.timeout,
    });

    if (result.timedOut) {
      shellRuntimeInstance.killBackgroundCommand(id);
      const completedResult = await shellRuntimeInstance.awaitBackgroundCommand({
        id,
        timeout: 0,
      });

      result = {
        ...completedResult,
        timedOut: true,
      };
    }

    const publicId = toPublicCommandId(id);

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
      timedOut: result.timedOut,
    }) as Record<string, unknown> & {
      output: string;
    });
  },
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInSyncShellInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';
    const resolvedCwd = resolveCommandCwd(options.input.cwd);
    const approvalDecision = await decideShellRunApproval({
      command: options.input.command,
      cwd: resolvedCwd,
      explanation: options.input.explanation,
      goal: options.input.goal,
      riskAssessment: options.input.riskAssessment,
      riskAssessmentContext: options.input.riskAssessmentContext,
    }, token);

    if (approvalDecision.decision === 'deny') {
      throw new Error(approvalDecision.reason ?? 'The shell approval policy denied this command.');
    }

    return {
      confirmationMessages: approvalDecision.decision === 'allow'
        ? undefined
        : {
          message: buildShellRunConfirmationMessage({
            approvalDecision,
            command: options.input.command,
            cwd: resolvedCwd,
            explanation: options.input.explanation,
            goal: options.input.goal,
            riskAssessment: options.input.riskAssessment,
            riskAssessmentContext: options.input.riskAssessmentContext,
          }),
          title: SHELL_TOOL_METADATA.runInSyncShell.confirmationTitle,
        },
      invocationMessage: SHELL_TOOL_METADATA.runInSyncShell.invocationMessage(commandPreview),
    };
  },
};

const awaitShellTool: vscode.LanguageModelTool<AwaitShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AwaitShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getShellRuntime().awaitBackgroundCommand(options.input);

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
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInSyncShell, runInSyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInAsyncShell, runInAsyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.awaitShell, awaitShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellOutput, getShellOutputTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellCommand, getShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getLastShellCommand, getLastShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.killShell, killShellTool),
    registerShellRiskAssessmentModelCommand(),
    registerShellCommandsPanel(getShellRuntime, extensionUri),
  ];

  return vscode.Disposable.from(...registrations);
}
