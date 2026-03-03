import * as process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { TerminalRuntime } from '@/terminalRuntime';
import {
  awaitTerminalInputSchema,
  getPackageVersion,
  getTerminalOutputInputSchema,
  killTerminalInputSchema,
  runInTerminalInputSchema,
  TERMINAL_TOOL_METADATA,
  TERMINAL_TOOL_NAMES,
  terminalLastCommandInputSchema,
} from '@/terminalToolContracts';

const terminalRuntime = new TerminalRuntime({
  getBackgroundCwd: () => process.cwd(),
  getInitialForegroundCwd: () => process.cwd(),
  pwdMarker: '__CUSTOM_VSCODE_MCP_PWD__',
});

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
    TERMINAL_TOOL_NAMES.runInTerminal,
    {
      description: TERMINAL_TOOL_METADATA.runInTerminal.description,
      inputSchema: runInTerminalInputSchema,
      title: TERMINAL_TOOL_METADATA.runInTerminal.title,
    },
    async input => {
      if (input.isBackground) {
        const id = terminalRuntime.startBackgroundCommand(input.command);
        return toTextContent({ id });
      }

      const result = await terminalRuntime.runForegroundCommand({
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
    TERMINAL_TOOL_NAMES.awaitTerminal,
    {
      description: TERMINAL_TOOL_METADATA.awaitTerminal.description,
      inputSchema: awaitTerminalInputSchema,
      title: TERMINAL_TOOL_METADATA.awaitTerminal.title,
    },
    async input => {
      const result = await terminalRuntime.awaitBackgroundCommand({
        id: input.id,
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
    TERMINAL_TOOL_NAMES.getTerminalOutput,
    {
      description: TERMINAL_TOOL_METADATA.getTerminalOutput.description,
      inputSchema: getTerminalOutputInputSchema,
      title: TERMINAL_TOOL_METADATA.getTerminalOutput.title,
    },
    async input => {
      const result = terminalRuntime.readBackgroundOutput(input);

      return toTextContent({
        isRunning: result.isRunning,
        output: result.output,
      });
    },
  );

  server.registerTool(
    TERMINAL_TOOL_NAMES.killTerminal,
    {
      description: TERMINAL_TOOL_METADATA.killTerminal.description,
      inputSchema: killTerminalInputSchema,
      title: TERMINAL_TOOL_METADATA.killTerminal.title,
    },
    async input => {
      terminalRuntime.killBackgroundCommand(input.id);

      return toTextContent({
        killed: true,
      });
    },
  );

  server.registerTool(
    TERMINAL_TOOL_NAMES.terminalLastCommand,
    {
      description: TERMINAL_TOOL_METADATA.terminalLastCommand.description,
      inputSchema: terminalLastCommandInputSchema,
      title: TERMINAL_TOOL_METADATA.terminalLastCommand.title,
    },
    async input => {
      const command = terminalRuntime.getLastCommand(input.id);

      return toTextContent({
        command: command ?? null,
      });
    },
  );
}

async function main(): Promise<void> {
  const version = getPackageVersion();
  const server = new McpServer(
    {
      name: 'custom-vscode-terminal-tools-mcp',
      version,
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
