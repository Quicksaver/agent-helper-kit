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

import { SHELL_OUTPUT_DIR_ENV_VAR } from '@/shellOutputStore';
import {
  createFakeProcess,
} from '@/test/fakeShellProcess';

const spawn = vi.hoisted(() => vi.fn());
const {
  defaultPlatformState,
  defaultSecurityState,
  platformState,
  securityState,
  vscode,
} = vi.hoisted(() => {
  const defaultState = {
    platform: 'darwin' as NodeJS.Platform,
  };

  const defaultShellSecurityState = {
    analyzeDecision: 'allow' as 'allow' | 'deny',
    analyzeReason: undefined as string | undefined,
    prepareDecision: 'allow' as 'allow' | 'deny',
    prepareReason: undefined as string | undefined,
  };

  const LanguageModelTextPart = function LanguageModelTextPart(this: { value: string }, value: string) {
    this.value = value;
  } as unknown as new (value: string) => { value: string };

  class LanguageModelToolResult {
    constructor(public readonly content: { value: string }[]) {}
  }

  return {
    defaultPlatformState: defaultState,
    defaultSecurityState: defaultShellSecurityState,
    platformState: { ...defaultState },
    securityState: { ...defaultShellSecurityState },
    vscode: {
      Disposable: {
        from: vi.fn(() => ({ dispose: vi.fn() })),
      },
      env: {
        shell: '   ',
      },
      LanguageModelTextPart,
      LanguageModelToolResult,
      lm: {
        registerTool: vi.fn((_name: string, tool: unknown) => tool),
      },
      workspace: {
        getConfiguration: vi.fn(() => ({
          get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        })),
        workspaceFolders: [
          {
            uri: {
              fsPath: '/workspace',
            },
          },
        ],
      },
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');

  return {
    ...actual,
    platform: () => platformState.platform,
  };
});

vi.mock('vscode', () => vscode);

vi.mock('@/shellCommandsPanel', () => ({
  registerShellCommandsPanel: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('@/shellRiskAssessment', () => ({
  registerShellRiskAssessmentModelCommand: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('@/shellToolSecurity', () => ({
  analyzeShellRunRuleDisposition: vi.fn(() => ({
    decision: securityState.analyzeDecision,
    reason: securityState.analyzeReason,
  })),
  buildShellRunConfirmationMessage: vi.fn(() => ''),
  decideShellRunApproval: vi.fn(async () => ({
    decision: securityState.prepareDecision,
    reason: securityState.prepareReason,
  })),
}));

let shellOutputTestDirectory = '';
const previousComSpec = process.env.ComSpec;
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

beforeEach(() => {
  shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellToolsPlatform-test-'));
});

function getRegisteredTool(name: string) {
  const registerToolMock = vscode.lm.registerTool as unknown as {
    mock: {
      calls: unknown[][];
    };
  };
  const call = registerToolMock.mock.calls.find(args => args[0] === name);

  if (!call) {
    throw new Error(`Tool not registered: ${name}`);
  }

  return call[1] as {
    invoke: (options: {
      input: Record<string, unknown>;
      toolInvocationToken?: undefined;
    }, token: unknown) => Promise<{ content: { value: string }[] }>;
  };
}

async function importShellToolsForPlatform(platform: NodeJS.Platform) {
  vi.resetModules();
  platformState.platform = platform;

  return import('../shellTools.js');
}

afterEach(() => {
  Object.assign(platformState, defaultPlatformState);
  Object.assign(securityState, defaultSecurityState);
  spawn.mockReset();
  vi.resetModules();
  vi.restoreAllMocks();
  (vscode.lm.registerTool as ReturnType<typeof vi.fn>).mockClear();
  (vscode.Disposable.from as ReturnType<typeof vi.fn>).mockClear();

  if (previousComSpec === undefined) {
    Reflect.deleteProperty(process.env, 'ComSpec');
  }
  else {
    process.env.ComSpec = previousComSpec;
  }

  if (previousShellOutputDirectory === undefined) {
    Reflect.deleteProperty(process.env, SHELL_OUTPUT_DIR_ENV_VAR);
  }
  else {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = previousShellOutputDirectory;
  }

  fs.rmSync(shellOutputTestDirectory, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 10,
  });
});

describe('shell tools platform fallbacks', () => {
  it('falls back to ComSpec when vscode has no default shell on Windows', async () => {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    spawn.mockReturnValue(createFakeProcess());

    const { registerShellTools } = await importShellToolsForPlatform('win32');
    registerShellTools();

    const runTool = getRegisteredTool('run_in_shell');
    const runPromise = runTool.invoke({
      input: {
        command: 'echo windows',
        explanation: 'verify ComSpec fallback',
        goal: 'cover Windows shell fallback',
        riskAssessment: 'This only prints output.',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [ '/d', '/s', '/c', 'echo windows' ],
      expect.objectContaining({
        cwd: '/workspace',
      }),
    );

    const fakeProcess = spawn.mock.results[0]?.value as ReturnType<typeof createFakeProcess>;
    fakeProcess.emit('close', 0, null);

    await expect(runPromise).resolves.toBeDefined();
  });

  it('uses the default deny message when invoke re-checks a deny without a reason', async () => {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
    securityState.analyzeDecision = 'deny';
    securityState.analyzeReason = undefined;

    const { registerShellTools } = await importShellToolsForPlatform('darwin');
    registerShellTools();

    const runTool = getRegisteredTool('run_in_shell');

    await expect(runTool.invoke({
      input: {
        command: 'echo blocked',
        explanation: 'verify fallback deny message',
        goal: 'cover invoke deny fallback',
        riskAssessment: 'This only prints output.',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('The shell approval policy denied this command.');

    expect(spawn).not.toHaveBeenCalled();
  });
});
