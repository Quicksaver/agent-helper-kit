import * as fs from 'node:fs';
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
import {
  createShellOutputFile,
  getShellOutputDirectoryPath,
  getShellOutputFilePath,
  initializeShellOutputStore,
  overwriteShellOutput,
  readShellCommandMetadata,
  readShellOutputSync,
  writeShellCommandMetadata,
} from '@/shellOutputStore';

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

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

function removeShellOutputDirectory(): void {
  fs.rmSync(getShellOutputDirectoryPath(), {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 10,
  });
}

describe('shell output store startup purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExtensionOutputChannelForTest();
  });

  afterEach(() => {
    removeShellOutputDirectory();
    vi.restoreAllMocks();
  });

  it('stores output files without duplicating the shell id prefix', () => {
    const outputFilePath = getShellOutputFilePath('shell-abc12345');

    expect(outputFilePath.endsWith('/output-shell-abc12345.log')).toBe(true);
  });

  it('recreates the output directory when a file blocks the temp path', () => {
    const outputDirectoryPath = getShellOutputDirectoryPath();

    removeShellOutputDirectory();
    fs.writeFileSync(outputDirectoryPath, 'blocked', { encoding: 'utf8' });

    expect(overwriteShellOutput('shell-abc12345', 'saved output\n')).toBe(true);
    expect(fs.statSync(outputDirectoryPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(getShellOutputFilePath('shell-abc12345'), 'utf8')).toBe('saved output\n');
  });

  it('returns undefined when reading output hits an unexpected filesystem error', () => {
    const outputFilePath = getShellOutputFilePath('shell-abc12345');
    fs.rmSync(outputFilePath, { force: true, recursive: true });
    fs.mkdirSync(outputFilePath, { recursive: true });

    expect(readShellOutputSync('shell-abc12345')).toBeUndefined();
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
