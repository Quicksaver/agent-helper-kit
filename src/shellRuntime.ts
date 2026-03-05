import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getFilteredOutput,
  type TerminalOutputFilterInput,
} from '@/shellOutputFilter';
import {
  appendTerminalOutput,
  initializeTerminalOutputStore,
  listTerminalOutputIds,
  overwriteTerminalOutput,
  readTerminalCommandMetadata,
  readTerminalOutput,
  removeTerminalCommandMetadata,
  removeTerminalOutputFile,
  writeTerminalCommandMetadata,
} from '@/shellOutputStore';

const DEFAULT_OUTPUT_LIMIT = 60 * 1024;
const DEFAULT_MEMORY_TO_FILE_DELAY_MS = 2 * 60 * 1000;
const READS_SINCE_COMPLETION_FOR_SYNC_RECORD = 1;
export const SHELL_COMMAND_ID_PREFIX = 'custom-shell-';
const TERMINAL_ID_HEX_LENGTH = 8;
const TERMINAL_ID_GENERATION_MAX_ATTEMPTS = 8;

export function toPublicCommandId(id: string): string {
  if (id.startsWith(SHELL_COMMAND_ID_PREFIX)) {
    return id.slice(SHELL_COMMAND_ID_PREFIX.length);
  }

  return id;
}

interface BackgroundProcessState {
  childProc?: childProcess.ChildProcessWithoutNullStreams;
  command: string;
  completed: boolean;
  completedAt: null | string;
  completion: Promise<void>;
  exitCode: null | number;
  killedByUser: boolean;
  lastReadCursor: number;
  memoryToFileTimer: NodeJS.Timeout | undefined;
  output: string;
  outputInFile: boolean;
  readsSinceCompletion: number;
  resolveCompletion: () => void;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

export interface TerminalCommandListItem {
  command: string;
  completedAt: null | string;
  exitCode: null | number;
  id: string;
  isRunning: boolean;
  killedByUser: boolean;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

export interface TerminalCommandDetails extends TerminalCommandListItem {
  output: string;
}

export interface RunForegroundCommandInput {
  command: string;
  shell?: string;
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
  shellEnv?: NodeJS.ProcessEnv;
  startupPurgeMaxAgeMs?: number;
}

export class TerminalRuntime {
  private readonly backgroundProcesses = new Map<string, BackgroundProcessState>();
  private readonly commandChangeListeners = new Set<() => void>();
  private lastCommand: string | undefined;

  constructor(private readonly options: TerminalRuntimeOptions) {
    initializeTerminalOutputStore(this.options.startupPurgeMaxAgeMs);
    this.hydrateFromPersistedOutput();
  }

  async awaitBackgroundCommand(input: AwaitBackgroundInput): Promise<RunCommandResult> {
    const {
      resolvedId,
      state,
    } = this.getBackgroundState(input.id);

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
      output: await this.getBackgroundOutput(resolvedId, state),
      terminationSignal: state.completed ? state.signal : null,
      timedOut,
    };
  }

  clearCompletedCommands(): number {
    let removedCount = 0;

    for (const [ id, state ] of this.backgroundProcesses.entries()) {
      if (!state.completed) {
        continue;
      }

      this.backgroundProcesses.delete(id);
      this.purgeCommandArtifacts(id, state);
      removedCount += 1;
    }

    if (removedCount > 0) {
      this.emitCommandChange();
    }

    return removedCount;
  }

  createCompletedCommandRecord(command: string, result: RunCommandResult): string {
    const id = this.createUniqueTerminalId();
    const startedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();

    const state: BackgroundProcessState = {
      command,
      completed: true,
      completedAt,
      completion: Promise.resolve(),
      exitCode: result.exitCode,
      killedByUser: false,
      lastReadCursor: 0,
      memoryToFileTimer: undefined,
      output: result.output,
      outputInFile: false,
      readsSinceCompletion: READS_SINCE_COMPLETION_FOR_SYNC_RECORD,
      resolveCompletion: () => undefined,
      signal: result.terminationSignal,
      startedAt,
    };

    this.backgroundProcesses.set(id, state);
    this.persistCommandMetadata(id, state);
    this.emitCommandChange();

    return id;
  }

  deleteCompletedCommand(id: string): boolean {
    const state = this.backgroundProcesses.get(id);

    if (!state?.completed) {
      return false;
    }

    this.backgroundProcesses.delete(id);
    this.purgeCommandArtifacts(id, state);
    this.emitCommandChange();

    return true;
  }

