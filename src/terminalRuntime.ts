import * as childProcess from 'node:child_process';
import * as os from 'node:os';

import {
  getFilteredOutput,
  type TerminalOutputFilterInput,
} from '@/terminalOutputFilter';
import {
  appendTerminalOutput,
  initializeTerminalOutputStore,
  overwriteTerminalOutput,
  readTerminalOutput,
  removeTerminalOutputFile,
} from '@/terminalOutputStore';

const DEFAULT_OUTPUT_LIMIT = 60 * 1024;
const DEFAULT_MEMORY_TO_FILE_DELAY_MS = 2 * 60 * 1000;
const DEFAULT_STATE_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const READS_SINCE_COMPLETION_FOR_SYNC_RECORD = 1;

interface BackgroundProcessState {
  childProc?: childProcess.ChildProcessWithoutNullStreams;
  cleanupTimer: NodeJS.Timeout | undefined;
  command: string;
  completed: boolean;
  completion: Promise<void>;
  exitCode: null | number;
  lastReadCursor: number;
  memoryToFileTimer: NodeJS.Timeout | undefined;
  output: string;
  outputInFile: boolean;
  purgeOnSpill: boolean;
  readsSinceCompletion: number;
  resolveCompletion: () => void;
  signal: NodeJS.Signals | null;
}

export interface RunForegroundCommandInput {
  command: string;
  timeout: number;
}

export interface RunCommandResult {
  exitCode: null | number;
  output: string;
  terminationSignal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface ShellInvocation {
  command: string;
  shell: string;
  shellArgs: string[];
}

export interface AwaitBackgroundInput {
  id: string;
  timeout: number;
}

export interface ReadBackgroundOutputInput extends TerminalOutputFilterInput {
  full_output?: boolean;
  id: string;
}

interface TerminalRuntimeOptions {
  getBackgroundCwd: () => string;
  getInitialForegroundCwd: () => string;
  memoryToFileDelayMs?: number;
  outputLimit?: number;
  pwdMarker: string;
  shellEnv?: NodeJS.ProcessEnv;
  stateCleanupDelayMs?: number;
}

export class TerminalRuntime {
  private backgroundIdCounter = 0;
  private readonly backgroundProcesses = new Map<string, BackgroundProcessState>();
  private lastCommand: string | undefined;
  private sharedForegroundCwd: string | undefined;

  constructor(private readonly options: TerminalRuntimeOptions) {
    initializeTerminalOutputStore(new Set(this.backgroundProcesses.keys()));
  }

  async awaitBackgroundCommand(input: AwaitBackgroundInput): Promise<RunCommandResult> {
    const state = this.getBackgroundState(input.id);

    if (!state.completed) {
      if (input.timeout === 0) {
        await state.completion;
      }
      else {
        await Promise.race([
          state.completion,
          new Promise<void>(resolve => {
            setTimeout(resolve, input.timeout);
          }),
        ]);
      }
    }

    const timedOut = !state.completed;

    return {
      exitCode: state.completed ? state.exitCode : null,
      output: await this.getBackgroundOutput(input.id, state),
      terminationSignal: state.completed ? state.signal : null,
      timedOut,
    };
  }

  createCompletedCommandRecord(command: string, result: RunCommandResult): string {
    const id = `custom-terminal-${++this.backgroundIdCounter}`;

    const state: BackgroundProcessState = {
      cleanupTimer: undefined,
      command,
      completed: true,
      completion: Promise.resolve(),
      exitCode: result.exitCode,
      lastReadCursor: 0,
      memoryToFileTimer: undefined,
      output: result.output,
      outputInFile: false,
      purgeOnSpill: false,
      readsSinceCompletion: READS_SINCE_COMPLETION_FOR_SYNC_RECORD,
      resolveCompletion: () => undefined,
      signal: result.terminationSignal,
    };

    this.backgroundProcesses.set(id, state);
    this.scheduleBackgroundStateCleanup(id, state);

    return id;
  }

  getLastCommand(id?: string): string | undefined {
    if (!id) {
      return this.lastCommand;
    }

    return this.getBackgroundState(id).command;
  }

  killBackgroundCommand(id: string): boolean {
    const state = this.getBackgroundState(id);

    if (!state.completed && state.childProc) {
      state.childProc.kill('SIGTERM');
      return true;
    }

    return false;
  }

