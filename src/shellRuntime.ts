import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { logWarn } from '@/logging';
import {
  DEFAULT_SHELL_COLUMNS,
  normalizeShellColumns,
} from '@/shellColumns';
import {
  getFilteredOutput,
  normalizeShellOutput,
  type ShellOutputFilterInput,
} from '@/shellOutputFilter';
import {
  appendShellOutput,
  initializeShellOutputStore,
  overwriteShellOutput,
  readShellOutput,
  readShellOutputSync,
  removeShellCommandMetadata,
  removeShellOutputFile,
  writeShellCommandMetadata,
} from '@/shellOutputStore';
import { HIDDEN_SHELL_INPUT_LOG_PLACEHOLDER } from '@/shellToolContracts';

const DEFAULT_OUTPUT_LIMIT_BYTES = 512 * 1024;
const DEFAULT_MEMORY_TO_FILE_DELAY_MS = 2 * 60 * 1000;
const EXIT_OUTPUT_DRAIN_GRACE_MS = 25;
const READS_SINCE_COMPLETION_FOR_SYNC_RECORD = 1;
export const SHELL_COMMAND_ID_PREFIX = 'shell-';
const SHELL_ID_HEX_LENGTH = 8;
const SHELL_ID_GENERATION_MAX_ATTEMPTS = 8;
const MAX_MEMORY_TO_FILE_RETRY_ATTEMPTS = 3;
const DEFAULT_SHELL_ROWS = 80;
const NODE_TERMINAL_SIZE_SHIM_PATH = path.resolve(__dirname, '..', 'resources', 'node-terminal-width-shim.cjs');
const NON_INTERACTIVE_GIT_EDITOR = ':';
const NON_INTERACTIVE_GIT_MERGE_AUTOEDIT = 'no';
const NON_INTERACTIVE_GIT_PAGER = 'cat';
const NON_INTERACTIVE_GIT_TERMINAL_PROMPT = '0';
const SHELL_INPUT_LOG_PREFIX = '[send_to_shell] ';
const SHELL_INPUT_ENTER_PLACEHOLDER = '[Enter]';
let hasNodeTerminalSizeShimFile: boolean | undefined;

interface CompletionInfo {
  exitCode: null | number;
  signal: NodeJS.Signals | null;
}

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
  completionTimer: NodeJS.Timeout | undefined;
  cwd: string;
  exitCode: null | number;
  killedByUser: boolean;
  lastReadCursor: number;
  memoryToFileRetryCount: number;
  memoryToFileTimer: NodeJS.Timeout | undefined;
  output: string;
  outputBytes: number;
  outputInFile: boolean;
  pendingExit: CompletionInfo | undefined;
  readsSinceCompletion: number;
  resolveCompletion: () => void;
  shell: string;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

export interface ShellCommandListItem {
  command: string;
  completedAt: null | string;
  cwd: string;
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

export interface StartBackgroundCommandOptions {
  columns?: number;
  cwd?: string;
  shell?: string;
}

function getNodeTerminalSizeShimPathExists(): boolean {
  if (hasNodeTerminalSizeShimFile === undefined) {
    hasNodeTerminalSizeShimFile = fs.existsSync(NODE_TERMINAL_SIZE_SHIM_PATH);
  }

  return hasNodeTerminalSizeShimFile;
}

/**
 * Parse NODE_OPTIONS into argv-style tokens so we can detect whether the width
 * shim is already required without relying on brittle substring checks.
 */
function parseNodeOptionsArguments(nodeOptions: string): string[] {
  const args: string[] = [];
  let current = '';
  let activeQuote: '"' | '\'' | undefined;
  let escaping = false;

  for (const character of nodeOptions) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (activeQuote) {
      if (character === activeQuote) {
        activeQuote = undefined;
      }
      else {
        current += character;
      }

      continue;
    }

    if (character === '"' || character === '\'') {
      activeQuote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }

      continue;
    }

    current += character;
  }

  if (escaping) {
    current += '\\';
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function hasNodeRequireOption(nodeOptions: string | undefined, requiredPath: string): boolean {
  if (typeof nodeOptions !== 'string' || nodeOptions.trim().length === 0) {
    return false;
  }

  const args = parseNodeOptionsArguments(nodeOptions);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--require' || arg === '-r') {
      if (args[index + 1] === requiredPath) {
        return true;
      }

      index += 1;
      continue;
    }

    if (arg.startsWith('--require=')) {
      return arg.slice('--require='.length) === requiredPath;
    }
  }

  return false;
}

