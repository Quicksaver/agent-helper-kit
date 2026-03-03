import * as childProcess from 'node:child_process';
import * as process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  appendTerminalOutput,
  createTerminalOutputFile,
  initializeTerminalOutputStore,
  readTerminalOutput,
} from '@/terminalOutputStore';

const OUTPUT_LIMIT = 60 * 1024;
const MEMORY_STATE_TTL_MS = 5 * 60 * 1000;
const PWD_MARKER = '__CUSTOM_VSCODE_MCP_PWD__';

interface BackgroundProcessState {
  childProc: childProcess.ChildProcessWithoutNullStreams;
  cleanupTimer: NodeJS.Timeout | undefined;
  command: string;
  completed: boolean;
  completion: Promise<void>;
  exitCode: null | number;
  output: string;
  resolveCompletion: () => void;
  signal: NodeJS.Signals | null;
}

const backgroundProcesses = new Map<string, BackgroundProcessState>();
let backgroundIdCounter = 0;
let foregroundIdCounter = 0;
let sharedForegroundCwd: string | undefined;
let lastCommand: string | undefined;

initializeTerminalOutputStore(new Set(backgroundProcesses.keys()));

function buildShellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: process.env.TERM ?? 'xterm-256color',
  };
}

function appendOutput(current: string, chunk: string): string {
  const next = `${current}${chunk}`;

  if (next.length <= OUTPUT_LIMIT) {
    return next;
  }

  return next.slice(-OUTPUT_LIMIT);
}

function parseOutputAndPwd(output: string): {
  outputWithoutMarker: string;
  resolvedCwd: string | undefined;
} {
  const markerIndex = output.lastIndexOf(PWD_MARKER);

  if (markerIndex === -1) {
    return {
      outputWithoutMarker: output,
      resolvedCwd: undefined,
    };
  }

  const before = output.slice(0, markerIndex);
  const after = output.slice(markerIndex + PWD_MARKER.length);
  const lineBreakIndex = after.indexOf('\n');
  const cwdValue = lineBreakIndex === -1 ? after : after.slice(0, lineBreakIndex);
  const rest = lineBreakIndex === -1 ? '' : after.slice(lineBreakIndex + 1);

  return {
    outputWithoutMarker: `${before}${rest}`,
    resolvedCwd: cwdValue.trim() || undefined,
  };
}

function getFilteredOutput(input: {
  last_lines?: number;
  regex?: string;
}, output: string): string {
  const hasLastLines = typeof input.last_lines === 'number';
  const hasRegex = typeof input.regex === 'string';

  if (hasLastLines && hasRegex) {
    throw new Error('last_lines and regex are mutually exclusive');
  }

  if (!hasLastLines && !hasRegex) {
    return output;
  }

  const lines = output.split('\n');

  if (hasLastLines) {
    const count = Math.max(Math.floor(input.last_lines ?? 0), 0);

    if (count === 0) {
      return '';
    }

    return lines.slice(-count).join('\n');
  }

  const expression = new RegExp(input.regex ?? '');
  return lines.filter(line => expression.test(line)).join('\n');
}

function scheduleBackgroundStateCleanup(id: string, state: BackgroundProcessState): void {
  state.cleanupTimer = setTimeout(() => {
    backgroundProcesses.delete(id);
  }, MEMORY_STATE_TTL_MS);
}

async function runForegroundCommand(input: {
  command: string;
  timeout: number;
}): Promise<{
  exitCode: null | number;
  output: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  const cwd = sharedForegroundCwd ?? process.cwd();
  const foregroundTerminalId = `custom-foreground-${++foregroundIdCounter}`;
  const wrappedCommand = `${input.command}\nprintf "\\n${PWD_MARKER}%s\\n" "$PWD"`;

  createTerminalOutputFile(foregroundTerminalId);

  const childProc = childProcess.spawn('/bin/bash', [ '-lc', wrappedCommand ], {
    cwd,
    env: buildShellEnv(),
  });

  let output = '';
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  childProc.stdout.on('data', (data: unknown) => {
    const chunk = String(data);
    output = appendOutput(output, chunk);
    appendTerminalOutput(foregroundTerminalId, chunk);
  });

  childProc.stderr.on('data', (data: unknown) => {
    const chunk = String(data);
    output = appendOutput(output, chunk);
    appendTerminalOutput(foregroundTerminalId, chunk);
  });

  if (input.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProc.kill('SIGTERM');
    }, input.timeout);
  }

  const closeResult = await new Promise<{
    code: null | number;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
      resolve({
        code,
        signal,
      });
    });
  });

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  const parsedOutput = parseOutputAndPwd(output);

  if (parsedOutput.resolvedCwd) {
    sharedForegroundCwd = parsedOutput.resolvedCwd;
  }

  return {
    exitCode: closeResult.code,
    output: parsedOutput.outputWithoutMarker,
    signal: closeResult.signal,
    timedOut,
  };
}

