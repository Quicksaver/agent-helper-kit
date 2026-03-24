import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { checkSync } from 'recheck';

import { logWarn } from '@/logging';
import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';

export const SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY = 'shellTools.autoApprove.enabled';
export const SHELL_TOOLS_AUTO_APPROVE_RULES_KEY = 'shellTools.autoApprove.rules';
export const SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY = 'shellTools.autoApprove.warningAccepted';

type ApprovalRuleMap = Record<string, boolean>;

type ApprovalRegexRuleParseResult
  = | {
    flags: string;
    kind: 'literal';
    pattern: string;
  }
  | {
    kind: 'invalid';
  }
  | {
    kind: 'non-literal';
  };

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
  '/^sed\\b.*;\\s*[wW]\\b/': false,
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

const APPROVAL_REGEX_LITERAL_PATTERN = /^\/((?:\\.|[^/])*)\/([a-z]*)$/u;
// Recognize all valid JS literal flags, then fail closed on stateful flags below.
const APPROVAL_REGEX_RECOGNIZED_FLAGS = new Set([ 'd', 'g', 'i', 'm', 's', 'u', 'v', 'y' ]);
const compiledRegexRulesCache = new WeakMap<ApprovalRuleMap, CompiledRegexRule[]>();
const parsedRegexRuleCache = new Map<string, null | RegExp>();
const safeConfiguredRegexRuleCache = new Map<string, boolean>();
const REGEX_RULE_VALIDATION_TIMEOUT_MS = 250;
const WHITESPACE_CHARACTER_REGEX = /\s/u;
let regexRuleValidator: typeof checkSync = checkSync;
let configuredAutoApproveRulesCache: undefined | {
  cacheKey: string;
  rules: ApprovalRuleMap;
};
let mergedAutoApproveRulesCache: undefined | {
  cacheKey: string;
  rules: ApprovalRuleMap;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseApprovalRegexRule(ruleKey: string): ApprovalRegexRuleParseResult {
  if (!ruleKey.startsWith('/')) {
    return { kind: 'non-literal' };
  }

  const match = APPROVAL_REGEX_LITERAL_PATTERN.exec(ruleKey);

  if (!match) {
    return { kind: 'invalid' };
  }

  const pattern = match[1];
  const rawFlags = match[2];
  const seenFlags = new Set<string>();

  for (const flag of rawFlags) {
    if (!APPROVAL_REGEX_RECOGNIZED_FLAGS.has(flag) || seenFlags.has(flag)) {
      return { kind: 'invalid' };
    }

    seenFlags.add(flag);
  }

  if (seenFlags.has('g') || seenFlags.has('y')) {
    return { kind: 'invalid' };
  }

  return {
    flags: seenFlags.has('u') || seenFlags.has('v') ? rawFlags : `${rawFlags}u`,
    kind: 'literal',
    pattern,
  };
}

function getConfiguredRulesCacheKey(configuredRules: unknown): string {
  if (!isRecord(configuredRules)) {
    return `__non-record__:${String(configuredRules)}`;
  }

  const sortedEntries = Object.entries(configuredRules).sort(
    ([ leftKey ], [ rightKey ]) => leftKey.localeCompare(rightKey),
  );

  return JSON.stringify(sortedEntries);
}

export function resetShellToolSecurityCaches(): void {
  configuredAutoApproveRulesCache = undefined;
  mergedAutoApproveRulesCache = undefined;
  parsedRegexRuleCache.clear();
  regexRuleValidator = checkSync;
  safeConfiguredRegexRuleCache.clear();
}

function setRegexRuleValidatorForTest(validator: typeof checkSync): void {
  regexRuleValidator = validator;
}

function isSafeConfiguredRegexRule(ruleKey: string): boolean {
  const parsedRule = parseApprovalRegexRule(ruleKey);

  if (parsedRule.kind === 'non-literal') {
    return true;
  }

  const cachedResult = safeConfiguredRegexRuleCache.get(ruleKey);

  if (cachedResult !== undefined) {
    return cachedResult;
  }

  if (parsedRule.kind === 'invalid') {
    logWarn(
      `Ignoring configured auto-approve regex rule ${ruleKey} because it is not a valid regex literal or uses unsupported flags.`,
    );
    safeConfiguredRegexRuleCache.set(ruleKey, false);
    return false;
  }

  try {
    const diagnostics = regexRuleValidator(parsedRule.pattern, parsedRule.flags, {
      timeout: REGEX_RULE_VALIDATION_TIMEOUT_MS,
    });

    if (diagnostics.status === 'vulnerable') {
      logWarn(
        `Ignoring configured auto-approve regex rule ${ruleKey} because recheck marked it as potentially vulnerable (${diagnostics.complexity.summary}).`,
      );
      safeConfiguredRegexRuleCache.set(ruleKey, false);
      return false;
    }

    if (diagnostics.status === 'unknown') {
      logWarn(
        `Ignoring configured auto-approve regex rule ${ruleKey} because recheck could not validate it (${diagnostics.error.kind}).`,
      );
      safeConfiguredRegexRuleCache.set(ruleKey, false);
      return false;
    }

    safeConfiguredRegexRuleCache.set(ruleKey, true);
    return true;
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';

    logWarn(`Ignoring configured auto-approve regex rule ${ruleKey} because validation failed: ${message}.`);
    safeConfiguredRegexRuleCache.set(ruleKey, false);
    return false;
  }
}

function getConfiguredAutoApproveRules(): ApprovalRuleMap {
  const configuredRules = getConfiguration().get<unknown>(SHELL_TOOLS_AUTO_APPROVE_RULES_KEY);
  const cacheKey = getConfiguredRulesCacheKey(configuredRules);

  if (configuredAutoApproveRulesCache?.cacheKey === cacheKey) {
    return configuredAutoApproveRulesCache.rules;
  }

  if (!isRecord(configuredRules)) {
    const emptyRules = {};

    configuredAutoApproveRulesCache = {
      cacheKey,
      rules: emptyRules,
    };
    return emptyRules;
  }

  const filteredRules = Object.fromEntries(
    Object.entries(configuredRules).filter(([ ruleKey, value ]) => {
      if (typeof value !== 'boolean') {
        return false;
      }

      return isSafeConfiguredRegexRule(ruleKey);
    }),
  ) as ApprovalRuleMap;

  configuredAutoApproveRulesCache = {
    cacheKey,
    rules: filteredRules,
  };

  return filteredRules;
}

function getMergedAutoApproveRules(): ApprovalRuleMap {
  const configuredRules = getConfiguration().get<unknown>(SHELL_TOOLS_AUTO_APPROVE_RULES_KEY);
  const cacheKey = getConfiguredRulesCacheKey(configuredRules);

  if (mergedAutoApproveRulesCache?.cacheKey === cacheKey) {
    return mergedAutoApproveRulesCache.rules;
  }

  const mergedRules = {
    ...DEFAULT_AUTO_APPROVE_RULES,
    ...getConfiguredAutoApproveRules(),
  };

  mergedAutoApproveRulesCache = {
    cacheKey,
    rules: mergedRules,
  };

  return mergedRules;
}

function parseRegexRule(ruleKey: string): RegExp | undefined {
  const parsedRule = parseApprovalRegexRule(ruleKey);

  if (parsedRule.kind !== 'literal') {
    return undefined;
  }

  const cachedRule = parsedRegexRuleCache.get(ruleKey);

  if (cachedRule !== undefined) {
    return cachedRule ?? undefined;
  }

  try {
    const compiledRule = new RegExp(parsedRule.pattern, parsedRule.flags);

    parsedRegexRuleCache.set(ruleKey, compiledRule);
    return compiledRule;
  }
  catch {
    parsedRegexRuleCache.set(ruleKey, null);
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

  let matchedRuleValue: boolean | undefined;

  for (const [ ruleKey, ruleValue ] of Object.entries(rules)) {
    if (!ruleKey.startsWith('/') && ruleKey.toLowerCase() === lowerCaseCommandName) {
      if (matchedRuleValue === undefined) {
        matchedRuleValue = ruleValue;
        continue;
      }

      if (matchedRuleValue !== ruleValue) {
        return undefined;
      }
    }
  }

  return matchedRuleValue;
}

/**
 * Extract the first whitespace-delimited token from a shell command string.
 *
 * This preserves quote characters so callers can make conservative decisions,
 * but it intentionally does not interpret escape sequences outside quotes.
 * Command names that rely on escaped whitespace therefore fail closed and
 * require manual approval instead of matching a named auto-approve rule.
 */
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

    if (WHITESPACE_CHARACTER_REGEX.test(character)) {
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
      if (character === '`') {
        return undefined;
      }

      if (character === '$' && nextCharacter === '(') {
        return undefined;
      }

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

    if (character === '\n' || character === '\r') {
      pushSubcommand(subcommands, current);
      current = '';

      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

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

  const commandName = extractFirstToken(trimmedCommand) ?? trimmedCommand;

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
  getConfiguredAutoApproveRules,
  getMergedAutoApproveRules,
  getPreviewCwd,
  parseApprovalRegexRule,
  parseRegexRule,
  resetShellToolSecurityCaches,
  setRegexRuleValidatorForTest,
  splitShellSubcommands,
};
