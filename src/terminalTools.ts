import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';

const OUTPUT_LIMIT = 60 * 1024;
const TOOL_PREFIX = 'custom_';
const PWD_MARKER = '__CUSTOM_VSCODE_PWD__';

interface RunInTerminalInput {
  command: string;
  explanation: string;
  goal: string;
  isBackground: boolean;
  timeout: number;
}

interface AwaitTerminalInput {
  id: string;
  timeout: number;
}

interface GetTerminalOutputInput {
  id: string;
}

interface KillTerminalInput {
  id: string;
}

interface TerminalLastCommandInput {
  id?: string;
}

interface BackgroundProcessState {
  childProc: childProcess.ChildProcessWithoutNullStreams;
  command: string;
  completed: boolean;
  completion: Promise<void>;
  exitCode: null | number;
  output: string;
  resolveCompletion: () => void;
  signal: NodeJS.Signals | null;
}

const backgroundProcesses = new Map<string, BackgroundProcessState>();
let backgroundIdCounter = 0;
let sharedForegroundCwd: string | undefined;
let lastCommand: string | undefined;

function buildShellEnv(): NodeJS.ProcessEnv {
  return {
    ...globalThis.process.env,
    TERM: globalThis.process.env.TERM ?? 'xterm-256color',
  };
}

function appendOutput(current: string, chunk: string): string {
  const next = `${current}${chunk}`;

  if (next.length <= OUTPUT_LIMIT) {
    return next;
  }

  return next.slice(-OUTPUT_LIMIT);
}

function getWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (folder) {
    return folder.uri.fsPath;
  }

  return os.homedir();
}

function buildToolResult(payload: object): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(payload)),
  ]);
}

function parseOutputAndPwd(output: string): {
  outputWithoutMarker: string;
  resolvedCwd: string | undefined;
} {
  const markerIndex = output.lastIndexOf(PWD_MARKER);

  if (markerIndex === -1) {
    return {
      outputWithoutMarker: output,
      resolvedCwd: undefined,
    };
  }

  const before = output.slice(0, markerIndex);
  const after = output.slice(markerIndex + PWD_MARKER.length);
  const lineBreakIndex = after.indexOf('\n');
  const cwdValue = lineBreakIndex === -1 ? after : after.slice(0, lineBreakIndex);
  const rest = lineBreakIndex === -1 ? '' : after.slice(lineBreakIndex + 1);

  return {
    outputWithoutMarker: `${before}${rest}`,
    resolvedCwd: cwdValue.trim() || undefined,
  };
}

async function runForegroundCommand(input: RunInTerminalInput): Promise<{
  exitCode: null | number;
  output: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  const cwd = sharedForegroundCwd ?? getWorkspaceCwd();
  const wrappedCommand = `${input.command}\nprintf "\\n${PWD_MARKER}%s\\n" "$PWD"`;

  const childProc = childProcess.spawn('/bin/bash', [ '-lc', wrappedCommand ], {
    cwd,
    env: buildShellEnv(),
  });

  let output = '';
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  childProc.stdout.on('data', (data: unknown) => {
    output = appendOutput(output, String(data));
  });

  childProc.stderr.on('data', (data: unknown) => {
    output = appendOutput(output, String(data));
  });

  if (input.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProc.kill('SIGTERM');
    }, input.timeout);
  }

  const closeResult = await new Promise<{
    code: null | number;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
      resolve({
        code,
        signal,
      });
    });
  });

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  const parsedOutput = parseOutputAndPwd(output);

  if (parsedOutput.resolvedCwd) {
    sharedForegroundCwd = parsedOutput.resolvedCwd;
  }

  return {
    exitCode: closeResult.code,
    output: parsedOutput.outputWithoutMarker,
    signal: closeResult.signal,
    timedOut,
  };
}

