import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  getExtensionOutputChannel,
  resetExtensionOutputChannelForTest,
} from '@/logging';
import {
  appendShellOutput,
  createShellOutputFile,
  getShellOutputDirectoryPath,
  getShellOutputFilePath,
  initializeShellOutputStore,
  listShellMetadataIds,
  listShellOutputIds,
  overwriteShellOutput,
  readShellCommandMetadata,
  readShellOutput,
  readShellOutputSync,
  removeShellCommandMetadata,
  removeShellOutputFile,
  SHELL_OUTPUT_DIR_ENV_VAR,
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
const shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellOutputStore-test-'));
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

type MockOutputChannel = {
  append: ReturnType<typeof vi.fn>;
  appendLine: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
};

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
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
    vi.clearAllMocks();
    resetExtensionOutputChannelForTest();
  });

  afterEach(() => {
    removeShellOutputDirectory();

    if (previousShellOutputDirectory === undefined) {
      Reflect.deleteProperty(process.env, SHELL_OUTPUT_DIR_ENV_VAR);
    }
    else {
      process.env[SHELL_OUTPUT_DIR_ENV_VAR] = previousShellOutputDirectory;
    }

    vi.restoreAllMocks();
  });

  it('stores output files without duplicating the shell id prefix', () => {
    const outputFilePath = getShellOutputFilePath('shell-abc12345');

    expect(outputFilePath.endsWith('/output-shell-abc12345.log')).toBe(true);
  });

  it('sanitizes shell ids before building output file paths', () => {
    const outputFilePath = getShellOutputFilePath('../shell:abc12345');

    expect(outputFilePath.endsWith('/output-___shell_abc12345.log')).toBe(true);
  });

  it('disposes the cached extension output channel when resetting test state', () => {
    getExtensionOutputChannel();

    resetExtensionOutputChannelForTest();

    const createdOutputChannel = vscode.window.createOutputChannel.mock.results[0]
      ?.value as MockOutputChannel | undefined;

    expect(createdOutputChannel?.dispose).toHaveBeenCalledOnce();
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

  it('returns an empty string for missing async output files and rejects unexpected async read errors', async () => {
    await expect(readShellOutput('shell-missing')).resolves.toBe('');

    const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'EIO' }),
    );

    await expect(readShellOutput('shell-error')).rejects.toThrow('boom');

    readFileSpy.mockRestore();
  });

  it('appends, lists, reads, and removes shell output artifacts', async () => {
    createShellOutputFile('shell-b');
    createShellOutputFile('shell-a');
    appendShellOutput('shell-a', 'first\n');
    appendShellOutput('shell-a', 'second\n');

    expect(listShellOutputIds()).toEqual([ 'shell-a', 'shell-b' ]);
    expect(readShellOutputSync('shell-a')).toBe('first\nsecond\n');
    await expect(readShellOutput('shell-a')).resolves.toBe('first\nsecond\n');

    removeShellOutputFile('shell-a');

    expect(readShellOutputSync('shell-a')).toBeUndefined();
    await expect(readShellOutput('shell-a')).resolves.toBe('');
  });

  it('lists metadata ids and removes metadata files', () => {
    writeShellCommandMetadata({
      command: 'echo second',
      completedAt: null,
      cwd: '/tmp',
      exitCode: null,
      id: 'shell-b',
      killedByUser: false,
      shell: '/bin/bash',
      signal: null,
      startedAt: new Date().toISOString(),
    });
    writeShellCommandMetadata({
      command: 'echo first',
      completedAt: null,
      cwd: '/tmp',
      exitCode: null,
      id: 'shell-a',
      killedByUser: false,
      shell: '/bin/bash',
      signal: null,
      startedAt: new Date().toISOString(),
    });

    expect(listShellMetadataIds()).toEqual([ 'shell-a', 'shell-b' ]);

    removeShellCommandMetadata('shell-a');

    expect(readShellCommandMetadata('shell-a')).toBeUndefined();
    expect(listShellMetadataIds()).toEqual([ 'shell-b' ]);
  });

  it('ignores unrelated files when listing metadata ids', () => {
    fs.mkdirSync(getShellOutputDirectoryPath(), { recursive: true });
    fs.writeFileSync(path.join(getShellOutputDirectoryPath(), 'metadata-shell-a.json'), '{}', { encoding: 'utf8' });
    fs.writeFileSync(path.join(getShellOutputDirectoryPath(), 'output-shell-a.log'), '', { encoding: 'utf8' });
    fs.writeFileSync(path.join(getShellOutputDirectoryPath(), 'metadata-shell-b.txt'), '{}', { encoding: 'utf8' });
    fs.writeFileSync(path.join(getShellOutputDirectoryPath(), 'notes.txt'), 'ignored', { encoding: 'utf8' });

    expect(listShellMetadataIds()).toEqual([ 'shell-a' ]);
  });

  it('defaults missing cwd and shell values when reading stored metadata', () => {
    const shellId = 'shell-defaults';
    const metadataPath = path.join(getShellOutputDirectoryPath(), `metadata-${shellId}.json`);

    fs.mkdirSync(getShellOutputDirectoryPath(), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify({
      command: 'echo defaults',
      completedAt: null,
      exitCode: null,
      id: shellId,
      killedByUser: false,
      signal: null,
      startedAt: '2026-03-19T00:00:00.000Z',
    }), { encoding: 'utf8' });

    expect(readShellCommandMetadata(shellId)).toMatchObject({
      command: 'echo defaults',
      cwd: process.env.HOME,
      shell: '',
    });
  });

  it('returns undefined for malformed metadata payloads', () => {
    const shellId = 'shell-invalid';
    const metadataPath = path.join(getShellOutputDirectoryPath(), `metadata-${shellId}.json`);

    fs.mkdirSync(getShellOutputDirectoryPath(), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify({
      command: 'echo invalid',
      completedAt: null,
      exitCode: '0',
      id: shellId,
      killedByUser: false,
      signal: null,
      startedAt: '2026-03-19T00:00:00.000Z',
    }), { encoding: 'utf8' });

    expect(readShellCommandMetadata(shellId)).toBeUndefined();
  });

  it('returns undefined for invalid metadata json', () => {
    const shellId = 'shell-invalid-json';
    const metadataPath = path.join(getShellOutputDirectoryPath(), `metadata-${shellId}.json`);

    fs.mkdirSync(getShellOutputDirectoryPath(), { recursive: true });
    fs.writeFileSync(metadataPath, '{not-json', { encoding: 'utf8' });

    expect(readShellCommandMetadata(shellId)).toBeUndefined();
  });

  it('returns undefined when metadata json is null', () => {
    const shellId = 'shell-null-json';
    const metadataPath = path.join(getShellOutputDirectoryPath(), `metadata-${shellId}.json`);

    fs.mkdirSync(getShellOutputDirectoryPath(), { recursive: true });
    fs.writeFileSync(metadataPath, 'null', { encoding: 'utf8' });

    expect(readShellCommandMetadata(shellId)).toBeUndefined();
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

  it('ignores unrelated files while purging stale shell output artifacts', () => {
    const oldShellId = 'old-shell';
    const oldDate = new Date(Date.now() - SEVEN_HOURS_MS);
    const unrelatedFilePath = path.join(getShellOutputDirectoryPath(), 'notes.txt');

    createShellOutputFile(oldShellId);
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
    fs.writeFileSync(unrelatedFilePath, 'keep me', { encoding: 'utf8' });

    const oldFilePath = getShellOutputFilePath(oldShellId);
    const oldMetadataFilePath = path.join(getShellOutputDirectoryPath(), `metadata-${oldShellId}.json`);

    fs.utimesSync(oldFilePath, oldDate, oldDate);
    fs.utimesSync(oldMetadataFilePath, oldDate, oldDate);
    fs.utimesSync(unrelatedFilePath, oldDate, oldDate);

    initializeShellOutputStore(SIX_HOURS_MS);

    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.existsSync(unrelatedFilePath)).toBe(true);
  });
});
