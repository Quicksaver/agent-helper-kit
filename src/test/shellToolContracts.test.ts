import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type ShellToolContractsModule = typeof import('../shellToolContracts.js');

const importShellToolContractsLoaders = [
  () => import('../shellToolContracts.js?case=0'),
  () => import('../shellToolContracts.js?case=1'),
  () => import('../shellToolContracts.js?case=2'),
  () => import('../shellToolContracts.js?case=3'),
  () => import('../shellToolContracts.js?case=4'),
  () => import('../shellToolContracts.js?case=5'),
  () => import('../shellToolContracts.js?case=6'),
  () => import('../shellToolContracts.js?case=7'),
  () => import('../shellToolContracts.js?case=8'),
  () => import('../shellToolContracts.js?case=9'),
  () => import('../shellToolContracts.js?case=10'),
  () => import('../shellToolContracts.js?case=11'),
] as const;

let importShellToolContractsLoaderIndex = 0;

function importFreshShellToolContracts(): Promise<ShellToolContractsModule> {
  const loader = importShellToolContractsLoaders[
    importShellToolContractsLoaderIndex % importShellToolContractsLoaders.length
  ];

  importShellToolContractsLoaderIndex += 1;

  return loader() as Promise<ShellToolContractsModule>;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doUnmock('node:path');
});

async function importShellToolContractsWithPackageJson(packageJson: unknown): Promise<ShellToolContractsModule> {
  vi.resetModules();
  vi.doMock('node:fs', () => ({
    readFileSync: vi.fn(() => JSON.stringify(packageJson)),
  }));

  return importFreshShellToolContracts();
}

async function importShellToolContractsWithReadError(message: string): Promise<ShellToolContractsModule> {
  vi.resetModules();
  vi.doMock('node:fs', () => ({
    readFileSync: vi.fn(() => {
      throw new Error(message);
    }),
  }));

  return importFreshShellToolContracts();
}

