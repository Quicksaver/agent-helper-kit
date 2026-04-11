import {
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import {
  assessShellCommandRisk,
  registerShellRiskAssessmentModelCommand,
  SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY,
  SHELL_TOOLS_RISK_ASSESSMENT_TIMEOUT_MS_KEY,
  shellRiskAssessmentInternals,
} from '@/shellRiskAssessment';

const readFile = vi.hoisted(() => vi.fn());
const realpath = vi.hoisted(() => vi.fn(async (value: string) => value));
const stat = vi.hoisted(() => vi.fn(async () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}));
const logWarn = vi.hoisted(() => vi.fn());
const registerCommand = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const selectChatModels = vi.hoisted(() => vi.fn(async () => []));
const showInformationMessage = vi.hoisted(() => vi.fn());
const showQuickPick = vi.hoisted(() => vi.fn());
const showWarningMessage = vi.hoisted(() => vi.fn());
const updateConfiguration = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const getConfiguration = vi.hoisted(() => vi.fn());
const userMessage = vi.hoisted(() => vi.fn((value: string) => ({ role: 'user', value })));
const MockCancellationTokenSource = vi.hoisted(() => class {
  private readonly listeners = new Set<() => void>();

  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.add(listener);

      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    },
  };

  cancel(): void {
    this.token.isCancellationRequested = true;

    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
});

function createConfiguration(
  getter: (key: string, defaultValue?: unknown) => unknown = (_, defaultValue) => defaultValue,
) {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      const value = getter(key, defaultValue);

      return value === undefined ? defaultValue : value;
    }),
    update: updateConfiguration,
  };
}

