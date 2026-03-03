import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';

import {
  appendTerminalOutput,
  initializeTerminalOutputStore,
  overwriteTerminalOutput,
  readTerminalOutput,
  removeTerminalOutputFile,
} from '@/terminalOutputStore';

const OUTPUT_LIMIT = 60 * 1024;
const MEMORY_TO_FILE_DELAY_MS = 2 * 60 * 1000;
const STATE_CLEANUP_DELAY_MS = 5 * 60 * 1000;
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
  last_lines?: number;
  regex?: string;
}

interface KillTerminalInput {
  id: string;
}

interface TerminalLastCommandInput {
  id?: string;
}

interface BackgroundProcessState {
  childProc: childProcess.ChildProcessWithoutNullStreams;
  cleanupTimer: NodeJS.Timeout | undefined;
  command: string;
  completed: boolean;
  completion: Promise<void>;
  exitCode: null | number;
  memoryToFileTimer: NodeJS.Timeout | undefined;
  output: string;
  outputInFile: boolean;
  purgeOnSpill: boolean;
  resolveCompletion: () => void;
  signal: NodeJS.Signals | null;
}

const backgroundProcesses = new Map<string, BackgroundProcessState>();
let backgroundIdCounter = 0;
let sharedForegroundCwd: string | undefined;
let lastCommand: string | undefined;

initializeTerminalOutputStore(new Set(backgroundProcesses.keys()));

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

function getFilteredOutput(input: GetTerminalOutputInput, output: string): string {
  const hasLastLines = typeof input.last_lines === 'number';
  const hasRegex = typeof input.regex === 'string';

  if (hasLastLines && hasRegex) {
    throw new Error('last_lines and regex are mutually exclusive');
  }

  if (!hasLastLines && !hasRegex) {
    return output;
  }

  const lines = output.endsWith('\n')
    ? output.slice(0, -1).split('\n')
    : output.split('\n');

  if (hasLastLines) {
    const count = Math.max(Math.floor(input.last_lines ?? 0), 0);

    if (count === 0) {
      return '';
    }

    return `${lines.slice(-count).join('\n')}\n`;
  }

  const expression = new RegExp(input.regex ?? '');
  return lines.filter(line => expression.test(line)).join('\n');
}

function scheduleBackgroundStateCleanup(id: string, state: BackgroundProcessState): void {
  state.cleanupTimer = setTimeout(() => {
    backgroundProcesses.delete(id);
  }, STATE_CLEANUP_DELAY_MS);
}

function scheduleMemoryToFileSpill(id: string, state: BackgroundProcessState): void {
  state.memoryToFileTimer = setTimeout(() => {
    if (state.purgeOnSpill) {
      state.output = '';
      return;
    }

    overwriteTerminalOutput(id, state.output);
    state.output = '';
    state.outputInFile = true;
  }, MEMORY_TO_FILE_DELAY_MS);
}

function appendBackgroundOutput(id: string, state: BackgroundProcessState, chunk: string): void {
  if (state.outputInFile) {
    appendTerminalOutput(id, chunk);
    return;
  }

  state.output = `${state.output}${chunk}`;
}

function getBackgroundOutput(id: string, state: BackgroundProcessState): string {
  if (state.outputInFile) {
    return readTerminalOutput(id);
  }

  return state.output;
}

function purgeBackgroundOutput(id: string, state: BackgroundProcessState): void {
  state.output = '';
  state.outputInFile = false;
  removeTerminalOutputFile(id);

  if (state.memoryToFileTimer) {
    clearTimeout(state.memoryToFileTimer);
    state.memoryToFileTimer = undefined;
  }
}

function handleSignalTermination(id: string, state: BackgroundProcessState, signal: NodeJS.Signals): void {
  if (signal === 'SIGINT') {
    return;
  }

  if (state.outputInFile) {
    purgeBackgroundOutput(id, state);
    return;
  }

  state.purgeOnSpill = true;
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
    const chunk = String(data);
    output = appendOutput(output, chunk);
  });

  childProc.stderr.on('data', (data: unknown) => {
    const chunk = String(data);
    output = appendOutput(output, chunk);
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

  const state: BackgroundProcessState = {
    childProc,
    cleanupTimer: undefined,
    command,
    completed: false,
    completion: Promise.resolve(),
    exitCode: null,
    memoryToFileTimer: undefined,
    output: '',
    outputInFile: false,
    purgeOnSpill: false,
    resolveCompletion: () => undefined,
    signal: null,
  };

  state.completion = new Promise<void>(resolve => {
    state.resolveCompletion = resolve;
  });

  scheduleMemoryToFileSpill(id, state);

  childProc.stdout.on('data', (data: unknown) => {
    const chunk = String(data);
    appendBackgroundOutput(id, state, chunk);
  });

  childProc.stderr.on('data', (data: unknown) => {
    const chunk = String(data);
    appendBackgroundOutput(id, state, chunk);
  });

  childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
    state.completed = true;
    state.exitCode = code;
    state.signal = signal;

    if (signal) {
      handleSignalTermination(id, state, signal);
    }

    state.resolveCompletion();
    scheduleBackgroundStateCleanup(id, state);
  });

  childProc.on('error', (error: Error) => {
    state.completed = true;
    appendBackgroundOutput(id, state, `\n${String(error)}\n`);
    state.resolveCompletion();
    scheduleBackgroundStateCleanup(id, state);
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
      output: getBackgroundOutput(options.input.id, state),
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
    const storedOutput = getBackgroundOutput(options.input.id, state);

    return buildToolResult({
      isRunning: !state.completed,
      output: getFilteredOutput(options.input, storedOutput),
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
