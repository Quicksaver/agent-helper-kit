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
  runInShell: 'run_in_shell',
  sendToShell: 'send_to_shell',
} as const;

interface ContributedLanguageModelTool {
  displayName: string;
  modelDescription: string;
  name: string;
  userDescription?: string;
}

interface ShellToolMetadataDescriptor {
  description: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRequiredDescription(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.trim()
    : undefined;
}

function normalizeOptionalDescription(value: unknown): string | undefined {
  const normalizedDescription = normalizeRequiredDescription(value);

  return normalizedDescription && normalizedDescription.length > 0
    ? normalizedDescription
    : undefined;
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
    const modelDescription = normalizeRequiredDescription(tool.modelDescription);
    const userDescription = normalizeOptionalDescription(tool.userDescription);

    if (
      typeof name !== 'string'
      || typeof displayName !== 'string'
      || modelDescription === undefined
    ) {
      throw new Error(`Invalid languageModelTools entry at index ${index}`);
    }

    return {
      displayName,
      modelDescription,
      name,
      userDescription,
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

  const description = normalizeOptionalDescription(manifestTool.userDescription)
    ?? manifestTool.modelDescription.trim();

  return {
    description,
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
    runInShell: {
      confirmationMessage: (commandPreview: string) => `Run shell command: ${commandPreview}`,
      confirmationTitle: 'Run shell command?',
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.runInShell),
      invocationMessage: (commandPreview: string) => `Running shell command: ${commandPreview}`,
    },
    sendToShell: {
      confirmationMessage: (id: string, commandPreview?: string, options?: {
        secret?: boolean;
      }) => {
        if (!commandPreview || commandPreview.trim().length === 0) {
          return `Press Enter for shell command ${id}`;
        }

        if (options?.secret === true) {
          return `Send secret input to shell command ${id}: ${commandPreview}`;
        }

        return `Send input to shell command ${id}: ${commandPreview}`;
      },
      confirmationTitle: 'Send input to running shell command?',
      ...getToolMetadata(contributedLanguageModelTools, SHELL_TOOL_NAMES.sendToShell),
      invocationMessage: (id: string) => `Sending input to shell command ${id}`,
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

export interface RunInShellInput extends RunInShellBaseInput {
  full_output?: boolean;
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
  timeout?: number;
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

export const HIDDEN_SHELL_INPUT_LOG_PLACEHOLDER = '[hidden sensitive input]';

export interface SendToShellInput {
  command: string;
  id: string;
  secret?: boolean;
}

export const MAX_SEND_TO_SHELL_INPUT_LENGTH = 16 * 1024;

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

export const runInShellInputSchema = {
  ...runInShellBaseInputSchema,
  full_output: z.boolean().optional(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  regex_flags: z.string().optional(),
  timeout: z.number().nonnegative().optional(),
} satisfies z.ZodRawShape;

export const awaitShellInputSchema = {
  id: z.string(),
  timeout: z.number().nonnegative(),
} satisfies z.ZodRawShape;

export const getShellOutputInputSchema = {
  full_output: z.boolean().optional(),
  id: z.string(),
  last_lines: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  regex_flags: z.string().optional(),
} satisfies z.ZodRawShape;

export const sendToShellInputSchema = {
  command: z.string().max(MAX_SEND_TO_SHELL_INPUT_LENGTH, {
    message: `command must be less than or equal to ${MAX_SEND_TO_SHELL_INPUT_LENGTH} characters`,
  }).refine(value => !/[\r\n]/u.test(value), {
    message: 'command must be a single line; Enter is added automatically',
  }),
  id: z.string(),
  secret: z.boolean().optional(),
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

const awaitShellInputValidator = z.object(awaitShellInputSchema);
const sendToShellInputValidator = z.object(sendToShellInputSchema);

const runInShellInputValidator = z.object(runInShellInputSchema).refine(
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
).refine(
  value => !(
    value.timeout === undefined
    && (
      value.full_output === true
      || typeof value.last_lines === 'number'
      || typeof value.regex === 'string'
      || typeof value.regex_flags === 'string'
    )
  ),
  {
    message: 'full_output, last_lines, regex, and regex_flags require timeout',
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

export function validateAwaitShellInput(input: AwaitShellInput): AwaitShellInput {
  return awaitShellInputValidator.parse(input);
}

export function validateSendToShellInput(input: SendToShellInput): SendToShellInput {
  return sendToShellInputValidator.parse(input);
}

export function validateRunInShellInput(input: RunInShellInput): RunInShellInput {
  return runInShellInputValidator.parse(input);
}
