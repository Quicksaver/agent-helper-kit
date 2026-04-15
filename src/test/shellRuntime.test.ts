import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { resetExtensionOutputChannelForTest } from '@/logging';
import { MAX_SHELL_COLUMNS } from '@/shellColumns';
import {
  getShellOutputDirectoryPath,
  getShellOutputFilePath,
  listShellMetadataIds,
  readShellCommandMetadata,
  SHELL_OUTPUT_DIR_ENV_VAR,
} from '@/shellOutputStore';
import {
  ShellRuntime,
  toPublicCommandId,
} from '@/shellRuntime';
import {
  createFakeProcess,
} from '@/test/fakeShellProcess';

const spawn = vi.hoisted(() => vi.fn());
const terminalWidthShimPath = path.resolve(__dirname, '..', '..', 'resources', 'node-terminal-width-shim.cjs');

vi.mock('node:child_process', () => ({
  spawn,
}));

const vscode = vi.hoisted(() => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
    })),
  },
}));

vi.mock('vscode', () => vscode);

const SHELL_ID_REGEX = /^shell-[a-f0-9]{8}$/;
const shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellRuntime-test-'));
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

function removeShellOutputDirectory(): void {
  fs.rmSync(getShellOutputDirectoryPath(), {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 10,
  });
}

afterEach(() => {
  removeShellOutputDirectory();

  if (previousShellOutputDirectory === undefined) {
    Reflect.deleteProperty(process.env, SHELL_OUTPUT_DIR_ENV_VAR);
  }
  else {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = previousShellOutputDirectory;
  }

  vi.restoreAllMocks();
});

beforeEach(() => {
  process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
  vi.clearAllMocks();
  resetExtensionOutputChannelForTest();
});

function getSpawnEnvironment(): NodeJS.ProcessEnv | undefined {
  const spawnOptions = spawn.mock.calls.at(-1)?.[2] as undefined | {
    env?: NodeJS.ProcessEnv;
  };

  return spawnOptions?.env;
}