  async getCommandDetails(id: string): Promise<TerminalCommandDetails> {
    const {
      resolvedId,
      state,
    } = this.getBackgroundState(id);
    const output = await this.getBackgroundOutput(resolvedId, state);

    return {
      ...this.toCommandListItem(resolvedId, state),
      output,
    };
  }

  getLastCommand(id?: string): string | undefined {
    if (!id) {
      return this.lastCommand;
    }

    return this.getBackgroundState(id).state.command;
  }

  killBackgroundCommand(id: string): boolean {
    const {
      resolvedId,
      state,
    } = this.getBackgroundState(id);

    if (!state.completed && state.childProc) {
      state.killedByUser = true;
      this.persistCommandMetadata(resolvedId, state);
      this.emitCommandChange();
      state.childProc.kill('SIGTERM');
      return true;
    }

    return false;
  }

  listCommands(): TerminalCommandListItem[] {
    return [ ...this.backgroundProcesses.entries() ]
      .map(([ id, state ]) => this.toCommandListItem(id, state))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  onDidChangeCommands(listener: () => void): () => void {
    this.commandChangeListeners.add(listener);

    return () => {
      this.commandChangeListeners.delete(listener);
    };
  }

  async readBackgroundOutput(input: ReadBackgroundOutputInput): Promise<{
    exitCode: null | number;
    isRunning: boolean;
    output: string;
    terminationSignal: NodeJS.Signals | null;
  }> {
    const {
      resolvedId,
      state,
    } = this.getBackgroundState(input.id);
    const fullOutput = await this.getBackgroundOutput(resolvedId, state);
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

    const cwd = this.options.getInitialForegroundCwd();
    const shellInvocation = this.createForegroundInvocation(input.command, input.shell);

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

    return {
      exitCode: closeResult.code,
      output,
      terminationSignal: closeResult.signal,
      timedOut,
    };
  }

  startBackgroundCommand(command: string, shell?: string): string {
    this.lastCommand = command;

    const shellInvocation = this.createShellInvocation(command, shell);
    const id = this.createUniqueTerminalId();
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
      command,
      completed: false,
      completedAt: null,
      completion: Promise.resolve(),
      exitCode: null,
      killedByUser: false,
      lastReadCursor: 0,
      memoryToFileTimer: undefined,
      output: '',
      outputInFile: false,
      readsSinceCompletion: 0,
      resolveCompletion: () => undefined,
      signal: null,
      startedAt: new Date().toISOString(),
    };

    state.completion = new Promise<void>(resolve => {
      state.resolveCompletion = resolve;
    });

    this.scheduleMemoryToFileSpill(id, state);
    this.backgroundProcesses.set(id, state);
    this.persistCommandMetadata(id, state);
    this.emitCommandChange();

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
      state.completedAt = new Date().toISOString();
      state.exitCode = code;
      state.readsSinceCompletion = 0;
      state.signal = signal;

      state.resolveCompletion();
      this.persistCommandMetadata(id, state);
      this.emitCommandChange();
    });

    childProc.on('error', (error: Error) => {
      state.completed = true;
      state.completedAt = new Date().toISOString();
      this.appendBackgroundOutput(id, state, `\n${String(error)}\n`);
      state.readsSinceCompletion = 0;
      state.resolveCompletion();
      this.persistCommandMetadata(id, state);
      this.emitCommandChange();
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
      COLORTERM: source.COLORTERM ?? 'truecolor',
      TERM: source.TERM ?? 'xterm-256color',
      ...source,
    };
  }

  private createForegroundInvocation(command: string, shell?: string): ShellInvocation {
    return this.createShellInvocation(command, shell);
  }

  private createPosixShellInvocation(command: string, shell: string): ShellInvocation {
    return {
      command,
      shell,
      shellArgs: [ '-lc' ],
    };
  }

  private createShellInvocation(command: string, preferredShell?: string): ShellInvocation {
    const shell = this.resolveShellExecutable(preferredShell);

    if (os.platform() === 'win32') {
      const shellName = this.getShellCommandName(shell);

      if (shellName === 'powershell' || shellName === 'pwsh') {
        return {
          command,
          shell,
          shellArgs: [ '-NoLogo', '-Command' ],
        };
      }

      return {
        command,
        shell,
        shellArgs: [ '/d', '/s', '/c' ],
      };
    }

    return this.createPosixShellInvocation(command, shell);
  }

