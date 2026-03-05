import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

export const SHELL_TOOL_NAMES = {
  awaitShell: 'await_shell',
  getShellOutput: 'get_shell_output',
  killShell: 'kill_shell',
  runInAsyncShell: 'run_in_async_shell',
  runInSyncShell: 'run_in_sync_shell',
  shellLastCommand: 'shell_last_command',
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

export const SHELL_TOOL_METADATA = {
  awaitShell: {
    ...getToolMetadata(SHELL_TOOL_NAMES.awaitShell),
    invocationMessage: (id: string) => `Waiting for shell command ${id}`,
  },
  getShellOutput: {
    ...getToolMetadata(SHELL_TOOL_NAMES.getShellOutput),
    invocationMessage: (id: string) => `Reading output for shell command ${id}`,
  },
  killShell: {
    confirmationMessage: (id: string) => `Stop shell command ${id}`,
    confirmationTitle: 'Stop running shell command?',
    ...getToolMetadata(SHELL_TOOL_NAMES.killShell),
    invocationMessage: (id: string) => `Stopping shell command ${id}`,
  },
  runInAsyncShell: {
    confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
    confirmationTitle: 'Run async shell command?',
    ...getToolMetadata(SHELL_TOOL_NAMES.runInAsyncShell),
    invocationMessage: (commandPreview: string) => `Running async shell command: ${commandPreview}`,
  },
  runInSyncShell: {
    confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
    confirmationTitle: 'Run sync shell command?',
    ...getToolMetadata(SHELL_TOOL_NAMES.runInSyncShell),
    invocationMessage: (commandPreview: string) => `Running sync shell command: ${commandPreview}`,
  },
  shellLastCommand: {
    invocationMessage: 'Reading last shell command',
    ...getToolMetadata(SHELL_TOOL_NAMES.shellLastCommand),
  },
} as const;

export interface RunInAsyncShellInput {
  command: string;
  explanation: string;
  goal: string;
  shell?: string;
  timeout: number;
}

export interface RunInSyncShellInput {
  command: string;
  explanation: string;
  full_output?: boolean;
  goal: string;
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
  shell?: string;
  timeout: number;
}

export interface AwaitShellInput {
  id: string;
  timeout: number;
}

export interface GetShellOutputInput {
  full_output?: boolean;
  id: string;
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
}

export interface KillShellInput {
  id: string;
}

export interface ShellLastCommandInput {
  id?: string;
}

export const runInAsyncShellInputSchema = {
  command: z.string(),
  explanation: z.string(),
  goal: z.string(),
  shell: z.string().optional(),
  timeout: z.number(),
} satisfies z.ZodRawShape;

export const runInSyncShellInputSchema = {
  command: z.string(),
  explanation: z.string(),
  full_output: z.boolean().optional(),
  goal: z.string(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  regex_flags: z.string().optional(),
  shell: z.string().optional(),
  timeout: z.number(),
} satisfies z.ZodRawShape;

export const awaitShellInputSchema = {
  id: z.string(),
  timeout: z.number(),
} satisfies z.ZodRawShape;

export const getShellOutputInputSchema = {
  full_output: z.boolean().optional(),
  id: z.string(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  regex_flags: z.string().optional(),
} satisfies z.ZodRawShape;

const getShellOutputInputValidator = z.object(getShellOutputInputSchema).refine(
  value => !(typeof value.last_lines === 'number' && typeof value.regex === 'string'),
  {
    message: 'last_lines and regex are mutually exclusive',
  },
).refine(
  value => !(typeof value.regex_flags === 'string' && typeof value.regex !== 'string'),
  {
    message: 'regex_flags requires regex',
  },
);

const runInAsyncShellInputValidator = z.object(runInAsyncShellInputSchema);

const runInSyncShellInputValidator = z.object(runInSyncShellInputSchema).refine(
  value => !(
    (typeof value.last_lines === 'number' && typeof value.regex === 'string')
    || (value.full_output === true && typeof value.last_lines === 'number')
    || (value.full_output === true && typeof value.regex === 'string')
  ),
  {
    message: 'full_output, last_lines, and regex are mutually exclusive options',
  },
).refine(
  value => !(typeof value.regex_flags === 'string' && typeof value.regex !== 'string'),
  {
    message: 'regex_flags requires regex',
  },
);

export const killShellInputSchema = {
  id: z.string(),
} satisfies z.ZodRawShape;

export const shellLastCommandInputSchema = {
  id: z.string().optional(),
} satisfies z.ZodRawShape;

export function validateGetShellOutputInput(input: GetShellOutputInput): GetShellOutputInput {
  return getShellOutputInputValidator.parse(input);
}

export function validateRunInAsyncShellInput(input: RunInAsyncShellInput): RunInAsyncShellInput {
  return runInAsyncShellInputValidator.parse(input);
}

export function validateRunInSyncShellInput(input: RunInSyncShellInput): RunInSyncShellInput {
  return runInSyncShellInputValidator.parse(input);
}