function startBackgroundCommand(command: string): string {
  const id = `custom-terminal-${++backgroundIdCounter}`;
  const childProc = childProcess.spawn('/bin/bash', [ '-lc', command ], {
    cwd: process.cwd(),
    env: buildShellEnv(),
  });

  let output = '';

  const state: BackgroundProcessState = {
    childProc,
    cleanupTimer: undefined,
    command,
    completed: false,
    completion: Promise.resolve(),
    exitCode: null,
    output: '',
    resolveCompletion: () => undefined,
    signal: null,
  };

  state.completion = new Promise<void>(resolve => {
    state.resolveCompletion = resolve;
  });

  createTerminalOutputFile(id);

  childProc.stdout.on('data', (data: unknown) => {
    const chunk = String(data);
    output = appendOutput(output, chunk);
    state.output = output;
    appendTerminalOutput(id, chunk);
  });

  childProc.stderr.on('data', (data: unknown) => {
    const chunk = String(data);
    output = appendOutput(output, chunk);
    state.output = output;
    appendTerminalOutput(id, chunk);
  });

  childProc.on('close', (code: null | number, signal: NodeJS.Signals | null) => {
    state.completed = true;
    state.exitCode = code;
    state.signal = signal;
    state.resolveCompletion();
    scheduleBackgroundStateCleanup(id, state);
  });

  childProc.on('error', (error: Error) => {
    state.completed = true;
    state.output = appendOutput(state.output, `\n${String(error)}\n`);
    appendTerminalOutput(id, `\n${String(error)}\n`);
    state.resolveCompletion();
    scheduleBackgroundStateCleanup(id, state);
  });

  backgroundProcesses.set(id, state);

  return id;
}

function getBackgroundState(id: string): BackgroundProcessState {
  const state = backgroundProcesses.get(id);

  if (!state) {
    throw new Error(`Unknown terminal id: ${id}`);
  }

  return state;
}

function toTextContent(payload: object): {
  content: {
    text: string;
    type: 'text';
  }[];
} {
  return {
    content: [
      {
        text: JSON.stringify(payload),
        type: 'text',
      },
    ],
  };
}

function registerTools(server: McpServer): void {
  server.registerTool(
    'custom_run_in_terminal',
    {
      description: 'Execute shell commands in a persistent bash terminal session. Supports foreground and background execution with output capture.',
      inputSchema: {
        command: z.string(),
        explanation: z.string(),
        goal: z.string(),
        isBackground: z.boolean(),
        timeout: z.number(),
      },
      title: 'Custom Run In Terminal',
    },
    async input => {
      lastCommand = input.command;

      if (input.isBackground) {
        const id = startBackgroundCommand(input.command);
        return toTextContent({ id });
      }

      const result = await runForegroundCommand({
        command: input.command,
        timeout: input.timeout,
      });

      return toTextContent({
        exitCode: result.exitCode,
        output: result.output,
        signal: result.signal,
        timedOut: result.timedOut,
      });
    },
  );

  server.registerTool(
    'custom_await_terminal',
    {
      description: 'Wait for a background terminal process to complete and return its output and status.',
      inputSchema: {
        id: z.string(),
        timeout: z.number(),
      },
      title: 'Custom Await Terminal',
    },
    async input => {
      const state = getBackgroundState(input.id);

      if (!state.completed) {
        if (input.timeout === 0) {
          await state.completion;
        }
        else {
          await Promise.race([
            state.completion,
            new Promise<void>(resolve => {
              setTimeout(resolve, input.timeout);
            }),
          ]);
        }
      }

      const timedOut = !state.completed;

      return toTextContent({
        exitCode: state.completed ? state.exitCode : null,
        output: state.output,
        signal: state.completed ? state.signal : null,
        timedOut,
      });
    },
  );

  server.registerTool(
    'custom_get_terminal_output',
    {
      description: 'Read current output from a background terminal process.',
      inputSchema: {
        id: z.string(),
        last_lines: z.number().int().nonnegative().optional(),
        regex: z.string().optional(),
      },
      title: 'Custom Get Terminal Output',
    },
    async input => {
      const state = getBackgroundState(input.id);
      const storedOutput = readTerminalOutput(input.id);

      return toTextContent({
        isRunning: !state.completed,
        output: getFilteredOutput(input, storedOutput),
      });
    },
  );

  server.registerTool(
    'custom_kill_terminal',
    {
      description: 'Terminate a running background terminal process.',
      inputSchema: {
        id: z.string(),
      },
      title: 'Custom Kill Terminal',
    },
    async input => {
      const state = getBackgroundState(input.id);

      if (!state.completed) {
        state.childProc.kill('SIGTERM');
      }

      return toTextContent({
        killed: true,
      });
    },
  );

  server.registerTool(
    'custom_terminal_last_command',
    {
      description: 'Return the last command executed via custom_run_in_terminal.',
      inputSchema: {
        id: z.string().optional(),
      },
      title: 'Custom Terminal Last Command',
    },
    async input => {
      const command = input.id
        ? getBackgroundState(input.id).command
        : lastCommand;

      return toTextContent({
        command: command ?? null,
      });
    },
  );
}

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: 'custom-vscode-terminal-tools-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
