import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  getShellOutputDirectoryPath,
  getShellOutputFilePath,
} from '@/shellOutputStore';
import { SHELL_COMMAND_ID_PREFIX } from '@/shellRuntime';
import {
  registerShellTools,
  resetShellRuntimeForTest,
} from '@/shellTools';

const SHELL_ID_REGEX = /^[a-f0-9]{8}$/;
const temporaryDirectories = new Set<string>();

function createTemporaryDirectory(prefix: string): string {
  const directoryPath = fs.mkdtempSync(`${os.tmpdir()}/${prefix}`);
  temporaryDirectories.add(directoryPath);

  return directoryPath;
}

function createConfiguration(getter: (key: string) => unknown = () => undefined): { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn((key: string) => getter(key)),
  };
}

function expectedShellArgs(shell: string): string[] {
  const normalizedShellName = shell
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(bat|cmd|exe)$/u, '') ?? shell;

  if (os.platform() === 'win32') {
    if (normalizedShellName === 'powershell' || normalizedShellName === 'pwsh') {
      return [ '-NoLogo', '-Command' ];
    }

    return [ '/d', '/s', '/c' ];
  }

  return [ '-lc' ];
}

type FakeReadable = EventEmitter;

interface FakeProcess extends EventEmitter {
  exitCode: null | number;
  kill: ReturnType<typeof vi.fn>;
  signalCode: NodeJS.Signals | null;
  stderr: FakeReadable;
  stdout: FakeReadable;
}

function createFakeProcess(): FakeProcess {
  const processEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fakeProcess = Object.assign(processEmitter, {
    exitCode: null,
    kill: vi.fn(),
    signalCode: null,
    stderr,
    stdout,
  }) as FakeProcess;

  fakeProcess.kill.mockImplementation((signal?: NodeJS.Signals) => {
    fakeProcess.signalCode = signal ?? 'SIGTERM';
    fakeProcess.emit('close', null, signal ?? 'SIGTERM');
    return true;
  });

  return fakeProcess;
}

const spawn = vi.hoisted(() => vi.fn());
const getConfiguration = vi.hoisted(() => vi.fn());

const vscode = vi.hoisted(() => {
  class TestEventEmitter<T> {
    private readonly emitter = new EventEmitter();

    dispose(): void {
      this.emitter.removeAllListeners();
    }

    readonly event = (listener: (value: T) => void) => {
      this.emitter.on('event', listener as (value: unknown) => void);

      return {
        dispose: () => {
          this.emitter.off('event', listener as (value: unknown) => void);
        },
      };
    };

    fire(value: T): void {
      this.emitter.emit('event', value);
    }
  }

  function TreeItem(this: { collapsibleState: number; label: string }, label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }

  function LanguageModelTextPart(this: { value: string }, value: string) {
    this.value = value;
  }

  function LanguageModelToolResult(this: { content: unknown[] }, content: unknown[]) {
    this.content = content;
  }

  return {
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    Disposable: {
      from: vi.fn((...disposables: { dispose: () => void }[]) => ({
        dispose: () => {
          for (const disposable of disposables) {
            disposable.dispose();
          }
        },
      })),
    },
    env: {
      shell: '/bin/zsh',
    },
    EventEmitter: TestEventEmitter,
    LanguageModelTextPart,
    LanguageModelToolResult,
    lm: {
      registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    },
    ThemeIcon: vi.fn(),
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        append: vi.fn(),
        appendLine: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
        show: vi.fn(),
      })),
      createTreeView: vi.fn(() => ({
        dispose: vi.fn(),
        onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
      })),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      getConfiguration,
      workspaceFolders: [
        {
          uri: {
            fsPath: '/workspace',
          },
        },
      ],
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn,
}));

vi.mock('vscode', () => vscode);

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
    invoke: (options: unknown, token: unknown) => Promise<{ content: { value: string }[] }>;
  };
}

function parseYamlScalar(value: string): unknown {
  const normalized = value.trim();

  if (normalized === 'null') {
    return null;
  }

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }

  try {
    return JSON.parse(normalized) as unknown;
  }
  catch {
    return normalized;
  }
}

