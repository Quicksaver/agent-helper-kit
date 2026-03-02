import { EventEmitter } from 'node:events';

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

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
    LanguageModelTextPart,
    LanguageModelToolResult,
    lm: {
      registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
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

// eslint-disable-next-line import/first -- must follow vi.mock
import { registerTerminalTools } from '@/terminalTools';

function createContext() {
  return {
    subscriptions: [] as { dispose: () => void }[],
  } as unknown as import('vscode').ExtensionContext;
}

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

function getResultPayload(result: { content: [{ value: string }] }): Record<string, unknown> {
  return JSON.parse(result.content[0].value) as Record<string, unknown>;
}

describe('terminal tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all custom terminal tools', () => {
    const context = createContext();

    registerTerminalTools(context);

    expect(vscode.lm.registerTool).toHaveBeenCalledWith('custom_run_in_terminal', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('custom_await_terminal', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('custom_get_terminal_output', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('custom_kill_terminal', expect.any(Object));
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('custom_terminal_last_command', expect.any(Object));
    expect(context.subscriptions).toHaveLength(5);
  });

  it('runs a background command and exposes output, await, kill, and last command', async () => {
    const fakeProcess = createFakeProcess();
    spawn.mockReturnValue(fakeProcess);

    const context = createContext();
    registerTerminalTools(context);

    const runTool = getRegisteredTool('custom_run_in_terminal');
    const getOutputTool = getRegisteredTool('custom_get_terminal_output');
    const awaitTool = getRegisteredTool('custom_await_terminal');
    const killTool = getRegisteredTool('custom_kill_terminal');
    const lastCommandTool = getRegisteredTool('custom_terminal_last_command');

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
        isBackground: true,
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
    expect(outputPayload.isRunning).toBe(true);
    expect(outputPayload.output).toBe('hello\n');

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
});
