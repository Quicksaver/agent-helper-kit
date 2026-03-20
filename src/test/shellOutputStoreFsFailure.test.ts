import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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

const SHELL_OUTPUT_DIR_ENV_VAR = 'AGENT_HELPER_KIT_SHELL_OUTPUT_DIR';
const shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellOutputStoreFsFailure-test-'));
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

async function importShellOutputStoreWithFsOverrides(overrides: Partial<typeof fs> & {
  promises?: Partial<typeof fs.promises>;
} = {}) {
  process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
  vi.resetModules();
  const actualFs = await import('node:fs');

  vi.doMock('node:fs', () => ({
    ...actualFs,
    ...overrides,
    promises: {
      ...actualFs.promises,
      ...(overrides.promises ?? {}),
    },
  }));

  return import('../shellOutputStore.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:fs');

  fs.rmSync(shellOutputTestDirectory, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 10,
  });

  if (previousShellOutputDirectory === undefined) {
    Reflect.deleteProperty(process.env, SHELL_OUTPUT_DIR_ENV_VAR);
  }
  else {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = previousShellOutputDirectory;
  }
});

describe('shell output store fs failure paths', () => {
  it('reuses an existing output directory when mkdirSync reports EEXIST', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      lstatSync: (() => ({
        isDirectory: () => true,
      })) as unknown as typeof fs.lstatSync,
      mkdirSync: () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
      writeFileSync: vi.fn(),
    });

    expect(store.overwriteShellOutput('shell-existing-dir', 'value')).toBe(true);
  });

  it('returns false when ensureOutputDirectory fails with a non-Node error shape', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      lstatSync: () => {
        throw Object.assign(new Error('missing target'), { code: 'ENOENT' });
      },
      mkdirSync: () => {
        throw new Error('boom');
      },
    });

    expect(store.overwriteShellOutput('shell-ensure-fail', 'value')).toBe(false);
  });

  it('returns false when overwrite logging formats file and symlink path states', async () => {
    const lstatSync = vi.fn()
      .mockReturnValueOnce({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o644,
        size: 12,
      })
      .mockReturnValueOnce({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
        mode: 0o777,
        size: 0,
      });
    const store = await importShellOutputStoreWithFsOverrides({
      lstatSync: lstatSync as unknown as typeof fs.lstatSync,
      writeFileSync: () => {
        throw new Error('write failed');
      },
    });

    expect(store.overwriteShellOutput('shell-write-fail-format', 'value')).toBe(false);
    expect(lstatSync).toHaveBeenCalled();
  });

  it('returns false when overwrite logging formats unknown path states', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      lstatSync: () => {
        throw new Error('stat failed');
      },
      writeFileSync: () => {
        throw new Error('write failed');
      },
    });

    expect(store.overwriteShellOutput('shell-write-fail-unknown', 'value')).toBe(false);
  });

  it('returns empty lists when output directory reads fail', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      readdirSync: () => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' });
      },
    });

    expect(store.listShellOutputIds()).toEqual([]);
    expect(store.listShellMetadataIds()).toEqual([]);
  });

  it('returns false when output writes fail', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      appendFileSync: () => {
        throw Object.assign(new Error('append failed'), { code: 'EIO' });
      },
      writeFileSync: () => {
        throw Object.assign(new Error('write failed'), { code: 'EIO' });
      },
    });

    expect(store.overwriteShellOutput('shell-write-fail', 'value')).toBe(false);
    expect(store.appendShellOutput('shell-append-fail', 'chunk')).toBe(false);
  });

  it('returns cleanly when startup purge cannot read the output directory', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      readdirSync: () => {
        throw Object.assign(new Error('blocked'), { code: 'EACCES' });
      },
    });

    expect(() => store.initializeShellOutputStore()).not.toThrow();
  });

  it('continues when startup purge cannot stat an artifact', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      readdirSync: ((() => [ 'output-shell-stat-fail.log' ]) as unknown) as typeof fs.readdirSync,
      statSync: () => {
        throw Object.assign(new Error('stat failed'), { code: 'EIO' });
      },
    });

    expect(() => store.initializeShellOutputStore()).not.toThrow();
  });

  it('continues when stale artifact purge removal fails', async () => {
    const oldStats = {
      mtimeMs: 0,
    } as fs.Stats;
    const rmSync = vi.fn(() => {
      throw Object.assign(new Error('rm failed'), { code: 'EIO' });
    });
    const store = await importShellOutputStoreWithFsOverrides({
      readdirSync: ((() => [ 'output-shell-stale.log', 'metadata-shell-stale.json' ]) as unknown) as typeof fs.readdirSync,
      rmSync,
      statSync: ((() => oldStats) as unknown) as typeof fs.statSync,
    });

    expect(() => store.initializeShellOutputStore(1)).not.toThrow();
    expect(rmSync).toHaveBeenCalled();
  });

  it('returns cleanly when writing metadata fails', async () => {
    const store = await importShellOutputStoreWithFsOverrides({
      writeFileSync: () => {
        throw Object.assign(new Error('metadata failed'), { code: 'EIO' });
      },
    });

    expect(() => store.writeShellCommandMetadata({
      command: 'echo fail',
      completedAt: null,
      cwd: '/tmp',
      exitCode: null,
      id: 'shell-meta-fail',
      killedByUser: false,
      shell: '/bin/bash',
      signal: null,
      startedAt: new Date().toISOString(),
    })).not.toThrow();
  });
});
