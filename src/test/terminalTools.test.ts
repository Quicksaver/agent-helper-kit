import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  getTerminalOutputDirectoryPath,
  getTerminalOutputFilePath,
} from '@/terminalOutputStore';
import { registerTerminalTools } from '@/terminalTools';

type FakeReadable = EventEmitter;

interface FakeProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  stderr: FakeReadable;
  stdout: FakeReadable;
}

function createFakeProcess(): FakeProcess {
  const processEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const kill = vi.fn((signal?: NodeJS.Signals) => {
    processEmitter.emit('close', null, signal ?? 'SIGTERM');
    return true;
  });

  return Object.assign(processEmitter, {
    kill,
    stderr,
    stdout,
  }) as FakeProcess;
}

const spawn = vi.hoisted(() => vi.fn());

const vscode = vi.hoisted(() => {
  function LanguageModelTextPart(this: { value: string }, value: string) {
    this.value = value;
  }

  function LanguageModelToolResult(this: { content: unknown[] }, content: unknown[]) {
    this.content = content;
  }

  return {
    Disposable: {
      from: vi.fn((...disposables: { dispose: () => void }[]) => ({
        dispose: () => {
          for (const disposable of disposables) {
            disposable.dispose();
          }
        },
      })),
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    lm: {
      registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn(() => undefined),
      })),
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
    invoke: (options: unknown, token: unknown) => Promise<{ content: [{ value: string }] }>;
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

function getResultPayload(result: { content: [{ value: string }] }): Record<string, unknown> {
  const raw = result.content[0].value;

  if (raw.startsWith('---\n')) {
    const closingIndex = raw.indexOf('\n---\n', 4);

    if (closingIndex < 0) {
      throw new Error('Invalid frontmatter result format');
    }

    const frontmatterRaw = raw.slice(4, closingIndex);
    const markdownBody = raw.slice(closingIndex + 5);
    const outputMatch = /^\n````text\n([\s\S]*?)\n````$/.exec(markdownBody);

    if (!outputMatch) {
      throw new Error('Invalid markdown output block format');
    }

    return {
      ...parseYamlObject(frontmatterRaw),
      output: outputMatch[1],
    };
  }

  return parseYamlObject(raw);
}

describe('terminal tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(getTerminalOutputDirectoryPath(), { force: true, recursive: true });
  });

  it('registers all custom terminal tools', () => {
    const registration = registerTerminalTools();

    expect(vscode.lm.registerTool).toHaveBeenCalledWith('run_in_sync_terminal', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('run_in_async_terminal', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('await_terminal_enhanced', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('get_terminal_output_enhanced', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('kill_terminal_enhanced', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('terminal_last_command_enhanced', expect.any(Object));
    expect(vscode.Disposable.from).toHaveBeenCalledOnce();
    expect(registration).toBeDefined();
  });

  it('runs a background command and exposes incremental output, await, kill, and last command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerTerminalTools();

    const runTool = getRegisteredTool('run_in_async_terminal');
    const getOutputTool = getRegisteredTool('get_terminal_output_enhanced');
    const awaitTool = getRegisteredTool('await_terminal_enhanced');
    const killTool = getRegisteredTool('kill_terminal_enhanced');
    const lastCommandTool = getRegisteredTool('terminal_last_command_enhanced');

    expect(runTool).toBeDefined();
    expect(getOutputTool).toBeDefined();
    expect(awaitTool).toBeDefined();
    expect(killTool).toBeDefined();
    expect(lastCommandTool).toBeDefined();

    const runResult = await runTool.invoke({
      input: {
        command: 'echo hello',
        explanation: 'prints a value',
        goal: 'test background execution',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const terminalId = runPayload.id as string;
    expect(terminalId).toContain('custom-terminal-');

    fakeProcess.stdout.emit('data', 'hello\n');

    const outputResult = await getOutputTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.exitCode).toBeNull();
    expect(outputPayload.isRunning).toBe(true);
    expect(outputPayload.output).toBe('hello\n');
    expect(outputPayload.terminationSignal).toBeNull();

    const noNewOutputResult = await getOutputTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const noNewOutputPayload = getResultPayload(noNewOutputResult);
    expect(noNewOutputPayload.exitCode).toBeNull();
    expect(noNewOutputPayload.output).toBe('');
    expect(noNewOutputPayload.terminationSignal).toBeNull();

    fakeProcess.stdout.emit('data', 'world\nmatch-line\n');

    const lastLinesResult = await getOutputTool.invoke({
      input: {
        id: terminalId,
        last_lines: 2,
      },
      toolInvocationToken: undefined,
    }, {});

    const lastLinesPayload = getResultPayload(lastLinesResult);
    expect(lastLinesPayload.output).toBe('world\nmatch-line\n');

    fakeProcess.stdout.emit('data', 'nomatch\nonly-match\n');

    const regexResult = await getOutputTool.invoke({
      input: {
        id: terminalId,
        regex: '^only-match$',
      },
      toolInvocationToken: undefined,
    }, {});

    const regexPayload = getResultPayload(regexResult);
    expect(regexPayload.output).toBe('only-match\n');

    const fullOutputResult = await getOutputTool.invoke({
      input: {
        full_output: true,
        id: terminalId,
      },
      toolInvocationToken: undefined,
    }, {});

    const fullOutputPayload = getResultPayload(fullOutputResult);
    expect(fullOutputPayload.output).toBe('hello\nworld\nmatch-line\nnomatch\nonly-match\n');

    await expect(getOutputTool.invoke({
      input: {
        id: terminalId,
        last_lines: 1,
        regex: 'hello',
      },
      toolInvocationToken: undefined,
    }, {})).rejects.toThrow('mutually exclusive');

    const timedAwaitResult = await awaitTool.invoke({
      input: {
        id: terminalId,
        timeout: 5,
      },
      toolInvocationToken: undefined,
    }, {});

    const timedAwaitPayload = getResultPayload(timedAwaitResult);
    expect(timedAwaitPayload.timedOut).toBe(true);

    await killTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const completedAwaitResult = await awaitTool.invoke({
      input: {
        id: terminalId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const completedAwaitPayload = getResultPayload(completedAwaitResult);
    expect(completedAwaitPayload.timedOut).toBe(false);
    expect(fakeProcess.kill).toHaveBeenCalledWith('SIGTERM');

    const firstCompletedRead = await getOutputTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const firstCompletedReadPayload = getResultPayload(firstCompletedRead);
    expect(firstCompletedReadPayload.exitCode).toBeNull();
    expect(firstCompletedReadPayload.isRunning).toBe(false);
    expect(firstCompletedReadPayload.output).toBe('');
    expect(firstCompletedReadPayload.terminationSignal).toBe('SIGTERM');

    const secondCompletedRead = await getOutputTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const secondCompletedReadPayload = getResultPayload(secondCompletedRead);
    expect(secondCompletedReadPayload.exitCode).toBeNull();
    expect(secondCompletedReadPayload.output).toBe('hello\nworld\nmatch-line\nnomatch\nonly-match\n');
    expect(secondCompletedReadPayload.terminationSignal).toBe('SIGTERM');

    const lastResult = await lastCommandTool.invoke({
      input: {},
      toolInvocationToken: undefined,
    }, {});

    const lastPayload = getResultPayload(lastResult);
    expect(lastPayload.command).toBe('echo hello');

    const perTerminalLastResult = await lastCommandTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const perTerminalPayload = getResultPayload(perTerminalLastResult);
    expect(perTerminalPayload.command).toBe('echo hello');
  });

  it('keeps output when process closes with SIGINT', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerTerminalTools();

    const runTool = getRegisteredTool('run_in_async_terminal');
    const awaitTool = getRegisteredTool('await_terminal_enhanced');

    const runResult = await runTool.invoke({
      input: {
        command: 'echo keep',
        explanation: 'sigint behavior test',
        goal: 'verify no purge on sigint',
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const runPayload = getResultPayload(runResult);
    const terminalId = runPayload.id as string;

    fakeProcess.stdout.emit('data', 'before-int\n');
    fakeProcess.emit('close', null, 'SIGINT');

    const awaitResult = await awaitTool.invoke({
      input: {
        id: terminalId,
        timeout: 0,
      },
      toolInvocationToken: undefined,
    }, {});

    const awaitPayload = getResultPayload(awaitResult);
    expect(awaitPayload.output).toContain('before-int');
    expect(awaitPayload.terminationSignal).toBe('SIGINT');
  });

  it('returns only id by default for foreground runs and exposes output via get_terminal_output_enhanced', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    registerTerminalTools();

    const runTool = getRegisteredTool('run_in_sync_terminal');
    const getOutputTool = getRegisteredTool('get_terminal_output_enhanced');

    const runPromise = runTool.invoke({
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
    const terminalId = runPayload.id as string;

    expect(terminalId).toContain('custom-terminal-');
    expect(runPayload).toEqual({
      exitCode: 0,
      id: terminalId,
      terminationSignal: null,
      timedOut: false,
    });
    expect(runPayload).not.toHaveProperty('output');

    const outputResult = await getOutputTool.invoke({
      input: { id: terminalId },
      toolInvocationToken: undefined,
    }, {});

    const outputPayload = getResultPayload(outputResult);
    expect(outputPayload.isRunning).toBe(false);
    expect(outputPayload.output).toBe('hello\nworld\n');
    expect(outputPayload.exitCode).toBe(0);
    expect(outputPayload.terminationSignal).toBeNull();
  });

  it('returns opt-in foreground output when full_output, last_lines, or regex is provided', async () => {
    registerTerminalTools();

    const runTool = getRegisteredTool('run_in_sync_terminal');

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
    expect(fullOutputPayload.id).toMatch(/^custom-terminal-/);
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
    expect(lastLinesPayload.id).toMatch(/^custom-terminal-/);
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
    expect(regexPayload.id).toMatch(/^custom-terminal-/);
    expect(regexPayload.output).toBe('b\nc\n');

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
  });

  it('purges disk output when process closes with non-SIGINT signal', async () => {
    vi.useFakeTimers();

    try {
      const fakeProcess = createFakeProcess();
      spawn.mockReturnValue(fakeProcess);

      registerTerminalTools();

      const runTool = getRegisteredTool('run_in_async_terminal');
      const awaitTool = getRegisteredTool('await_terminal_enhanced');

      const runResult = await runTool.invoke({
        input: {
          command: 'echo spill',
          explanation: 'signal purge test',
          goal: 'verify disk purge on sigterm',
          timeout: 0,
        },
        toolInvocationToken: undefined,
      }, {});

      const runPayload = getResultPayload(runResult);
      const terminalId = runPayload.id as string;

      fakeProcess.stdout.emit('data', 'spill-me\n');

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10);

      const outputFilePath = getTerminalOutputFilePath(terminalId);
      expect(fs.existsSync(outputFilePath)).toBe(true);

      fakeProcess.emit('close', null, 'SIGTERM');

      expect(fs.existsSync(outputFilePath)).toBe(false);

      const awaitResult = await awaitTool.invoke({
        input: {
          id: terminalId,
          timeout: 0,
        },
        toolInvocationToken: undefined,
      }, {});

      const awaitPayload = getResultPayload(awaitResult);
      expect(awaitPayload.output).toBe('');
      expect(awaitPayload.terminationSignal).toBe('SIGTERM');
    }
    finally {
      vi.useRealTimers();
    }
  });
});
