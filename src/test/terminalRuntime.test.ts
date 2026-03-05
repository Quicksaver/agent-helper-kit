import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { TerminalRuntime } from '@/terminalRuntime';

const TERMINAL_ID_REGEX = /^custom-terminal-[a-f0-9]{8}$/;

function normalizePath(value: string): string {
  return fs.realpathSync.native(value.trim()).replaceAll('\\', '/');
}

describe('TerminalRuntime foreground cwd behavior', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const tempDirectory of tempDirectories.splice(0)) {
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it('starts each foreground command from initial cwd', async () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-vscode-runtime-'));
    tempDirectories.push(rootDirectory);

    const childDirectory = path.join(rootDirectory, 'child');
    fs.mkdirSync(childDirectory);

    const runtime = new TerminalRuntime({
      getBackgroundCwd: () => rootDirectory,
      getInitialForegroundCwd: () => rootDirectory,
    });

    await runtime.runForegroundCommand({
      command: `cd "${childDirectory}"`,
      timeout: 0,
    });

    const cwdResult = await runtime.runForegroundCommand({
      command: os.platform() === 'win32' ? 'cd' : 'pwd',
      timeout: 0,
    });

    const reportedCwd = cwdResult.output
      .trim()
      .split(/\r?\n/)
      .at(-1) ?? '';

    expect(normalizePath(reportedCwd)).toBe(normalizePath(rootDirectory));
  });
});

describe('TerminalRuntime terminal id generation', () => {
  it('creates non-sequential 8-char hexadecimal ids', () => {
    const runtime = new TerminalRuntime({
      getBackgroundCwd: () => '/',
      getInitialForegroundCwd: () => '/',
    });

    const firstId = runtime.createCompletedCommandRecord('echo one', {
      exitCode: 0,
      output: 'one\n',
      terminationSignal: null,
      timedOut: false,
    });

    const secondId = runtime.createCompletedCommandRecord('echo two', {
      exitCode: 0,
      output: 'two\n',
      terminationSignal: null,
      timedOut: false,
    });

    expect(firstId).toMatch(TERMINAL_ID_REGEX);
    expect(secondId).toMatch(TERMINAL_ID_REGEX);
    expect(firstId).not.toBe(secondId);
  });
});
