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
const shellOutputTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-shellRuntimePlatform-test-'));
const previousShellOutputDirectory = process.env[SHELL_OUTPUT_DIR_ENV_VAR];

async function importShellRuntimeForPlatform(platform: NodeJS.Platform, homeDir: string) {
  vi.resetModules();

  vi.doMock('node:child_process', () => ({
    spawn,
  }));
  vi.doMock('vscode', () => vscode);
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');

    return {
      ...actual,
      homedir: () => homeDir,
      platform: () => platform,
    };
  });

  return import('../shellRuntime.js');
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:os');
  vi.doUnmock('vscode');
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
    runtime.startBackgroundCommand('Write-Output test', 'pwsh');

    expect(spawn).toHaveBeenCalledWith(
      'pwsh',
      [ '-NoLogo', '-Command', 'Write-Output test' ],
      expect.objectContaining({
        cwd: 'C:\\Users\\tester',
      }),
    );
  });
});