function startBackgroundCommand(command: string): string {
  const id = `custom-terminal-${++backgroundIdCounter}`;
  const childProc = childProcess.spawn('/bin/bash', [ '-lc', command ], {
    cwd: getWorkspaceCwd(),
    env: buildShellEnv(),
  });

  let output = '';

  const state: BackgroundProcessState = {
    childProc,
    command,
    completed: false,
    completion: Promise.resolve(),
    exitCode: null,
    output: '',
    resolveCompletion: () => undefined,
    signal: null,
  };

  state.completion = new Promise<void>(resolve => {
    state.resolveCompletion = resolve;
  });

  childProc.stdout.on('data', (data: unknown) => {
    output = appendOutput(output, String(data));
    state.output = output;
  });

  childProc.stderr.on('data', (data: unknown) => {
    output = appendOutput(output, String(data));
    state.output = output;
  });

  childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
    state.completed = true;
    state.exitCode = code;
    state.signal = signal;
    state.resolveCompletion();
  });

  childProc.on('error', (error: Error) => {
    state.completed = true;
    state.output = appendOutput(state.output, `\n${String(error)}\n`);
    state.resolveCompletion();
  });

  backgroundProcesses.set(id, state);

  return id;
}

function getBackgroundState(id: string): BackgroundProcessState {
  const state = backgroundProcesses.get(id);

  if (!state) {
    throw new Error(`Unknown terminal id: ${id}`);
  }

  return state;
}

const customRunInTerminalTool: vscode.LanguageModelTool<RunInTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunInTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { input } = options;
    lastCommand = input.command;

    if (input.isBackground) {
      const id = startBackgroundCommand(input.command);
      return buildToolResult({ id });
    }

    const result = await runForegroundCommand(input);
    return buildToolResult({
      exitCode: result.exitCode,
      output: result.output,
      signal: result.signal,
      timedOut: result.timedOut,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunInTerminalInput>,
  ): vscode.PreparedToolInvocation {
    const commandPreview = options.input.command.split('\n')[0]?.trim() || '(empty command)';

    return {
      confirmationMessages: {
        message: `Run shell command: ${commandPreview}`,
        title: 'Run terminal command?',
      },
      invocationMessage: `Running in terminal: ${commandPreview}`,
    };
  },
};

const customAwaitTerminalTool: vscode.LanguageModelTool<AwaitTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AwaitTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const state = getBackgroundState(options.input.id);

    if (!state.completed) {
      if (options.input.timeout === 0) {
        await state.completion;
      }
      else {
        await Promise.race([
          state.completion,
          new Promise<void>(resolve => {
            setTimeout(resolve, options.input.timeout);
          }),
        ]);
      }
    }

    const timedOut = !state.completed;
    return buildToolResult({
      exitCode: state.completed ? state.exitCode : null,
      output: state.output,
      signal: state.completed ? state.signal : null,
      timedOut,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AwaitTerminalInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Waiting for terminal ${options.input.id}`,
    };
  },
};

const customGetTerminalOutputTool: vscode.LanguageModelTool<GetTerminalOutputInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTerminalOutputInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const state = getBackgroundState(options.input.id);
    return buildToolResult({
      isRunning: !state.completed,
      output: state.output,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetTerminalOutputInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Reading output for terminal ${options.input.id}`,
    };
  },
};

const customKillTerminalTool: vscode.LanguageModelTool<KillTerminalInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<KillTerminalInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const state = getBackgroundState(options.input.id);

    if (!state.completed) {
      state.childProc.kill('SIGTERM');
    }

    return buildToolResult({
      killed: true,
    });
  },
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<KillTerminalInput>,
  ): vscode.PreparedToolInvocation {
    return {
      confirmationMessages: {
        message: `Stop terminal ${options.input.id}`,
        title: 'Stop running terminal?',
      },
      invocationMessage: `Stopping terminal ${options.input.id}`,
    };
  },
};

const customTerminalLastCommandTool: vscode.LanguageModelTool<TerminalLastCommandInput> = {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TerminalLastCommandInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const requestedTerminalId = options.input.id;
    const command = requestedTerminalId
      ? getBackgroundState(requestedTerminalId).command
      : lastCommand;

    return buildToolResult({
      command: command ?? null,
    });
  },
  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: 'Reading last terminal command',
    };
  },
};

export function registerTerminalTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool(`${TOOL_PREFIX}run_in_terminal`, customRunInTerminalTool),
    vscode.lm.registerTool(`${TOOL_PREFIX}await_terminal`, customAwaitTerminalTool),
    vscode.lm.registerTool(`${TOOL_PREFIX}get_terminal_output`, customGetTerminalOutputTool),
    vscode.lm.registerTool(`${TOOL_PREFIX}kill_terminal`, customKillTerminalTool),
    vscode.lm.registerTool(`${TOOL_PREFIX}terminal_last_command`, customTerminalLastCommandTool),
  );
}
