import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

afterEach(() => {
  vi.resetModules();
});

describe('shell tool contracts', () => {
  it('reads package version and manifest-backed tool metadata', async () => {
    const {
      buildShellToolMetadata,
      getContributedLanguageModelToolsFromManifest,
      getPackageVersion,
      SHELL_TOOL_METADATA,
      SHELL_TOOL_NAMES,
    } = await import('../shellToolContracts.js');
    const packageJson = (await import('../../package.json', {
      with: {
        type: 'json',
      },
    })).default as {
      contributes: {
        languageModelTools: {
          displayName: string;
          modelDescription: string;
          name: string;
        }[];
      };
      version: string;
    };
    const shellToolMetadata = buildShellToolMetadata(packageJson);
    const syncTool = packageJson.contributes.languageModelTools.find(
      tool => tool.name === SHELL_TOOL_NAMES.runInSyncShell,
    );
    const contributedLanguageModelTools = getContributedLanguageModelToolsFromManifest(packageJson);

    expect(getPackageVersion()).toBe(packageJson.version);
    expect(contributedLanguageModelTools).toContainEqual({
      displayName: syncTool?.displayName,
      modelDescription: syncTool?.modelDescription,
      name: SHELL_TOOL_NAMES.runInSyncShell,
    });
    expect(shellToolMetadata.runInSyncShell.title).toBe(syncTool?.displayName);
    expect(shellToolMetadata.runInSyncShell.description).toBe(syncTool?.modelDescription);
    expect(SHELL_TOOL_METADATA.runInSyncShell.title).toBe(syncTool?.displayName);
    expect(shellToolMetadata.awaitShell.invocationMessage('abcd1234')).toBe('Waiting for shell command abcd1234');
    expect(shellToolMetadata.getLastShellCommand.invocationMessage).toBe('Reading most recent shell command');
    expect(shellToolMetadata.getShellCommand.invocationMessage('abcd1234')).toBe('Reading shell command abcd1234');
    expect(shellToolMetadata.getShellOutput.invocationMessage('abcd1234')).toBe('Reading output for shell command abcd1234');
    expect(shellToolMetadata.killShell.confirmationMessage('abcd1234')).toBe('Stop shell command abcd1234');
    expect(shellToolMetadata.killShell.confirmationTitle).toBe('Stop running shell command?');
    expect(shellToolMetadata.killShell.invocationMessage('abcd1234')).toBe('Stopping shell command abcd1234');
    expect(shellToolMetadata.runInAsyncShell.confirmationMessage('echo ok')).toBe('Run shell command: echo ok');
    expect(shellToolMetadata.runInAsyncShell.confirmationTitle).toBe('Run async shell command?');
    expect(shellToolMetadata.runInAsyncShell.invocationMessage('echo ok')).toBe('Running async shell command: echo ok');
    expect(shellToolMetadata.runInSyncShell.confirmationMessage('echo ok')).toBe('Run shell command: echo ok');
    expect(shellToolMetadata.runInSyncShell.confirmationTitle).toBe('Run sync shell command?');
    expect(shellToolMetadata.runInSyncShell.invocationMessage('echo ok')).toBe('Running sync shell command: echo ok');
  });

  it('falls back cleanly when package.json cannot be read', async () => {
    const {
      buildShellToolMetadata,
      buildShellToolMetadataFromReader,
      getPackageVersionFromManifest,
      getPackageVersionFromReader,
    } = await import('../shellToolContracts.js');
    const shellToolMetadata = buildShellToolMetadata(undefined);
    const shellToolMetadataFromReader = buildShellToolMetadataFromReader(() => {
      throw new Error('unreadable');
    });

    expect(getPackageVersionFromManifest(undefined)).toBe('0.0.0');
    expect(getPackageVersionFromReader(() => {
      throw new Error('unreadable');
    })).toBe('0.0.0');
    expect(shellToolMetadata.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(shellToolMetadata.runInSyncShell.description).toBe('');
    expect(shellToolMetadataFromReader.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(shellToolMetadataFromReader.runInSyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json is missing contributes metadata', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const shellToolMetadata = buildShellToolMetadata({ version: '9.9.9' });

    expect(getPackageVersionFromManifest({ version: '9.9.9' })).toBe('9.9.9');
    expect(shellToolMetadata.runInAsyncShell.title).toBe('run_in_async_shell');
    expect(shellToolMetadata.runInAsyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json is valid JSON but not an object', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const shellToolMetadata = buildShellToolMetadata('not-an-object');

    expect(getPackageVersionFromManifest('not-an-object')).toBe('0.0.0');
    expect(shellToolMetadata.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(shellToolMetadata.runInSyncShell.description).toBe('');
  });

  it('falls back cleanly when package.json contributes is not an object', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: 'invalid',
      version: '2.0.0',
    };
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(getPackageVersionFromManifest(manifest)).toBe('2.0.0');
    expect(shellToolMetadata.getShellOutput.title).toBe('get_shell_output');
    expect(shellToolMetadata.getShellOutput.description).toBe('');
  });

  it('falls back cleanly when language model tools is not an array', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: {
        languageModelTools: {
          name: 'run_in_sync_shell',
        },
      },
      version: '3.0.0',
    };
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(getPackageVersionFromManifest(manifest)).toBe('3.0.0');
    expect(shellToolMetadata.awaitShell.title).toBe('await_shell');
    expect(shellToolMetadata.awaitShell.description).toBe('');
  });

  it('falls back cleanly when language model tool entries are malformed', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: {
        languageModelTools: [
          null,
        ],
      },
      version: '1.0.0',
    };
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(getPackageVersionFromManifest(manifest)).toBe('1.0.0');
    expect(shellToolMetadata.killShell.title).toBe('kill_shell');
    expect(shellToolMetadata.killShell.description).toBe('');
  });

  it('falls back cleanly when a language model tool entry is missing required fields', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: {
        languageModelTools: [
          {
            displayName: 'Run Shell Command (Sync)',
            name: 'run_in_sync_shell',
          },
        ],
      },
      version: '1.1.0',
    };
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(getPackageVersionFromManifest(manifest)).toBe('1.1.0');
    expect(shellToolMetadata.runInSyncShell.title).toBe('run_in_sync_shell');
    expect(shellToolMetadata.runInSyncShell.description).toBe('');
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