  async readBackgroundOutput(input: ReadBackgroundOutputInput): Promise<{
    exitCode: null | number;
    isRunning: boolean;
    output: string;
    terminationSignal: NodeJS.Signals | null;
  }> {
    const state = this.getBackgroundState(input.id);
    const fullOutput = await this.getBackgroundOutput(input.id, state);
    const boundedCursor = Math.max(0, Math.min(state.lastReadCursor, fullOutput.length));

    const shouldReturnFullOutput = input.full_output === true
      || (state.completed && state.readsSinceCompletion === 1);

    const sourceOutput = shouldReturnFullOutput
      ? fullOutput
      : fullOutput.slice(boundedCursor);

    const output = getFilteredOutput(input, sourceOutput);

    state.lastReadCursor = fullOutput.length;

    if (state.completed) {
      state.readsSinceCompletion += 1;
    }

    return {
      exitCode: state.completed ? state.exitCode : null,
      isRunning: !state.completed,
      output,
      terminationSignal: state.completed ? state.signal : null,
    };
  }

  async runForegroundCommand(input: RunForegroundCommandInput): Promise<RunCommandResult> {
    this.lastCommand = input.command;

    const cwd = this.sharedForegroundCwd ?? this.options.getInitialForegroundCwd();
    const shellInvocation = this.createForegroundInvocation(input.command);

    const childProc = childProcess.spawn(
      shellInvocation.shell,
      [ ...shellInvocation.shellArgs, shellInvocation.command ],
      {
        cwd,
        env: this.buildShellEnv(),
      },
    );

    let output = '';
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    childProc.stdout.on('data', (data: unknown) => {
      const chunk = String(data);
      output = this.appendOutput(output, chunk);
    });

    childProc.stderr.on('data', (data: unknown) => {
      const chunk = String(data);
      output = this.appendOutput(output, chunk);
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

    const parsedOutput = this.parseOutputAndPwd(output);

    if (parsedOutput.resolvedCwd) {
      this.sharedForegroundCwd = parsedOutput.resolvedCwd;
    }

    return {
      exitCode: closeResult.code,
      output: parsedOutput.outputWithoutMarker,
      terminationSignal: closeResult.signal,
      timedOut,
    };
  }

  startBackgroundCommand(command: string): string {
    this.lastCommand = command;

    const shellInvocation = this.createShellInvocation(command);
    const id = `custom-terminal-${++this.backgroundIdCounter}`;
    const childProc = childProcess.spawn(
      shellInvocation.shell,
      [ ...shellInvocation.shellArgs, shellInvocation.command ],
      {
        cwd: this.options.getBackgroundCwd(),
        env: this.buildShellEnv(),
      },
    );

    const state: BackgroundProcessState = {
      childProc,
      cleanupTimer: undefined,
      command,
      completed: false,
      completion: Promise.resolve(),
      exitCode: null,
      lastReadCursor: 0,
      memoryToFileTimer: undefined,
      output: '',
      outputInFile: false,
      purgeOnSpill: false,
      readsSinceCompletion: 0,
      resolveCompletion: () => undefined,
      signal: null,
    };

    state.completion = new Promise<void>(resolve => {
      state.resolveCompletion = resolve;
    });

    this.scheduleMemoryToFileSpill(id, state);
    this.backgroundProcesses.set(id, state);

    childProc.stdout.on('data', (data: unknown) => {
      const chunk = String(data);
      this.appendBackgroundOutput(id, state, chunk);
    });

    childProc.stderr.on('data', (data: unknown) => {
      const chunk = String(data);
      this.appendBackgroundOutput(id, state, chunk);
    });

    childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
      state.completed = true;
      state.exitCode = code;
      state.readsSinceCompletion = 0;
      state.signal = signal;

      if (signal) {
        this.handleSignalTermination(id, state, signal);
      }

      state.resolveCompletion();
      this.scheduleBackgroundStateCleanup(id, state);
    });

    childProc.on('error', (error: Error) => {
      state.completed = true;
      this.appendBackgroundOutput(id, state, `\n${String(error)}\n`);
      state.readsSinceCompletion = 0;
      state.resolveCompletion();
      this.scheduleBackgroundStateCleanup(id, state);
    });

    return id;
  }

