import * as os from 'node:os';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  analyzeShellRunRuleDisposition,
  buildShellRunConfirmationMessage,
  decideShellRunApproval,
  SHELL_TOOLS_APPROVAL_RULES_KEY,
  SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY,
  shellToolSecurityInternals,
} from '@/shellToolSecurity';

const assessShellCommandRisk = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

function createConfiguration(
  getter: (key: string, defaultValue?: unknown) => unknown = (_, defaultValue) => defaultValue,
): {
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      const value = getter(key, defaultValue);

      return value === undefined ? defaultValue : value;
    }),
  };
}

const getConfiguration = vi.hoisted(() => vi.fn());
const workspaceFoldersState = vi.hoisted(() => ({
  value: [
    {
      uri: {
        fsPath: '/workspace',
      },
    },
  ] as undefined | { uri: { fsPath: string } }[],
}));

vi.mock('@/logging', () => ({
  logWarn,
}));

vi.mock('@/shellRiskAssessment', () => ({
  assessShellCommandRisk,
  SHELL_TOOLS_RISK_ASSESSMENT_CHAT_MODEL_KEY: 'shellTools.riskAssessment.chatModel',
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration,
    get workspaceFolders() {
      return workspaceFoldersState.value;
    },
  },
}));

describe('shell tool security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellToolSecurityInternals.resetShellToolSecurityCaches();
    workspaceFoldersState.value = [
      {
        uri: {
          fsPath: '/workspace',
        },
      },
    ];
    getConfiguration.mockReturnValue(createConfiguration());
    assessShellCommandRisk.mockResolvedValue({ kind: 'disabled' });
  });

  afterEach(() => {
    shellToolSecurityInternals.resetShellToolSecurityCaches();
  });

  it('builds a detailed confirmation message with risk context and approval notes', () => {
    expect(buildShellRunConfirmationMessage({
      approvalDecision: {
        decision: 'ask',
        modelAssessment: 'The command may delete files under the workspace.',
        reason: 'Risk assessment requested explicit approval before running this command.',
      },
      command: 'node scripts/danger.js',
      cwd: 'packages/api',
      explanation: 'run a maintenance script',
      goal: 'clean generated files',
      riskAssessment: 'This script may delete generated files under build outputs.',
      riskAssessmentContext: [ 'scripts/danger.js', 'src/cleanup.ts' ],
    })).toBe(
      'Command: node scripts/danger.js\n\nCwd: /workspace/packages/api\n\nExplanation: run a maintenance script\n\nGoal: clean generated files\n\nRisk pre-assessment: This script may delete generated files under build outputs.\n\nRisk context: scripts/danger.js, src/cleanup.ts\n\nRisk model note: The command may delete files under the workspace.\n\nApproval note: Risk assessment requested explicit approval before running this command.',
    );
  });

  it('falls back to the home directory and placeholders when confirmation details are missing', () => {
    workspaceFoldersState.value = undefined;

    expect(buildShellRunConfirmationMessage({
      approvalDecision: {
        decision: 'allow',
      },
      command: '',
      cwd: ' ',
      riskAssessment: '',
    })).toBe(
      `Command: (empty command)\n\nCwd: ${os.homedir()} (invalid empty cwd override)\n\nExplanation: (not provided)\n\nGoal: (not provided)\n\nRisk pre-assessment: (not provided)`,
    );
  });

  it('allows commands when every parsed subcommand matches allow rules', () => {
    expect(analyzeShellRunRuleDisposition('pwd && wc -l README.md')).toEqual({
      decision: 'allow',
      reason: 'Every parsed subcommand matched an allow rule.',
    });
    expect(analyzeShellRunRuleDisposition('git status')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+status\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('git --no-pager diff --stat')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+diff\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('git -C packages/api log --oneline')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+log\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('docker ps')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^docker\\s+(ps|images|info|version|inspect|logs)\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('npm ls react')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^npm\\s+(ls|list|outdated|view|info|show|explain|why)\\b/.',
    });
  });

  it('denies dangerous commands and dangerous variants of otherwise safe commands', () => {
    expect(analyzeShellRunRuleDisposition('RM -rf build')).toEqual({
      decision: 'deny',
      reason: 'The command `RM` is denied by the shell approval policy.',
    });
    expect(analyzeShellRunRuleDisposition('find . -delete')).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('sort -o sorted.txt unsorted.txt')).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^sort\\b.*\\s-o\\b/.',
    });
  });

  it('falls back to risk assessment when transient environment variables suppress an allow rule', () => {
    expect(analyzeShellRunRuleDisposition('FOO=bar pwd')).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
    });
    expect(analyzeShellRunRuleDisposition('FOO=$HOME pwd')).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
    });
    expect(analyzeShellRunRuleDisposition('FOO=bar pwd && git branch')).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
    });
  });

  it('preserves ask and deny rules when transient environment variables are present', () => {
    expect(analyzeShellRunRuleDisposition('FOO=bar rm -rf build')).toEqual({
      decision: 'deny',
      reason: 'The command `rm` is denied by the shell approval policy.',
    });

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          pwd: 'ask',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunRuleDisposition('FOO=bar pwd')).toEqual({
      decision: 'ask',
      reason: 'The command `pwd` is configured to always request approval.',
    });
    expect(analyzeShellRunRuleDisposition('echo $(pwd)')).toEqual({
      decision: 'ask',
      reason: 'The command line could not be parsed safely for approval rules, so explicit approval is required.',
    });
  });

  it('defers unknown commands to the risk assessment model', () => {
    expect(analyzeShellRunRuleDisposition('git branch')).toEqual({
      decision: 'defer',
    });
    expect(analyzeShellRunRuleDisposition('git checkout main')).toEqual({
      decision: 'defer',
    });
  });

  it('applies configured allow, ask, and deny overrides', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^customcmd\\b/': 'allow',
          pwd: 'ask',
          rm: 'allow',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunRuleDisposition('customcmd --help')).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^customcmd\\b/.',
    });
    expect(analyzeShellRunRuleDisposition('pwd')).toEqual({
      decision: 'ask',
      reason: 'The command `pwd` is configured to always request approval.',
    });
    expect(analyzeShellRunRuleDisposition('rm -rf build')).toEqual({
      decision: 'allow',
      reason: 'Every parsed subcommand matched an allow rule.',
    });
  });

  it('ignores invalid configured regex rules and logs a warning', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^customcmd$/g': 'allow',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunRuleDisposition('customcmd')).toEqual({
      decision: 'defer',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured shell approval regex rule /^customcmd$/g because it is not a valid regex literal or uses unsupported flags.',
    );
  });

  it('parses regex approval rules and rejects unsupported forms', () => {
    expect(shellToolSecurityInternals.parseApprovalRegexRule('pwd')).toEqual({ kind: 'non-literal' });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/')).toEqual({
      flags: 'u',
      kind: 'literal',
      pattern: '^pwd$',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/i')).toEqual({
      flags: 'iu',
      kind: 'literal',
      pattern: '^pwd$',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/u')).toEqual({
      flags: 'u',
      kind: 'literal',
      pattern: '^pwd$',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/g')).toEqual({ kind: 'invalid' });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/ii')).toEqual({ kind: 'invalid' });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$')).toEqual({ kind: 'invalid' });
  });

  it('compiles regex approval rules and drops invalid expressions', () => {
    expect(shellToolSecurityInternals.parseRegexRule('/^pwd$/')?.test('pwd')).toBe(true);
    expect(shellToolSecurityInternals.parseRegexRule('/[a-/')).toBeUndefined();
    expect(shellToolSecurityInternals.parseRegexRule('pwd')).toBeUndefined();
  });

  it('extracts first tokens and splits shell command lines conservatively', () => {
    expect(shellToolSecurityInternals.extractFirstToken('   ')).toBeUndefined();
    expect(shellToolSecurityInternals.extractFirstToken('echo "hello world"')).toBe('echo');
    expect(shellToolSecurityInternals.extractFirstToken('"my tool" --flag')).toBe('"my tool"');

    expect(shellToolSecurityInternals.splitShellSubcommands('pwd && wc -l README.md;git status\r\necho ok')).toEqual([
      'pwd',
      'wc -l README.md',
      'git status',
      'echo ok',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo $(pwd)')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo hi > out.txt')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "unterminated')).toBeUndefined();
  });

  it('covers additional cwd preview and shell parser edge cases', () => {
    expect(shellToolSecurityInternals.getPreviewCwd(undefined)).toBe('/workspace');
    expect(shellToolSecurityInternals.getPreviewCwd('packages/api')).toBe('/workspace/packages/api');
    expect(shellToolSecurityInternals.extractFirstToken('\'two words\' --flag')).toBe('\'two words\'');
    expect(shellToolSecurityInternals.splitShellSubcommands('echo one\\ two | cat')).toEqual([
      'echo one\\ two',
      'cat',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('printf \'a b\' || cat')).toEqual([
      'printf \'a b\'',
      'cat',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "fine" && cat')).toEqual([
      'echo "fine"',
      'cat',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "bad `subshell`"')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "bad $(subshell)"')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo `pwd`')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo trailing\\')).toBeUndefined();
    expect(shellToolSecurityInternals.stripLeadingTransientEnvironmentAssignments('  FOO=bar BAR="two words" pwd')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommand: '  pwd',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar pwd && BAR="two words" wc -l README.md')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd && wc -l README.md',
    });
  });

  it('parses transient environment assignments conservatively', () => {
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=bar pwd', 0)).toBe('FOO=bar'.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=$HOME pwd', 0)).toBe('FOO=$HOME'.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=ba\\r pwd', 0)).toBe('FOO=ba\\r'.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('BAR="two words" pwd', 0)).toBe('BAR="two words"'.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('BAR="$HOME" pwd', 0)).toBe('BAR="$HOME"'.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('BAZ=\'two words\' pwd', 0)).toBe('BAZ=\'two words\''.length);
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('pwd', 3)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('9FOO=bar pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=`whoami` pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=$(whoami) pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO="bad `whoami`" pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO="bad $(whoami)" pwd', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO="unterminated', 0)).toBeUndefined();
    expect(shellToolSecurityInternals.parseLeadingTransientEnvironmentAssignment('FOO=bar\\', 0)).toBeUndefined();
  });

  it('strips transient environment prefixes from full command lines while failing closed on ambiguous syntax', () => {
    expect(shellToolSecurityInternals.stripLeadingTransientEnvironmentAssignments('pwd')).toEqual({
      hadTransientEnvironmentAssignments: false,
      strippedCommand: 'pwd',
    });
    expect(shellToolSecurityInternals.stripLeadingTransientEnvironmentAssignments('  FOO=bar')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommand: '  ',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar pwd; BAR=baz cat\r\nBAZ=qux tail')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd; cat\r\ntail',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar pwd | BAR=baz cat')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd | cat',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar pwd || BAR=baz cat')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd || cat',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=ba\\r pwd')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=$HOME pwd && BAR="$SHELL" wc -l README.md')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd && wc -l README.md',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=\'two words\' pwd')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: 'pwd',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar \'two words\'')).toEqual({
      hadTransientEnvironmentAssignments: true,
      strippedCommandLine: '\'two words\'',
    });
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=`bad` pwd')).toBeUndefined();
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO="bad `x`" pwd')).toBeUndefined();
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar > out.txt')).toBeUndefined();
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar $(pwd)')).toBeUndefined();
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO="bad $(x)" pwd')).toBeUndefined();
    expect(shellToolSecurityInternals.stripTransientEnvironmentAssignmentsFromCommandLine('FOO=bar "unterminated')).toBeUndefined();
  });

  it('evaluates single commands and full command lines with named and regex rules', () => {
    const rules = {
      '/^echo ok\nnext$/': 'allow',
      '/^reviewcmd/': 'ask',
      customcmd: 'allow',
      dangerous: 'deny',
      maybe: 'ask',
    } as const;

    expect(shellToolSecurityInternals.evaluateSingleCommand('dangerous --now', rules)).toEqual({
      decision: 'deny',
      reason: 'The command `dangerous` is denied by the shell approval policy.',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('maybe later', rules)).toEqual({
      decision: 'ask',
      reason: 'The command `maybe` is configured to always request approval.',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('reviewcmd --review', rules)).toEqual({
      decision: 'ask',
      reason: 'The command matched ask rule /^reviewcmd/.',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('customcmd --fast', rules)).toEqual({
      decision: 'allow',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('unknown', rules)).toEqual({
      decision: 'defer',
    });

    expect(shellToolSecurityInternals.evaluateFullCommandLine('echo ok\nnext', rules)).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^echo ok\nnext$/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('FOO="bad `x`" pwd', rules)).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable parsing was ambiguous, so the command must be risk-assessed before it can run without confirmation.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('customcmd --fast', rules)).toEqual({
      decision: 'defer',
    });
  });

  it('covers regex-only deny and ask branches for single commands and full command lines', () => {
    const rules = {
      '/^blocked/': 'deny',
      '/^line one\nline two$/': 'ask',
      '/^safe/': 'allow',
    } as const;

    expect(shellToolSecurityInternals.evaluateSingleCommand('', rules)).toEqual({
      decision: 'defer',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('blocked now', rules)).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^blocked/.',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('safe now', rules)).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^safe/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('', rules)).toEqual({
      decision: 'defer',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('ENV=1 cmd', rules)).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('blocked now', rules)).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^blocked/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('line one\nline two', rules)).toEqual({
      decision: 'ask',
      reason: 'The command matched ask rule /^line one\nline two$/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('ENV=1 line one\nline two', rules)).toEqual({
      decision: 'ask',
      reason: 'The command matched ask rule /^line one\nline two$/.',
    });
  });

  it('covers extracted rule helpers and transient-aware full-command allow suppression', () => {
    const rules = {
      '/^pwd && cat README.md$/': 'allow',
      '/^pwd && rm -rf build$/': 'deny',
      '/^status$/': 'ask',
      pwd: 'allow',
      rm: 'deny',
    } as const;

    expect(shellToolSecurityInternals.evaluateSingleCommandAgainstRules('', rules)).toEqual({
      decision: 'defer',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommandAgainstRules('pwd', rules)).toEqual({
      decision: 'allow',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommandAgainstRules('status', rules)).toEqual({
      decision: 'ask',
      reason: 'The command matched ask rule /^status$/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLineAgainstRules('', rules)).toEqual({
      decision: 'defer',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLineAgainstRules('pwd && cat README.md', rules)).toEqual({
      decision: 'allow',
      reason: 'The command matched allow rule /^pwd && cat README.md$/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('FOO=bar pwd && cat README.md', rules)).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable assignments suppress automatic allow rules, so the command must be risk-assessed before it can run without confirmation.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('FOO=bar pwd && rm -rf build', rules)).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^pwd && rm -rf build$/.',
    });
    expect(shellToolSecurityInternals.evaluateFullCommandLine('FOO=`bad` pwd', rules)).toEqual({
      decision: 'defer',
      reason: 'Transient environment variable parsing was ambiguous, so the command must be risk-assessed before it can run without confirmation.',
    });
  });

  it('treats conflicting case-variant named rules as ask', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          FoO: 'allow',
          fOo: 'deny',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunRuleDisposition('FOO README.md')).toEqual({
      decision: 'ask',
      reason: 'The command `FOO` is configured to always request approval.',
    });
  });

  it('retries regex validation timeouts before accepting configured regex rules', () => {
    const validator = vi
      .fn()
      .mockReturnValueOnce({
        error: { kind: 'timeout' },
        status: 'unknown',
      })
      .mockReturnValueOnce({
        status: 'safe',
      });

    shellToolSecurityInternals.setRegexRuleValidatorForTest(validator as never);
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^customcmd$/': 'allow',
        };
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({
      '/^customcmd$/': 'allow',
    });
    expect(validator).toHaveBeenNthCalledWith(1, '^customcmd$', 'u', { timeout: 250 });
    expect(validator).toHaveBeenNthCalledWith(2, '^customcmd$', 'u', { timeout: 1000 });
  });

  it('accepts safe configured regex rules without retrying validation', () => {
    const validator = vi.fn().mockReturnValue({
      status: 'safe',
    });

    shellToolSecurityInternals.setRegexRuleValidatorForTest(validator as never);
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^safecmd$/': 'allow',
        };
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({
      '/^safecmd$/': 'allow',
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith('^safecmd$', 'u', { timeout: 250 });
  });

  it('reuses cached configured rule validation and compiled regex instances', () => {
    const validator = vi.fn().mockReturnValue({
      status: 'safe',
    });

    shellToolSecurityInternals.setRegexRuleValidatorForTest(validator as never);
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^cached$/': 'allow',
        };
      }

      return undefined;
    }));

    const firstRules = shellToolSecurityInternals.getConfiguredApprovalRules();
    const secondRules = shellToolSecurityInternals.getConfiguredApprovalRules();
    const firstRegex = shellToolSecurityInternals.parseRegexRule('/^cached$/');
    const secondRegex = shellToolSecurityInternals.parseRegexRule('/^cached$/');
    const missingRegex = shellToolSecurityInternals.parseRegexRule('/[a-/');
    const missingRegexAgain = shellToolSecurityInternals.parseRegexRule('/[a-/');

    expect(firstRules).toBe(secondRules);
    expect(firstRegex).toBe(secondRegex);
    expect(missingRegex).toBeUndefined();
    expect(missingRegexAgain).toBeUndefined();
    expect(validator).toHaveBeenCalledTimes(1);

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^cached$/': 'allow',
          plain: 'allow',
        };
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({
      '/^cached$/': 'allow',
      plain: 'allow',
    });
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('drops configured regex rules that are vulnerable, unknown, or throw during validation', () => {
    const validator = vi
      .fn()
      .mockReturnValueOnce({
        complexity: { summary: 'catastrophic backtracking' },
        status: 'vulnerable',
      })
      .mockReturnValueOnce({
        error: { kind: 'unsupported' },
        status: 'unknown',
      })
      .mockImplementationOnce(() => {
        throw new Error('validator exploded');
      });

    shellToolSecurityInternals.setRegexRuleValidatorForTest(validator as never);
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^askme$/': 'ask',
          '/^boom$/': 'deny',
          '/^safe$/': 'allow',
          plain: 'allow',
        };
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({
      plain: 'allow',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured shell approval regex rule /^askme$/ because recheck marked it as potentially vulnerable (catastrophic backtracking).',
    );
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured shell approval regex rule /^boom$/ because recheck could not validate it (unsupported).',
    );
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured shell approval regex rule /^safe$/ because validation failed: validator exploded.',
    );
  });

  it('ignores non-record configured approval rules', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return 'not-an-object';
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({});
  });

  it('filters configured approval rules with unsupported values', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          broken: 'maybe',
          numeric: 1,
          ok: 'allow',
        };
      }

      return undefined;
    }));

    expect(shellToolSecurityInternals.getConfiguredApprovalRules()).toEqual({
      ok: 'allow',
    });
  });

  it('lets full-command regex rules force ask or deny after subcommand parsing succeeds', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          '/^echo ok\nnext$/': 'ask',
          '/^pwd\nnext$/': 'deny',
          echo: 'allow',
          next: 'allow',
          pwd: 'allow',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunRuleDisposition('echo ok\nnext')).toEqual({
      decision: 'ask',
      reason: 'The command matched ask rule /^echo ok\nnext$/.',
    });
    expect(analyzeShellRunRuleDisposition('pwd\nnext')).toEqual({
      decision: 'deny',
      reason: 'The command matched deny rule /^pwd\nnext$/.',
    });
  });

  it('requests approval when the model is disabled and the YOLO override is off', async () => {
    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      explanation: 'switch branches',
      goal: 'move to main',
      riskAssessment: 'This changes the working tree and may replace uncommitted files.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      reason: 'Risk assessment model is disabled via shellTools.riskAssessment.chatModel, so explicit approval is required.',
    });
  });

  it('runs without prompting when the model is disabled and the YOLO override is on', async () => {
    getConfiguration.mockReturnValue(createConfiguration((key, defaultValue) => {
      if (key === SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY) {
        return true;
      }

      return defaultValue;
    }));

    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      explanation: 'switch branches',
      goal: 'move to main',
      riskAssessment: 'This changes the working tree and may replace uncommitted files.',
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      reason: 'The YOLO override is enabled, so unresolved commands run without risk-assessment prompting.',
    });
    expect(assessShellCommandRisk).not.toHaveBeenCalled();
  });

  it('lets the YOLO shortcut auto-run unresolved transient-prefixed commands', async () => {
    getConfiguration.mockReturnValue(createConfiguration((key, defaultValue) => {
      if (key === SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY) {
        return true;
      }

      return defaultValue;
    }));

    await expect(decideShellRunApproval({
      command: 'FOO=bar pwd',
      cwd: '/workspace',
      explanation: 'print the current directory with a transient flag',
      goal: 'inspect the workspace location',
      riskAssessment: 'Read-only command with a transient environment variable prefix.',
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      reason: 'The YOLO override is enabled, so unresolved commands run without risk-assessment prompting.',
    });
    expect(assessShellCommandRisk).not.toHaveBeenCalled();
  });

  it('uses the model response when rule evaluation defers', async () => {
    assessShellCommandRisk.mockResolvedValue({
      decision: 'request',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'The command may overwrite checked out files and should be reviewed.',
    });

    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      explanation: 'switch branches',
      goal: 'move to main',
      riskAssessment: 'This may replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      modelAssessment: 'The command may overwrite checked out files and should be reviewed.',
      reason: 'Risk assessment requested explicit approval before running this command.',
    });
  });

  it('returns rule-based allow and deny decisions without consulting the model', async () => {
    await expect(decideShellRunApproval({
      command: 'pwd',
      cwd: '/workspace',
      riskAssessment: 'Read-only command.',
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      reason: 'Every parsed subcommand matched an allow rule.',
    });
    await expect(decideShellRunApproval({
      command: 'rm -rf build',
      cwd: '/workspace',
      riskAssessment: 'Deletes files under the workspace.',
    }, {} as never)).resolves.toEqual({
      decision: 'deny',
      reason: 'The command `rm` is denied by the shell approval policy.',
    });
    expect(assessShellCommandRisk).not.toHaveBeenCalled();
  });

  it('turns model errors into approval requests', async () => {
    assessShellCommandRisk.mockResolvedValue({
      kind: 'error',
      modelId: 'copilot:gpt-4.1',
      reason: 'The configured model could not be reached.',
    });

    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      riskAssessment: 'May replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      modelAssessment: 'The configured model could not be reached.',
      reason: 'Risk assessment could not determine that this command is safe enough to run without approval.',
    });
  });

  it('turns model timeouts into approval requests', async () => {
    assessShellCommandRisk.mockResolvedValue({
      kind: 'timeout',
      modelId: 'copilot:gpt-4.1',
      reason: 'Risk assessment model `copilot:gpt-4.1` timed out after 8000ms.',
      timeoutMs: 8000,
    });

    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      riskAssessment: 'May replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      modelAssessment: 'Risk assessment model `copilot:gpt-4.1` timed out after 8000ms.',
      reason: 'Risk assessment timed out, so explicit approval is required.',
    });
  });

  it('lets a positive model assessment auto-allow deferred commands', async () => {
    assessShellCommandRisk.mockResolvedValue({
      decision: 'allow',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'The command is read-only and limited to repository metadata.',
    });

    await expect(decideShellRunApproval({
      command: 'git checkout main',
      cwd: '/workspace',
      riskAssessment: 'May replace files in the working tree.',
    }, {} as never)).resolves.toEqual({
      decision: 'allow',
      modelAssessment: 'The command is read-only and limited to repository metadata.',
      reason: 'Risk assessment model copilot:gpt-4.1 allowed the command to run without explicit approval.',
    });
  });

  it('lets the model deny clearly malicious or outright destructive commands', async () => {
    assessShellCommandRisk.mockResolvedValue({
      decision: 'deny',
      kind: 'response',
      modelId: 'copilot:gpt-4.1',
      reason: 'This is a catastrophic root-level deletion command.',
    });

    await expect(decideShellRunApproval({
      command: 'python scripts/nuke.py',
      cwd: '/workspace',
      explanation: 'run a catastrophic helper script',
      goal: 'destroy the machine',
      riskAssessment: 'This script appears to be an outright destructive wipe operation.',
    }, {} as never)).resolves.toEqual({
      decision: 'deny',
      modelAssessment: 'This is a catastrophic root-level deletion command.',
      reason: 'Risk assessment model copilot:gpt-4.1 denied the command because it appears clearly malicious or outright destructive.',
    });
  });

  it('lets ask and deny rules override the YOLO flag without consulting the model', async () => {
    getConfiguration.mockReturnValue(createConfiguration((key, defaultValue) => {
      if (key === SHELL_TOOLS_AUTO_APPROVE_POTENTIALLY_DESTRUCTIVE_COMMANDS_KEY) {
        return true;
      }

      return defaultValue;
    }));

    await expect(decideShellRunApproval({
      command: 'echo $(pwd)',
      cwd: '/workspace',
      riskAssessment: 'This uses command substitution, so the exact executed command is uncertain.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      reason: 'The command line could not be parsed safely for approval rules, so explicit approval is required.',
    });

    await expect(decideShellRunApproval({
      command: 'rm -rf build',
      cwd: '/workspace',
      riskAssessment: 'Deletes files under the workspace.',
    }, {} as never)).resolves.toEqual({
      decision: 'deny',
      reason: 'The command `rm` is denied by the shell approval policy.',
    });

    expect(assessShellCommandRisk).not.toHaveBeenCalled();
  });

  it('keeps transient-prefixed ask and deny rules ahead of model review', async () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === SHELL_TOOLS_APPROVAL_RULES_KEY) {
        return {
          pwd: 'ask',
        };
      }

      return undefined;
    }));

    await expect(decideShellRunApproval({
      command: 'FOO=bar pwd',
      cwd: '/workspace',
      riskAssessment: 'Read-only command with a transient environment variable prefix.',
    }, {} as never)).resolves.toEqual({
      decision: 'ask',
      reason: 'The command `pwd` is configured to always request approval.',
    });
    await expect(decideShellRunApproval({
      command: 'FOO=bar rm -rf build',
      cwd: '/workspace',
      riskAssessment: 'Deletes files under the workspace.',
    }, {} as never)).resolves.toEqual({
      decision: 'deny',
      reason: 'The command `rm` is denied by the shell approval policy.',
    });

    expect(assessShellCommandRisk).not.toHaveBeenCalled();
  });
});