export interface AwaitBackgroundInput {
  id: string;
  timeout: number;
}

export interface ReadBackgroundOutputInput extends ShellOutputFilterInput {
  full_output?: boolean;
  id: string;
}

export interface SendInputToBackgroundInput {
  command: string;
  id: string;
  secret?: boolean;
}

interface ShellRuntimeOptions {
  memoryToFileDelayMs?: number;
  outputLimitBytes?: number;
  shellEnv?: NodeJS.ProcessEnv;
  startupPurgeMaxAgeMs?: number;
}

function normalizeShellInputForWrite(command: string): string {
  if (command.trim().length === 0) {
    return '\n';
  }

  return `${command}\n`;
}

function formatShellInputLogEntry(command: string, secret?: boolean): string {
  if (command.trim().length === 0) {
    return `${SHELL_INPUT_LOG_PREFIX}${SHELL_INPUT_ENTER_PLACEHOLDER}\n`;
  }

  if (secret) {
    return `${SHELL_INPUT_LOG_PREFIX}${HIDDEN_SHELL_INPUT_LOG_PLACEHOLDER}\n`;
  }

  return `${SHELL_INPUT_LOG_PREFIX}${command}\n`;
}

/**
 * Manage shell command execution and history for both LM tools and the Shell
 * Runs panel. Output stays in memory until size or time thresholds push it to
 * the file-backed store, but reads always normalize from the same boundary.
 */
export class ShellRuntime {
  private readonly backgroundProcesses = new Map<string, BackgroundProcessState>();
  private readonly commandChangeListeners = new Set<() => void>();
  private lastCommand: string | undefined;

