import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';

export const SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY = 'shellTools.autoApprove.enabled';
export const SHELL_TOOLS_AUTO_APPROVE_RULES_KEY = 'shellTools.autoApprove.rules';
export const SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY = 'shellTools.autoApprove.warningAccepted';

type ApprovalRuleMap = Record<string, boolean>;

type ApprovalState = 'allowed' | 'denied' | 'pending';

type CompiledRegexRule = {
  regex: RegExp;
  ruleKey: string;
  ruleValue: boolean;
};

type CommandApprovalResult = {
  reason?: string;
  state: ApprovalState;
};

export type ShellRunApprovalDecision = {
  autoApprove: boolean;
  reason?: string;
};

const DEFAULT_AUTO_APPROVE_RULES: ApprovalRuleMap = {
  '/^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/': false,
  '/^git\\s+(branch|diff|log|show|status)\\b/': true,
  '/^rg\\b.*\\s(--hostname-bin|--pre)\\b/': false,
  '/^sed\\b.*;W/': false,
  '/^sed\\b.*\\s(-[a-zA-Z]*(e|f|i)[a-zA-Z]*|--expression|--file|--in-place)\\b/': false,
  '/^sed\\b.*s\\/.*\\/.*\\/[ew]/': false,
  cat: true,
  chmod: false,
  chown: false,
  dd: false,
  del: false,
  echo: true,
  erase: false,
  eval: false,
  find: true,
  grep: true,
  head: true,
  iex: false,
  'Invoke-Expression': false,
  'Invoke-RestMethod': false,
  'Invoke-WebRequest': false,
  iwr: false,
  jq: false,
  kill: false,
  ls: true,
  ps: false,
  pwd: true,
  rd: false,
  'Remove-Item': false,
  rg: true,
  ri: false,
  rm: false,
  rmdir: false,
  sed: true,
  'Set-Acl': false,
  'Set-ItemProperty': false,
  sort: true,
  sp: false,
  spps: false,
  'Stop-Process': false,
  tail: true,
  taskkill: false,
  'taskkill.exe': false,
  top: false,
  uniq: true,
  wc: true,
  wget: false,
  which: true,
  xargs: false,
};

const compiledRegexRulesCache = new WeakMap<ApprovalRuleMap, CompiledRegexRule[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (folder) {
    return folder.uri.fsPath;
  }

  return os.homedir();
}

function getPreviewCwd(inputCwd: string | undefined): string {
  const defaultCwd = getWorkspaceCwd();

  if (inputCwd === undefined) {
    return defaultCwd;
  }

  const trimmedCwd = inputCwd.trim();

  if (trimmedCwd.length === 0) {
    return `${defaultCwd} (invalid empty cwd override)`;
  }

  return path.resolve(defaultCwd, trimmedCwd);
}

function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
}

function getConfiguredAutoApproveRules(): ApprovalRuleMap {
  const configuredRules = getConfiguration().get<unknown>(SHELL_TOOLS_AUTO_APPROVE_RULES_KEY);

  if (!isRecord(configuredRules)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(configuredRules).filter(([ , value ]) => typeof value === 'boolean'),
  ) as ApprovalRuleMap;
}

function getMergedAutoApproveRules(): ApprovalRuleMap {
  return {
    ...DEFAULT_AUTO_APPROVE_RULES,
    ...getConfiguredAutoApproveRules(),
  };
}

function parseRegexRule(ruleKey: string): RegExp | undefined {
  if (!ruleKey.startsWith('/') || !ruleKey.endsWith('/')) {
    return undefined;
  }

  const pattern = ruleKey.slice(1, -1);

  try {
    return new RegExp(pattern, 'u');
  }
  catch {
    return undefined;
  }
}

function getCompiledRegexRules(rules: ApprovalRuleMap): CompiledRegexRule[] {
  const cachedRules = compiledRegexRulesCache.get(rules);

  if (cachedRules) {
    return cachedRules;
  }

  const compiledRules = Object.entries(rules)
    .map(([ ruleKey, ruleValue ]) => ({
      regex: parseRegexRule(ruleKey),
      ruleKey,
      ruleValue,
    }))
    .filter((rule): rule is CompiledRegexRule => rule.regex !== undefined);

  compiledRegexRulesCache.set(rules, compiledRules);
  return compiledRules;
}

function getNamedRule(rules: ApprovalRuleMap, commandName: string): boolean | undefined {
  if (Object.hasOwn(rules, commandName)) {
    return rules[commandName];
  }

  const lowerCaseCommandName = commandName.toLowerCase();

  if (lowerCaseCommandName !== commandName && Object.hasOwn(rules, lowerCaseCommandName)) {
    return rules[lowerCaseCommandName];
  }

  return undefined;
}

function extractFirstToken(command: string): string | undefined {
  const trimmedCommand = command.trim();

  if (trimmedCommand.length === 0) {
    return undefined;
  }

  let token = '';
  let quote: 'double' | 'single' | undefined;

  for (const character of trimmedCommand) {
    if (quote === 'single') {
      token += character;

      if (character === '\'') {
        quote = undefined;
      }

      continue;
    }

    if (quote === 'double') {
      token += character;

      if (character === '"') {
        quote = undefined;
      }

      continue;
    }

    if (character === '\'') {
      token += character;
      quote = 'single';
      continue;
    }

    if (character === '"') {
      token += character;
      quote = 'double';
      continue;
    }

    if (/\s/u.test(character)) {
      break;
    }

    token += character;
  }

  return token.length > 0 ? token : undefined;
}

function pushSubcommand(subcommands: string[], current: string): void {
  const trimmedCommand = current.trim();

  if (trimmedCommand.length > 0) {
    subcommands.push(trimmedCommand);
  }
}

