import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const TERMINAL_TOOL_NAMES = {
  awaitTerminal: 'custom_await_terminal',
  getTerminalOutput: 'custom_get_terminal_output',
  killTerminal: 'custom_kill_terminal',
  runInTerminal: 'custom_run_in_terminal',
  terminalLastCommand: 'custom_terminal_last_command',
} as const;

interface ContributedLanguageModelTool {
  displayName: string;
  modelDescription: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPackageJsonManifest(): unknown {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirectoryPath = path.dirname(currentFilePath);
  const packageJsonPath = path.resolve(currentDirectoryPath, '..', 'package.json');
  const packageJsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf8' });

  return JSON.parse(packageJsonContent) as unknown;
}

function getContributedLanguageModelTools(): ContributedLanguageModelTool[] {
  const manifest = readPackageJsonManifest();

  if (!isRecord(manifest)) {
    throw new Error('package.json content must be a JSON object');
  }

  const { contributes } = manifest;

  if (!isRecord(contributes)) {
    throw new Error('package.json is missing contributes');
  }

  const { languageModelTools } = contributes;

  if (
    !Array.isArray(languageModelTools)
  ) {
    throw new Error('package.json is missing contributes.languageModelTools');
  }

  return languageModelTools.map((tool, index) => {
    if (!isRecord(tool)) {
      throw new Error(`Invalid languageModelTools entry at index ${index}`);
    }

    const { name } = tool;
    const { displayName } = tool;
    const { modelDescription } = tool;

    if (
      typeof name !== 'string'
      || typeof displayName !== 'string'
      || typeof modelDescription !== 'string'
    ) {
      throw new Error(`Invalid languageModelTools entry at index ${index}`);
    }

    return {
      displayName,
      modelDescription,
      name,
    };
  });
}

const contributedLanguageModelTools = getContributedLanguageModelTools();

function getToolFromManifest(name: string): ContributedLanguageModelTool {
  const tool = contributedLanguageModelTools.find(candidate => candidate.name === name);

  if (!tool) {
    throw new Error(`Tool not found in package.json contributes.languageModelTools: ${name}`);
  }

  return tool;
}

function getToolMetadata(name: string): {
  description: string;
  title: string;
} {
  const manifestTool = getToolFromManifest(name);

  return {
    description: manifestTool.modelDescription,
    title: manifestTool.displayName,
  };
}

export const TERMINAL_TOOL_METADATA = {
  awaitTerminal: {
    ...getToolMetadata(TERMINAL_TOOL_NAMES.awaitTerminal),
    invocationMessage: (id: string) => `Waiting for terminal ${id}`,
  },
  getTerminalOutput: {
    ...getToolMetadata(TERMINAL_TOOL_NAMES.getTerminalOutput),
    invocationMessage: (id: string) => `Reading output for terminal ${id}`,
  },
  killTerminal: {
    confirmationMessage: (id: string) => `Stop terminal ${id}`,
    confirmationTitle: 'Stop running terminal?',
    ...getToolMetadata(TERMINAL_TOOL_NAMES.killTerminal),
    invocationMessage: (id: string) => `Stopping terminal ${id}`,
  },
  runInTerminal: {
    confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
    confirmationTitle: 'Run terminal command?',
    ...getToolMetadata(TERMINAL_TOOL_NAMES.runInTerminal),
    invocationMessage: (commandPreview: string) => `Running in terminal: ${commandPreview}`,
  },
  terminalLastCommand: {
    invocationMessage: 'Reading last terminal command',
    ...getToolMetadata(TERMINAL_TOOL_NAMES.terminalLastCommand),
  },
} as const;

export interface RunInTerminalInput {
  command: string;
  explanation: string;
  goal: string;
  isBackground: boolean;
  timeout: number;
}

export interface AwaitTerminalInput {
  id: string;
  timeout: number;
}

export interface GetTerminalOutputInput {
  id: string;
  last_lines?: number;
  regex?: string;
}

export interface KillTerminalInput {
  id: string;
}

export interface TerminalLastCommandInput {
  id?: string;
}

export const runInTerminalInputSchema = {
  command: z.string(),
  explanation: z.string(),
  goal: z.string(),
  isBackground: z.boolean(),
  timeout: z.number(),
} satisfies z.ZodRawShape;

export const awaitTerminalInputSchema = {
  id: z.string(),
  timeout: z.number(),
} satisfies z.ZodRawShape;

export const getTerminalOutputInputSchema = {
  id: z.string(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
} satisfies z.ZodRawShape;

export const killTerminalInputSchema = {
  id: z.string(),
} satisfies z.ZodRawShape;

export const terminalLastCommandInputSchema = {
  id: z.string().optional(),
} satisfies z.ZodRawShape;