describe('ShellRuntime helpers', () => {
  it('strips only the public shell id prefix when converting ids', () => {
    expect(toPublicCommandId('shell-abc12345')).toBe('abc12345');
    expect(toPublicCommandId('abc12345')).toBe('abc12345');
  });

  it('uses fallback cwd and shell metadata for completed command records', async () => {
    const runtime = new ShellRuntime({ outputLimitBytes: Number.NaN });

    const id = runtime.createCompletedCommandRecord('echo fallback', {
      exitCode: 0,
      output: 'fallback\n',
      shell: '',
      terminationSignal: null,
      timedOut: false,
    }, '   ', '   ');

    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      cwd: os.homedir(),
      output: 'fallback\n',
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('keeps completed-record completion callbacks callable', async () => {
    const runtime = new ShellRuntime({});

    const id = runtime.createCompletedCommandRecord('echo complete', {
      exitCode: 0,
      output: 'complete\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    const { backgroundProcesses } = runtime as unknown as {
      backgroundProcesses: Map<string, {
        resolveCompletion: () => void;
      }>;
    };
    const state = backgroundProcesses.get(id);

    expect(state).toBeDefined();
    expect(() => state?.resolveCompletion()).not.toThrow();
    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      output: 'complete\n',
    });
  });
});

describe('ShellRuntime session command list', () => {
  it('starts with an empty command list after a new runtime is created', () => {
    const firstRuntime = new ShellRuntime({});

    const persistedId = firstRuntime.createCompletedCommandRecord('echo persisted', {
      exitCode: 0,
      output: 'persisted\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(readShellCommandMetadata(persistedId)?.command).toBe('echo persisted');

    const nextRuntime = new ShellRuntime({});

    expect(nextRuntime.listCommands()).toEqual([]);
  });

  it('clears completed commands, deletes metadata, and notifies listeners', () => {
    const runtime = new ShellRuntime({});
    const listener = vi.fn();
    const dispose = runtime.onDidChangeCommands(listener);

    const firstId = runtime.createCompletedCommandRecord('echo one', {
      exitCode: 0,
      output: 'one\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });
    runtime.createCompletedCommandRecord('echo two', {
      exitCode: 0,
      output: 'two\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(listShellMetadataIds().length).toBeGreaterThanOrEqual(1);
    expect(runtime.clearCompletedCommands()).toBe(2);
    expect(runtime.listCommands()).toEqual([]);
    expect(listShellMetadataIds()).toEqual([]);
    expect(readShellCommandMetadata(firstId)).toBeUndefined();
    expect(listener).toHaveBeenCalled();

    dispose();
    runtime.createCompletedCommandRecord('echo three', {
      exitCode: 0,
      output: 'three\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('deletes a single completed command and rejects unknown ids', () => {
    const runtime = new ShellRuntime({});
    const id = runtime.createCompletedCommandRecord('echo delete', {
      exitCode: 0,
      output: 'delete\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(runtime.deleteCompletedCommand('shell-missing')).toBe(false);
    expect(runtime.deleteCompletedCommand(id)).toBe(true);
    expect(runtime.deleteCompletedCommand(id)).toBe(false);
  });

  it('clears only completed commands and leaves running commands intact', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const runningId = runtime.startBackgroundCommand('echo running');
    const completedId = runtime.createCompletedCommandRecord('echo done', {
      exitCode: 0,
      output: 'done\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(runtime.clearCompletedCommands()).toBe(1);
    expect(runtime.listCommands()).toEqual([
      expect.objectContaining({
        id: runningId,
        isRunning: true,
      }),
    ]);
    expect(runtime.deleteCompletedCommand(completedId)).toBe(false);
  });

  it('treats denied planned commands as terminal records for listing and clearing', () => {
    const runtime = new ShellRuntime({});

    const id = runtime.createPlannedCommandRecord('git checkout main', {
      approval: {
        decision: 'deny',
        reason: 'The shell approval policy denied this command.',
        source: 'rule',
      },
      cwd: '/workspace',
      phase: 'denied',
      request: {
        explanation: 'switch branches',
        goal: 'move to main',
        riskAssessment: 'This may replace files in the working tree.',
      },
      shell: '/bin/bash',
    });

    const deniedCommand = runtime.listCommands()[0];

    expect(deniedCommand).toMatchObject({
      id,
      isRunning: false,
      phase: 'denied',
    });
    expect(deniedCommand.approval).toMatchObject({
      decision: 'deny',
      source: 'rule',
    });
    expect(runtime.clearCompletedCommands()).toBe(1);
    expect(runtime.listCommands()).toEqual([]);
  });
});

describe('ShellRuntime shell id generation', () => {
  it('creates non-sequential 8-char hexadecimal ids', () => {
    const runtime = new ShellRuntime({});

    const firstId = runtime.createCompletedCommandRecord('echo one', {
      exitCode: 0,
      output: 'one\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    const secondId = runtime.createCompletedCommandRecord('echo two', {
      exitCode: 0,
      output: 'two\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(firstId).toMatch(SHELL_ID_REGEX);
    expect(secondId).toMatch(SHELL_ID_REGEX);
    expect(firstId).not.toBe(secondId);
  });

  it('retries when random id candidate collides', () => {
    const runtime = new ShellRuntime({});

    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');

    const firstId = runtime.createCompletedCommandRecord('echo one', {
      exitCode: 0,
      output: 'one\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    const { backgroundProcesses } = runtime as unknown as {
      backgroundProcesses: Map<string, unknown>;
    };
    const originalHas = backgroundProcesses.has.bind(backgroundProcesses);
    let collisionInjected = false;
    const hasSpy = vi.spyOn(backgroundProcesses, 'has').mockImplementation(id => {
      if (!collisionInjected) {
        collisionInjected = true;

        return true;
      }

      return originalHas(id);
    });

    const secondId = runtime.createCompletedCommandRecord('echo two', {
      exitCode: 0,
      output: 'two\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(secondId).toMatch(SHELL_ID_REGEX);
    expect(secondId).not.toBe(firstId);
    expect(hasSpy).toHaveBeenCalledTimes(2);
    expect(randomUuidSpy).not.toHaveBeenCalled();
  });

  it('falls back to UUID-based id after exhausting collision retries', () => {
    const runtime = new ShellRuntime({});

    runtime.createCompletedCommandRecord('echo one', {
      exitCode: 0,
      output: 'one\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    const { backgroundProcesses } = runtime as unknown as {
      backgroundProcesses: Map<string, unknown>;
    };
    vi.spyOn(backgroundProcesses, 'has').mockReturnValue(true);
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('12345678-9abc-def0-1234-56789abcdef0');

    const secondId = runtime.createCompletedCommandRecord('echo two', {
      exitCode: 0,
      output: 'two\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    expect(secondId).toBe('shell-12345678');
    expect(randomUuidSpy).toHaveBeenCalledOnce();
  });

  it('keeps output readable when spilling to disk fails', async () => {
    const runtime = new ShellRuntime({ outputLimitBytes: 1 });
    const outputDirectoryPath = getShellOutputDirectoryPath();

    fs.rmSync(outputDirectoryPath, { force: true, recursive: true });
    fs.writeFileSync(outputDirectoryPath, 'blocked', { encoding: 'utf8' });

    try {
      const id = runtime.createCompletedCommandRecord('echo spill failure', {
        exitCode: 0,
        output: 'spill survives\n',
        shell: '/bin/bash',
        terminationSignal: null,
        timedOut: false,
      });

      await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
        output: 'spill survives\n',
      });
    }
    finally {
      fs.rmSync(outputDirectoryPath, { force: true, recursive: true });
    }
  });

  it('sorts command list items newest first', () => {
    vi.useFakeTimers();

    try {
      const runtime = new ShellRuntime({});

      vi.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
      const firstId = runtime.createCompletedCommandRecord('echo first', {
        exitCode: 0,
        output: 'first\n',
        shell: '/bin/bash',
        terminationSignal: null,
        timedOut: false,
      });

      vi.setSystemTime(new Date('2026-03-19T00:00:01.000Z'));
      const secondId = runtime.createCompletedCommandRecord('echo second', {
        exitCode: 0,
        output: 'second\n',
        shell: '/bin/bash',
        terminationSignal: null,
        timedOut: false,
      });

      expect(runtime.listCommands().map(command => command.id)).toEqual([ secondId, firstId ]);
    }
    finally {
      vi.useRealTimers();
    }
  });
});

describe('ShellRuntime background execution', () => {
  it('reuses a planned command record when the shell process starts after approval', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const plannedId = runtime.createPlannedCommandRecord('git checkout main', {
      approval: {
        decision: 'ask',
        reason: 'Explicit approval is required.',
        source: 'risk-assessment',
      },
      cwd: '/workspace',
      phase: 'pending-approval',
      request: {
        explanation: 'switch branches',
        goal: 'move to main',
        riskAssessment: 'This may replace files in the working tree.',
      },
      shell: '/bin/bash',
    });

    const runningId = runtime.startBackgroundCommand('git checkout main', {
      cwd: '/workspace',
      id: plannedId,
      shell: '/bin/bash',
    });

    expect(runningId).toBe(plannedId);
    const runningCommand = runtime.listCommands()[0];

    expect(runningCommand).toMatchObject({
      id: plannedId,
      isRunning: true,
      phase: 'running',
    });
    expect(runningCommand.approval).toMatchObject({
      decision: 'ask',
      source: 'risk-assessment',
    });
    expect(runningCommand.request).toMatchObject({
      explanation: 'switch branches',
    });

    fakeProcess.emit('close', 0, null);

    await expect(runtime.awaitBackgroundCommand({
      id: plannedId,
      timeout: 0,
    })).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    await expect(runtime.getCommandDetails(plannedId)).resolves.toMatchObject({
      isRunning: false,
      phase: 'completed',
    });
  });

  it('updates nonterminal planned records and handles unknown ids', async () => {
    const runtime = new ShellRuntime({});

    expect(runtime.updateCommandRecord('shell-missing', {
      phase: 'queued',
    })).toBe(false);

    const plannedId = runtime.createPlannedCommandRecord('echo queued', {
      cwd: '/workspace',
      phase: 'evaluating',
      shell: '/bin/bash',
    });

    expect(runtime.updateCommandRecord(plannedId, {
      approval: {
        decision: 'allow',
        reason: 'Every parsed subcommand matched an allow rule.',
        source: 'rule',
      },
      completedAt: '2026-03-10T00:01:00.000Z',
      cwd: '/workspace/project',
      request: {
        goal: 'inspect the repository',
      },
      shell: '/bin/zsh',
    })).toBe(true);
    expect(runtime.updateCommandRecord(plannedId, {
      phase: 'queued',
    })).toBe(true);

    const updatedDetails = await runtime.getCommandDetails(plannedId);

    expect(updatedDetails).toMatchObject({
      completedAt: null,
      cwd: '/workspace/project',
      phase: 'queued',
      request: {
        goal: 'inspect the repository',
      },
      shell: '/bin/zsh',
    });
    expect(updatedDetails.approval).toMatchObject({
      decision: 'allow',
      source: 'rule',
    });
  });

  it('marks planned records completed and ignores blank cwd and shell overrides', async () => {
    const runtime = new ShellRuntime({});

    const plannedId = runtime.createPlannedCommandRecord('echo done', {
      cwd: '/workspace',
      phase: 'queued',
      shell: '/bin/bash',
    });

    expect(runtime.updateCommandRecord(plannedId, {
      completedAt: '2026-03-10T00:01:00.000Z',
      cwd: '   ',
      phase: 'completed',
      shell: '   ',
    })).toBe(true);

    await expect(runtime.awaitBackgroundCommand({
      id: plannedId,
      timeout: 0,
    })).resolves.toMatchObject({
      exitCode: null,
      shell: '/bin/bash',
      timedOut: false,
    });
    await expect(runtime.getCommandDetails(plannedId)).resolves.toMatchObject({
      completedAt: '2026-03-10T00:01:00.000Z',
      cwd: '/workspace',
      phase: 'completed',
      shell: '/bin/bash',
    });
  });

  it('starts a new runtime entry when the requested planned id is already terminal', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const deniedId = runtime.createPlannedCommandRecord('rm -rf build', {
      approval: {
        decision: 'deny',
        reason: 'The shell approval policy denied this command.',
        source: 'rule',
      },
      cwd: '/workspace',
      phase: 'denied',
      shell: '/bin/bash',
    });

    const runningId = runtime.startBackgroundCommand('echo separate', {
      cwd: '/workspace',
      id: deniedId,
      shell: '/bin/bash',
    });

    expect(runningId).not.toBe(deniedId);
    expect(runtime.listCommands()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deniedId,
        isRunning: false,
        phase: 'denied',
      }),
      expect.objectContaining({
        id: runningId,
        isRunning: true,
        phase: 'running',
      }),
    ]));

    fakeProcess.emit('close', 0, null);

    await expect(runtime.awaitBackgroundCommand({
      id: runningId,
      timeout: 0,
    })).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  it('returns timedOut when awaiting a command that is still running after the timeout', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo waiting');
    fakeProcess.stdout.emit('data', 'partial\n');

    await expect(runtime.awaitBackgroundCommand({
      id,
      timeout: 1,
    })).resolves.toMatchObject({
      exitCode: null,
      output: 'partial\n',
      terminationSignal: null,
      timedOut: true,
    });
  });

  it('supports public ids for await and output reads', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo public-id');
    const publicId = toPublicCommandId(id);
    const awaitPromise = runtime.awaitBackgroundCommand({
      id: publicId,
      timeout: 0,
    });

    fakeProcess.stdout.emit('data', 'hello\n');
    fakeProcess.emit('close', 0, null);

    await expect(awaitPromise).resolves.toMatchObject({
      exitCode: 0,
      output: 'hello\n',
    });
    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id: publicId,
    })).resolves.toMatchObject({
      exitCode: 0,
      isRunning: false,
      output: 'hello\n',
    });
  });

  it('supports public ids for sending stdin to a running command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id: toPublicCommandId(id),
    })).resolves.toEqual({
      isRunning: true,
      sent: true,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    expect(fakeProcess.stdin.write).toHaveBeenCalledWith('answer\n', expect.any(Function));
    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id,
    })).resolves.toMatchObject({
      isRunning: true,
      output: '[send_to_shell] answer\n',
    });
  });

  it('logs a redacted placeholder when send_to_shell input is marked secret', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read secret');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'super-secret-token',
      id,
      secret: true,
    })).resolves.toEqual({
      isRunning: true,
      sent: true,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    expect(fakeProcess.stdin.write).toHaveBeenCalledWith('super-secret-token\n', expect.any(Function));
    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id,
    })).resolves.toMatchObject({
      isRunning: true,
      output: '[send_to_shell] [hidden sensitive input]\n',
    });
  });

  it('keeps Enter visible when a secret send_to_shell input is whitespace only', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read secret');

    await expect(runtime.sendInputToBackgroundCommand({
      command: '   ',
      id,
      secret: true,
    })).resolves.toEqual({
      isRunning: true,
      sent: true,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    expect(fakeProcess.stdin.write).toHaveBeenCalledWith('\n', expect.any(Function));
    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id,
    })).resolves.toMatchObject({
      isRunning: true,
      output: '[send_to_shell] [Enter]\n',
    });
  });

  it('returns a stable failure when send_to_shell targets an unknown id', async () => {
    const runtime = new ShellRuntime({});

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id: 'deadbeef',
    })).resolves.toEqual({
      isRunning: false,
      reason: 'shell command was not found',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('returns a stable failure when stdin is no longer writable', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.stdin.writableEnded = true;
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    fakeProcess.emit('close', 0, null);

    await expect(runtime.sendInputToBackgroundCommand({
      command: '',
      id,
    })).resolves.toEqual({
      isRunning: false,
      reason: 'shell command is no longer running',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('returns a stable failure when stdin is marked not writable', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    fakeProcess.stdin.writable = false;

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('treats stdin error events as a send failure without throwing', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.stdin.write.mockImplementation((_: string, callback?: (error?: Error | null) => void) => {
      const writeError = new Error('stdin failed');

      fakeProcess.stdin.emit('error', writeError);
      callback?.(writeError);

      return false;
    });
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('treats stdin callback errors as a send failure without throwing', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.stdin.write.mockImplementation((_: string, callback?: (error?: Error | null) => void) => {
      callback?.(new Error('stdin callback failed'));
      return false;
    });
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id,
    })).resolves.toMatchObject({
      isRunning: true,
      output: '',
    });
  });

  it('treats thrown stdin writes as a send failure without throwing', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.stdin.write.mockImplementation(() => {
      throw new Error('stdin crashed');
    });
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });
  });

  it('removes a prelogged send_to_shell entry from file-backed output when stdin delivery fails', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.stdin.write.mockImplementation((_: string, callback?: (error?: Error | null) => void) => {
      callback?.(new Error('stdin callback failed'));
      return false;
    });
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({ outputLimitBytes: 1 });

    const id = runtime.startBackgroundCommand('read value');

    await expect(runtime.sendInputToBackgroundCommand({
      command: 'answer',
      id,
    })).resolves.toEqual({
      isRunning: true,
      reason: 'shell stdin is not writable',
      sent: false,
      shell: process.env.SHELL ?? '/bin/bash',
    });

    await expect(runtime.readBackgroundOutput({
      full_output: true,
      id,
    })).resolves.toMatchObject({
      isRunning: true,
      output: '',
    });
  });

  it('treats empty trailing-output removals as a no-op success', () => {
    const runtime = new ShellRuntime({});
    const runtimeAccess = runtime as unknown as {
      removeTrailingBackgroundOutput: (id: string, state: {
        output: string;
        outputBytes: number;
        outputInFile: boolean;
      }, chunk: string) => boolean;
    };
    const state = {
      output: 'value',
      outputBytes: Buffer.byteLength('value', 'utf8'),
      outputInFile: false,
    };

    expect(runtimeAccess.removeTrailingBackgroundOutput('shell-abc12345', state, '')).toBe(true);
    expect(state).toEqual({
      output: 'value',
      outputBytes: Buffer.byteLength('value', 'utf8'),
      outputInFile: false,
    });
  });

  it('returns false when spilled output does not end with the send_to_shell log entry being removed', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({ outputLimitBytes: 1 });
    const runtimeAccess = runtime as unknown as {
      backgroundProcesses: Map<string, {
        output: string;
        outputBytes: number;
        outputInFile: boolean;
      }>;
      removeTrailingBackgroundOutput: (id: string, state: {
        output: string;
        outputBytes: number;
        outputInFile: boolean;
      }, chunk: string) => boolean;
    };

    const id = runtime.startBackgroundCommand('read value');
    fakeProcess.stdout.emit('data', 'existing output\n');

    const state = runtimeAccess.backgroundProcesses.get(id);

    expect(state?.outputInFile).toBe(true);
    expect(runtimeAccess.removeTrailingBackgroundOutput(id, state as {
      output: string;
      outputBytes: number;
      outputInFile: boolean;
    }, '[send_to_shell] answer\n')).toBe(false);
  });

  it('returns false when in-memory output does not end with the send_to_shell log entry being removed', () => {
    const runtime = new ShellRuntime({});
    const runtimeAccess = runtime as unknown as {
      removeTrailingBackgroundOutput: (id: string, state: {
        output: string;
        outputBytes: number;
        outputInFile: boolean;
      }, chunk: string) => boolean;
    };
    const state = {
      output: 'existing output\n',
      outputBytes: Buffer.byteLength('existing output\n', 'utf8'),
      outputInFile: false,
    };

    expect(runtimeAccess.removeTrailingBackgroundOutput('shell-abc12345', state, '[send_to_shell] answer\n')).toBe(false);
    expect(state).toEqual({
      output: 'existing output\n',
      outputBytes: Buffer.byteLength('existing output\n', 'utf8'),
      outputInFile: false,
    });
  });

  it('falls back to in-memory state when persisted send_to_shell log removal cannot overwrite the file', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    vi.resetModules();
    vi.doMock('../shellOutputStore.js', async () => {
      const actual = await vi.importActual<typeof import('../shellOutputStore.js')>('../shellOutputStore.js');

      return {
        ...actual,
        overwriteShellOutput: (shellId: string, output: string) => {
          if (shellId.startsWith('shell-') && output.length === 0) {
            return false;
          }

          return actual.overwriteShellOutput(shellId, output);
        },
      };
    });

    try {
      const { ShellRuntime: MockedShellRuntime } = await import('../shellRuntime.js');
      const runtime = new MockedShellRuntime({ outputLimitBytes: 1 });
      const runtimeAccess = runtime as unknown as {
        backgroundProcesses: Map<string, {
          output: string;
          outputBytes: number;
          outputInFile: boolean;
        }>;
        removeTrailingBackgroundOutput: (id: string, state: {
          output: string;
          outputBytes: number;
          outputInFile: boolean;
        }, chunk: string) => boolean;
      };
      const chunk = '[send_to_shell] answer\n';
      const id = runtime.startBackgroundCommand('read value');

      fakeProcess.stdout.emit('data', chunk);

      const state = runtimeAccess.backgroundProcesses.get(id);

      expect(state?.outputInFile).toBe(true);
      expect(runtimeAccess.removeTrailingBackgroundOutput(id, state as {
        output: string;
        outputBytes: number;
        outputInFile: boolean;
      }, chunk)).toBe(true);
      expect(state).toMatchObject({
        output: '',
        outputBytes: 0,
        outputInFile: false,
      });
    }
    finally {
      vi.doUnmock('../shellOutputStore.js');
      vi.resetModules();
    }
  });

  it('captures stderr output in the command details', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo stderr');
    const awaitPromise = runtime.awaitBackgroundCommand({
      id,
      timeout: 0,
    });

    fakeProcess.stderr.emit('data', 'problem\n');
    fakeProcess.emit('close', 0, null);

    await expect(awaitPromise).resolves.toMatchObject({
      output: 'problem\n',
    });
    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      output: 'problem\n',
    });
  });

  it('falls back to in-memory output when appending to spilled output fails', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      memoryToFileDelayMs: 60_000,
      outputLimitBytes: 1,
    });

    const id = runtime.startBackgroundCommand('echo recover');

    fakeProcess.stdout.emit('data', 'a');

    const outputFilePath = getShellOutputDirectoryPath();
    expect(fs.existsSync(outputFilePath)).toBe(true);

    const spilledOutputPath = getShellOutputFilePath(id);
    fs.rmSync(spilledOutputPath, { force: true, recursive: true });
    fs.mkdirSync(spilledOutputPath, { recursive: true });

    const awaitPromise = runtime.awaitBackgroundCommand({
      id,
      timeout: 0,
    });

    fakeProcess.stdout.emit('data', 'b');
    fakeProcess.emit('close', 0, null);

    await expect(awaitPromise).resolves.toMatchObject({
      exitCode: 0,
      output: 'b',
    });
    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      output: 'b',
    });
  });

  it('returns full output once for completed records and then only deltas on later reads', async () => {
    const runtime = new ShellRuntime({});

    const id = runtime.createCompletedCommandRecord('echo done', {
      exitCode: 0,
      output: 'done\n',
      shell: '/bin/bash',
      terminationSignal: null,
      timedOut: false,
    });

    await expect(runtime.readBackgroundOutput({
      id,
    })).resolves.toMatchObject({
      exitCode: 0,
      isRunning: false,
      output: 'done\n',
    });

    await expect(runtime.readBackgroundOutput({
      id,
    })).resolves.toMatchObject({
      exitCode: 0,
      isRunning: false,
      output: '',
    });
  });

  it('marks running commands as killed and exposes that through the command list', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    fakeProcess.kill.mockImplementation((signal?: NodeJS.Signals) => {
      fakeProcess.signalCode = signal ?? 'SIGTERM';
      return true;
    });
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo killable');

    expect(runtime.killBackgroundCommand(toPublicCommandId(id))).toBe(true);
    expect(fakeProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runtime.listCommands()[0]).toEqual(expect.objectContaining({
      id,
      isRunning: true,
      killedByUser: true,
    }));
  });

  it('captures child process errors into output and completes the command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo boom');
    const awaitPromise = runtime.awaitBackgroundCommand({
      id,
      timeout: 0,
    });

    fakeProcess.emit('error', new Error('boom'));

    await expect(awaitPromise).resolves.toMatchObject({
      exitCode: null,
      terminationSignal: null,
    });
    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      isRunning: false,
      output: 'Error: boom\n',
    });
  });

  it('clears pending exit completion when a later process error finalizes the command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo delayed-error');
    fakeProcess.emit('exit', 1, null);
    fakeProcess.emit('error', new Error('boom after exit'));
    fakeProcess.emit('close', 1, null);

    await expect(runtime.awaitBackgroundCommand({
      id,
      timeout: 0,
    })).resolves.toMatchObject({
      exitCode: null,
      terminationSignal: null,
    });

    await expect(runtime.getCommandDetails(id)).resolves.toMatchObject({
      isRunning: false,
      output: 'Error: boom after exit\n',
    });
  });

  it('returns false when killing a command that has already completed', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    const id = runtime.startBackgroundCommand('echo done');
    fakeProcess.emit('close', 0, null);
    await runtime.awaitBackgroundCommand({ id, timeout: 0 });

    expect(runtime.killBackgroundCommand(id)).toBe(false);
  });

  it('records child exit metadata when kill fails after the process already exited', async () => {
    vi.useFakeTimers();

    try {
      const fakeProcess = createFakeProcess();
      spawn.mockReturnValue(fakeProcess);
      fakeProcess.kill.mockImplementation(() => {
        fakeProcess.exitCode = 7;
        return false;
      });
      const runtime = new ShellRuntime({});

      const id = runtime.startBackgroundCommand('echo already-exited');

      expect(runtime.killBackgroundCommand(id)).toBe(false);

      await vi.advanceTimersByTimeAsync(25);

      await expect(runtime.awaitBackgroundCommand({ id, timeout: 0 })).resolves.toMatchObject({
        exitCode: 7,
        terminationSignal: null,
        timedOut: false,
      });
      expect(runtime.listCommands()[0]).toEqual(expect.objectContaining({
        exitCode: 7,
        id,
        isRunning: false,
      }));
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('uses default color-related environment variables and respects NO_COLOR', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NO_COLOR: '1',
      },
    });

    runtime.startBackgroundCommand('echo env');

    const spawnEnvironment = getSpawnEnvironment();

    expect(spawnEnvironment).toMatchObject({
      CLICOLOR: '1',
      COLORTERM: 'truecolor',
      COLUMNS: '240',
      GIT_EDITOR: ':',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LINES: '80',
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    });
    expect(spawnEnvironment?.CLICOLOR_FORCE).toBeUndefined();
    expect(spawnEnvironment?.FORCE_COLOR).toBeUndefined();
  });

  it('overrides inherited interactive git environment variables with non-interactive defaults', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        GIT_EDITOR: 'vim',
        GIT_MERGE_AUTOEDIT: 'yes',
        GIT_PAGER: 'less',
        GIT_TERMINAL_PROMPT: '1',
      },
    });

    runtime.startBackgroundCommand('git diff');

    expect(getSpawnEnvironment()).toMatchObject({
      GIT_EDITOR: ':',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('overrides COLUMNS when a caller requests a custom terminal width', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        COLUMNS: '120',
      },
    });

    runtime.startBackgroundCommand('echo env', {
      columns: 320,
    });

    expect(getSpawnEnvironment()?.COLUMNS).toBe('320');
  });

  it('sanitizes direct runtime column overrides before exporting COLUMNS', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({});

    runtime.startBackgroundCommand('echo env', {
      columns: MAX_SHELL_COLUMNS + 0.9,
    });

    expect(getSpawnEnvironment()?.COLUMNS).toBe(String(MAX_SHELL_COLUMNS));
  });

  it('appends the terminal width shim to direct runtime NODE_OPTIONS', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: '--trace-warnings',
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--trace-warnings --require ${JSON.stringify(terminalWidthShimPath)}`);
  });

  it('reuses an existing long-form terminal width shim require option', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const existingNodeOptions = `--trace-warnings --require ${JSON.stringify(terminalWidthShimPath)}`;
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: existingNodeOptions,
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(existingNodeOptions);
  });

  it('reuses existing short and equals-form terminal width shim require options', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: `--trace-warnings -r ${JSON.stringify(terminalWidthShimPath)}`,
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--trace-warnings -r ${JSON.stringify(terminalWidthShimPath)}`);

    const nextFakeProcess = createFakeProcess();
    spawn.mockReturnValue(nextFakeProcess);
    const secondRuntime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: `--trace-warnings --require=${JSON.stringify(terminalWidthShimPath)}`,
      },
    });

    secondRuntime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--trace-warnings --require=${JSON.stringify(terminalWidthShimPath)}`);
  });

  it('preserves trailing escapes and substring-only NODE_OPTIONS while appending the shim', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: '--trace-warnings\\',
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--trace-warnings\\ --require ${JSON.stringify(terminalWidthShimPath)}`);

    const nextFakeProcess = createFakeProcess();
    spawn.mockReturnValue(nextFakeProcess);
    const secondRuntime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: `--title=${terminalWidthShimPath}-copy`,
      },
    });

    secondRuntime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--title=${terminalWidthShimPath}-copy --require ${JSON.stringify(terminalWidthShimPath)}`);
  });

  it('preserves escaped characters inside NODE_OPTIONS tokens while appending the shim', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: '--title=hello\\ world',
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--title=hello\\ world --require ${JSON.stringify(terminalWidthShimPath)}`);
  });

  it('skips unrelated require options before appending the terminal width shim', () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    const runtime = new ShellRuntime({
      shellEnv: {
        NODE_OPTIONS: '--trace-warnings --require ./other-shim.js',
      },
    });

    runtime.startBackgroundCommand('echo env');

    expect(getSpawnEnvironment()?.NODE_OPTIONS).toBe(`--trace-warnings --require ./other-shim.js --require ${JSON.stringify(terminalWidthShimPath)}`);
  });
});
