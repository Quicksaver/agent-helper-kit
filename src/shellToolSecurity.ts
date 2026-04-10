import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { checkSync } from 'recheck/lib/browser';

import { logWarn } from '@/logging';
import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';
import {
  assessShellCommandRisk,
  SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY,
} from '@/shellRiskAssessment';

export const SHELL_TOOLS_APPROVAL_RULES_KEY = 'shellTools.approvalRules';
export const SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY = 'shellTools.autoApprovePotentiallyDestructiveCommands';

export type ApprovalRuleValue = 'allow' | 'ask' | 'deny';

type ApprovalRuleMap = Record<string, ApprovalRuleValue>;

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

type CompiledRegexRule = {
  regex: RegExp;
  ruleKey: string;
  ruleValue: ApprovalRuleValue;
};

type CommandRuleDecision = {
  decision: 'allow' | 'ask' | 'defer' | 'deny';
  reason?: string;
};

export type ShellRunApprovalDecision = {
  decision: 'allow' | 'ask' | 'deny';
  modelAssessment?: string;
  reason?: string;
};

const DEFAULT_APPROVAL_RULES: ApprovalRuleMap = {
  '/^docker\\s+(ps|images|info|version|inspect|logs)\\b/': 'allow',
  '/^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/': 'deny',
  '/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+diff\\b/': 'allow',
  '/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+log\\b/': 'allow',
  '/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+show\\b/': 'allow',
  '/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+status\\b/': 'allow',
  '/^npm\\s+(ls|list|outdated|view|info|show|explain|why)\\b/': 'allow',
  '/^rg\\b.*\\s(--hostname-bin|--pre)\\b/': 'deny',
  '/^sed\\b.*;\\s*[wW]\\b/': 'deny',
  '/^sed\\b.*\\s(-[a-zA-Z]*(e|f|i)[a-zA-Z]*|--expression|--file|--in-place)\\b/': 'deny',
  '/^sed\\b.*s\\/.*\\/.*\\/[ew]/': 'deny',
  '/^sort\\b.*\\s-o\\b/': 'deny',
  cat: 'allow',
  chmod: 'deny',
  chown: 'deny',
  curl: 'deny',
  dd: 'deny',
  del: 'deny',
  echo: 'allow',
  erase: 'deny',
  eval: 'deny',
  find: 'allow',
  grep: 'allow',
  head: 'allow',
  iex: 'deny',
  'Invoke-Expression': 'deny',
  'Invoke-RestMethod': 'deny',
  'Invoke-WebRequest': 'deny',
  irm: 'deny',
  iwr: 'deny',
  jq: 'deny',
  kill: 'deny',
  ls: 'allow',
  ps: 'deny',
  pwd: 'allow',
  rd: 'deny',
  'Remove-Item': 'deny',
  rg: 'allow',
  ri: 'deny',
  rm: 'deny',
  rmdir: 'deny',
  sed: 'allow',
  'Set-Acl': 'deny',
  'Set-ItemProperty': 'deny',
  sort: 'allow',
  sp: 'deny',
  spps: 'deny',
  'Stop-Process': 'deny',
  tail: 'allow',
  taskkill: 'deny',
  'taskkill.exe': 'deny',
  top: 'deny',
  uniq: 'allow',
  wc: 'allow',
  wget: 'deny',
  which: 'allow',
  xargs: 'deny',
};

const APPROVAL_REGEX_LITERAL_PATTERN = /^\/((?:\\.|[^/])*)\/([a-z]*)$/u;
const APPROVAL_REGEX_RECOGNIZED_FLAGS = new Set([ 'd', 'g', 'i', 'm', 's', 'u', 'v', 'y' ]);
const APPROVAL_RULE_VALUES = new Set<ApprovalRuleValue>([ 'allow', 'ask', 'deny' ]);
const compiledRegexRulesCache = new WeakMap<ApprovalRuleMap, CompiledRegexRule[]>();
const parsedRegexRuleCache = new Map<string, null | RegExp>();
const safeConfiguredRegexRuleCache = new Map<string, boolean>();
const REGEX_RULE_VALIDATION_TIMEOUT_MS = 250;
const REGEX_RULE_VALIDATION_RETRY_TIMEOUT_MS = 1000;
const WHITESPACE_CHARACTER_REGEX = /\s/u;
const TRANSIENT_ENVIRONMENT_VARIABLE_NAME_CHARACTER_REGEX = /[a-zA-Z0-9_]/u;
let regexRuleValidator: typeof checkSync = checkSync;
let configuredApprovalRulesCache: undefined | {
  cacheKey: string;
  rules: ApprovalRuleMap;
};
let mergedApprovalRulesCache: undefined | {
  cacheKey: string;
  rules: ApprovalRuleMap;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
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

/**
 * Parse a configured regex rule written as a JavaScript-style /pattern/flags
 * literal. Rules that are not literals, use duplicate flags, or rely on
 * stateful matching fail closed and never participate in auto-approval.
 */
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

  return JSON.stringify(
    Object.entries(configuredRules).sort(([ leftKey ], [ rightKey ]) => leftKey.localeCompare(rightKey)),
  );
}

