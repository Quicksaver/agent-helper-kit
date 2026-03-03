import * as os from 'node:os';
import * as vscode from 'vscode';

import { TerminalRuntime } from '@/terminalRuntime';
import {
  type AwaitTerminalInput,
  type GetTerminalOutputInput,
  type KillTerminalInput,
  type RunInTerminalInput,
  TERMINAL_TOOL_METADATA,
  TERMINAL_TOOL_NAMES,
  type TerminalLastCommandInput,
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

const terminalRuntime = new TerminalRuntime({
  getBackgroundCwd: () => getWorkspaceCwd(),
  getInitialForegroundCwd: () => getWorkspaceCwd(),
  pwdMarker: '__CUSTOM_VSCODE_PWD__',
  stateCleanupDelayMs: STATE_CLEANUP_DELAY_MS,
});

const customRunInTerminalTool: vscode.LanguageModelTool<RunInTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { input } = options;

    if (input.isBackground) {
      const id = terminalRuntime.startBackgroundCommand(input.command);
      return buildYamlToolResult({ id });
    }

    const result = await terminalRuntime.runForegroundCommand({
      command: input.command,
      timeout: input.timeout,
    });

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      output: result.output,
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
    const result = await terminalRuntime.awaitBackgroundCommand(options.input);

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
    const result = terminalRuntime.readBackgroundOutput(options.input);

    return buildMarkdownOutputToolResult({
      exitCode: result.exitCode,
      isRunning: result.isRunning,
      output: result.output,
      terminationSignal: result.terminationSignal,
      timedOut: result.timedOut,
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
    terminalRuntime.killBackgroundCommand(options.input.id);

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
    const command = terminalRuntime.getLastCommand(options.input.id);

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
