import * as fs from 'node:fs';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  createTerminalOutputFile,
  getTerminalOutputDirectoryPath,
  getTerminalOutputFilePath,
  initializeTerminalOutputStore,
} from '@/terminalOutputStore';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

describe('terminal output store startup purge', () => {
  afterEach(() => {
    fs.rmSync(getTerminalOutputDirectoryPath(), { force: true, recursive: true });
  });

  it('purges persisted terminal output files older than configured max age', () => {
    const oldTerminalId = 'old-terminal';
    const freshTerminalId = 'fresh-terminal';

    createTerminalOutputFile(oldTerminalId);
    createTerminalOutputFile(freshTerminalId);

    const oldFilePath = getTerminalOutputFilePath(oldTerminalId);
    const freshFilePath = getTerminalOutputFilePath(freshTerminalId);
    const oldDate = new Date(Date.now() - (7 * 60 * 60 * 1000));

    fs.utimesSync(oldFilePath, oldDate, oldDate);

    initializeTerminalOutputStore(SIX_HOURS_MS);

    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.existsSync(freshFilePath)).toBe(true);
  });
});