function parseYamlObject(raw: string): Record<string, unknown> {
  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return lines.reduce<Record<string, unknown>>((acc, line) => {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex < 0) {
      return acc;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    acc[key] = parseYamlScalar(value);
    return acc;
  }, {});
}

function getResultPayload(result: { content: { value: string }[] }): Record<string, unknown> {
  if (result.content.length === 0) {
    return {};
  }

  const metadataRaw = result.content[0].value;
  const metadata = parseYamlObject(metadataRaw);

  if (result.content.length < 2) {
    return metadata;
  }

  return {
    ...metadata,
    output: result.content[1].value,
  };
}

function setupShellTools(fakeProcess: FakeProcess = createFakeProcess()): {
  awaitTool: ReturnType<typeof getRegisteredTool>;
  fakeProcess: FakeProcess;
  getOutputTool: ReturnType<typeof getRegisteredTool>;
  killTool: ReturnType<typeof getRegisteredTool>;
  runAsyncTool: ReturnType<typeof getRegisteredTool>;
  runSyncTool: ReturnType<typeof getRegisteredTool>;
} {
  spawn.mockReturnValue(fakeProcess);
  registerShellTools();

  return {
    awaitTool: getRegisteredTool('await_shell'),
    fakeProcess,
    getOutputTool: getRegisteredTool('get_shell_output'),
    killTool: getRegisteredTool('kill_shell'),
    runAsyncTool: getRegisteredTool('run_in_async_shell'),
    runSyncTool: getRegisteredTool('run_in_sync_shell'),
  };
}

