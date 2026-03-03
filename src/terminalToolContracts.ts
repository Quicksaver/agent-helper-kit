import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

export const TERMINAL_TOOL_NAMES = {
  awaitTerminal: 'await_terminal_enhanced',
  getTerminalOutput: 'get_terminal_output_enhanced',
  killTerminal: 'kill_terminal_enhanced',
  runInTerminal: 'run_in_terminal_enhanced',
  terminalLastCommand: 'terminal_last_command_enhanced',
} as const;

interface ContributedLanguageModelTool {
  displayName: string;
  modelDescription: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

let packageJsonManifestCache: unknown;

function readPackageJsonManifest(): unknown {
  if (packageJsonManifestCache !== undefined) {
    return packageJsonManifestCache;
  }

  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const packageJsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf8' });
  const manifest = JSON.parse(packageJsonContent) as unknown;

  packageJsonManifestCache = manifest;
  return manifest;
}

export function getPackageVersion(): string {
  let manifest: unknown;

  try {
    manifest = readPackageJsonManifest();
  }
  catch {
    return '0.0.0';
  }

  if (
    isRecord(manifest)
    && typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }

  return '0.0.0';
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

function getContributedLanguageModelToolsSafely(): ContributedLanguageModelTool[] {
  try {
    return getContributedLanguageModelTools();
  }
  catch {
    return [];
  }
}

const contributedLanguageModelTools = getContributedLanguageModelToolsSafely();

function getToolMetadata(name: string): {
  description: string;
  title: string;
} {
  const manifestTool = contributedLanguageModelTools.find(candidate => candidate.name === name);

  if (!manifestTool) {
    return {
      description: '',
      title: name,
    };
  }

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
  full_output?: boolean;
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
  full_output: z.boolean().optional(),
  id: z.string(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
} satisfies z.ZodRawShape;

const getTerminalOutputInputValidator = z.object(getTerminalOutputInputSchema).refine(
  value => !(typeof value.last_lines === 'number' && typeof value.regex === 'string'),
  {
    message: 'last_lines and regex are mutually exclusive',
  },
);

export const killTerminalInputSchema = {
  id: z.string(),
} satisfies z.ZodRawShape;

export const terminalLastCommandInputSchema = {
  id: z.string().optional(),
} satisfies z.ZodRawShape;

export function validateGetTerminalOutputInput(input: GetTerminalOutputInput): GetTerminalOutputInput {
  return getTerminalOutputInputValidator.parse(input);
}