  private appendBackgroundOutput(id: string, state: BackgroundProcessState, chunk: string): void {
    if (state.outputInFile) {
      appendTerminalOutput(id, chunk);
      return;
    }

    state.output = this.appendOutput(state.output, chunk);
  }

  private appendOutput(current: string, chunk: string): string {
    const next = `${current}${chunk}`;
    const outputLimit = this.options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;

    if (next.length <= outputLimit) {
      return next;
    }

    return next.slice(-outputLimit);
  }

  private buildShellEnv(): NodeJS.ProcessEnv {
    const source = this.options.shellEnv ?? globalThis.process.env;

    return {
      ...source,
      TERM: source.TERM ?? 'xterm-256color',
    };
  }

  private createForegroundInvocation(command: string): ShellInvocation {
    if (os.platform() === 'win32') {
      return this.createShellInvocation(`${command}\r\necho ${this.options.pwdMarker}%CD%`);
    }

    return this.createShellInvocation(`${command}\nprintf "\\n${this.options.pwdMarker}%s\\n" "$PWD"`);
  }

  private createShellInvocation(command: string): ShellInvocation {
    if (os.platform() === 'win32') {
      return {
        command,
        shell: globalThis.process.env.ComSpec ?? 'cmd.exe',
        shellArgs: [ '/d', '/s', '/c' ],
      };
    }

    return {
      command,
      shell: globalThis.process.env.SHELL ?? '/bin/bash',
      shellArgs: [ '-lc' ],
    };
  }

  private async getBackgroundOutput(id: string, state: BackgroundProcessState): Promise<string> {
    if (state.outputInFile) {
      return readTerminalOutput(id);
    }

    return state.output;
  }

  private getBackgroundState(id: string): BackgroundProcessState {
    const state = this.backgroundProcesses.get(id);

    if (!state) {
      throw new Error(`Unknown terminal id: ${id}`);
    }

    return state;
  }

  private handleSignalTermination(id: string, state: BackgroundProcessState, signal: NodeJS.Signals): void {
    if (signal === 'SIGINT') {
      return;
    }

    if (state.outputInFile) {
      this.purgeBackgroundOutput(id, state);
      return;
    }

    if (!state.memoryToFileTimer) {
      state.output = '';
      return;
    }

    state.purgeOnSpill = true;
  }

  private parseOutputAndPwd(output: string): {
    outputWithoutMarker: string;
    resolvedCwd: string | undefined;
  } {
    const markerIndex = output.lastIndexOf(this.options.pwdMarker);

    if (markerIndex === -1) {
      return {
        outputWithoutMarker: output,
        resolvedCwd: undefined,
      };
    }

    const before = output.slice(0, markerIndex);
    const after = output.slice(markerIndex + this.options.pwdMarker.length);
    const lineBreakIndex = after.indexOf('\n');
    const cwdValue = lineBreakIndex === -1 ? after : after.slice(0, lineBreakIndex);
    const rest = lineBreakIndex === -1 ? '' : after.slice(lineBreakIndex + 1);

    return {
      outputWithoutMarker: `${before}${rest}`,
      resolvedCwd: cwdValue.trim() || undefined,
    };
  }

  private purgeBackgroundOutput(id: string, state: BackgroundProcessState): void {
    state.output = '';
    state.outputInFile = false;
    removeTerminalOutputFile(id);

    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
      state.memoryToFileTimer = undefined;
    }
  }

  private scheduleBackgroundStateCleanup(id: string, state: BackgroundProcessState): void {
    const delay = this.options.stateCleanupDelayMs ?? DEFAULT_STATE_CLEANUP_DELAY_MS;

    state.cleanupTimer = setTimeout(() => {
      if (state.outputInFile) {
        removeTerminalOutputFile(id);
      }

      this.backgroundProcesses.delete(id);
    }, delay);
  }

  private scheduleMemoryToFileSpill(id: string, state: BackgroundProcessState): void {
    const delay = this.options.memoryToFileDelayMs ?? DEFAULT_MEMORY_TO_FILE_DELAY_MS;

    state.memoryToFileTimer = setTimeout(() => {
      state.memoryToFileTimer = undefined;

      if (state.purgeOnSpill) {
        state.output = '';
        state.outputInFile = false;
        return;
      }

      overwriteTerminalOutput(id, state.output);
      state.output = '';
      state.outputInFile = true;
    }, delay);
  }
}
