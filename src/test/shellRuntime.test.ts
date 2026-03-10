import * as fs from 'node:fs';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { resetExtensionOutputChannelForTest } from '@/logging';
import {
  getShellOutputDirectoryPath,
  readShellCommandMetadata,
} from '@/shellOutputStore';
import { ShellRuntime } from '@/shellRuntime';

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
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetExtensionOutputChannelForTest();
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
});
