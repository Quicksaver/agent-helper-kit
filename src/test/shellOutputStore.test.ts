import * as fs from 'node:fs';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  createShellOutputFile,
  getShellOutputDirectoryPath,
  getShellOutputFilePath,
  initializeShellOutputStore,
} from '@/shellOutputStore';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

describe('shell output store startup purge', () => {
  afterEach(() => {
    fs.rmSync(getShellOutputDirectoryPath(), { force: true, recursive: true });
  });

  it('stores output files without duplicating the shell id prefix', () => {
    const outputFilePath = getShellOutputFilePath('shell-abc12345');

    expect(outputFilePath.endsWith('/output-shell-abc12345.log')).toBe(true);
  });

  it('purges persisted shell output files older than configured max age', () => {
    const oldShellId = 'old-shell';
    const freshShellId = 'fresh-shell';

    createShellOutputFile(oldShellId);
    createShellOutputFile(freshShellId);

    const oldFilePath = getShellOutputFilePath(oldShellId);
    const freshFilePath = getShellOutputFilePath(freshShellId);
    const oldDate = new Date(Date.now() - SEVEN_HOURS_MS);

    fs.utimesSync(oldFilePath, oldDate, oldDate);

    initializeShellOutputStore(SIX_HOURS_MS);

    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.existsSync(freshFilePath)).toBe(true);
  });
});
