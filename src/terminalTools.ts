import * as os from 'node:os';
import * as vscode from 'vscode';

import { getFilteredOutput } from '@/terminalOutputFilter';
import { TerminalRuntime } from '@/terminalRuntime';
import {
  type AwaitTerminalInput,
  type GetTerminalOutputInput,
  type KillTerminalInput,
  type RunInTerminalInput,
  TERMINAL_TOOL_METADATA,
  TERMINAL_TOOL_NAMES,
  type TerminalLastCommandInput,
  validateRunInTerminalInput,
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

function hasRunOutputOverrides(input: RunInTerminalInput): boolean {
  return input.full_output === true
    || typeof input.last_lines === 'number'
    || typeof input.regex === 'string';
}

const customRunInTerminalTool: vscode.LanguageModelTool<RunInTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const input = validateRunInTerminalInput(options.input);
    const shouldReturnOutput = hasRunOutputOverrides(input);

    if (input.isBackground) {
      const id = getTerminalRuntime().startBackgroundCommand(input.command);

      if (!shouldReturnOutput) {
        return buildYamlToolResult({ id });
      }

      const result = await getTerminalRuntime().readBackgroundOutput({
        full_output: input.full_output,
        id,
        last_lines: input.last_lines,
        regex: input.regex,
      });

      return buildMarkdownOutputToolResult({
        exitCode: result.exitCode,
        id,
        isRunning: result.isRunning,
        output: result.output,
        terminationSignal: result.terminationSignal,
      });
    }

    const result = await getTerminalRuntime().runForegroundCommand({
      command: input.command,
      timeout: input.timeout,
    });
    const id = getTerminalRuntime().createCompletedCommandRecord(input.command, result);

    if (!shouldReturnOutput) {
      return buildYamlToolResult({
        exitCode: result.exitCode,
        id,
        terminationSignal: result.terminationSignal,
        timedOut: result.timedOut,
      });
    }

    const filteredOutput = getFilteredOutput(
      {
        last_lines: input.last_lines,
        regex: input.regex,
      },
      result.output,
    );

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      id,
      output: filteredOutput,
      terminationSignal: result.terminationSignal,
      timedOut: result.timedOut,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInTerminalInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: TERMINAL_TOOL_METADATA.runInTerminal.confirmationMessage(commandPreview),
        title: TERMINAL_TOOL_METADATA.runInTerminal.confirmationTitle,
      },
      invocationMessage: TERMINAL_TOOL_METADATA.runInTerminal.invocationMessage(commandPreview),
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
    getTerminalRuntime().killBackgroundCommand(options.input.id);

    return buildYamlToolResult({
      killed: true,
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
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.runInTerminal, customRunInTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.awaitTerminal, customAwaitTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.getTerminalOutput, customGetTerminalOutputTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.killTerminal, customKillTerminalTool),
    vscode.lm.registerTool(TERMINAL_TOOL_NAMES.terminalLastCommand, customTerminalLastCommandTool),
  );
}
