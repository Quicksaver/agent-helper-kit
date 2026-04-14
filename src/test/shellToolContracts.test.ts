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
          userDescription?: string;
        }[];
      };
      version: string;
    };
    const shellToolMetadata = buildShellToolMetadata(packageJson);
    const runTool = packageJson.contributes.languageModelTools.find(
      tool => tool.name === SHELL_TOOL_NAMES.runInShell,
    );
    const sendTool = packageJson.contributes.languageModelTools.find(
      tool => tool.name === SHELL_TOOL_NAMES.sendToShell,
    );
    const contributedLanguageModelTools = getContributedLanguageModelToolsFromManifest(packageJson);

    expect(getPackageVersion()).toBe(packageJson.version);
    expect(contributedLanguageModelTools).toContainEqual({
      displayName: runTool?.displayName,
      modelDescription: runTool?.modelDescription,
      name: SHELL_TOOL_NAMES.runInShell,
      userDescription: runTool?.userDescription,
    });
    expect(shellToolMetadata.runInShell.title).toBe(runTool?.displayName);
    expect(shellToolMetadata.runInShell.description).toBe(runTool?.userDescription);
    expect(SHELL_TOOL_METADATA.runInShell.title).toBe(runTool?.displayName);
    expect(shellToolMetadata.awaitShell.invocationMessage('abcd1234')).toBe('Waiting for shell command abcd1234');
    expect(shellToolMetadata.getLastShellCommand.invocationMessage).toBe('Reading most recent shell command');
    expect(shellToolMetadata.getShellCommand.invocationMessage('abcd1234')).toBe('Reading shell command abcd1234');
    expect(shellToolMetadata.getShellOutput.invocationMessage('abcd1234')).toBe('Reading output for shell command abcd1234');
    expect(shellToolMetadata.killShell.confirmationMessage('abcd1234')).toBe('Stop shell command abcd1234');
    expect(shellToolMetadata.killShell.confirmationTitle).toBe('Stop running shell command?');
    expect(shellToolMetadata.killShell.invocationMessage('abcd1234')).toBe('Stopping shell command abcd1234');
    expect(shellToolMetadata.runInShell.confirmationMessage('echo ok')).toBe('Run shell command: echo ok');
    expect(shellToolMetadata.runInShell.confirmationTitle).toBe('Run shell command?');
    expect(shellToolMetadata.runInShell.invocationMessage('echo ok')).toBe('Running shell command: echo ok');
    expect(shellToolMetadata.sendToShell.title).toBe(sendTool?.displayName);
    expect(shellToolMetadata.sendToShell.description).toBe(sendTool?.userDescription);
    expect(shellToolMetadata.sendToShell.confirmationMessage('abcd1234', 'yes')).toBe('Send input to shell command abcd1234: yes');
    expect(shellToolMetadata.sendToShell.confirmationMessage('abcd1234', '[hidden sensitive input]', { secret: true })).toBe('Send secret input to shell command abcd1234: [hidden sensitive input]');
    expect(shellToolMetadata.sendToShell.confirmationMessage('abcd1234')).toBe('Press Enter for shell command abcd1234');
    expect(shellToolMetadata.sendToShell.confirmationTitle).toBe('Send input to running shell command?');
    expect(shellToolMetadata.sendToShell.invocationMessage('abcd1234')).toBe('Sending input to shell command abcd1234');
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
    expect(shellToolMetadata.runInShell.title).toBe('run_in_shell');
    expect(shellToolMetadata.runInShell.description).toBe('');
    expect(shellToolMetadataFromReader.runInShell.title).toBe('run_in_shell');
    expect(shellToolMetadataFromReader.runInShell.description).toBe('');
  });

  it('falls back cleanly when package.json is missing contributes metadata', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const shellToolMetadata = buildShellToolMetadata({ version: '9.9.9' });

    expect(getPackageVersionFromManifest({ version: '9.9.9' })).toBe('9.9.9');
    expect(shellToolMetadata.runInShell.title).toBe('run_in_shell');
    expect(shellToolMetadata.runInShell.description).toBe('');
  });

  it('falls back cleanly when package.json is valid JSON but not an object', async () => {
    const { buildShellToolMetadata, getPackageVersionFromManifest } = await import('../shellToolContracts.js');
    const shellToolMetadata = buildShellToolMetadata('not-an-object');

    expect(getPackageVersionFromManifest('not-an-object')).toBe('0.0.0');
    expect(shellToolMetadata.runInShell.title).toBe('run_in_shell');
    expect(shellToolMetadata.runInShell.description).toBe('');
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
          name: 'run_in_shell',
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
            displayName: 'Run Shell Command',
            name: 'run_in_shell',
          },
        ],
      },
      version: '1.1.0',
    };
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(getPackageVersionFromManifest(manifest)).toBe('1.1.0');
    expect(shellToolMetadata.runInShell.title).toBe('run_in_shell');
    expect(shellToolMetadata.runInShell.description).toBe('');
  });

  it('uses modelDescription when userDescription is missing or blank', async () => {
    const {
      buildShellToolMetadata,
      getContributedLanguageModelToolsFromManifest,
    } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: {
        languageModelTools: [
          {
            displayName: 'Run Shell Command',
            modelDescription: 'Detailed run description',
            name: 'run_in_shell',
          },
          {
            displayName: 'Send to Shell',
            modelDescription: 'Detailed send description',
            name: 'send_to_shell',
            userDescription: '   ',
          },
        ],
      },
    };

    const contributedLanguageModelTools = getContributedLanguageModelToolsFromManifest(manifest);
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(contributedLanguageModelTools).toContainEqual({
      displayName: 'Run Shell Command',
      modelDescription: 'Detailed run description',
      name: 'run_in_shell',
      userDescription: undefined,
    });
    expect(contributedLanguageModelTools).toContainEqual({
      displayName: 'Send to Shell',
      modelDescription: 'Detailed send description',
      name: 'send_to_shell',
      userDescription: undefined,
    });
    expect(shellToolMetadata.runInShell.description).toBe('Detailed run description');
    expect(shellToolMetadata.sendToShell.description).toBe('Detailed send description');
  });

  it('trims non-blank userDescription values from the manifest', async () => {
    const {
      buildShellToolMetadata,
      getContributedLanguageModelToolsFromManifest,
    } = await import('../shellToolContracts.js');
    const manifest = {
      contributes: {
        languageModelTools: [
          {
            displayName: 'Run Shell Command',
            modelDescription: 'Detailed run description',
            name: 'run_in_shell',
            userDescription: '  Friendly run description  ',
          },
        ],
      },
    };

    const contributedLanguageModelTools = getContributedLanguageModelToolsFromManifest(manifest);
    const shellToolMetadata = buildShellToolMetadata(manifest);

    expect(contributedLanguageModelTools).toContainEqual({
      displayName: 'Run Shell Command',
      modelDescription: 'Detailed run description',
      name: 'run_in_shell',
      userDescription: 'Friendly run description',
    });
    expect(shellToolMetadata.runInShell.description).toBe('Friendly run description');
  });

  it('validates async-style shell inputs without timeout', async () => {
    const { MAX_SHELL_COLUMNS } = await import('../shellColumns.js');
    const {
      MAX_SEND_TO_SHELL_INPUT_LENGTH,
      validateAwaitShellInput,
      validateRunInShellInput,
      validateSendToShellInput,
    } = await import('../shellToolContracts.js');

    expect(validateRunInShellInput({
      columns: 320,
      command: 'echo ok',
      cwd: '/workspace',
      explanation: 'print ok',
      goal: 'test async-style validation',
      riskAssessment: 'This only prints output.',
      shell: '/bin/zsh',
    })).toEqual({
      columns: 320,
      command: 'echo ok',
      cwd: '/workspace',
      explanation: 'print ok',
      goal: 'test async-style validation',
      riskAssessment: 'This only prints output.',
      shell: '/bin/zsh',
    });

    expect(() => validateRunInShellInput({
      columns: MAX_SHELL_COLUMNS + 1,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test async-style validation',
      riskAssessment: 'This only prints output.',
    })).toThrow(new RegExp(`columns must be less than or equal to ${MAX_SHELL_COLUMNS}`));

    expect(() => validateRunInShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'reject negative run timeout',
      riskAssessment: 'This only prints output.',
      timeout: -1,
    })).toThrow(/expected number to be >=0/);

    expect(() => validateAwaitShellInput({
      id: 'abcd1234',
      timeout: -1,
    })).toThrow(/expected number to be >=0/);

    expect(validateSendToShellInput({
      command: 'yes',
      id: 'abcd1234',
      secret: true,
    })).toEqual({
      command: 'yes',
      id: 'abcd1234',
      secret: true,
    });

    expect(() => validateSendToShellInput({
      command: 'yes\nno',
      id: 'abcd1234',
    })).toThrow(/command must be a single line; Enter is added automatically/);

    expect(() => validateSendToShellInput({
      command: 'a'.repeat(MAX_SEND_TO_SHELL_INPUT_LENGTH + 1),
      id: 'abcd1234',
    })).toThrow(new RegExp(`command must be less than or equal to ${MAX_SEND_TO_SHELL_INPUT_LENGTH} characters`));
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

  it('rejects waited shell output options without timeout', async () => {
    const { validateRunInShellInput } = await import('../shellToolContracts.js');

    expect(() => validateRunInShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test validation',
      riskAssessment: 'This only prints output.',
    })).toThrow(/full_output, last_lines, regex, and regex_flags require timeout/);
  });

  it('rejects incompatible waited shell output options', async () => {
    const { validateRunInShellInput } = await import('../shellToolContracts.js');

    expect(() => validateRunInShellInput({
      columns: 0,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test waited validation',
      riskAssessment: 'This only prints output.',
      timeout: 0,
    })).toThrow(/columns must be greater than 0/);

    expect(() => validateRunInShellInput({
      columns: 12.5,
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test waited validation',
      riskAssessment: 'This only prints output.',
      timeout: 0,
    })).toThrow(/columns must be a whole number/);

    expect(() => validateRunInShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test waited validation',
      last_lines: 5,
      riskAssessment: 'This only prints output.',
      timeout: 0,
    })).toThrow(/full_output, last_lines, and regex are mutually exclusive options/);

    expect(() => validateRunInShellInput({
      command: 'echo ok',
      explanation: 'print ok',
      goal: 'test waited validation',
      regex_flags: 'i',
      riskAssessment: 'This only prints output.',
      timeout: 0,
    })).toThrow(/regex_flags requires regex/);
  });

  it('accepts valid waited shell options', async () => {
    const { validateRunInShellInput } = await import('../shellToolContracts.js');

    expect(validateRunInShellInput({
      columns: 320,
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test waited validation',
      riskAssessment: 'This only prints output.',
      timeout: 1000,
    })).toEqual({
      columns: 320,
      command: 'echo ok',
      explanation: 'print ok',
      full_output: true,
      goal: 'test waited validation',
      riskAssessment: 'This only prints output.',
      timeout: 1000,
    });
  });
});