describe('shell tool contracts', () => {
  it('reads package version and manifest-backed tool metadata', async () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      contributes: {
        languageModelTools: {
          displayName: string;
          modelDescription: string;
          name: string;
        }[];
      };
      version: string;
    };

    vi.resetModules();
    vi.doUnmock('node:fs');

    const contracts = await importFreshShellToolContracts();
    const syncTool = packageJson.contributes.languageModelTools.find(
      tool => tool.name === contracts.SHELL_TOOL_NAMES.runInSyncShell,
    );

    expect(contracts.getPackageVersion()).toBe(packageJson.version);
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.title).toBe(syncTool?.displayName);
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.description).toBe(syncTool?.modelDescription);
    expect(contracts.SHELL_TOOL_METADATA.awaitShell.invocationMessage('abcd1234')).toBe('Waiting for shell command abcd1234');
    expect(contracts.SHELL_TOOL_METADATA.getLastShellCommand.invocationMessage).toBe('Reading most recent shell command');
    expect(contracts.SHELL_TOOL_METADATA.getShellCommand.invocationMessage('abcd1234')).toBe('Reading shell command abcd1234');
    expect(contracts.SHELL_TOOL_METADATA.getShellOutput.invocationMessage('abcd1234')).toBe('Reading output for shell command abcd1234');
    expect(contracts.SHELL_TOOL_METADATA.killShell.confirmationMessage('abcd1234')).toBe('Stop shell command abcd1234');
    expect(contracts.SHELL_TOOL_METADATA.killShell.confirmationTitle).toBe('Stop running shell command?');
    expect(contracts.SHELL_TOOL_METADATA.killShell.invocationMessage('abcd1234')).toBe('Stopping shell command abcd1234');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.confirmationMessage('echo ok')).toBe('Run shell command: echo ok');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.confirmationTitle).toBe('Run async shell command?');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.invocationMessage('echo ok')).toBe('Running async shell command: echo ok');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.confirmationMessage('echo ok')).toBe('Run shell command: echo ok');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.confirmationTitle).toBe('Run sync shell command?');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.invocationMessage('echo ok')).toBe('Running sync shell command: echo ok');
  });

  it('falls back cleanly when package.json cannot be read', async () => {
    const contracts = await importShellToolContractsWithReadError('unreadable');

    expect(contracts.getPackageVersion()).toBe('0.0.0');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json is missing contributes metadata', async () => {
    const contracts = await importShellToolContractsWithPackageJson({ version: '9.9.9' });

    expect(contracts.getPackageVersion()).toBe('9.9.9');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.title).toBe('run_in_async_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json is valid JSON but not an object', async () => {
    const contracts = await importShellToolContractsWithPackageJson('not-an-object');

    expect(contracts.getPackageVersion()).toBe('0.0.0');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json contributes is not an object', async () => {
    const contracts = await importShellToolContractsWithPackageJson({
      contributes: 'invalid',
      version: '2.0.0',
    });

    expect(contracts.getPackageVersion()).toBe('2.0.0');
    expect(contracts.SHELL_TOOL_METADATA.getShellOutput.title).toBe('get_shell_output');
    expect(contracts.SHELL_TOOL_METADATA.getShellOutput.description).toBe('');
  });

  it('falls back cleanly when language model tools is not an array', async () => {
    const contracts = await importShellToolContractsWithPackageJson({
      contributes: {
        languageModelTools: {
          name: 'run_in_sync_shell',
        },
      },
      version: '3.0.0',
    });

    expect(contracts.getPackageVersion()).toBe('3.0.0');
    expect(contracts.SHELL_TOOL_METADATA.awaitShell.title).toBe('await_shell');
    expect(contracts.SHELL_TOOL_METADATA.awaitShell.description).toBe('');
  });

  it('falls back cleanly when language model tool entries are malformed', async () => {
    const contracts = await importShellToolContractsWithPackageJson({
      contributes: {
        languageModelTools: [
          null,
        ],
      },
      version: '1.0.0',
    });

    expect(contracts.getPackageVersion()).toBe('1.0.0');
    expect(contracts.SHELL_TOOL_METADATA.killShell.title).toBe('kill_shell');
    expect(contracts.SHELL_TOOL_METADATA.killShell.description).toBe('');
  });

  it('falls back cleanly when a language model tool entry is missing required fields', async () => {
    const contracts = await importShellToolContractsWithPackageJson({
      contributes: {
        languageModelTools: [
          {
            displayName: 'Run Shell Command (Sync)',
            name: 'run_in_sync_shell',
          },
        ],
      },
      version: '1.1.0',
    });

    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.description).toBe('');
  });

  it('validates async shell inputs', async () => {
    const { MAX_SHELL_COLUMNS } = await import('../shellColumns.js');
    const {
      validateRunInAsyncShellInput,
    } = await import('../shellToolContracts.js');

    expect(validateRunInAsyncShellInput({
      columns: 320,
      command: 'echo ok',
      cwd: '/workspace',
      explanation: 'print ok',
      goal: 'test async validation',
      shell: '/bin/zsh',
    })).toEqual({
      columns: 320,
      command: 'echo ok',
      cwd: '/workspace',
      explanation: 'print ok',
      goal: 'test async validation',
      shell: '/bin/zsh',
    });

    expect(() => validateRunInAsyncShellInput({
      columns: MAX_SHELL_COLUMNS + 1,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test async validation',
    })).toThrow(new RegExp(`columns must be less than or equal to ${MAX_SHELL_COLUMNS}`));
  });

  it('rejects incompatible get shell output options', async () => {
    const { validateGetShellOutputInput } = await import('../shellToolContracts.js');

    expect(() => validateGetShellOutputInput({
      id: 'abcd1234',
      last_lines: 5,
      regex: 'value',
    })).toThrow(/last_lines and regex are mutually exclusive/);

    expect(() => validateGetShellOutputInput({
      id: 'abcd1234',
      regex_flags: 'i',
    })).toThrow(/regex_flags requires regex/);
  });

  it('rejects incompatible sync shell output options', async () => {
    const { validateRunInSyncShellInput } = await import('../shellToolContracts.js');

    expect(() => validateRunInSyncShellInput({
      columns: 0,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      timeout: 0,
    })).toThrow(/columns must be greater than 0/);

    expect(() => validateRunInSyncShellInput({
      columns: 12.5,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      timeout: 0,
    })).toThrow(/columns must be a whole number/);

    expect(() => validateRunInSyncShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test sync validation',
      last_lines: 5,
      timeout: 0,
    })).toThrow(/full_output, last_lines, and regex are mutually exclusive options/);

    expect(() => validateRunInSyncShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      regex_flags: 'i',
      timeout: 0,
    })).toThrow(/regex_flags requires regex/);
  });

  it('accepts valid sync shell options', async () => {
    const { validateRunInSyncShellInput } = await import('../shellToolContracts.js');

    expect(validateRunInSyncShellInput({
      columns: 320,
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test sync validation',
      timeout: 1000,
    })).toEqual({
      columns: 320,
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test sync validation',
      timeout: 1000,
    });
  });
});