export function resetShellToolSecurityCaches(): void {
  configuredApprovalRulesCache = undefined;
  mergedApprovalRulesCache = undefined;
  parsedRegexRuleCache.clear();
  regexRuleValidator = checkSync;
  safeConfiguredRegexRuleCache.clear();
}

function setRegexRuleValidatorForTest(validator: typeof checkSync): void {
  regexRuleValidator = validator;
}

/**
 * Validate a configured regex with a short timeout, then retry once with a
 * longer timeout when recheck reports an inconclusive timeout.
 */
function validateConfiguredRegexRule(pattern: string, flags: string) {
  const firstDiagnostics = regexRuleValidator(pattern, flags, {
    timeout: REGEX_RULE_VALIDATION_TIMEOUT_MS,
  });

  if (firstDiagnostics.status === 'unknown' && firstDiagnostics.error.kind === 'timeout') {
    return regexRuleValidator(pattern, flags, {
      timeout: REGEX_RULE_VALIDATION_RETRY_TIMEOUT_MS,
    });
  }

  return firstDiagnostics;
}

/**
 * Decide whether a configured regex rule is safe enough to use for approval
 * decisions. Invalid, vulnerable, and inconclusive rules are ignored and logged.
 */
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
      `Ignoring configured shell approval regex rule ${ruleKey} because it is not a valid regex literal or uses unsupported flags.`,
    );
    safeConfiguredRegexRuleCache.set(ruleKey, false);
    return false;
  }

  try {
    const diagnostics = validateConfiguredRegexRule(parsedRule.pattern, parsedRule.flags);

    if (diagnostics.status === 'vulnerable') {
      logWarn(
        `Ignoring configured shell approval regex rule ${ruleKey} because recheck marked it as potentially vulnerable (${diagnostics.complexity.summary}).`,
      );
      safeConfiguredRegexRuleCache.set(ruleKey, false);
      return false;
    }

    if (diagnostics.status === 'unknown') {
      logWarn(
        `Ignoring configured shell approval regex rule ${ruleKey} because recheck could not validate it (${diagnostics.error.kind}).`,
      );
      safeConfiguredRegexRuleCache.set(ruleKey, false);
      return false;
    }

    safeConfiguredRegexRuleCache.set(ruleKey, true);
    return true;
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';

    logWarn(`Ignoring configured shell approval regex rule ${ruleKey} because validation failed: ${message}.`);
    safeConfiguredRegexRuleCache.set(ruleKey, false);
    return false;
  }
}

function getConfiguredApprovalRules(): ApprovalRuleMap {
  const configuredRules = getConfiguration().get<unknown>(SHELL_TOOLS_APPROVAL_RULES_KEY);
  const cacheKey = getConfiguredRulesCacheKey(configuredRules);

  if (configuredApprovalRulesCache?.cacheKey === cacheKey) {
    return configuredApprovalRulesCache.rules;
  }

  if (!isRecord(configuredRules)) {
    const emptyRules = {};

    configuredApprovalRulesCache = {
      cacheKey,
      rules: emptyRules,
    };
    return emptyRules;
  }

  const filteredRules = Object.fromEntries(
    Object.entries(configuredRules).filter(([ ruleKey, value ]) => {
      if (typeof value !== 'string' || !APPROVAL_RULE_VALUES.has(value as ApprovalRuleValue)) {
        return false;
      }

      return isSafeConfiguredRegexRule(ruleKey);
    }),
  ) as ApprovalRuleMap;

  configuredApprovalRulesCache = {
    cacheKey,
    rules: filteredRules,
  };

  return filteredRules;
}