  constructor(private readonly options: ShellRuntimeOptions) {
    initializeShellOutputStore(this.options.startupPurgeMaxAgeMs);
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

  createCompletedCommandRecord(command: string, result: RunCommandResult, shell?: string, cwd?: string): string {
    const id = this.createUniqueShellId();
    const startedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    const outputBytes = Buffer.byteLength(result.output, 'utf8');
    const commandCwd = typeof cwd === 'string' && cwd.trim().length > 0
      ? cwd
      : os.homedir();

    const state: BackgroundProcessState = {
      command,
      completed: true,
      completedAt,
      completion: Promise.resolve(),
      completionTimer: undefined,
      cwd: commandCwd,
      exitCode: result.exitCode,
      killedByUser: false,
      lastReadCursor: 0,
      memoryToFileRetryCount: 0,
      memoryToFileTimer: undefined,
      output: result.output,
      outputBytes,
      outputInFile: false,
      pendingExit: undefined,
      readsSinceCompletion: READS_SINCE_COMPLETION_FOR_SYNC_RECORD,
      resolveCompletion: () => undefined,
      shell: this.resolveShellExecutable(shell ?? result.shell),
      signal: result.terminationSignal,
      startedAt,
    };

    if (this.shouldSpillToFile(outputBytes)) {
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
      const killed = state.childProc.kill('SIGTERM');

      if (!killed) {
        const childExitCode = state.childProc.exitCode;
        const childSignal = state.childProc.signalCode;

        if (childExitCode !== null || childSignal !== null) {
          this.recordExit(id, state, childExitCode, childSignal);
        }

        return false;
      }

      state.killedByUser = true;
      this.persistCommandMetadata(resolvedId, state);
      this.emitCommandChange();
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

  /**
   * Read command output using incremental cursors for streaming callers while
   * still returning a full final read once after completion for sync records.
   */
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

  async sendInputToBackgroundCommand(input: SendInputToBackgroundInput): Promise<{
    isRunning: boolean;
    reason?: string;
    sent: boolean;
    shell: string;
  }> {
    let resolvedId: string;
    let state: BackgroundProcessState;

    try {
      ({ resolvedId, state } = this.getBackgroundState(input.id));
    }
    catch {
      return {
        isRunning: false,
        reason: 'shell command was not found',
        sent: false,
        shell: this.resolveShellExecutable(),
      };
    }

    if (state.completed || !state.childProc) {
      return {
        isRunning: false,
        reason: 'shell command is no longer running',
        sent: false,
        shell: state.shell,
      };
    }

    const { stdin } = state.childProc;

    if (stdin.destroyed || !stdin.writable || stdin.writableEnded) {
      return {
        isRunning: !state.completed,
        reason: 'shell stdin is not writable',
        sent: false,
        shell: state.shell,
      };
    }

    const commandText = normalizeShellInputForWrite(input.command);
    const logEntry = formatShellInputLogEntry(input.command, input.secret);

    this.appendBackgroundOutput(resolvedId, state, logEntry);

    const sent = await new Promise<boolean>(resolve => {
      let settled = false;
      let onError!: () => void;

      function settle(value: boolean): void {
        if (settled) {
          return;
        }

        settled = true;
        stdin.off('error', onError);
        resolve(value);
      }

      onError = (): void => {
        settle(false);
      };

      stdin.once('error', onError);

      try {
        stdin.write(commandText, error => {
          settle(!error);
        });
      }
      catch {
        settle(false);
      }
    });

    if (!sent) {
      this.removeTrailingBackgroundOutput(resolvedId, state, logEntry);

      return {
        isRunning: !state.completed,
        reason: 'shell stdin is not writable',
        sent: false,
        shell: state.shell,
      };
    }

    return {
      isRunning: !state.completed,
      sent: true,
      shell: state.shell,
    };
  }

  startBackgroundCommand(command: string, options: StartBackgroundCommandOptions = {}): string {
    /**
     * Preserve shell-friendly terminal defaults, then append the Node width shim
     * only when it is packaged and not already present in NODE_OPTIONS.
     */
    this.lastCommand = command;

    const shellInvocation = this.createShellInvocation(command, options.shell);
    const id = this.createUniqueShellId();
    const commandCwd = typeof options.cwd === 'string' && options.cwd.trim().length > 0
      ? options.cwd
      : os.homedir();
    const childProc = childProcess.spawn(
      shellInvocation.shell,
      [ ...shellInvocation.shellArgs, shellInvocation.command ],
      {
        cwd: commandCwd,
        env: this.buildShellEnv(options.columns),
      },
    );
    let resolveCompletion!: () => void;
    const completion = new Promise<void>(resolve => {
      resolveCompletion = resolve;
    });

    const state: BackgroundProcessState = {
      childProc,
      command,
      completed: false,
      completedAt: null,
      completion,
      completionTimer: undefined,
      cwd: commandCwd,
      exitCode: null,
      killedByUser: false,
      lastReadCursor: 0,
      memoryToFileRetryCount: 0,
      memoryToFileTimer: undefined,
      output: '',
      outputBytes: 0,
      outputInFile: false,
      pendingExit: undefined,
      readsSinceCompletion: 0,
      resolveCompletion,
      shell: shellInvocation.shell,
      signal: null,
      startedAt: new Date().toISOString(),
    };

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

    childProc.on('exit', (code: null | number, signal: NodeJS.Signals | null) => {
      this.recordExit(id, state, code, signal);
    });

    childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
      this.completeFromClose(id, state, code, signal);
    });

    childProc.on('error', (error: Error) => {
      this.appendBackgroundOutput(id, state, `\n${String(error)}\n`);
      this.completeBackgroundCommand(id, state, null, null);
    });

    return id;
  }

  private appendBackgroundOutput(id: string, state: BackgroundProcessState, chunk: string): void {
    this.bumpPendingCompletion(id, state);

    if (state.outputInFile) {
      if (!appendShellOutput(id, chunk)) {
        const persistedOutput = readShellOutputSync(id);

        if (persistedOutput === undefined) {
          logWarn(`Failed to recover persisted shell output for ${id}; falling back to latest chunk only.`);
        }

        state.output = `${persistedOutput ?? ''}${chunk}`;
        state.outputBytes = Buffer.byteLength(state.output, 'utf8');
        state.outputInFile = false;
        this.scheduleMemoryToFileSpill(id, state);
      }

      return;
    }

    const nextOutput = `${state.output}${chunk}`;
    const nextOutputBytes = state.outputBytes + Buffer.byteLength(chunk, 'utf8');

    if (this.shouldSpillToFile(nextOutputBytes)) {
      this.spillOutputToFile(id, state, nextOutput);
      return;
    }

    state.output = nextOutput;
    state.outputBytes = nextOutputBytes;
  }

  private buildShellEnv(columns?: number): NodeJS.ProcessEnv {
    const source = this.options.shellEnv ?? globalThis.process.env;
    const environment: NodeJS.ProcessEnv = {
      ...source,
    };

    const resolvedColumns = normalizeShellColumns(columns);

    if (resolvedColumns !== undefined) {
      environment.COLUMNS = String(resolvedColumns);
    }
    else if (typeof environment.COLUMNS !== 'string' || environment.COLUMNS.length === 0) {
      environment.COLUMNS = String(DEFAULT_SHELL_COLUMNS);
    }

    if (typeof environment.LINES !== 'string' || environment.LINES.length === 0) {
      environment.LINES = String(DEFAULT_SHELL_ROWS);
    }

    if (typeof environment.TERM !== 'string' || environment.TERM.length === 0) {
      environment.TERM = 'xterm-256color';
    }

    if (typeof environment.COLORTERM !== 'string' || environment.COLORTERM.length === 0) {
      environment.COLORTERM = 'truecolor';
    }

    if (typeof environment.CLICOLOR !== 'string' || environment.CLICOLOR.length === 0) {
      environment.CLICOLOR = '1';
    }

    // Keep git-based tool runs deterministic by disabling pagers, editor prompts, and terminal credential prompts.
    environment.GIT_EDITOR = NON_INTERACTIVE_GIT_EDITOR;
    environment.GIT_MERGE_AUTOEDIT = NON_INTERACTIVE_GIT_MERGE_AUTOEDIT;
    environment.GIT_PAGER = NON_INTERACTIVE_GIT_PAGER;
    environment.GIT_TERMINAL_PROMPT = NON_INTERACTIVE_GIT_TERMINAL_PROMPT;

    if (typeof environment.NO_COLOR === 'string' && environment.NO_COLOR.length > 0) {
      delete environment.CLICOLOR_FORCE;
      delete environment.FORCE_COLOR;
    }
    else {
      if (typeof environment.CLICOLOR_FORCE !== 'string' || environment.CLICOLOR_FORCE.length === 0) {
        environment.CLICOLOR_FORCE = '1';
      }

      if (typeof environment.FORCE_COLOR !== 'string' || environment.FORCE_COLOR.length === 0) {
        environment.FORCE_COLOR = '3';
      }
    }

    if (getNodeTerminalSizeShimPathExists()) {
      const shimOption = `--require ${JSON.stringify(NODE_TERMINAL_SIZE_SHIM_PATH)}`;
      const existingNodeOptions = environment.NODE_OPTIONS?.trim();

      if (!hasNodeRequireOption(existingNodeOptions, NODE_TERMINAL_SIZE_SHIM_PATH)) {
        environment.NODE_OPTIONS = existingNodeOptions
          ? `${existingNodeOptions} ${shimOption}`
          : shimOption;
      }
    }

    return environment;
  }

  private bumpPendingCompletion(id: string, state: BackgroundProcessState): void {
    if (state.completed || !state.pendingExit) {
      return;
    }

    this.schedulePendingExitCompletion(id, state);
  }

  private completeBackgroundCommand(
    id: string,
    state: BackgroundProcessState,
    exitCode: null | number,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.completed) {
      return;
    }

    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }

