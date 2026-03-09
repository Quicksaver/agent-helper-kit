import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getFilteredOutput,
  type ShellOutputFilterInput,
} from '@/shellOutputFilter';
import {
  appendShellOutput,
  initializeShellOutputStore,
  listShellOutputIds,
  overwriteShellOutput,
  readShellCommandMetadata,
  readShellOutput,
  removeShellCommandMetadata,
  removeShellOutputFile,
  writeShellCommandMetadata,
} from '@/shellOutputStore';

const DEFAULT_OUTPUT_LIMIT_BYTES = 512 * 1024;
const DEFAULT_MEMORY_TO_FILE_DELAY_MS = 2 * 60 * 1000;
const READS_SINCE_COMPLETION_FOR_SYNC_RECORD = 1;
export const SHELL_COMMAND_ID_PREFIX = 'shell-';
const SHELL_ID_HEX_LENGTH = 8;
const SHELL_ID_GENERATION_MAX_ATTEMPTS = 8;

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
  shell: string;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

export interface ShellCommandListItem {
  command: string;
  completedAt: null | string;
  exitCode: null | number;
  id: string;
  isRunning: boolean;
  killedByUser: boolean;
  shell: string;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

export interface ShellCommandDetails extends ShellCommandListItem {
  output: string;
}

export interface RunCommandResult {
  exitCode: null | number;
  output: string;
  shell: string;
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

export interface ReadBackgroundOutputInput extends ShellOutputFilterInput {
  full_output?: boolean;
  id: string;
}

interface ShellRuntimeOptions {
  memoryToFileDelayMs?: number;
  outputLimitBytes?: number;
  shellEnv?: NodeJS.ProcessEnv;
  startupPurgeMaxAgeMs?: number;
}

export class ShellRuntime {
  private readonly backgroundProcesses = new Map<string, BackgroundProcessState>();
  private readonly commandChangeListeners = new Set<() => void>();
  private lastCommand: string | undefined;

  constructor(private readonly options: ShellRuntimeOptions) {
    initializeShellOutputStore(this.options.startupPurgeMaxAgeMs);
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
      shell: state.shell,
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

  createCompletedCommandRecord(command: string, result: RunCommandResult, shell?: string): string {
    const id = this.createUniqueShellId();
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
      shell: this.resolveShellExecutable(shell ?? result.shell),
      signal: result.terminationSignal,
      startedAt,
    };

    if (this.shouldSpillToFile(state.output)) {
      this.spillOutputToFile(id, state, state.output);
    }

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

  async getCommandDetails(id: string): Promise<ShellCommandDetails> {
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

  listCommands(): ShellCommandListItem[] {
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
    shell: string;
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
      shell: state.shell,
      terminationSignal: state.completed ? state.signal : null,
    };
  }

  startBackgroundCommand(command: string, shell?: string, cwd?: string): string {
    this.lastCommand = command;

    const shellInvocation = this.createShellInvocation(command, shell);
    const id = this.createUniqueShellId();
    const commandCwd = typeof cwd === 'string' && cwd.trim().length > 0
      ? cwd
      : os.homedir();
    const childProc = childProcess.spawn(
      shellInvocation.shell,
      [ ...shellInvocation.shellArgs, shellInvocation.command ],
      {
        cwd: commandCwd,
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
      shell: shellInvocation.shell,
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
      appendShellOutput(id, chunk);
      return;
    }

    const nextOutput = `${state.output}${chunk}`;

    if (this.shouldSpillToFile(nextOutput)) {
      this.spillOutputToFile(id, state, nextOutput);
      return;
    }

    state.output = nextOutput;
  }

  private buildShellEnv(): NodeJS.ProcessEnv {
    const source = this.options.shellEnv ?? globalThis.process.env;

    return {
      COLORTERM: source.COLORTERM ?? 'truecolor',
      TERM: source.TERM ?? 'xterm-256color',
      ...source,
    };
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

  private createUniqueShellId(): string {
    for (let attempt = 0; attempt < SHELL_ID_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      const candidate = `${SHELL_COMMAND_ID_PREFIX}${randomBytes(SHELL_ID_HEX_LENGTH / 2).toString('hex')}`;

      if (!this.backgroundProcesses.has(candidate)) {
        return candidate;
      }
    }

    // Extremely rare collision scenario: if repeated clashes exhaust all attempts,
    // fall back to UUID entropy to keep ID generation practically collision-free.
    return `${SHELL_COMMAND_ID_PREFIX}${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, SHELL_ID_HEX_LENGTH)}`;
  }

  private emitCommandChange(): void {
    for (const listener of this.commandChangeListeners) {
      listener();
    }
  }

  private async getBackgroundOutput(id: string, state: BackgroundProcessState): Promise<string> {
    if (state.outputInFile) {
      return readShellOutput(id);
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

  private getOutputLimitBytes(): number {
    const outputLimit = this.options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;

    if (!Number.isFinite(outputLimit) || outputLimit < 0) {
      return 0;
    }

    return Math.floor(outputLimit);
  }

  private getShellCommandName(shell: string): string {
    return path.basename(shell).toLowerCase().replace(/\.(bat|cmd|exe)$/u, '');
  }

  private hydrateFromPersistedOutput(): void {
    const outputIds = listShellOutputIds();

    for (const id of outputIds) {
      if (this.backgroundProcesses.has(id)) {
        continue;
      }

      const metadata = readShellCommandMetadata(id);
      const hydratedShell = typeof metadata?.shell === 'string' && metadata.shell.length > 0
        ? metadata.shell
        : this.resolveShellExecutable();
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
        shell: hydratedShell,
        signal: metadata?.signal ?? null,
        startedAt: metadata?.startedAt ?? new Date().toISOString(),
      };

      this.backgroundProcesses.set(id, state);
    }
  }

  private persistCommandMetadata(id: string, state: BackgroundProcessState): void {
    writeShellCommandMetadata({
      command: state.command,
      completedAt: state.completedAt,
      exitCode: state.exitCode,
      id,
      killedByUser: state.killedByUser,
      shell: state.shell,
      signal: state.signal,
      startedAt: state.startedAt,
    });
  }

  private purgeBackgroundOutput(id: string, state: BackgroundProcessState): void {
    state.output = '';
    state.outputInFile = false;
    removeShellOutputFile(id);

    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
      state.memoryToFileTimer = undefined;
    }
  }

  private purgeCommandArtifacts(id: string, state: BackgroundProcessState): void {
    if (state.outputInFile) {
      removeShellOutputFile(id);
    }

    removeShellCommandMetadata(id);

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
      this.spillOutputToFile(id, state, state.output);
      this.emitCommandChange();
    }, delay);
  }

  private shouldSpillToFile(output: string): boolean {
    const outputLimitBytes = this.getOutputLimitBytes();

    if (outputLimitBytes === 0) {
      return false;
    }

    return Buffer.byteLength(output, 'utf8') >= outputLimitBytes;
  }

  private spillOutputToFile(id: string, state: BackgroundProcessState, output: string): void {
    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
      state.memoryToFileTimer = undefined;
    }

    overwriteShellOutput(id, output);
    state.output = '';
    state.outputInFile = true;
  }

  private toCommandListItem(id: string, state: BackgroundProcessState): ShellCommandListItem {
    return {
      command: state.command,
      completedAt: state.completedAt,
      exitCode: state.exitCode,
      id,
      isRunning: !state.completed,
      killedByUser: state.killedByUser,
      shell: state.shell,
      signal: state.signal,
      startedAt: state.startedAt,
    };
  }
}
