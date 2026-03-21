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

import { SHELL_OUTPUT_DIR_ENV_VAR } from '@/shellOutputConstants';
import {
  createFakeProcess,
} from '@/test/fakeShellProcess';

const spawn = vi.hoisted(() => vi.fn());
const runtimePlatformState = vi.hoisted(() => ({
  homeDir: '',
  platform: 'darwin' as NodeJS.Platform,
}));

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

vi.mock('node:child_process', () => ({
  spawn,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');

  return {
    ...actual,
    homedir: () => runtimePlatformState.homeDir,
    platform: () => runtimePlatformState.platform,
  };
});

vi.mock('vscode', () => vscode);

const shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellRuntimePlatform-test-'));
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

async function importShellRuntimeForPlatform(platform: NodeJS.Platform, homeDir: string) {
  vi.resetModules();

  runtimePlatformState.homeDir = homeDir;
  runtimePlatformState.platform = platform;

  return import('../shellRuntime.js');
}

afterEach(() => {
  runtimePlatformState.homeDir = '';
  runtimePlatformState.platform = 'darwin';
  spawn.mockReset();
  vi.resetModules();
  vi.restoreAllMocks();

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

describe('ShellRuntime platform-specific shell invocation', () => {
  it('uses cmd shell arguments on Windows when ComSpec is the fallback shell', async () => {
    const originalComSpec = process.env.ComSpec;

    try {
      process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
      process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
      spawn.mockReturnValue(createFakeProcess());
      const { ShellRuntime } = await importShellRuntimeForPlatform('win32', 'C:\\Users\\tester');

      const runtime = new ShellRuntime({});
      runtime.startBackgroundCommand('echo windows');

      expect(spawn).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\cmd.exe',
        [ '/d', '/s', '/c', 'echo windows' ],
        expect.objectContaining({
          cwd: 'C:\\Users\\tester',
        }),
      );
    }
    finally {
      process.env.ComSpec = originalComSpec;
    }
  });

  it('uses PowerShell arguments on Windows when pwsh is requested', async () => {
    process.env[SHELL_OUTPUT_DIR_ENV_VAR] = shellOutputTestDirectory;
    spawn.mockReturnValue(createFakeProcess());
    const { ShellRuntime } = await importShellRuntimeForPlatform('win32', 'C:\\Users\\tester');

    const runtime = new ShellRuntime({});
    runtime.startBackgroundCommand('Write-Output test', {
      shell: 'pwsh',
    });

    expect(spawn).toHaveBeenCalledWith(
      'pwsh',
      [ '-NoLogo', '-Command', 'Write-Output test' ],
      expect.objectContaining({
        cwd: 'C:\\Users\\tester',
      }),
    );
  });
});