describe('shell tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetShellRuntimeForTest();
    getConfiguration.mockReturnValue(createConfiguration());
  });

  afterEach(() => {
    fs.rmSync(getShellOutputDirectoryPath(), { force: true, recursive: true });

    for (const directoryPath of temporaryDirectories) {
      fs.rmSync(directoryPath, { force: true, recursive: true });
    }

    temporaryDirectories.clear();
  });

  it('registers all shell tools', () => {
    const registration = registerShellTools();

    expect(vscode.lm.registerTool).toHaveBeenCalledWith('run_in_sync_shell', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('run_in_async_shell', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('await_shell', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('get_shell_output', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('get_shell_command', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('get_last_shell_command', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('kill_shell', expect.any(Object));
    expect(vscode.Disposable.from).toHaveBeenCalledTimes(2);
    expect(registration).toBeDefined();
  });

  it('runs a background command and exposes incremental output, await, kill, and last command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');
    const awaitTool = getRegisteredTool('await_shell');
    const killTool = getRegisteredTool('kill_shell');
    const getShellCommandTool = getRegisteredTool('get_shell_command');
    const getLastShellCommandTool = getRegisteredTool('get_last_shell_command');

    expect(runTool).toBeDefined();
    expect(getOutputTool).toBeDefined();
    expect(awaitTool).toBeDefined();
    expect(killTool).toBeDefined();
    expect(getShellCommandTool).toBeDefined();
    expect(getLastShellCommandTool).toBeDefined();

    const runResult = await runTool.invoke({
      input: {
        command: 'echo hello',
        explanation: 'prints a value',
        goal: 'test background execution',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;
    expect(shellId).toMatch(SHELL_ID_REGEX);

    fakeProcess.stdout.emit('data', 'hello\n');

    const outputResult = await getOutputTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload).not.toHaveProperty('exitCode');
    expect(outputPayload.isRunning).toBe(true);
    expect(outputPayload.output).toBe('hello\n');
    expect(outputPayload.shell).toBe('/bin/zsh');
    expect(outputPayload).not.toHaveProperty('terminationSignal');

    const noNewOutputResult = await getOutputTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const noNewOutputPayload = getResultPayload(noNewOutputResult);
    expect(noNewOutputPayload).not.toHaveProperty('exitCode');
    expect(noNewOutputPayload.output).toBe('');
    expect(noNewOutputPayload.shell).toBe('/bin/zsh');
    expect(noNewOutputPayload).not.toHaveProperty('terminationSignal');

    fakeProcess.stdout.emit('data', 'world\nmatch-line\n');

    const lastLinesResult = await getOutputTool.invoke({
      input: {
        id: shellId,
        last_lines: 2,
      },
      toolInvocationToken: undefined,
    }, {});

    const lastLinesPayload = getResultPayload(lastLinesResult);
    expect(lastLinesPayload.output).toBe('world\nmatch-line\n');

    fakeProcess.stdout.emit('data', 'nomatch\nonly-match\n');

    const regexResult = await getOutputTool.invoke({
      input: {
        id: shellId,
        regex: '^only-match$',
      },
      toolInvocationToken: undefined,
    }, {});

    const regexPayload = getResultPayload(regexResult);
    expect(regexPayload.output).toBe('only-match\n');

    fakeProcess.stdout.emit('data', 'CaseSensitive\n');

    const regexFlagsResult = await getOutputTool.invoke({
      input: {
        id: shellId,
        regex: '^casesensitive$',
        regex_flags: 'i',
      },
      toolInvocationToken: undefined,
    }, {});

    const regexFlagsPayload = getResultPayload(regexFlagsResult);
    expect(regexFlagsPayload.output).toBe('CaseSensitive\n');

    const fullOutputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const fullOutputPayload = getResultPayload(fullOutputResult);
    expect(fullOutputPayload.output).toBe('hello\nworld\nmatch-line\nnomatch\nonly-match\nCaseSensitive\n');

    await expect(getOutputTool.invoke({
      input: {
        id: shellId,
        last_lines: 1,
        regex: 'hello',
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('mutually exclusive');

    await expect(getOutputTool.invoke({
      input: {
        id: shellId,
        regex_flags: 'i',
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('regex_flags requires regex');

    const timedAwaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 5,
      },
      toolInvocationToken: undefined,
    }, {});

    const timedAwaitPayload = getResultPayload(timedAwaitResult);
    expect(timedAwaitPayload).not.toHaveProperty('output');
    expect(timedAwaitPayload.timedOut).toBe(true);

    await killTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const completedAwaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const completedAwaitPayload = getResultPayload(completedAwaitResult);
    expect(completedAwaitPayload).not.toHaveProperty('output');
    expect(completedAwaitPayload).not.toHaveProperty('timedOut');
    expect(fakeProcess.kill).toHaveBeenCalledWith('SIGTERM');

    const firstCompletedRead = await getOutputTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const firstCompletedReadPayload = getResultPayload(firstCompletedRead);
    expect(firstCompletedReadPayload).not.toHaveProperty('exitCode');
    expect(firstCompletedReadPayload).not.toHaveProperty('isRunning');
    expect(firstCompletedReadPayload.output).toBe('');
    expect(firstCompletedReadPayload.shell).toBe('/bin/zsh');
    expect(firstCompletedReadPayload.terminationSignal).toBe('SIGTERM');

    const secondCompletedRead = await getOutputTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const secondCompletedReadPayload = getResultPayload(secondCompletedRead);
    expect(secondCompletedReadPayload).not.toHaveProperty('exitCode');
    expect(secondCompletedReadPayload.output).toBe('hello\nworld\nmatch-line\nnomatch\nonly-match\nCaseSensitive\n');
    expect(secondCompletedReadPayload.shell).toBe('/bin/zsh');
    expect(secondCompletedReadPayload.terminationSignal).toBe('SIGTERM');

    const lastResult = await getLastShellCommandTool.invoke({
      input: {},
      toolInvocationToken: undefined,
    }, {});

    const lastPayload = getResultPayload(lastResult);
    expect(lastPayload.command).toBe('echo hello');

    const perShellLastResult = await getShellCommandTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const perShellPayload = getResultPayload(perShellLastResult);
    expect(perShellPayload.command).toBe('echo hello');
  });

  it('keeps output when process closes with SIGINT', async () => {
    const {
      awaitTool,
      fakeProcess,
      getOutputTool,
      runAsyncTool,
    } = setupShellTools();

    const runResult = await runAsyncTool.invoke({
      input: {
        command: 'echo keep',
        explanation: 'sigint behavior test',
        goal: 'verify no purge on sigint',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'before-int\n');
    fakeProcess.emit('close', null, 'SIGINT');

    const awaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload).not.toHaveProperty('output');
    expect(awaitPayload.terminationSignal).toBe('SIGINT');

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});
    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.output).toContain('before-int');
  });

  it('treats process exit as completion even if close never arrives', async () => {
    const {
      awaitTool,
      fakeProcess,
      getOutputTool,
      killTool,
      runAsyncTool,
    } = setupShellTools();

    const runResult = await runAsyncTool.invoke({
      input: {
        command: 'echo controlled-failure',
        explanation: 'exit without close test',
        goal: 'verify exit completes command tracking',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'final visible line\n');
    fakeProcess.emit('exit', 127, null);

    const awaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload.exitCode).toBe(127);
    expect(awaitPayload.timedOut).toBeUndefined();

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.exitCode).toBe(127);
    expect(outputPayload).not.toHaveProperty('isRunning');
    expect(outputPayload.output).toBe('final visible line\n');

    const killResult = await killTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const killPayload = getResultPayload(killResult);
    expect(killPayload.killed).toBe(false);
    expect(fakeProcess.kill).not.toHaveBeenCalled();
  });

  it('keeps draining output after exit until close completes the command', async () => {
    const {
      awaitTool,
      fakeProcess,
      getOutputTool,
      runAsyncTool,
    } = setupShellTools();

    const runResult = await runAsyncTool.invoke({
      input: {
        command: 'echo exit-drain',
        explanation: 'exit drain test',
        goal: 'verify post-exit output is preserved until close',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    const awaitPromise = awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    fakeProcess.stdout.emit('data', 'before-exit\n');
    fakeProcess.emit('exit', 127, null);
    fakeProcess.stdout.emit('data', 'after-exit\n');
    fakeProcess.emit('close', 0, 'SIGTERM');

    const awaitResult = await awaitPromise;

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload.exitCode).toBe(127);
    expect(awaitPayload.terminationSignal).toBeUndefined();
    expect(awaitPayload.timedOut).toBeUndefined();

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.exitCode).toBe(127);
    expect(outputPayload).not.toHaveProperty('terminationSignal');
    expect(outputPayload.output).toBe('before-exit\nafter-exit\n');
  });

  it('uses close as a fallback when it arrives before exit', async () => {
    const {
      awaitTool,
      fakeProcess,
      getOutputTool,
      killTool,
      runAsyncTool,
    } = setupShellTools();

    const runResult = await runAsyncTool.invoke({
      input: {
        command: 'echo close-first',
        explanation: 'close before exit test',
        goal: 'verify close can finalize when exit is absent',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'close-first output\n');
    fakeProcess.emit('close', 0, 'SIGTERM');
    fakeProcess.emit('exit', 127, null);

    const awaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload.exitCode).toBe(0);
    expect(awaitPayload.terminationSignal).toBe('SIGTERM');
    expect(awaitPayload.timedOut).toBeUndefined();

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.exitCode).toBe(0);
    expect(outputPayload.terminationSignal).toBe('SIGTERM');
    expect(outputPayload.output).toBe('close-first output\n');

    const killResult = await killTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const killPayload = getResultPayload(killResult);
    expect(killPayload.killed).toBe(false);
    expect(fakeProcess.kill).not.toHaveBeenCalled();
  });

  it('stops treating a command as running when kill sees an already-exited process', async () => {
    const fakeProcess = createFakeProcess();
    fakeProcess.kill.mockImplementation(() => {
      fakeProcess.exitCode = 0;
      return false;
    });

    const {
      awaitTool,
      killTool,
      runAsyncTool,
    } = setupShellTools(fakeProcess);

    const runResult = await runAsyncTool.invoke({
      input: {
        command: 'echo almost-done',
        explanation: 'kill false fallback test',
        goal: 'verify completed state is recovered from child status',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    const killResult = await killTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const killPayload = getResultPayload(killResult);
    expect(killPayload.killed).toBe(false);

    const awaitResult = await awaitTool.invoke({
      input: {
        id: shellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload.exitCode).toBe(0);
    expect(awaitPayload.timedOut).toBeUndefined();
  });

  it('returns only id by default for foreground runs and exposes output via get_shell_output', async () => {
    const {
      fakeProcess,
      getOutputTool,
      runSyncTool,
    } = setupShellTools();

    const runPromise = runSyncTool.invoke({
      input: {
        command: 'echo foreground',
        explanation: 'foreground id-only behavior',
        goal: 'ensure output is not returned by default',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    fakeProcess.stdout.emit('data', 'hello\nworld\n');
    fakeProcess.emit('close', 0, null);

    const runResult = await runPromise;
    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    expect(shellId).toMatch(SHELL_ID_REGEX);
    expect(runPayload).toEqual({
      exitCode: 0,
      id: shellId,
      shell: '/bin/zsh',
    });
    expect(runPayload).not.toHaveProperty('output');

    const outputResult = await getOutputTool.invoke({
      input: { id: shellId },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload).not.toHaveProperty('isRunning');
    expect(outputPayload.output).toBe('hello\nworld\n');
    expect(outputPayload.exitCode).toBe(0);
    expect(outputPayload.shell).toBe('/bin/zsh');
    expect(outputPayload).not.toHaveProperty('terminationSignal');
  });

  it('returns opt-in foreground output when full_output, last_lines, or regex is provided', async () => {
    registerShellTools();

    const runTool = getRegisteredTool('run_in_sync_shell');

    const fullOutputProcess = createFakeProcess();
    spawn.mockReturnValueOnce(fullOutputProcess);

    const fullOutputPromise = runTool.invoke({
      input: {
        command: 'echo full',
        explanation: 'foreground full output behavior',
        full_output: true,
        goal: 'return full output inline',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    fullOutputProcess.stdout.emit('data', 'a\nb\nc\n');
    fullOutputProcess.emit('close', 0, null);

    const fullOutputResult = await fullOutputPromise;
    const fullOutputPayload = getResultPayload(fullOutputResult);
    expect(fullOutputPayload.id).toMatch(SHELL_ID_REGEX);
    expect(fullOutputPayload.output).toBe('a\nb\nc\n');

    const lastLinesProcess = createFakeProcess();
    spawn.mockReturnValueOnce(lastLinesProcess);

    const lastLinesPromise = runTool.invoke({
      input: {
        command: 'echo lines',
        explanation: 'foreground last lines behavior',
        goal: 'return only trailing lines inline',
        last_lines: 2,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    lastLinesProcess.stdout.emit('data', 'a\nb\nc\n');
    lastLinesProcess.emit('close', 0, null);

    const lastLinesResult = await lastLinesPromise;
    const lastLinesPayload = getResultPayload(lastLinesResult);
    expect(lastLinesPayload.id).toMatch(SHELL_ID_REGEX);
    expect(lastLinesPayload.output).toBe('b\nc\n');

    const regexProcess = createFakeProcess();
    spawn.mockReturnValueOnce(regexProcess);

    const regexPromise = runTool.invoke({
      input: {
        command: 'echo regex',
        explanation: 'foreground regex behavior',
        goal: 'return only matching lines inline',
        regex: '^b$|^c$',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    regexProcess.stdout.emit('data', 'a\nb\nc\n');
    regexProcess.emit('close', 0, null);

    const regexResult = await regexPromise;
    const regexPayload = getResultPayload(regexResult);
    expect(regexPayload.id).toMatch(SHELL_ID_REGEX);
    expect(regexPayload.output).toBe('b\nc\n');

    const regexFlagsProcess = createFakeProcess();
    spawn.mockReturnValueOnce(regexFlagsProcess);

    const regexFlagsPromise = runTool.invoke({
      input: {
        command: 'echo regex-flags',
        explanation: 'foreground regex flags behavior',
        goal: 'return matching lines inline using regex flags',
        regex: '^b$',
        regex_flags: 'i',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    regexFlagsProcess.stdout.emit('data', 'A\nB\nC\n');
    regexFlagsProcess.emit('close', 0, null);

    const regexFlagsResult = await regexFlagsPromise;
    const regexFlagsPayload = getResultPayload(regexFlagsResult);
    expect(regexFlagsPayload.id).toMatch(SHELL_ID_REGEX);
    expect(regexFlagsPayload.output).toBe('B\n');

    await expect(runTool.invoke({
      input: {
        command: 'echo invalid',
        explanation: 'invalid options test',
        goal: 'reject mutually exclusive filters',
        last_lines: 1,
        regex: 'a',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('mutually exclusive');

    await expect(runTool.invoke({
      input: {
        command: 'echo invalid-full-lines',
        explanation: 'invalid options test',
        full_output: true,
        goal: 'reject mutually exclusive output options',
        last_lines: 1,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('mutually exclusive');

    await expect(runTool.invoke({
      input: {
        command: 'echo invalid-full-regex',
        explanation: 'invalid options test',
        full_output: true,
        goal: 'reject mutually exclusive output options',
        regex: 'a',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('mutually exclusive');

    await expect(runTool.invoke({
      input: {
        command: 'echo invalid-regex-flags-only',
        explanation: 'invalid regex flags options test',
        goal: 'reject regex_flags without regex',
        regex_flags: 'i',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('regex_flags requires regex');
  });

  it('uses provided shell when shell input is set', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const selectedShell = os.platform() === 'win32' ? 'pwsh.exe' : '/bin/bash';
    const customCwd = createTemporaryDirectory('agent-helper-kit-cwd-');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo with shell',
        cwd: customCwd,
        explanation: 'verify selected shell is used',
        goal: 'shell selection',
        shell: selectedShell,
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    expect(runPayload.id).toMatch(SHELL_ID_REGEX);
    expect(spawn).toHaveBeenCalledWith(
      selectedShell,
      [ ...expectedShellArgs(selectedShell), 'echo with shell' ],
      expect.objectContaining({
        cwd: customCwd,
      }),
    );
  });

  it('uses vscode default shell when shell input is omitted', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerShellTools();

    const runTool = getRegisteredTool('run_in_sync_shell');
    const defaultShell = os.platform() === 'win32' ? 'pwsh.exe' : '/bin/zsh';
    vscode.env.shell = defaultShell;

    const runPromise = runTool.invoke({
      input: {
        command: 'echo default shell',
        explanation: 'verify vscode default shell fallback',
        goal: 'default shell selection',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    expect(spawn).toHaveBeenCalledWith(
      defaultShell,
      [ ...expectedShellArgs(defaultShell), 'echo default shell' ],
      expect.objectContaining({
        cwd: '/workspace',
      }),
    );

    fakeProcess.emit('close', 0, null);
    await runPromise;
  });

  it('uses provided cwd for sync shell runs', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerShellTools();

    const runTool = getRegisteredTool('run_in_sync_shell');
    const customCwd = createTemporaryDirectory('agent-helper-kit-sync-cwd-');

    const runPromise = runTool.invoke({
      input: {
        command: 'echo custom cwd',
        cwd: customCwd,
        explanation: 'verify sync cwd override',
        goal: 'sync cwd selection',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    expect(spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [ ...expectedShellArgs('/bin/zsh'), 'echo custom cwd' ],
      expect.objectContaining({
        cwd: customCwd,
      }),
    );

    fakeProcess.emit('close', 0, null);
    await runPromise;
  });

  it('rejects missing cwd before spawning an async command', async () => {
    const { runAsyncTool } = setupShellTools();
    const missingCwd = `${os.tmpdir()}/agent-helper-kit-missing-cwd-${Date.now()}`;

    await expect(runAsyncTool.invoke({
      input: {
        command: 'echo missing cwd',
        cwd: missingCwd,
        explanation: 'verify missing cwd validation',
        goal: 'reject invalid cwd',
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('cwd does not exist or is inaccessible');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects inaccessible cwd before spawning a sync command', async () => {
    const { runSyncTool } = setupShellTools();
    const inaccessibleCwd = createTemporaryDirectory('agent-helper-kit-inaccessible-cwd-');

    if (os.platform() === 'win32') {
      return;
    }

    fs.chmodSync(inaccessibleCwd, 0o000);

    try {
      await expect(runSyncTool.invoke({
        input: {
          command: 'echo inaccessible cwd',
          cwd: inaccessibleCwd,
          explanation: 'verify inaccessible cwd validation',
          goal: 'reject inaccessible cwd',
          timeout: 0,
        },
        toolInvocationToken: undefined,
      }, {})).rejects.toThrow('cwd does not exist or is inaccessible');
    }
    finally {
      fs.chmodSync(inaccessibleCwd, 0o700);
    }

    expect(spawn).not.toHaveBeenCalled();
  });

  it('strips ANSI escape sequences from shell output payloads', async () => {
    registerShellTools();

    const runSyncTool = getRegisteredTool('run_in_sync_shell');
    const runAsyncTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');
    const awaitTool = getRegisteredTool('await_shell');
    const ansiDecoratedOutput = '\u001B[1m\u001B[46m RUN \u001B[49m\u001B[22m \u001B[36mv4.0.18\u001B[39m\n';

    const syncProcess = createFakeProcess();
    spawn.mockReturnValueOnce(syncProcess);

    const runSyncPromise = runSyncTool.invoke({
      input: {
        command: 'vitest run',
        explanation: 'strip ansi codes from sync output',
        full_output: true,
        goal: 'improve readability',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    syncProcess.stdout.emit('data', ansiDecoratedOutput);
    syncProcess.emit('close', 0, null);

    const runSyncResult = await runSyncPromise;
    const runSyncPayload = getResultPayload(runSyncResult);
    expect(runSyncPayload.output).toBe(' RUN  v4.0.18\n');

    const syncShellId = runSyncPayload.id as string;
    const getOutputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: syncShellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const getOutputPayload = getResultPayload(getOutputResult);
    expect(getOutputPayload.output).toBe(' RUN  v4.0.18\n');

    const asyncProcess = createFakeProcess();
    spawn.mockReturnValueOnce(asyncProcess);

    const runAsyncResult = await runAsyncTool.invoke({
      input: {
        command: 'vitest run --watch=false',
        explanation: 'strip ansi codes from async output',
        goal: 'improve readability',
      },
      toolInvocationToken: undefined,
    }, {});

    const runAsyncPayload = getResultPayload(runAsyncResult);
    const asyncShellId = runAsyncPayload.id as string;

    asyncProcess.stdout.emit('data', ansiDecoratedOutput);
    asyncProcess.emit('close', 0, null);

    const awaitResult = await awaitTool.invoke({
      input: {
        id: asyncShellId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload).not.toHaveProperty('output');

    const asyncOutputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: asyncShellId,
      },
      toolInvocationToken: undefined,
    }, {});
    const asyncOutputPayload = getResultPayload(asyncOutputResult);
    expect(asyncOutputPayload.output).toBe(' RUN  v4.0.18\n');
  });

  it('retains disk output when process closes with non-SIGINT signal', async () => {
    vi.useFakeTimers();

    try {
      const fakeProcess = createFakeProcess();
      spawn.mockReturnValue(fakeProcess);

      registerShellTools();

      const runTool = getRegisteredTool('run_in_async_shell');
      const awaitTool = getRegisteredTool('await_shell');
      const getOutputTool = getRegisteredTool('get_shell_output');

      const runResult = await runTool.invoke({
        input: {
          command: 'echo spill',
          explanation: 'signal purge test',
          goal: 'verify disk purge on sigterm',
        },
        toolInvocationToken: undefined,
      }, {});

      const runPayload = getResultPayload(runResult);
      const shellId = runPayload.id as string;

      fakeProcess.stdout.emit('data', 'spill-me\n');

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10);

      const outputFilePath = getShellOutputFilePath(`${SHELL_COMMAND_ID_PREFIX}${shellId}`);
      expect(fs.existsSync(outputFilePath)).toBe(true);

      fakeProcess.emit('close', null, 'SIGTERM');

      expect(fs.existsSync(outputFilePath)).toBe(true);

      const awaitResult = await awaitTool.invoke({
        input: {
          id: shellId,
          timeout: 0,
        },
        toolInvocationToken: undefined,
      }, {});

      const awaitPayload = getResultPayload(awaitResult);
      expect(awaitPayload).not.toHaveProperty('output');
      expect(awaitPayload.terminationSignal).toBe('SIGTERM');

      const outputResult = await getOutputTool.invoke({
        input: {
          full_output: true,
          id: shellId,
        },
        toolInvocationToken: undefined,
      }, {});
      const outputPayload = getResultPayload(outputResult);
      expect(outputPayload.output).toBe('spill-me\n');
    }
    finally {
      vi.useRealTimers();
    }
  });

  it('spills to file immediately when configured in-memory output limit is reached', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    getConfiguration.mockReturnValue(createConfiguration((key: string): number | undefined => {
      if (key === 'shellOutput.inMemoryOutputLimitKiB') {
        return 1 / 1024;
      }

      return undefined;
    }));

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo spill-now',
        explanation: 'spill by size threshold',
        goal: 'preserve full output after file spill',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'a');
    fakeProcess.stdout.emit('data', 'b');
    fakeProcess.stdout.emit('data', 'c');

    const outputFilePath = getShellOutputFilePath(`${SHELL_COMMAND_ID_PREFIX}${shellId}`);
    expect(fs.existsSync(outputFilePath)).toBe(true);

    fakeProcess.stdout.emit('data', 'd');
    fakeProcess.emit('close', 0, null);

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.output).toBe('abcd');
  });

  it('allows disabling the size-based spill threshold with 0', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    getConfiguration.mockReturnValue(createConfiguration((key: string): number | undefined => {
      if (key === 'shellOutput.inMemoryOutputLimitKiB') {
        return 0;
      }

      if (key === 'shellOutput.memoryToFileSpillMinutes') {
        return 60;
      }

      return undefined;
    }));

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo uncapped',
        explanation: 'disable size spill threshold',
        goal: 'keep output in memory until time-based spill',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'abc');
    fakeProcess.emit('close', 0, null);

    const outputFilePath = getShellOutputFilePath(`${SHELL_COMMAND_ID_PREFIX}${shellId}`);
    expect(fs.existsSync(outputFilePath)).toBe(false);

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.output).toBe('abc');
  });

  it('falls back to the default size spill threshold when configuration is invalid', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    getConfiguration.mockReturnValue(createConfiguration((key: string): number | undefined => {
      if (key === 'shellOutput.inMemoryOutputLimitKiB') {
        return Number.NaN;
      }

      if (key === 'shellOutput.memoryToFileSpillMinutes') {
        return 60;
      }

      return undefined;
    }));

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo fallback-threshold',
        explanation: 'invalid limit fallback',
        goal: 'keep the default spill threshold active',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'abc');
    fakeProcess.emit('close', 0, null);

    const outputFilePath = getShellOutputFilePath(`${SHELL_COMMAND_ID_PREFIX}${shellId}`);
    expect(fs.existsSync(outputFilePath)).toBe(false);

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.output).toBe('abc');
  });

  it('preserves repeated multi-byte chunks across the size spill boundary', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);
    getConfiguration.mockReturnValue(createConfiguration((key: string): number | undefined => {
      if (key === 'shellOutput.inMemoryOutputLimitKiB') {
        return 4 / 1024;
      }

      return undefined;
    }));

    registerShellTools();

    const runTool = getRegisteredTool('run_in_async_shell');
    const getOutputTool = getRegisteredTool('get_shell_output');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo multibyte-spill',
        explanation: 'spill by utf8 bytes',
        goal: 'keep all multibyte output after spilling',
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const shellId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'é');
    fakeProcess.stdout.emit('data', 'é');
    fakeProcess.stdout.emit('data', 'é');
    fakeProcess.emit('close', 0, null);

    const outputFilePath = getShellOutputFilePath(`${SHELL_COMMAND_ID_PREFIX}${shellId}`);
    expect(fs.existsSync(outputFilePath)).toBe(true);

    const outputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: shellId,
      },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.output).toBe('ééé');
  });
});