  private createUniqueTerminalId(): string {
    for (let attempt = 0; attempt < TERMINAL_ID_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      const candidate = `${SHELL_COMMAND_ID_PREFIX}${randomBytes(TERMINAL_ID_HEX_LENGTH / 2).toString('hex')}`;

      if (!this.backgroundProcesses.has(candidate)) {
        return candidate;
      }
    }

    // Extremely rare collision scenario: if repeated clashes exhaust all attempts,
    // fall back to UUID entropy to keep ID generation practically collision-free.
    return `${SHELL_COMMAND_ID_PREFIX}${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, TERMINAL_ID_HEX_LENGTH)}`;
  }

  private emitCommandChange(): void {
    for (const listener of this.commandChangeListeners) {
      listener();
    }
  }

  private async getBackgroundOutput(id: string, state: BackgroundProcessState): Promise<string> {
    if (state.outputInFile) {
      return readTerminalOutput(id);
    }

    return state.output;
  }

  private getBackgroundState(id: string): {
    resolvedId: string;
    state: BackgroundProcessState;
  } {
    const directMatch = this.backgroundProcesses.get(id);

    if (directMatch) {
      return {
        resolvedId: id,
        state: directMatch,
      };
    }

    const candidates: string[] = [];

    if (!id.startsWith(SHELL_COMMAND_ID_PREFIX)) {
      candidates.push(`${SHELL_COMMAND_ID_PREFIX}${id}`);
    }

    for (const candidate of candidates) {
      const state = this.backgroundProcesses.get(candidate);

      if (state) {
        return {
          resolvedId: candidate,
          state,
        };
      }
    }

    throw new Error(`Unknown shell command id: ${id}`);
  }

  private getShellCommandName(shell: string): string {
    return path.basename(shell).toLowerCase().replace(/\.(bat|cmd|exe)$/u, '');
  }

  private hydrateFromPersistedOutput(): void {
    const outputIds = listTerminalOutputIds();

    for (const id of outputIds) {
      if (this.backgroundProcesses.has(id)) {
        continue;
      }

      const metadata = readTerminalCommandMetadata(id);
      const state: BackgroundProcessState = {
        childProc: undefined,
        command: metadata?.command ?? '(command not recorded)',
        completed: true,
        completedAt: metadata?.completedAt ?? new Date().toISOString(),
        completion: Promise.resolve(),
        exitCode: metadata?.exitCode ?? null,
        killedByUser: metadata?.killedByUser ?? false,
        lastReadCursor: 0,
        memoryToFileTimer: undefined,
        output: '',
        outputInFile: true,
        readsSinceCompletion: READS_SINCE_COMPLETION_FOR_SYNC_RECORD,
        resolveCompletion: () => undefined,
        signal: metadata?.signal ?? null,
        startedAt: metadata?.startedAt ?? new Date().toISOString(),
      };

      this.backgroundProcesses.set(id, state);
    }
  }

  private persistCommandMetadata(id: string, state: BackgroundProcessState): void {
    writeTerminalCommandMetadata({
      command: state.command,
      completedAt: state.completedAt,
      exitCode: state.exitCode,
      id,
      killedByUser: state.killedByUser,
      signal: state.signal,
      startedAt: state.startedAt,
    });
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

  private purgeCommandArtifacts(id: string, state: BackgroundProcessState): void {
    if (state.outputInFile) {
      removeTerminalOutputFile(id);
    }

    removeTerminalCommandMetadata(id);

    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
      state.memoryToFileTimer = undefined;
    }
  }

  private resolveShellExecutable(preferredShell?: string): string {
    if (typeof preferredShell === 'string' && preferredShell.trim().length > 0) {
      return preferredShell.trim();
    }

    if (os.platform() === 'win32') {
      return globalThis.process.env.ComSpec ?? 'cmd.exe';
    }

    return globalThis.process.env.SHELL ?? '/bin/bash';
  }

  private scheduleMemoryToFileSpill(id: string, state: BackgroundProcessState): void {
    const delay = this.options.memoryToFileDelayMs ?? DEFAULT_MEMORY_TO_FILE_DELAY_MS;

    state.memoryToFileTimer = setTimeout(() => {
      state.memoryToFileTimer = undefined;

      overwriteTerminalOutput(id, state.output);
      state.output = '';
      state.outputInFile = true;
      this.emitCommandChange();
    }, delay);
  }

  private toCommandListItem(id: string, state: BackgroundProcessState): TerminalCommandListItem {
    return {
      command: state.command,
      completedAt: state.completedAt,
      exitCode: state.exitCode,
      id,
      isRunning: !state.completed,
      killedByUser: state.killedByUser,
      signal: state.signal,
      startedAt: state.startedAt,
    };
  }
}
