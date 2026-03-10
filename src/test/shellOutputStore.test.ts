import * as fs from 'node:fs';
import * as path from 'node:path';

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
  readShellCommandMetadata,
  writeShellCommandMetadata,
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
    const oldDate = new Date(Date.now() - SEVEN_HOURS_MS);

    createShellOutputFile(oldShellId);
    createShellOutputFile(freshShellId);
    writeShellCommandMetadata({
      command: 'echo old',
      completedAt: oldDate.toISOString(),
      exitCode: 0,
      id: oldShellId,
      killedByUser: false,
      shell: '/bin/bash',
      signal: null,
      startedAt: oldDate.toISOString(),
    });
    writeShellCommandMetadata({
      command: 'echo fresh',
      completedAt: null,
      exitCode: null,
      id: freshShellId,
      killedByUser: false,
      shell: '/bin/bash',
      signal: null,
      startedAt: new Date().toISOString(),
    });

    const oldFilePath = getShellOutputFilePath(oldShellId);
    const freshFilePath = getShellOutputFilePath(freshShellId);
    const oldMetadataFilePath = path.join(getShellOutputDirectoryPath(), `metadata-${oldShellId}.json`);

    fs.utimesSync(oldFilePath, oldDate, oldDate);
    fs.utimesSync(oldMetadataFilePath, oldDate, oldDate);

    initializeShellOutputStore(SIX_HOURS_MS);

    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.existsSync(freshFilePath)).toBe(true);
    expect(readShellCommandMetadata(oldShellId)).toBeUndefined();
    expect(readShellCommandMetadata(freshShellId)?.command).toBe('echo fresh');
  });
});
