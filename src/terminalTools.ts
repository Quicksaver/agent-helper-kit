import * as os from 'node:os';
import * as vscode from 'vscode';

import { getFilteredOutput } from '@/terminalOutputFilter';
import { TerminalRuntime } from '@/terminalRuntime';
import {
  type AwaitTerminalInput,
  type GetTerminalOutputInput,
  type KillTerminalInput,
  type RunInAsyncTerminalInput,
  type RunInSyncTerminalInput,
  TERMINAL_TOOL_METADATA,
  TERMINAL_TOOL_NAMES,
  type TerminalLastCommandInput,
  validateRunInAsyncTerminalInput,
  validateRunInSyncTerminalInput,
} from '@/terminalToolContracts';

const STATE_CLEANUP_DELAY_MS = 5 * 60 * 1000;

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

function buildMarkdownOutputToolResult(payload: Record<string, unknown> & {
  output: string;
}): vscode.LanguageModelToolResult {
  const {
    output,
    ...frontmatter
  } = payload;

  const normalizedOutput = output === '' || output.endsWith('\n') ? output : `${output}\n`;
  const markdown = [
    '---',
    toYaml(frontmatter),
    '---',
    '',
    '````text',
    normalizedOutput,
    '````',
  ].join('\n');

  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(markdown),
  ]);
}

let terminalRuntime: TerminalRuntime | undefined;

function getTerminalRuntime(): TerminalRuntime {
  if (!terminalRuntime) {
    terminalRuntime = new TerminalRuntime({
      getBackgroundCwd: () => getWorkspaceCwd(),
      getInitialForegroundCwd: () => getWorkspaceCwd(),
      pwdMarker: '__CUSTOM_VSCODE_PWD__',
      stateCleanupDelayMs: STATE_CLEANUP_DELAY_MS,
    });
  }

  return terminalRuntime;
}

function hasRunOutputOverrides(input: {
  full_output?: boolean;
  last_lines?: number;
  regex?: string;
}): boolean {
  return input.full_output === true
    || typeof input.last_lines === 'number'
    || typeof input.regex === 'string';
}

const customRunInAsyncTerminalTool: vscode.LanguageModelTool<RunInAsyncTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInAsyncTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInAsyncTerminalInput(options.input);
    const id = getTerminalRuntime().startBackgroundCommand(input.command);

    return buildYamlToolResult({ id });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInAsyncTerminalInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: TERMINAL_TOOL_METADATA.runInAsyncTerminal.confirmationMessage(commandPreview),
        title: TERMINAL_TOOL_METADATA.runInAsyncTerminal.confirmationTitle,
      },
      invocationMessage: TERMINAL_TOOL_METADATA.runInAsyncTerminal.invocationMessage(commandPreview),
    };
  },
};

const customRunInSyncTerminalTool: vscode.LanguageModelTool<RunInSyncTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInSyncTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInSyncTerminalInput(options.input);
    const shouldReturnOutput = hasRunOutputOverrides(input);
    const terminalRuntimeInstance = getTerminalRuntime();

    const result = await terminalRuntimeInstance.runForegroundCommand({
      command: input.command,
      timeout: input.timeout,
    });
    const id = terminalRuntimeInstance.createCompletedCommandRecord(input.command, result);

    if (!shouldReturnOutput) {
      return buildYamlToolResult({
        exitCode: result.exitCode,
        id,
        terminationSignal: result.terminationSignal,
        timedOut: result.timedOut,
      });
    }

    const output = input.full_output === true
      ? result.output
      : getFilteredOutput(
        {
          last_lines: input.last_lines,
          regex: input.regex,
        },
        result.output,
      );

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      id,
      output,
      terminationSignal: result.terminationSignal,
      timedOut: result.timedOut,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInSyncTerminalInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: TERMINAL_TOOL_METADATA.runInSyncTerminal.confirmationMessage(commandPreview),
        title: TERMINAL_TOOL_METADATA.runInSyncTerminal.confirmationTitle,
      },
      invocationMessage: TERMINAL_TOOL_METADATA.runInSyncTerminal.invocationMessage(commandPreview),
    };
  },
};

const customAwaitTerminalTool: vscode.LanguageModelTool<AwaitTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AwaitTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getTerminalRuntime().awaitBackgroundCommand(options.input);

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      output: result.output,
      terminationSignal: result.terminationSignal,
      timedOut: result.timedOut,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AwaitTerminalInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: TERMINAL_TOOL_METADATA.awaitTerminal.invocationMessage(options.input.id),
    };
  },
};

const customGetTerminalOutputTool: vscode.LanguageModelTool<GetTerminalOutputInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTerminalOutputInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await getTerminalRuntime().readBackgroundOutput(options.input);

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      isRunning: result.isRunning,
      output: result.output,
      terminationSignal: result.terminationSignal,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetTerminalOutputInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: TERMINAL_TOOL_METADATA.getTerminalOutput.invocationMessage(options.input.id),
    };
  },
};

const customKillTerminalTool: vscode.LanguageModelTool<KillTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<KillTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const killed = getTerminalRuntime().killBackgroundCommand(options.input.id);

    return buildYamlToolResult({
      killed,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<KillTerminalInput>,
  ): vscode.PreparedToolInvocation {
    return {
      confirmationMessages: {
        message: TERMINAL_TOOL_METADATA.killTerminal.confirmationMessage(options.input.id),
        title: TERMINAL_TOOL_METADATA.killTerminal.confirmationTitle,
      },
      invocationMessage: TERMINAL_TOOL_METADATA.killTerminal.invocationMessage(options.input.id),
    };
  },
};

const customTerminalLastCommandTool: vscode.LanguageModelTool<TerminalLastCommandInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TerminalLastCommandInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const command = getTerminalRuntime().getLastCommand(options.input.id);

    return buildYamlToolResult({
      command: command ?? null,
    });
  },
  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: TERMINAL_TOOL_METADATA.terminalLastCommand.invocationMessage,
    };
  },
};

export function registerTerminalTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.runInSyncTerminal, customRunInSyncTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.runInAsyncTerminal, customRunInAsyncTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.awaitTerminal, customAwaitTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.getTerminalOutput, customGetTerminalOutputTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.killTerminal, customKillTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.terminalLastCommand, customTerminalLastCommandTool),
  );
}
