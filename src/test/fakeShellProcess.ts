import { EventEmitter } from 'node:events';

import { vi } from 'vitest';

export type FakeReadable = EventEmitter;

export interface FakeWritable extends EventEmitter {
  destroyed: boolean;
  writableEnded: boolean;
  write: ReturnType<typeof vi.fn>;
}

export interface FakeProcess extends EventEmitter {
  exitCode: null | number;
  kill: ReturnType<typeof vi.fn>;
  signalCode: NodeJS.Signals | null;
  stderr: FakeReadable;
  stdin: FakeWritable;
  stdout: FakeReadable;
}

export function createFakeProcess(options: { emitCloseOnKill?: boolean } = {}): FakeProcess {
  const processEmitter = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: vi.fn((_: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
  }) as FakeWritable;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fakeProcess = Object.assign(processEmitter, {
    exitCode: null,
    kill: vi.fn(() => true),
    signalCode: null,
    stderr,
    stdin,
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