function splitShellSubcommands(commandLine: string): string[] | undefined {
  const subcommands: string[] = [];
  let current = '';
  let escapeNext = false;
  let quote: 'double' | 'single' | undefined;

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];
    const nextCharacter = commandLine[index + 1];

    if (escapeNext) {
      current += character;
      escapeNext = false;
      continue;
    }

    if (quote === 'single') {
      current += character;

      if (character === '\'') {
        quote = undefined;
      }

      continue;
    }

    if (character === '\\') {
      current += character;
      escapeNext = true;
      continue;
    }

    if (quote === 'double') {
      current += character;

      if (character === '"') {
        quote = undefined;
      }

      continue;
    }

    if (character === '`') {
      return undefined;
    }

    if (character === '$' && nextCharacter === '(') {
      return undefined;
    }

    if (character === '\'') {
      current += character;
      quote = 'single';
      continue;
    }

    if (character === '"') {
      current += character;
      quote = 'double';
      continue;
    }

    if (character === '>' || character === '<') {
      return undefined;
    }

    if (character === '&') {
      pushSubcommand(subcommands, current);
      current = '';

      if (nextCharacter === '&') {
        index += 1;
      }

      continue;
    }

    if (character === '|') {
      pushSubcommand(subcommands, current);
      current = '';

      if (nextCharacter === '|') {
        index += 1;
      }

      continue;
    }

    if (character === ';') {
      pushSubcommand(subcommands, current);
      current = '';
      continue;
    }

    current += character;
  }

  if (escapeNext || quote !== undefined) {
    return undefined;
  }

  pushSubcommand(subcommands, current);
  return subcommands;
}

function evaluateSingleCommand(command: string, rules: ApprovalRuleMap): CommandApprovalResult {
  const trimmedCommand = command.trim();

  if (trimmedCommand.length === 0) {
    return { state: 'pending' };
  }

  const commandName = extractFirstToken(trimmedCommand);

  if (!commandName) {
    return {
      reason: 'The command name could not be determined safely.',
      state: 'pending',
    };
  }

  const namedRule = getNamedRule(rules, commandName);

  if (namedRule === false) {
    return {
      reason: `The command \`${commandName}\` is denied by the shell security policy.`,
      state: 'denied',
    };
  }

  const regexRules = getCompiledRegexRules(rules);

  const deniedRegexRule = regexRules.find(rule => !rule.ruleValue && rule.regex.test(trimmedCommand));

  if (deniedRegexRule) {
    return {
      reason: `The command matched denied rule ${deniedRegexRule.ruleKey}.`,
      state: 'denied',
    };
  }

  const allowedRegexRule = regexRules.find(rule => rule.ruleValue && rule.regex.test(trimmedCommand));

  if (allowedRegexRule || namedRule === true) {
    return { state: 'allowed' };
  }

  return {
    reason: 'The command is not allowlisted for auto-approval.',
    state: 'pending',
  };
}

export function analyzeShellRunAutoApproval(commandLine: string): ShellRunApprovalDecision {
  const configuration = getConfiguration();
  const autoApproveEnabled = configuration.get(SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY);
  const autoApproveWarningAccepted = configuration.get(SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY);

  if (autoApproveEnabled !== true) {
    return {
      autoApprove: false,
      reason: 'Auto-approval is disabled in settings.',
    };
  }

  if (autoApproveWarningAccepted !== true) {
    return {
      autoApprove: false,
      reason: 'Auto-approval warning has not been accepted in settings.',
    };
  }

  const subcommands = splitShellSubcommands(commandLine);

  if (!subcommands || subcommands.length === 0) {
    return {
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    };
  }

  const rules = getMergedAutoApproveRules();
  const subcommandResults = subcommands.map(subcommand => evaluateSingleCommand(subcommand, rules));
  const deniedSubcommandResult = subcommandResults.find(result => result.state === 'denied');

  if (deniedSubcommandResult) {
    return {
      autoApprove: false,
      reason: deniedSubcommandResult.reason,
    };
  }

  const commandLineResult = evaluateSingleCommand(commandLine, rules);

  if (commandLineResult.state === 'denied') {
    return {
      autoApprove: false,
      reason: commandLineResult.reason,
    };
  }

  const hasPendingSubcommand = subcommandResults.some(result => result.state !== 'allowed');

  if (hasPendingSubcommand || commandLineResult.state !== 'allowed') {
    return {
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    };
  }

  return {
    autoApprove: true,
  };
}

type BuildConfirmationOptions = {
  autoApprovalDecision: ShellRunApprovalDecision;
  command: string;
  cwd?: string;
  explanation?: string;
  goal?: string;
};

export function buildShellRunConfirmationMessage(options: BuildConfirmationOptions): string {
  const commandText = options.command.length > 0 ? options.command : '(empty command)';
  const explanationText = options.explanation?.trim().length ? options.explanation : '(not provided)';
  const goalText = options.goal?.trim().length ? options.goal : '(not provided)';
  const lines = [
    `Command: ${commandText}`,
    `Cwd: ${getPreviewCwd(options.cwd)}`,
    `Explanation: ${explanationText}`,
    `Goal: ${goalText}`,
  ];

  if (options.autoApprovalDecision.reason) {
    lines.push(`Approval note: ${options.autoApprovalDecision.reason}`);
  }

  return lines.join('\n\n');
}

export const shellToolSecurityInternals = {
  evaluateSingleCommand,
  extractFirstToken,
  getMergedAutoApproveRules,
  getPreviewCwd,
  parseRegexRule,
  splitShellSubcommands,
};
