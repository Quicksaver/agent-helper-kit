import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

import { MAX_SHELL_COLUMNS } from '@/shellColumns';

export const SHELL_TOOL_NAMES = {
  awaitShell: 'await_shell',
  getLastShellCommand: 'get_last_shell_command',
  getShellCommand: 'get_shell_command',
  getShellOutput: 'get_shell_output',
  killShell: 'kill_shell',
  runInAsyncShell: 'run_in_async_shell',
  runInSyncShell: 'run_in_sync_shell',
} as const;

interface ContributedLanguageModelTool {
  displayName: string;
  modelDescription: string;
  name: string;
}

interface ShellToolMetadataDescriptor {
  description: string;
  title: string;
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

export function getPackageVersionFromManifest(manifest: unknown): string {
  if (
    isRecord(manifest)
    && typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }

  return '0.0.0';
}

export function getPackageVersionFromReader(readManifest: () => unknown = readPackageJsonManifest): string {
  try {
    return getPackageVersionFromManifest(readManifest());
  }
  catch {
    return '0.0.0';
  }
}

export function getPackageVersion(): string {
  return getPackageVersionFromReader();
}

export function getContributedLanguageModelToolsFromManifest(manifest: unknown): ContributedLanguageModelTool[] {
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

function getToolMetadata(
  contributedLanguageModelTools: ContributedLanguageModelTool[],
  name: string,
): ShellToolMetadataDescriptor {
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

export function buildShellToolMetadata(manifest: unknown) {
  const contributedLanguageModelTools = (() => {
    try {
      return getContributedLanguageModelToolsFromManifest(manifest);
    }
    catch {
      return [];
    }
  })();

  return {
    awaitShell: {
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.awaitShell),
      invocationMessage: (id: string) => `Waiting for shell command ${id}`,
    },
    getLastShellCommand: {
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.getLastShellCommand),
      invocationMessage: 'Reading most recent shell command',
    },
    getShellCommand: {
      invocationMessage: (id: string) => `Reading shell command ${id}`,
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.getShellCommand),
    },
    getShellOutput: {
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.getShellOutput),
      invocationMessage: (id: string) => `Reading output for shell command ${id}`,
    },
    killShell: {
      confirmationMessage: (id: string) => `Stop shell command ${id}`,
      confirmationTitle: 'Stop running shell command?',
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.killShell),
      invocationMessage: (id: string) => `Stopping shell command ${id}`,
    },
    runInAsyncShell: {
      confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
      confirmationTitle: 'Run async shell command?',
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.runInAsyncShell),
      invocationMessage: (commandPreview: string) => `Running async shell command: ${commandPreview}`,
    },
    runInSyncShell: {
      confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
      confirmationTitle: 'Run sync shell command?',
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.runInSyncShell),
      invocationMessage: (commandPreview: string) => `Running sync shell command: ${commandPreview}`,
    },
  } as const;
}

export type ShellToolMetadata = ReturnType<typeof buildShellToolMetadata>;

export function buildShellToolMetadataFromReader(
  readManifest: () => unknown = readPackageJsonManifest,
): ShellToolMetadata {
  try {
    return buildShellToolMetadata(readManifest());
  }
  catch {
    return buildShellToolMetadata(undefined);
  }
}

export const SHELL_TOOL_METADATA = buildShellToolMetadataFromReader();

export interface ShellRiskAssessmentInput {
  explanation: string;
  goal: string;
  riskAssessment: string;
  riskAssessmentContext?: string[];
}

export interface RunInShellBaseInput extends ShellRiskAssessmentInput {
  columns?: number;
  command: string;
  cwd?: string;
  shell?: string;
}

export type RunInAsyncShellInput = RunInShellBaseInput;

export interface RunInSyncShellInput extends RunInShellBaseInput {
  full_output?: boolean;
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
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

export interface GetShellCommandInput {
  id: string;
}

export type GetLastShellCommandInput = Record<string, never>;

const shellColumnsSchema = z.number().int({
  message: 'columns must be a whole number',
}).gt(0, {
  message: 'columns must be greater than 0',
}).lte(MAX_SHELL_COLUMNS, {
  message: `columns must be less than or equal to ${MAX_SHELL_COLUMNS}`,
})
  .optional();

const shellRiskAssessmentInputSchema = {
  explanation: z.string(),
  goal: z.string(),
  riskAssessment: z.string(),
  riskAssessmentContext: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;

const runInShellBaseInputSchema = {
  columns: shellColumnsSchema,
  command: z.string(),
  cwd: z.string().optional(),
  ...shellRiskAssessmentInputSchema,
  shell: z.string().optional(),
} satisfies z.ZodRawShape;

export const runInAsyncShellInputSchema = {
  ...runInShellBaseInputSchema,
} satisfies z.ZodRawShape;

export const runInSyncShellInputSchema = {
  ...runInShellBaseInputSchema,
  full_output: z.boolean().optional(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  regex_flags: z.string().optional(),
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

export const getShellCommandInputSchema = {
  id: z.string(),
} satisfies z.ZodRawShape;

export const getLastShellCommandInputSchema = {
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