/**
 * Merge validated user-defined approval rules over the built-in defaults.
 * User rules override defaults by key after regex safety filtering succeeds.
 */
function getMergedApprovalRules(): ApprovalRuleMap {
  const configuredRules = getConfiguration().get<unknown>(SHELL_TOOLS_APPROVAL_RULES_KEY);
  const cacheKey = getConfiguredRulesCacheKey(configuredRules);

  if (mergedApprovalRulesCache?.cacheKey === cacheKey) {
    return mergedApprovalRulesCache.rules;
  }

  const mergedRules = {
    ...DEFAULT_APPROVAL_RULES,
    ...getConfiguredApprovalRules(),
  };

  mergedApprovalRulesCache = {
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

function getNamedRule(rules: ApprovalRuleMap, commandName: string): ApprovalRuleValue | undefined {
  if (Object.hasOwn(rules, commandName)) {
    return rules[commandName];
  }

  const lowerCaseCommandName = commandName.toLowerCase();

  if (lowerCaseCommandName !== commandName && Object.hasOwn(rules, lowerCaseCommandName)) {
    return rules[lowerCaseCommandName];
  }

  let matchedRuleValue: ApprovalRuleValue | undefined;

  for (const [ ruleKey, ruleValue ] of Object.entries(rules)) {
    if (!ruleKey.startsWith('/') && ruleKey.toLowerCase() === lowerCaseCommandName) {
      if (matchedRuleValue === undefined) {
        matchedRuleValue = ruleValue;
        continue;
      }

      if (matchedRuleValue !== ruleValue) {
        return 'ask';
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

function parseLeadingTransientEnvironmentAssignment(command: string, startIndex: number): number | undefined {
  if (startIndex >= command.length) {
    return undefined;
  }

  const firstCharacter = command[startIndex];

  if (!/[a-zA-Z_]/u.test(firstCharacter)) {
    return undefined;
  }

  let index = startIndex + 1;

  while (
    index < command.length
    && TRANSIENT_ENVIRONMENT_VARIABLE_NAME_CHARACTER_REGEX.test(command[index] ?? '')
  ) {
    index += 1;
  }

  if (command[index] !== '=') {
    return undefined;
  }

  index += 1;

  let escapeNext = false;
  let quote: 'double' | 'single' | undefined;

  for (; index < command.length; index += 1) {
    const character = command[index];
    const nextCharacter = command[index + 1];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (quote === 'single') {
      if (character === '\'') {
        quote = undefined;
      }

      continue;
    }

    if (character === '\\') {
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
      quote = 'single';
      continue;
    }

    if (character === '"') {
      quote = 'double';
      continue;
    }

    if (WHITESPACE_CHARACTER_REGEX.test(character)) {
      return index;
    }
  }

  if (escapeNext || quote !== undefined) {
    return undefined;
  }

  return index;
}

function stripLeadingTransientEnvironmentAssignments(command: string): {
  hadTransientEnvironmentAssignments: boolean;
  strippedCommand: string;
} {
  let index = 0;

  while (index < command.length && WHITESPACE_CHARACTER_REGEX.test(command[index] ?? '')) {
    index += 1;
  }

  const leadingWhitespace = command.slice(0, index);
  let scanIndex = index;
  let hadTransientEnvironmentAssignments = false;

  while (scanIndex < command.length) {
    const assignmentEndIndex = parseLeadingTransientEnvironmentAssignment(command, scanIndex);

    if (assignmentEndIndex === undefined) {
      break;
    }

    hadTransientEnvironmentAssignments = true;
    scanIndex = assignmentEndIndex;

    while (scanIndex < command.length && WHITESPACE_CHARACTER_REGEX.test(command[scanIndex] ?? '')) {
      scanIndex += 1;
    }
  }

  if (!hadTransientEnvironmentAssignments) {
    return {
      hadTransientEnvironmentAssignments,
      strippedCommand: command,
    };
  }

  return {
    hadTransientEnvironmentAssignments,
    strippedCommand: `${leadingWhitespace}${command.slice(scanIndex)}`,
  };
}

function stripTransientEnvironmentAssignmentsFromCommandLine(commandLine: string): undefined | {
  hadTransientEnvironmentAssignments: boolean;
  strippedCommandLine: string;
} {
  let current = '';
  let escapeNext = false;
  let quote: 'double' | 'single' | undefined;
  let hadTransientEnvironmentAssignments = false;
  let strippedCommandLine = '';

  const flushCurrent = () => {
    const strippedCurrent = stripLeadingTransientEnvironmentAssignments(current);

    hadTransientEnvironmentAssignments ||= strippedCurrent.hadTransientEnvironmentAssignments;
    strippedCommandLine += strippedCurrent.strippedCommand;
    current = '';
  };

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
      flushCurrent();
      strippedCommandLine += nextCharacter === '&' ? '&&' : '&';

      if (nextCharacter === '&') {
        index += 1;
      }

      continue;
    }

    if (character === '|') {
      flushCurrent();
      strippedCommandLine += nextCharacter === '|' ? '||' : '|';

      if (nextCharacter === '|') {
        index += 1;
      }

      continue;
    }

    if (character === ';') {
      flushCurrent();
      strippedCommandLine += character;
      continue;
    }

    if (character === '\n' || character === '\r') {
      flushCurrent();
      strippedCommandLine += character;

      if (character === '\r' && nextCharacter === '\n') {
        strippedCommandLine += nextCharacter;
        index += 1;
      }

      continue;
    }

    current += character;
  }

  if (escapeNext || quote !== undefined) {
    return undefined;
  }

  flushCurrent();

  return {
    hadTransientEnvironmentAssignments,
    strippedCommandLine,
  };
}

function evaluateSingleCommandAgainstRules(command: string, rules: ApprovalRuleMap): CommandRuleDecision {
  const trimmedCommand = command.trim();

  if (trimmedCommand.length === 0) {
    return { decision: 'defer' };
  }

  const commandName = extractFirstToken(trimmedCommand) ?? trimmedCommand;
  const namedRule = getNamedRule(rules, commandName);
  const regexOutcomes = getCompiledRegexRules(rules)
    .filter(rule => rule.regex.test(trimmedCommand))
    .map(rule => ({
      reason: `The command matched ${rule.ruleValue} rule ${rule.ruleKey}.`,
      value: rule.ruleValue,
    }));

  if (namedRule === 'deny') {
    return {
      decision: 'deny',
      reason: `The command \`${commandName}\` is denied by the shell approval policy.`,
    };
  }

  const deniedRegexRule = regexOutcomes.find(rule => rule.value === 'deny');

  if (deniedRegexRule) {
    return {
      decision: 'deny',
      reason: deniedRegexRule.reason,
    };
  }

  if (namedRule === 'ask') {
    return {
      decision: 'ask',
      reason: `The command \`${commandName}\` is configured to always request approval.`,
    };
  }

  const askedRegexRule = regexOutcomes.find(rule => rule.value === 'ask');

  if (askedRegexRule) {
    return {
      decision: 'ask',
      reason: askedRegexRule.reason,
    };
  }

  if (namedRule === 'allow') {
    return { decision: 'allow' };
  }

  const allowedRegexRule = regexOutcomes.find(rule => rule.value === 'allow');

  if (allowedRegexRule) {
    return {
      decision: 'allow',
      reason: allowedRegexRule.reason,
    };
  }

  return {
    decision: 'defer',
  };
}

function evaluateFullCommandLineAgainstRules(command: string, rules: ApprovalRuleMap): CommandRuleDecision {
  const trimmedCommand = command.trim();

  if (trimmedCommand.length === 0) {
    return { decision: 'defer' };
  }

  const regexOutcomes = getCompiledRegexRules(rules)
    .filter(rule => rule.regex.test(trimmedCommand))
    .map(rule => ({
      reason: `The command matched ${rule.ruleValue} rule ${rule.ruleKey}.`,
      value: rule.ruleValue,
    }));

  const deniedRegexRule = regexOutcomes.find(rule => rule.value === 'deny');

  if (deniedRegexRule) {
    return {
      decision: 'deny',
      reason: deniedRegexRule.reason,
    };
  }

  const askedRegexRule = regexOutcomes.find(rule => rule.value === 'ask');

  if (askedRegexRule) {
    return {
      decision: 'ask',
      reason: askedRegexRule.reason,
    };
  }

  const allowedRegexRule = regexOutcomes.find(rule => rule.value === 'allow');

  if (allowedRegexRule) {
    return {
      decision: 'allow',
      reason: allowedRegexRule.reason,
    };
  }

  return {
    decision: 'defer',
  };
}

/**
 * Split a shell command line into approval-sized subcommands using a
 * conservative parser. Anything ambiguous, such as substitutions,
 * redirections, dangling escapes, or unterminated quotes, fails closed.
 */
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

/**
 * Evaluate a single parsed subcommand against named and regex approval rules.
 * Deny wins first, then ask, then allow; unmatched commands defer to later
 * model assessment or explicit approval.
 */
function evaluateSingleCommand(command: string, rules: ApprovalRuleMap): CommandRuleDecision {
  const strippedCommand = stripLeadingTransientEnvironmentAssignments(command);
  const evaluation = evaluateSingleCommandAgainstRules(strippedCommand.strippedCommand, rules);

  if (!strippedCommand.hadTransientEnvironmentAssignments) {
    return evaluation;
  }

  if (evaluation.decision === 'ask' || evaluation.decision === 'deny') {
    return evaluation;
  }

  return {
    decision: 'defer',
    reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
  };
}

/**
 * Evaluate full command-line regex rules after subcommand-level analysis. This
 * lets compound patterns still match the original text while preserving the
 * same deny > ask > allow precedence. Per-subcommand transient env prefixes
 * are handled earlier by `evaluateSingleCommand` during full disposition.
 */
function evaluateFullCommandLine(command: string, rules: ApprovalRuleMap): CommandRuleDecision {
  const strippedCommandLine = stripTransientEnvironmentAssignmentsFromCommandLine(command);

  if (!strippedCommandLine) {
    return { decision: 'defer' };
  }

  const evaluation = evaluateFullCommandLineAgainstRules(strippedCommandLine.strippedCommandLine, rules);

  if (!strippedCommandLine.hadTransientEnvironmentAssignments) {
    return evaluation;
  }

  if (evaluation.decision === 'ask' || evaluation.decision === 'deny') {
    return evaluation;
  }

  return {
    decision: 'defer',
    reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
  };
}

/**
 * Resolve the rule-based disposition for a shell command line. The parser must
 * first split the line safely; once parsed, explicit deny rules win, then ask,
 * then allow, before any model-based risk assessment is considered.
 */
export function analyzeShellRunRuleDisposition(commandLine: string): CommandRuleDecision {
  const subcommands = splitShellSubcommands(commandLine);

  if (!subcommands || subcommands.length === 0) {
    return {
      decision: 'ask',
      reason: 'The command line could not be parsed safely for approval rules, so explicit approval is required.',
    };
  }

  const rules = getMergedApprovalRules();
  const subcommandResults = subcommands.map(subcommand => evaluateSingleCommand(subcommand, rules));
  const deniedSubcommandResult = subcommandResults.find(result => result.decision === 'deny');

  if (deniedSubcommandResult) {
    return deniedSubcommandResult;
  }

  const commandLineResult = evaluateFullCommandLine(commandLine, rules);

  if (commandLineResult.decision === 'deny') {
    return commandLineResult;
  }

  const askedSubcommandResult = subcommandResults.find(result => result.decision === 'ask');

  if (askedSubcommandResult) {
    return askedSubcommandResult;
  }

  if (commandLineResult.decision === 'ask') {
    return commandLineResult;
  }

  if (commandLineResult.decision === 'allow') {
    return commandLineResult;
  }

  if (subcommandResults.every(result => result.decision === 'allow')) {
    return {
      decision: 'allow',
      reason: 'Every parsed subcommand matched an allow rule.',
    };
  }

  if (commandLineResult.reason) {
    return {
      decision: 'defer',
      reason: commandLineResult.reason,
    };
  }

  return {
    decision: 'defer',
  };
}

/**
 * Combine explicit approval rules, optional model-based risk assessment, and
 * the dangerous YOLO override into the final approval decision returned from
 * prepareInvocation.
 */
export async function decideShellRunApproval(options: {
  command: string;
  cwd: string;
  explanation?: string;
  goal?: string;
  riskAssessment: string;
  riskAssessmentContext?: string[];
}, token: vscode.CancellationToken): Promise<ShellRunApprovalDecision> {
  const ruleDisposition = analyzeShellRunRuleDisposition(options.command);

  if (ruleDisposition.decision === 'allow') {
    return {
      decision: 'allow',
      reason: ruleDisposition.reason,
    };
  }

  if (ruleDisposition.decision === 'ask') {
    return {
      decision: 'ask',
      reason: ruleDisposition.reason,
    };
  }

  if (ruleDisposition.decision === 'deny') {
    return {
      decision: 'deny',
      reason: ruleDisposition.reason,
    };
  }

  const yoloSetting = getConfiguration().get(SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY);
  const yoloEnabled = yoloSetting === true;

  if (yoloEnabled) {
    return {
      decision: 'allow',
      reason: 'The YOLO override is enabled, so unresolved commands run without risk-assessment prompting.',
    };
  }

  const modelResult = await assessShellCommandRisk({
    command: options.command,
    cwd: options.cwd,
    explanation: options.explanation,
    goal: options.goal,
    riskAssessment: options.riskAssessment,
    riskAssessmentContext: options.riskAssessmentContext,
  }, token);

  if (modelResult.kind === 'disabled') {
    return {
      decision: 'ask',
      reason: `Risk assessment model is disabled via ${SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY}, so explicit approval is required.`,
    };
  }

  if (modelResult.kind === 'error') {
    return {
      decision: 'ask',
      modelAssessment: modelResult.reason,
      reason: 'Risk assessment could not determine that this command is safe enough to run without approval.',
    };
  }

  if (modelResult.kind === 'timeout') {
    return {
      decision: 'ask',
      modelAssessment: modelResult.reason,
      reason: 'Risk assessment timed out, so explicit approval is required.',
    };
  }

  if (modelResult.decision === 'allow') {
    return {
      decision: 'allow',
      modelAssessment: modelResult.reason,
      reason: `Risk assessment model ${modelResult.modelId} allowed the command to run without explicit approval.`,
    };
  }

  if (modelResult.decision === 'deny') {
    return {
      decision: 'deny',
      modelAssessment: modelResult.reason,
      reason: `Risk assessment model ${modelResult.modelId} denied the command because it appears clearly malicious or outright destructive.`,
    };
  }

  return {
    decision: 'ask',
    modelAssessment: modelResult.reason,
    reason: 'Risk assessment requested explicit approval before running this command.',
  };
}

type BuildConfirmationOptions = {
  approvalDecision: ShellRunApprovalDecision;
  command: string;
  cwd?: string;
  explanation?: string;
  goal?: string;
  riskAssessment: string;
  riskAssessmentContext?: string[];
};

/**
 * Build the human-facing confirmation body shown when a shell command still
 * needs explicit approval after rule evaluation and risk pre-assessment.
 */
export function buildShellRunConfirmationMessage(options: BuildConfirmationOptions): string {
  const commandText = options.command.length > 0 ? options.command : '(empty command)';
  const explanationText = options.explanation?.trim().length ? options.explanation : '(not provided)';
  const goalText = options.goal?.trim().length ? options.goal : '(not provided)';
  const riskAssessmentText = options.riskAssessment.trim().length > 0 ? options.riskAssessment : '(not provided)';
  const lines = [
    `Command: ${commandText}`,
    `Cwd: ${getPreviewCwd(options.cwd)}`,
    `Explanation: ${explanationText}`,
    `Goal: ${goalText}`,
    `Risk pre-assessment: ${riskAssessmentText}`,
  ];

  if (options.riskAssessmentContext && options.riskAssessmentContext.length > 0) {
    lines.push(`Risk context: ${options.riskAssessmentContext.join(', ')}`);
  }

  if (options.approvalDecision.modelAssessment) {
    lines.push(`Risk model note: ${options.approvalDecision.modelAssessment}`);
  }

  if (options.approvalDecision.reason) {
    lines.push(`Approval note: ${options.approvalDecision.reason}`);
  }

  return lines.join('\n\n');
}

export const shellToolSecurityInternals = {
  analyzeShellRunRuleDisposition,
  evaluateFullCommandLine,
  evaluateFullCommandLineAgainstRules,
  evaluateSingleCommand,
  evaluateSingleCommandAgainstRules,
  extractFirstToken,
  getConfiguredApprovalRules,
  getMergedApprovalRules,
  getPreviewCwd,
  parseApprovalRegexRule,
  parseLeadingTransientEnvironmentAssignment,
  parseRegexRule,
  resetShellToolSecurityCaches,
  setRegexRuleValidatorForTest,
  splitShellSubcommands,
  stripLeadingTransientEnvironmentAssignments,
  stripTransientEnvironmentAssignmentsFromCommandLine,
};
