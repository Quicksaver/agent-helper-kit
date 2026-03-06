import * as os from 'node:os';
import * as vscode from 'vscode';

import { registerShellCommandsPanel } from '@/shellCommandsPanel';
import {
  getFilteredOutput,
  stripTerminalControlSequences,
} from '@/shellOutputFilter';
import {
  TerminalRuntime,
  toPublicCommandId,
} from '@/shellRuntime';
import {
  type AwaitShellInput,
  type GetShellOutputInput,
  type KillShellInput,
  type RunInAsyncShellInput,
  type RunInSyncShellInput,
  SHELL_TOOL_METADATA,
  SHELL_TOOL_NAMES,
  type ShellLastCommandInput,
  validateRunInAsyncShellInput,
  validateRunInSyncShellInput,
} from '@/shellToolContracts';

const DEFAULT_MEMORY_TO_FILE_SPILL_MINUTES = 2;
const DEFAULT_STARTUP_PURGE_MAX_AGE_HOURS = 6;

function getNumericSettingOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

function getTerminalOutputSettings(): {
  memoryToFileDelayMs: number;
  startupPurgeMaxAgeMs: number;
} {
  const configuration = vscode.workspace.getConfiguration('custom-vscode');
  const memoryToFileSpillMinutes = getNumericSettingOrDefault(
    configuration.get<number>('shellOutput.memoryToFileSpillMinutes'),
    DEFAULT_MEMORY_TO_FILE_SPILL_MINUTES,
  );
  const startupPurgeMaxAgeHours = getNumericSettingOrDefault(
    configuration.get<number>('shellOutput.startupPurgeMaxAgeHours'),
    DEFAULT_STARTUP_PURGE_MAX_AGE_HOURS,
  );

  return {
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

function buildSplitOutputToolResult(payload: Record<string, unknown> & {
  output: string;
}): vscode.LanguageModelToolResult {
  const {
    output,
    ...metadata
  } = payload;
  const sanitizedOutput = stripTerminalControlSequences(output);

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(toYaml(metadata)),
    new vscode.LanguageModelTextPart(sanitizedOutput),
  ]);
}

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

let terminalRuntime: TerminalRuntime | undefined;

function getTerminalRuntime(): TerminalRuntime {
  if (!terminalRuntime) {
    const {
      memoryToFileDelayMs,
      startupPurgeMaxAgeMs,
    } = getTerminalOutputSettings();

    terminalRuntime = new TerminalRuntime({
      memoryToFileDelayMs,
      startupPurgeMaxAgeMs,
    });
  }

  return terminalRuntime;
}

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

const customRunInAsyncShellTool: vscode.LanguageModelTool<RunInAsyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInAsyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInAsyncShellInput(options.input);
    const id = getTerminalRuntime().startBackgroundCommand(
      input.command,
      getRequestedOrDefaultShell(input.shell),
      getWorkspaceCwd(),
    );

    return buildYamlToolResult({ id: toPublicCommandId(id) });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInAsyncShellInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: SHELL_TOOL_METADATA.runInAsyncShell.confirmationMessage(commandPreview),
        title: SHELL_TOOL_METADATA.runInAsyncShell.confirmationTitle,
      },
      invocationMessage: SHELL_TOOL_METADATA.runInAsyncShell.invocationMessage(commandPreview),
    };
  },
};

const customRunInSyncShellTool: vscode.LanguageModelTool<RunInSyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInSyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInSyncShellInput(options.input);
    const shouldReturnOutput = hasRunOutputOverrides(input);
    const terminalRuntimeInstance = getTerminalRuntime();
    const resolvedShell = getRequestedOrDefaultShell(input.shell);

    const id = terminalRuntimeInstance.startBackgroundCommand(
      input.command,
      resolvedShell,
      getWorkspaceCwd(),
    );
    let result = await terminalRuntimeInstance.awaitBackgroundCommand({
      id,
      timeout: input.timeout,
    });

    if (result.timedOut) {
      terminalRuntimeInstance.killBackgroundCommand(id);
      const completedResult = await terminalRuntimeInstance.awaitBackgroundCommand({
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
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInSyncShellInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: SHELL_TOOL_METADATA.runInSyncShell.confirmationMessage(commandPreview),
        title: SHELL_TOOL_METADATA.runInSyncShell.confirmationTitle,
      },
      invocationMessage: SHELL_TOOL_METADATA.runInSyncShell.invocationMessage(commandPreview),
    };
  },
};

const customAwaitShellTool: vscode.LanguageModelTool<AwaitShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AwaitShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getTerminalRuntime().awaitBackgroundCommand(options.input);

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

const customGetShellOutputTool: vscode.LanguageModelTool<GetShellOutputInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetShellOutputInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getTerminalRuntime().readBackgroundOutput(options.input);
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

const customKillShellTool: vscode.LanguageModelTool<KillShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<KillShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const killed = getTerminalRuntime().killBackgroundCommand(options.input.id);

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

const customShellLastCommandTool: vscode.LanguageModelTool<ShellLastCommandInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ShellLastCommandInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const command = getTerminalRuntime().getLastCommand(options.input.id);

    return buildYamlToolResult({
      command: command ?? null,
    });
  },
  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: SHELL_TOOL_METADATA.shellLastCommand.invocationMessage,
    };
  },
};

export function registerShellTools(): vscode.Disposable {
  const registrations = [
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInSyncShell, customRunInSyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInAsyncShell, customRunInAsyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.awaitShell, customAwaitShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellOutput, customGetShellOutputTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.killShell, customKillShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.shellLastCommand, customShellLastCommandTool),
    registerShellCommandsPanel(getTerminalRuntime),
  ];

  return vscode.Disposable.from(...registrations);
}
