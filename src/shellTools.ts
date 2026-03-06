import * as os from 'node:os';
import * as vscode from 'vscode';

import { registerShellCommandsPanel } from '@/shellCommandsPanel';
import {
  getFilteredOutput,
  stripShellControlSequences,
} from '@/shellOutputFilter';
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

const DEFAULT_MEMORY_TO_FILE_SPILL_MINUTES = 2;
const DEFAULT_STARTUP_PURGE_MAX_AGE_HOURS = 6;

function getNumericSettingOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

function getShellOutputSettings(): {
  memoryToFileDelayMs: number;
  startupPurgeMaxAgeMs: number;
} {
  const configuration = vscode.workspace.getConfiguration('agent-helper-kit');
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
  const sanitizedOutput = stripShellControlSequences(output);

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

let shellRuntime: ShellRuntime | undefined;

function getShellRuntime(): ShellRuntime {
  if (!shellRuntime) {
    const {
      memoryToFileDelayMs,
      startupPurgeMaxAgeMs,
    } = getShellOutputSettings();

    shellRuntime = new ShellRuntime({
      memoryToFileDelayMs,
      startupPurgeMaxAgeMs,
    });
  }

  return shellRuntime;
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

const runInAsyncShellTool: vscode.LanguageModelTool<RunInAsyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInAsyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInAsyncShellInput(options.input);
    const id = getShellRuntime().startBackgroundCommand(
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

const runInSyncShellTool: vscode.LanguageModelTool<RunInSyncShellInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInSyncShellInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInSyncShellInput(options.input);
    const shouldReturnOutput = hasRunOutputOverrides(input);
    const shellRuntimeInstance = getShellRuntime();
    const resolvedShell = getRequestedOrDefaultShell(input.shell);

    const id = shellRuntimeInstance.startBackgroundCommand(
      input.command,
      resolvedShell,
      getWorkspaceCwd(),
    );
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

export function registerShellTools(): vscode.Disposable {
  const registrations = [
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInSyncShell, runInSyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.runInAsyncShell, runInAsyncShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.awaitShell, awaitShellTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellOutput, getShellOutputTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getShellCommand, getShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.getLastShellCommand, getLastShellCommandTool),
    vscode.lm.registerTool(SHELL_TOOL_NAMES.killShell, killShellTool),
    registerShellCommandsPanel(getShellRuntime),
  ];

  return vscode.Disposable.from(...registrations);
}
