import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doUnmock('node:path');
});

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
    const contracts = await import('../shellToolContracts.js');
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
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn(() => {
        throw new Error('unreadable');
      }),
    }));

    const contracts = await import('../shellToolContracts.js');

    expect(contracts.getPackageVersion()).toBe('0.0.0');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInSyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json is missing contributes metadata', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn(() => JSON.stringify({ version: '9.9.9' })),
    }));

    const contracts = await import('../shellToolContracts.js');

    expect(contracts.getPackageVersion()).toBe('9.9.9');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.title).toBe('run_in_async_shell');
    expect(contracts.SHELL_TOOL_METADATA.runInAsyncShell.description).toBe('');
  });

  it('falls back cleanly when language model tool entries are malformed', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn(() => JSON.stringify({
        contributes: {
          languageModelTools: [
            null,
          ],
        },
        version: '1.0.0',
      })),
    }));

    const contracts = await import('../shellToolContracts.js');

    expect(contracts.getPackageVersion()).toBe('1.0.0');
    expect(contracts.SHELL_TOOL_METADATA.killShell.title).toBe('kill_shell');
    expect(contracts.SHELL_TOOL_METADATA.killShell.description).toBe('');
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
    })).toThrowError(new RegExp(`columns must be less than or equal to ${MAX_SHELL_COLUMNS}`));
  });

  it('rejects incompatible get shell output options', async () => {
    const { validateGetShellOutputInput } = await import('../shellToolContracts.js');

    expect(() => validateGetShellOutputInput({
      id: 'abcd1234',
      last_lines: 5,
      regex: 'value',
    })).toThrowError(/last_lines and regex are mutually exclusive/);

    expect(() => validateGetShellOutputInput({
      id: 'abcd1234',
      regex_flags: 'i',
    })).toThrowError(/regex_flags requires regex/);
  });

  it('rejects incompatible sync shell output options', async () => {
    const { validateRunInSyncShellInput } = await import('../shellToolContracts.js');

    expect(() => validateRunInSyncShellInput({
      columns: 0,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      timeout: 0,
    })).toThrowError(/columns must be greater than 0/);

    expect(() => validateRunInSyncShellInput({
      columns: 12.5,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      timeout: 0,
    })).toThrowError(/columns must be a whole number/);

    expect(() => validateRunInSyncShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test sync validation',
      last_lines: 5,
      timeout: 0,
    })).toThrowError(/full_output, last_lines, and regex are mutually exclusive options/);

    expect(() => validateRunInSyncShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test sync validation',
      regex_flags: 'i',
      timeout: 0,
    })).toThrowError(/regex_flags requires regex/);
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
