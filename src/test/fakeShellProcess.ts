import { EventEmitter } from 'node:events';

import { vi } from 'vitest';

export type FakeReadable = EventEmitter;

export interface FakeProcess extends EventEmitter {
  exitCode: null | number;
  kill: ReturnType<typeof vi.fn>;
  signalCode: NodeJS.Signals | null;
  stderr: FakeReadable;
  stdout: FakeReadable;
}

export function createFakeProcess(options: { emitCloseOnKill?: boolean } = {}): FakeProcess {
  const processEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fakeProcess = Object.assign(processEmitter, {
    exitCode: null,
    kill: vi.fn(() => true),
    signalCode: null,
    stderr,
    stdout,
  }) as FakeProcess;

  if (options.emitCloseOnKill) {
    fakeProcess.kill.mockImplementation((signal?: NodeJS.Signals) => {
      fakeProcess.signalCode = signal ?? 'SIGTERM';
      fakeProcess.emit('close', null, signal ?? 'SIGTERM');
      return true;
    });
  }

  return fakeProcess;
}