    state.childProc = undefined;
    state.completed = true;
    state.completedAt = new Date().toISOString();
    state.exitCode = exitCode;
    state.pendingExit = undefined;
    state.readsSinceCompletion = 0;
    state.signal = signal;

    state.resolveCompletion();
    this.persistCommandMetadata(id, state);
    this.emitCommandChange();
  }

  private completeFromClose(
    id: string,
    state: BackgroundProcessState,
    exitCode: null | number,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.completed) {
      return;
    }

    const completion = state.pendingExit ?? {
      exitCode,
      signal,
    };

    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = undefined;
    }

    this.completeBackgroundCommand(id, state, completion.exitCode, completion.signal);
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

  /**
   * Normalize output at read time rather than append time so persisted output,
   * incremental reads, and panel rendering all apply the same filtering rules.
   */
  private async getBackgroundOutput(id: string, state: BackgroundProcessState): Promise<string> {
    if (state.outputInFile) {
      return normalizeShellOutput(await readShellOutput(id));
    }

    return normalizeShellOutput(state.output);
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

    if (outputLimit === 0) {
      return 0;
    }

    if (!Number.isFinite(outputLimit) || outputLimit < 0) {
      return DEFAULT_OUTPUT_LIMIT_BYTES;
    }

    return Math.floor(outputLimit);
  }

  private getShellCommandName(shell: string): string {
    return path.basename(shell).toLowerCase().replace(/\.(bat|cmd|exe)$/u, '');
  }

  private persistCommandMetadata(id: string, state: BackgroundProcessState): void {
    writeShellCommandMetadata({
      command: state.command,
      completedAt: state.completedAt,
      cwd: state.cwd,
      exitCode: state.exitCode,
      id,
      killedByUser: state.killedByUser,
      shell: state.shell,
      signal: state.signal,
      startedAt: state.startedAt,
    });
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

  /**
   * Treat process exit as the authoritative status, but delay completion until
   * close or a short drain timer so trailing piped output is not dropped.
   */
  private recordExit(
    id: string,
    state: BackgroundProcessState,
    exitCode: null | number,
    signal: NodeJS.Signals | null,
  ): void {
    if (state.completed) {
      return;
    }

    state.pendingExit = {
      exitCode,
      signal,
    };
    this.schedulePendingExitCompletion(id, state);
  }

  private removeTrailingBackgroundOutput(id: string, state: BackgroundProcessState, chunk: string): boolean {
    if (chunk.length === 0) {
      return true;
    }

    if (state.outputInFile) {
      const persistedOutput = readShellOutputSync(id);

      if (!persistedOutput?.endsWith(chunk)) {
        return false;
      }

      const trimmedOutput = persistedOutput.slice(0, -chunk.length);

      if (overwriteShellOutput(id, trimmedOutput)) {
        state.outputBytes = Buffer.byteLength(trimmedOutput, 'utf8');
        return true;
      }

      state.output = trimmedOutput;
      state.outputBytes = Buffer.byteLength(trimmedOutput, 'utf8');
      state.outputInFile = false;
      this.scheduleMemoryToFileSpill(id, state);
      return true;
    }

    if (!state.output.endsWith(chunk)) {
      return false;
    }

    state.output = state.output.slice(0, -chunk.length);
    state.outputBytes = Buffer.byteLength(state.output, 'utf8');
    return true;
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
    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
    }

    const delay = this.options.memoryToFileDelayMs ?? DEFAULT_MEMORY_TO_FILE_DELAY_MS;

    state.memoryToFileTimer = setTimeout(() => {
      this.spillOutputToFile(id, state, state.output);
      this.emitCommandChange();
    }, delay);
  }

  private schedulePendingExitCompletion(id: string, state: BackgroundProcessState): void {
    if (state.completed || !state.pendingExit) {
      return;
    }

    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
    }

    state.completionTimer = setTimeout(() => {
      state.completionTimer = undefined;

      if (state.completed || !state.pendingExit) {
        return;
      }

      this.completeBackgroundCommand(id, state, state.pendingExit.exitCode, state.pendingExit.signal);
    }, EXIT_OUTPUT_DRAIN_GRACE_MS);
  }

  private shouldSpillToFile(outputBytes: number): boolean {
    const outputLimitBytes = this.getOutputLimitBytes();

    if (outputLimitBytes === 0) {
      return false;
    }

    return outputBytes >= outputLimitBytes;
  }

  /**
   * Move buffered output into the file-backed store. The state only flips to
   * file-backed after a successful write, and failed writes retry a few times
   * before falling back to in-memory retention.
   */
  private spillOutputToFile(id: string, state: BackgroundProcessState, output: string): void {
    if (state.memoryToFileTimer) {
      clearTimeout(state.memoryToFileTimer);
      state.memoryToFileTimer = undefined;
    }

    if (!overwriteShellOutput(id, output)) {
      if (!state.completed) {
        state.memoryToFileRetryCount += 1;

        if (state.memoryToFileRetryCount >= MAX_MEMORY_TO_FILE_RETRY_ATTEMPTS) {
          logWarn(`Stopped retrying shell output spill for ${id} after repeated write failures.`);
          return;
        }

        this.scheduleMemoryToFileSpill(id, state);
      }

      return;
    }

    state.memoryToFileRetryCount = 0;
    state.output = '';
    state.outputBytes = 0;
    state.outputInFile = true;
  }

  private toCommandListItem(id: string, state: BackgroundProcessState): ShellCommandListItem {
    return {
      command: state.command,
      completedAt: state.completedAt,
      cwd: state.cwd,
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