function createResponseStream(chunks: string[]) {
  const text = (async function* responseTextStream() {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  return {
    stream: text,
    text,
  } as never;
}

function createModel(overrides: Partial<import('vscode').LanguageModelChat> & { id: string; vendor: string }) {
  return {
    countTokens: overrides.countTokens ?? (async () => 0),
    family: overrides.family ?? overrides.id,
    id: overrides.id,
    maxInputTokens: overrides.maxInputTokens ?? 128_000,
    name: overrides.name ?? overrides.id,
    sendRequest: overrides.sendRequest ?? (async () => createResponseStream([ 'allow::safe enough' ])),
    vendor: overrides.vendor,
    version: overrides.version ?? '1',
  } as unknown as import('vscode').LanguageModelChat;
}

function getRegisteredHandler(): () => Promise<void> {
  const call = registerCommand.mock.calls[0];

  expect(call).toBeDefined();

  return (call as unknown as [string, () => Promise<void>])[1];
}

function mockSelectChatModels(models: import('vscode').LanguageModelChat[]): void {
  (selectChatModels as unknown as Mock).mockResolvedValue(models);
}

vi.mock('node:fs/promises', () => ({
  readFile,
  realpath,
  stat,
}));

vi.mock('@/logging', () => ({
  logWarn,
}));

vi.mock('vscode', () => ({
  CancellationTokenSource: MockCancellationTokenSource,
  commands: {
    registerCommand,
  },
  ConfigurationTarget: {
    Global: 1,
  },
  LanguageModelChatMessage: {
    User: userMessage,
  },
  lm: {
    selectChatModels,
  },
  QuickPickItemKind: {
    Separator: -1,
  },
  window: {
    showInformationMessage,
    showQuickPick,
    showWarningMessage,
  },
  workspace: {
    getConfiguration,
  },
}));

describe('shell risk assessment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellRiskAssessmentInternals.resetShellRiskAssessmentCacheForTest();
    registerCommand.mockReset();
    selectChatModels.mockReset();
    showInformationMessage.mockReset();
    showQuickPick.mockReset();
    showWarningMessage.mockReset();
    updateConfiguration.mockReset();
    getConfiguration.mockReset();
    userMessage.mockReset();
    getConfiguration.mockReturnValue(createConfiguration());
    selectChatModels.mockImplementation(async () => []);
    updateConfiguration.mockImplementation(() => Promise.resolve());
    userMessage.mockImplementation((value: string) => ({ role: 'user', value }));
    readFile.mockResolvedValue('export const ok = true;');
    realpath.mockImplementation(async (value: string) => value);
    stat.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('registers the model selection command', () => {
    const disposable = registerShellRiskAssessmentModelCommand();

    expect(registerCommand).toHaveBeenCalledWith(
      'agent-helper-kit.shellTools.selectRiskAssessmentModel',
      expect.any(Function),
    );
    expect(disposable).toBeDefined();
  });

  it('warns when no chat models are available during model selection', async () => {
    registerShellRiskAssessmentModelCommand();

    const handler = getRegisteredHandler();

    await handler();

    expect(showWarningMessage).toHaveBeenCalledWith('No chat models are available for shell risk assessment.');
  });

  it('allows clearing the configured risk assessment model', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', vendor: 'copilot' }) ]);
    showQuickPick.mockResolvedValue({
      modelIdWithVendor: '__clearRiskAssessmentModel__',
      name: 'Disable model-based shell risk assessment',
    });

    registerShellRiskAssessmentModelCommand();
    const handler = getRegisteredHandler();

    await handler();

    expect(updateConfiguration).toHaveBeenCalledWith(
      SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY,
      '',
      1,
    );
    expect(showInformationMessage).toHaveBeenCalledWith('Shell risk assessment model disabled.');
  });

  it('updates the configured risk assessment model from the quick pick', async () => {
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', vendor: 'copilot' }) ]);
    showQuickPick.mockResolvedValue({
      modelIdWithVendor: 'copilot:gpt-4.1',
      name: 'GPT-4.1',
    });

    registerShellRiskAssessmentModelCommand();
    const handler = getRegisteredHandler();

    await handler();

    expect(updateConfiguration).toHaveBeenCalledWith(
      SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY,
      'copilot:gpt-4.1',
      1,
    );
    expect(showInformationMessage).toHaveBeenCalledWith('Shell risk assessment model set to: GPT-4.1');
  });

  it('falls back to the model id when the quick-pick result has no display name', async () => {
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', vendor: 'copilot' }) ]);
    showQuickPick.mockResolvedValue({
      modelIdWithVendor: 'copilot:gpt-4.1',
    });

    registerShellRiskAssessmentModelCommand();
    const handler = getRegisteredHandler();

    await handler();

    expect(showInformationMessage).toHaveBeenCalledWith(
      'Shell risk assessment model set to: copilot:gpt-4.1',
    );
  });

  it('does nothing when model selection is cancelled', async () => {
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', vendor: 'copilot' }) ]);
    showQuickPick.mockResolvedValue(undefined);

    registerShellRiskAssessmentModelCommand();
    const handler = getRegisteredHandler();

    await handler();

    expect(updateConfiguration).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('marks the current model in the picker when the stored value is a bare id', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'copilot' }) ]);
    showQuickPick.mockImplementation(async items => {
      expect(items).toContainEqual(expect.objectContaining({ label: '$(check) GPT-4.1' }));

      return undefined;
    });

    registerShellRiskAssessmentModelCommand();
    const handler = getRegisteredHandler();

    await handler();
  });

  it('groups models into recommended, vendor, and unsupported quick pick sections', () => {
    const items = shellRiskAssessmentInternals.getModelQuickPickItems([
      createModel({ id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'copilot' }),
      createModel({ id: 'claude-sonnet-4.6-pro', name: 'Claude Sonnet 4.6 Pro', vendor: 'copilot' }),
      createModel({ id: 'claude-sonnet-4-6-fast', name: 'Claude Sonnet 4.6', vendor: 'claude-model-provider' }),
      createModel({ id: 'azure-alpha', name: 'Azure Alpha', vendor: 'azure' }),
      createModel({ id: 'azure-fast', name: 'Azure Fast', vendor: 'azure' }),
      createModel({ id: 'gemini-pro', name: 'Gemini Pro', vendor: 'google' }),
      createModel({ id: 'haiku', name: 'Haiku', vendor: 'anthropic' }),
      createModel({ id: 'auto', name: 'Auto', vendor: 'copilot' }),
    ]);

    expect(items).toEqual([
      { kind: -1, label: 'Recommended Models' },
      expect.objectContaining({ label: 'GPT-4.1', modelIdWithVendor: 'copilot:gpt-4.1' }),
      expect.objectContaining({ label: 'Claude Sonnet 4.6 Pro', modelIdWithVendor: 'copilot:claude-sonnet-4.6-pro' }),
      expect.objectContaining({
        label: 'Claude Sonnet 4.6',
        modelIdWithVendor: 'claude-model-provider:claude-sonnet-4-6-fast',
      }),
      { kind: -1, label: 'Azure Models' },
      expect.objectContaining({ label: 'Azure Alpha', modelIdWithVendor: 'azure:azure-alpha' }),
      expect.objectContaining({ label: 'Azure Fast', modelIdWithVendor: 'azure:azure-fast' }),
      { kind: -1, label: 'Google Models' },
      expect.objectContaining({ label: 'Gemini Pro', modelIdWithVendor: 'google:gemini-pro' }),
      { kind: -1, label: 'Unsupported Models' },
      expect.objectContaining({ label: 'Haiku', modelIdWithVendor: 'anthropic:haiku' }),
      expect.objectContaining({ label: 'Auto', modelIdWithVendor: 'copilot:auto' }),
    ]);
  });

  it('omits recommended and unsupported separators when only uncategorized models exist', () => {
    const items = shellRiskAssessmentInternals.getModelQuickPickItems([
      createModel({ id: 'alpha', name: 'Alpha', vendor: undefined as unknown as string }),
      createModel({ id: 'zeta', name: 'Zeta', vendor: undefined as unknown as string }),
    ]);

    expect(items).toEqual([
      { kind: -1, label: 'Other Models' },
      expect.objectContaining({ label: 'Alpha', modelIdWithVendor: 'alpha' }),
      expect.objectContaining({ label: 'Zeta', modelIdWithVendor: 'zeta' }),
    ]);
  });

  it('parses deterministic risk assessment model responses', () => {
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('allow::looks safe')).toEqual({
      decision: 'allow',
      reason: 'looks safe',
    });
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('deny::catastrophic command')).toEqual({
      decision: 'deny',
      reason: 'catastrophic command',
    });
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('request::needs review')).toEqual({
      decision: 'request',
      reason: 'needs review',
    });
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('allow::looks safe\nignore this')).toBeUndefined();
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('allow::   ')).toBeUndefined();
    expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('maybe')).toBeUndefined();
  });

  it('fails closed when parsing produces an unsupported decision payload', () => {
    const originalExec = Object.getOwnPropertyDescriptor(RegExp.prototype, 'exec')?.value as
      | ((this: RegExp, value: string) => null | RegExpExecArray)
      | undefined;

    expect(originalExec).toBeDefined();

    const execSpy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function mockExec(this: RegExp, value: string) {
      if (this.source === '^(allow|deny|request)\\s*::\\s*(.+)$') {
        return [ 'maybe::reason', 'maybe', 'reason' ] as unknown as RegExpExecArray;
      }

      return originalExec?.call(this, value) ?? null;
    });

    try {
      expect(shellRiskAssessmentInternals.parseRiskAssessmentResponse('allow::looks safe')).toBeUndefined();
    }
    finally {
      execSpy.mockRestore();
    }
  });

  it('loads file-backed context and records read failures inline', async () => {
    readFile
      .mockResolvedValueOnce('console.log("hello")')
      .mockRejectedValueOnce('ENOENT');

    await expect(shellRiskAssessmentInternals.loadContextFiles([
      'scripts/run.js',
      'missing.js',
    ], '/workspace')).resolves.toEqual([
      {
        content: 'console.log("hello")',
        path: '/workspace/scripts/run.js',
      },
      {
        content: '[unable to read file: ENOENT]',
        path: '/workspace/missing.js',
      },
    ]);
  });

  it('falls back to the default timeout when the configured timeout is invalid', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_TIMEOUT_MS_KEY) {
        return 0;
      }

      return undefined;
    }));

    expect(shellRiskAssessmentInternals.getConfiguredRiskAssessmentTimeoutMs()).toBe(8000);
  });

  it('normalizes existing bare filenames as files, keeps non-files inline, and falls back when realpath fails', async () => {
    (stat as unknown as Mock)
      .mockResolvedValueOnce({ isFile: () => true })
      .mockResolvedValueOnce({ isFile: () => false });
    realpath.mockRejectedValueOnce(new Error('realpath unavailable'));

    await expect(shellRiskAssessmentInternals.normalizeRiskAssessmentContextEntries([
      'script.ts',
      'notes.txt',
    ], '/workspace')).resolves.toEqual([
      {
        kind: 'file',
        path: '/workspace/script.ts',
        sortKey: 'file:/workspace/script.ts',
      },
      {
        kind: 'inline',
        sortKey: 'inline:notes.txt',
        value: 'notes.txt',
      },
    ]);
  });

  it('truncates oversized context files and preserves absolute file paths', async () => {
    readFile
      .mockResolvedValueOnce('a'.repeat(12_100))
      .mockResolvedValueOnce('b'.repeat(60_000))
      .mockResolvedValueOnce('c'.repeat(60_000))
      .mockResolvedValueOnce('d'.repeat(60_000))
      .mockResolvedValueOnce('e'.repeat(60_000))
      .mockResolvedValueOnce('f'.repeat(60_000));

    const files = await shellRiskAssessmentInternals.loadContextFiles([
      '/absolute/path.js',
      'relative-1.txt',
      'relative-2.txt',
      'relative-3.txt',
      'relative-4.txt',
      'relative-5.txt',
    ], '/workspace');

    expect(files[0]).toEqual({
      content: `${'a'.repeat(12_000)}\n\n[... FILE CONTENT TRUNCATED ...]`,
      path: '/absolute/path.js',
    });
    expect(files).toHaveLength(5);
    expect(files[1]?.path).toBe('/workspace/relative-1.txt');
    expect(files[4]?.content).toContain('[... ADDITIONAL CONTEXT TRUNCATED ...]');
  });

  it('normalizes context entries so reordered pointers and equivalent paths share one cache key', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::safe enough after reviewing context' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    (stat as unknown as Mock).mockImplementation(async (targetPath: string) => ({
      isFile: () => targetPath === '/workspace/scripts/run.js',
    }));
    realpath.mockImplementation(async (targetPath: string) => targetPath);
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);
    readFile.mockResolvedValue('console.log("safe");');

    await expect(assessShellCommandRisk({
      command: 'npm run alias-task',
      cwd: '/workspace',
      explanation: 'run the alias',
      goal: 'refresh generated metadata',
      riskAssessment: 'This alias may run a workspace script that rewrites generated files.',
      riskAssessmentContext: [ 'scripts/run.js', 'alias expands to: node scripts/run.js --refresh' ],
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'safe enough after reviewing context',
    });

    await assessShellCommandRisk({
      command: 'npm run alias-task',
      cwd: '/workspace',
      explanation: 'run the alias again',
      goal: 'retry after transient shell failure',
      riskAssessment: 'This alias may run a workspace script that rewrites generated files.',
      riskAssessmentContext: [ 'alias expands to: node scripts/run.js --refresh', '/workspace/scripts/run.js' ],
    }, {} as never);

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<file path="/workspace/scripts/run.js">'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<context_item kind="inline">'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('alias expands to: node scripts/run.js --refresh'));
  });

  it('omits additional context entries once the total context budget is exhausted', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::context budget enforced' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);

    const oversizedInlineContext = [ 'A', 'B', 'C', 'D', 'E', 'F' ].map(label => `${label}_START:${label.toLowerCase().repeat(11_992)}`);

    await expect(assessShellCommandRisk({
      command: 'node scripts/huge-context.js',
      cwd: '/workspace',
      explanation: 'exercise context budgeting',
      goal: 'verify prompt truncation boundaries',
      riskAssessment: 'This command reads a large amount of inline risk context.',
      riskAssessmentContext: oversizedInlineContext,
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'context budget enforced',
    });

    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('A_START:'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('E_START:'));
    expect(userMessage).not.toHaveBeenCalledWith(expect.stringContaining('F_START:'));
  });

  it('evicts non-response model results from the session cache so retries can recover', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::safe enough after retry' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    (selectChatModels as unknown as Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);

    await expect(assessShellCommandRisk({
      command: 'git checkout main',
      cwd: '/workspace',
      explanation: 'switch branches',
      goal: 'move to main',
      riskAssessment: 'This may replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      kind: 'error',
      modelId: 'copilot:gpt-4.1',
      reason: 'Configured risk assessment model `copilot:gpt-4.1` is not available.',
    });

    await expect(assessShellCommandRisk({
      command: 'git checkout main',
      cwd: '/workspace',
      explanation: 'switch branches',
      goal: 'move to main',
      riskAssessment: 'This may replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'safe enough after retry',
    });

    expect(selectChatModels).toHaveBeenCalledTimes(2);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('returns disabled when no risk assessment model is configured', async () => {
    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, {} as never)).resolves.toEqual({ kind: 'disabled' });
  });

  it('returns an error when the configured model cannot be found', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));

    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, {} as never)).resolves.toEqual({
      kind: 'error',
      modelId: 'copilot:gpt-4.1',
      reason: 'Configured risk assessment model `copilot:gpt-4.1` is not available.',
    });
  });

  it('prompts the configured model with command, risk summary, and loaded file context', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::safe enough after reviewing the script' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);
    readFile.mockResolvedValue('import "./dep";\nconsole.log("safe");');

    await expect(assessShellCommandRisk({
      command: 'node scripts/run.js',
      cwd: '/workspace',
      explanation: 'run the helper script',
      goal: 'refresh generated metadata',
      riskAssessment: 'This script may rewrite generated files under the workspace.',
      riskAssessmentContext: [ 'scripts/run.js' ],
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'safe enough after reviewing the script',
    });

    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<command>node scripts/run.js</command>'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<risk_assessment>This script may rewrite generated files under the workspace.</risk_assessment>'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<file path="/workspace/scripts/run.js">'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('script-injection, prompt-injection, or fetched-content dangers'));
    expect(sendRequest).toHaveBeenCalled();
  });

  it('escapes prompt tag content and file path attributes before sending them to the model', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::escaped safely' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);

    await assessShellCommandRisk({
      command: 'echo </command> && echo <safe>',
      cwd: '/workspace',
      explanation: 'quote <this>',
      goal: 'avoid </goal> prompt breaks',
      riskAssessment: 'This <might> rewrite generated files & needs review.',
      riskAssessmentContext: [ '/workspace/script"quoted".ts' ],
    }, {} as never);

    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining(
      '<command>echo &lt;/command&gt; &amp;&amp; echo &lt;safe&gt;</command>',
    ));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining(
      '<risk_assessment>This &lt;might&gt; rewrite generated files &amp; needs review.</risk_assessment>',
    ));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining(
      '<file path="/workspace/script&quot;quoted&quot;.ts">',
    ));
  });

  it('includes unreadable file placeholders when cached prompt context cannot be loaded', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'allow::safe enough after reviewing the placeholder' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);
    readFile.mockRejectedValueOnce('ENOENT');

    await expect(assessShellCommandRisk({
      command: 'bash scripts/missing.sh',
      cwd: '/workspace',
      explanation: 'run a missing helper',
      goal: 'exercise placeholder context loading',
      riskAssessment: 'This would run a workspace helper if it existed.',
      riskAssessmentContext: [ 'scripts/missing.sh' ],
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'safe enough after reviewing the placeholder',
    });

    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('[unable to read file: ENOENT]'));
  });

  it('supports configured model ids without an explicit vendor prefix', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', vendor: 'copilot' }) ]);

    await assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, {} as never);

    expect(selectChatModels).toHaveBeenCalledWith({
      id: 'gpt-4.1',
      vendor: undefined,
    });
  });

  it('uses placeholder prompt sections and returns request decisions from the model', async () => {
    const sendRequest = vi.fn(async () => createResponseStream([ 'request::needs confirmation' ]));

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([ createModel({ id: 'gpt-4.1', sendRequest, vendor: 'copilot' }) ]);

    await expect(assessShellCommandRisk({
      command: 'customcmd --apply',
      cwd: '/workspace',
      riskAssessment: 'This command may modify generated files.',
    }, {} as never)).resolves.toEqual({
      decision: 'request',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'needs confirmation',
    });

    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<explanation>(not provided)</explanation>'));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining('<goal>(not provided)</goal>'));
    expect(userMessage).toHaveBeenCalledWith(
      expect.stringContaining('<risk_assessment_context>(none provided)</risk_assessment_context>'),
    );
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining(
      'If the command appears to rely on scripts, aliases, package-manager script definitions, generated shell fragments, or fetched/remote content and the provided context does not make it clear what will actually run or what data will be consumed, request user confirmation.',
    ));
    expect(userMessage).toHaveBeenCalledWith(expect.stringContaining(
      'Treat missing or incomplete script definitions, alias expansions, or fetched-content details as insufficient context for auto-approval.',
    ));
  });

  it('uses the configured timeout and returns a timeout result when the model does not answer in time', async () => {
    vi.useFakeTimers();

    try {
      let requestToken: undefined | { isCancellationRequested: boolean };

      getConfiguration.mockReturnValue(createConfiguration(key => {
        if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
          return 'copilot:gpt-4.1';
        }

        if (key === SHELL_TOOLS_RISK_ASSESSMENT_TIMEOUT_MS_KEY) {
          return 25;
        }

        return undefined;
      }));
      mockSelectChatModels([
        createModel({
          id: 'gpt-4.1',
          sendRequest: vi.fn(async (_messages, _options, token) => {
            requestToken = token as { isCancellationRequested: boolean };

            return new Promise<never>((resolve, reject) => {
              void resolve;
              void reject;
            });
          }),
          vendor: 'copilot',
        }),
      ]);

      const assessmentPromise = assessShellCommandRisk({
        command: 'git checkout main',
        cwd: '/workspace',
        explanation: 'switch branches',
        goal: 'move to main',
        riskAssessment: 'This may replace files in the working tree.',
      }, {} as never);

      await vi.advanceTimersByTimeAsync(25);

      await expect(assessmentPromise).resolves.toEqual({
        kind: 'timeout',
        modelId: 'copilot:gpt-4.1',
        reason: 'Risk assessment model `copilot:gpt-4.1` timed out after 25ms.',
        timeoutMs: 25,
      });
      expect(requestToken?.isCancellationRequested).toBe(true);
      expect(logWarn).toHaveBeenCalledWith('Shell risk assessment timed out for model copilot:gpt-4.1 after 25ms.');
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('passes through an already-cancelled token even when no cancellation listener is available', async () => {
    let requestToken: undefined | { isCancellationRequested: boolean };

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([
      createModel({
        id: 'gpt-4.1',
        sendRequest: vi.fn(async (_messages, _options, token) => {
          requestToken = token as { isCancellationRequested: boolean };

          return createResponseStream([ 'allow::already cancelled but still parsed' ]);
        }),
        vendor: 'copilot',
      }),
    ]);

    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, { isCancellationRequested: true } as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'already cancelled but still parsed',
    });

    expect(requestToken?.isCancellationRequested).toBe(true);
  });

  it('propagates external cancellation requests to the model token', async () => {
    let requestToken: undefined | { isCancellationRequested: boolean };
    let triggerCancellation: (() => void) | undefined;

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([
      createModel({
        id: 'gpt-4.1',
        sendRequest: vi.fn(async (_messages, _options, token) => {
          requestToken = token as { isCancellationRequested: boolean };
          triggerCancellation?.();

          return createResponseStream([ 'allow::cancel propagated' ]);
        }),
        vendor: 'copilot',
      }),
    ]);

    const externalToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        triggerCancellation = () => {
          externalToken.isCancellationRequested = true;
          listener();
        };

        return {
          dispose: () => {
            triggerCancellation = undefined;
          },
        };
      },
    };

    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, externalToken as never)).resolves.toEqual({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'cancel propagated',
    });

    expect(requestToken?.isCancellationRequested).toBe(true);
  });

  it('returns an error when the model response is not parseable', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([
      createModel({
        id: 'gpt-4.1',
        sendRequest: vi.fn(async () => createResponseStream([ 'not valid output' ])),
        vendor: 'copilot',
      }),
    ]);

    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, {} as never)).resolves.toEqual({
      kind: 'error',
      modelId: 'copilot:gpt-4.1',
      reason: 'Risk assessment model `copilot:gpt-4.1` returned an unrecognized response.',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Shell risk assessment model copilot:gpt-4.1 returned an unrecognized response: not valid output',
    );
  });

  it('returns an error when the model request throws', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([
      createModel({
        id: 'gpt-4.1',
        sendRequest: vi.fn(async () => {
          throw new Error('boom');
        }),
        vendor: 'copilot',
      }),
    ]);

    await expect(assessShellCommandRisk({
      command: 'git status',
      cwd: '/workspace',
      explanation: 'inspect state',
      goal: 'read repo status',
      riskAssessment: 'Read-only command.',
    }, {} as never)).resolves.toEqual({
      kind: 'error',
      modelId: 'copilot:gpt-4.1',
      reason: 'Risk assessment model `copilot:gpt-4.1` failed: boom',
    });
    expect(logWarn).toHaveBeenCalledWith('Shell risk assessment failed for model copilot:gpt-4.1: boom');
  });

  it('falls back to an error result when pre-prompt cache preparation fails', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));

    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('cache key failed');
    });

    try {
      await expect(assessShellCommandRisk({
        command: 'git checkout main',
        cwd: '/workspace',
        explanation: 'switch branches',
        goal: 'move to main',
        riskAssessment: 'This may replace files in the working tree.',
      }, {} as never)).resolves.toEqual({
        kind: 'error',
        modelId: 'copilot:gpt-4.1',
        reason: 'Risk assessment model `copilot:gpt-4.1` failed: cache key failed',
      });
    }
    finally {
      stringifySpy.mockRestore();
    }

    expect(selectChatModels).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('Shell risk assessment failed for model copilot:gpt-4.1: cache key failed');
  });

  it('cleans up the cache key when cache storage fails after key generation', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));

    const mapSetSpy = vi.spyOn(Map.prototype, 'set').mockImplementationOnce(() => {
      throw new Error('cache store failed');
    });

    try {
      await expect(assessShellCommandRisk({
        command: 'git checkout main',
        cwd: '/workspace',
        explanation: 'switch branches',
        goal: 'move to main',
        riskAssessment: 'This may replace files in the working tree.',
      }, {} as never)).resolves.toEqual({
        kind: 'error',
        modelId: 'copilot:gpt-4.1',
        reason: 'Risk assessment model `copilot:gpt-4.1` failed: cache store failed',
      });
    }
    finally {
      mapSetSpy.mockRestore();
    }

    expect(logWarn).toHaveBeenCalledWith('Shell risk assessment failed for model copilot:gpt-4.1: cache store failed');
  });

  it('returns a deny decision when the model flags a command as clearly destructive', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY) {
        return 'copilot:gpt-4.1';
      }

      return undefined;
    }));
    mockSelectChatModels([
      createModel({
        id: 'gpt-4.1',
        sendRequest: vi.fn(async () => createResponseStream([ 'deny::This is a catastrophic root-level deletion command.' ])),
        vendor: 'copilot',
      }),
    ]);

    await expect(assessShellCommandRisk({
      command: 'rm -rf / --no-preserve-root',
      cwd: '/workspace',
      explanation: 'delete everything',
      goal: 'destroy the machine',
      riskAssessment: 'This is an outright destructive root-level delete.',
    }, {} as never)).resolves.toEqual({
      decision: 'deny',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'This is a catastrophic root-level deletion command.',
    });
  });
});
