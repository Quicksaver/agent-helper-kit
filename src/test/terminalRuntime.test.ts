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
