import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ShellRuntime } from '@/shellRuntime';

const SHELL_ID_REGEX = /^custom-shell-[a-f0-9]{8}$/;

describe('ShellRuntime shell id generation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    expect(secondId).toBe('custom-shell-12345678');
    expect(randomUuidSpy).toHaveBeenCalledOnce();
  });
});
