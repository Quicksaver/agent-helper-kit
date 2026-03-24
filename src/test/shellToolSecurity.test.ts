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
  analyzeShellRunAutoApproval,
  buildShellRunConfirmationMessage,
  shellToolSecurityInternals,
} from '@/shellToolSecurity';

const logWarn = vi.hoisted(() => vi.fn());

function createConfiguration(getter: (key: string) => unknown = () => undefined): { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn((key: string) => getter(key)),
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
  });

  afterEach(() => {
    shellToolSecurityInternals.resetShellToolSecurityCaches();
  });

  it('builds a detailed confirmation message with workspace-relative cwd preview and approval note', () => {
    expect(buildShellRunConfirmationMessage({
      autoApprovalDecision: {
        autoApprove: false,
        reason: 'Auto-approval is disabled in settings.',
      },
      command: 'pwd',
      cwd: 'packages/api',
      explanation: 'print working directory',
      goal: 'inspect cwd',
    })).toBe(
      'Command: pwd\n\nCwd: /workspace/packages/api\n\nExplanation: print working directory\n\nGoal: inspect cwd\n\nApproval note: Auto-approval is disabled in settings.',
    );
  });

  it('falls back to home directory and placeholder text when confirmation details are missing', () => {
    workspaceFoldersState.value = undefined;

    expect(buildShellRunConfirmationMessage({
      autoApprovalDecision: {
        autoApprove: true,
      },
      command: '',
      cwd: ' ',
    })).toBe(
      `Command: (empty command)\n\nCwd: ${os.homedir()} (invalid empty cwd override)\n\nExplanation: (not provided)\n\nGoal: (not provided)`,
    );
  });

  it('requires auto-approval to be explicitly enabled', () => {
    expect(analyzeShellRunAutoApproval('pwd')).toEqual({
      autoApprove: false,
      reason: 'Auto-approval is disabled in settings.',
    });
  });

  it('requires the warning acceptance gate even when auto-approval is enabled', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('pwd')).toEqual({
      autoApprove: false,
      reason: 'Auto-approval warning has not been accepted in settings.',
    });
  });

  it('auto-approves only when every parsed subcommand is allowlisted', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('pwd && wc -l README.md')).toEqual({
      autoApprove: true,
    });
    expect(analyzeShellRunAutoApproval('echo "a|b" && echo c\\;d')).toEqual({
      autoApprove: true,
    });
    expect(analyzeShellRunAutoApproval('echo \'a\\\' && pwd')).toEqual({
      autoApprove: true,
    });
  });

  it('allows regex-backed safe commands such as git status and git show', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('git status')).toEqual({
      autoApprove: true,
    });
    expect(analyzeShellRunAutoApproval('git show HEAD~1')).toEqual({
      autoApprove: true,
    });
  });

  it('denies named dangerous commands even when written with different casing', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('RM -rf build')).toEqual({
      autoApprove: false,
      reason: 'The command `RM` is denied by the shell security policy.',
    });
    expect(analyzeShellRunAutoApproval('invoke-expression whoami')).toEqual({
      autoApprove: false,
      reason: 'The command `invoke-expression` is denied by the shell security policy.',
    });
  });

  it('denies dangerous variants of otherwise safe commands through regex rules', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('find . -delete')).toEqual({
      autoApprove: false,
      reason: 'The command matched denied rule /^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/.',
    });
    expect(analyzeShellRunAutoApproval('rg todo --pre cat')).toEqual({
      autoApprove: false,
      reason: 'The command matched denied rule /^rg\\b.*\\s(--hostname-bin|--pre)\\b/.',
    });
    expect(analyzeShellRunAutoApproval('sed -i "" file.txt')).toEqual({
      autoApprove: false,
      reason: 'The command matched denied rule /^sed\\b.*\\s(-[a-zA-Z]*(e|f|i)[a-zA-Z]*|--expression|--file|--in-place)\\b/.',
    });
    expect(analyzeShellRunAutoApproval('sed \'s/a/b/;w out.txt\' file.txt')).toEqual({
      autoApprove: false,
      reason: 'The command matched denied rule /^sed\\b.*;\\s*[wW]\\b/.',
    });
  });

  it('keeps confirmation when a command is not on the allowlist', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('git checkout main')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
  });

  it('allows safe configured regex rules and ignores non-boolean entries', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/^customcmd\\b/': true,
          note: 'ignore-me',
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd --help')).toEqual({
      autoApprove: true,
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('requires every subcommand in a compound command to pass the policy', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('pwd && rm -rf build')).toEqual({
      autoApprove: false,
      reason: 'The command `rm` is denied by the shell security policy.',
    });
    expect(analyzeShellRunAutoApproval('pwd | top')).toEqual({
      autoApprove: false,
      reason: 'The command `top` is denied by the shell security policy.',
    });
  });

  it('denies compound command lines matched by a configured whole-line regex rule', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/^pwd && which node$/': false,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('pwd && which node')).toEqual({
      autoApprove: false,
      reason: 'The command matched denied rule /^pwd && which node$/.',
    });
  });

  it('applies user-configured rule overrides after the built-in defaults', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/[invalid/': true,
          customcmd: true,
          pwd: false,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd && which node')).toEqual({
      autoApprove: true,
    });
    expect(analyzeShellRunAutoApproval('pwd')).toEqual({
      autoApprove: false,
      reason: 'The command `pwd` is denied by the shell security policy.',
    });
  });

  it('fails closed on conflicting case-insensitive named rule variants', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          CustomTool: true,
          cUSTOMtOOL: false,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('CUSTOMTOOL README.md')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
  });

  it('accepts matching case-insensitive named rule variants when they agree', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          CustomTool: true,
          cUSTOMtOOL: true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('CUSTOMTOOL README.md')).toEqual({
      autoApprove: true,
    });
  });

  it('rejects vulnerable user-configured regex rules and falls back to manual approval', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/(a+)+$/': true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('aaaa')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured auto-approve regex rule /(a+)+$/ because recheck marked it as potentially vulnerable (exponential).',
    );
  });

  it('ignores malformed rule configuration payloads', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return [ true ];
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('0')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
  });

  it('fails closed when parsing sees command substitution, redirection, backticks, or unmatched quoting', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('echo $(pwd)')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
    expect(analyzeShellRunAutoApproval('echo "$(pwd)"')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
    expect(analyzeShellRunAutoApproval('echo `pwd`')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
    expect(analyzeShellRunAutoApproval('echo "`pwd`"')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
    expect(analyzeShellRunAutoApproval('echo ok > file.txt')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
    expect(analyzeShellRunAutoApproval('echo "unterminated')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
  });

  it('treats line breaks as command separators during auto-approval analysis', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('pwd\nrm -rf build')).toEqual({
      autoApprove: false,
      reason: 'The command `rm` is denied by the shell security policy.',
    });
    expect(analyzeShellRunAutoApproval('pwd\r\nwhich node')).toEqual({
      autoApprove: true,
    });
  });

  it('fails closed when parsing cannot identify any subcommand', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('   ')).toEqual({
      autoApprove: false,
      reason: 'The command line could not be parsed safely for subcommand analysis.',
    });
  });

  it('extracts first tokens across plain, single-quoted, and double-quoted command names', () => {
    expect(shellToolSecurityInternals.extractFirstToken('pwd -P')).toBe('pwd');
    expect(shellToolSecurityInternals.extractFirstToken('   ')).toBeUndefined();
    expect(shellToolSecurityInternals.extractFirstToken('"git status" --short')).toBe('"git status"');
    expect(shellToolSecurityInternals.extractFirstToken('\'custom tool\' --help')).toBe('\'custom tool\'');
  });

  it('parses approval regex literals conservatively', () => {
    expect(shellToolSecurityInternals.parseApprovalRegexRule('pwd')).toEqual({
      kind: 'non-literal',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/[invalid')).toEqual({
      kind: 'invalid',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/ii')).toEqual({
      kind: 'invalid',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/y')).toEqual({
      kind: 'invalid',
    });
    expect(shellToolSecurityInternals.parseApprovalRegexRule('/^pwd$/i')).toEqual({
      flags: 'iu',
      kind: 'literal',
      pattern: '^pwd$',
    });
  });

  it('splits safe compound command lines and preserves quoted separators', () => {
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd && wc -l README.md')).toEqual([
      'pwd',
      'wc -l README.md',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "a|b" | wc -c')).toEqual([
      'echo "a|b"',
      'wc -c',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo \'a;b\' ; pwd')).toEqual([
      'echo \'a;b\'',
      'pwd',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo a\\;b && pwd')).toEqual([
      'echo a\\;b',
      'pwd',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('echo \'a\\\' ; pwd')).toEqual([
      'echo \'a\\\'',
      'pwd',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd & which node')).toEqual([
      'pwd',
      'which node',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd || which node')).toEqual([
      'pwd',
      'which node',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd\nwhich node')).toEqual([
      'pwd',
      'which node',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd\r\nwhich node')).toEqual([
      'pwd',
      'which node',
    ]);
  });

  it('rejects subcommand splitting when the syntax is ambiguous or unsafe', () => {
    expect(shellToolSecurityInternals.splitShellSubcommands('echo `pwd`')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo $(pwd)')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "$(pwd)"')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "`pwd`"')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo ok > out.txt')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo ok < in.txt')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo "unterminated')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo trailing\\')).toBeUndefined();
  });

  it('evaluates named and regex-backed rules directly', () => {
    const rules = shellToolSecurityInternals.getMergedAutoApproveRules();

    expect(shellToolSecurityInternals.evaluateSingleCommand('', rules)).toEqual({
      state: 'pending',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('pwd', rules)).toEqual({
      state: 'allowed',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('RM -rf build', rules)).toEqual({
      reason: 'The command `RM` is denied by the shell security policy.',
      state: 'denied',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('git diff --stat', rules)).toEqual({
      state: 'allowed',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('find . -exec rm {} \\;', rules)).toEqual({
      reason: 'The command matched denied rule /^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/.',
      state: 'denied',
    });
    expect(shellToolSecurityInternals.evaluateSingleCommand('customcmd', rules)).toEqual({
      reason: 'The command is not allowlisted for auto-approval.',
      state: 'pending',
    });
  });

  it('parses regex rules safely and resolves cwd previews from the workspace', () => {
    expect(shellToolSecurityInternals.parseRegexRule('/^pwd$/')?.test('pwd')).toBe(true);
    expect(shellToolSecurityInternals.parseRegexRule('/^pwd$/i')?.test('PWD')).toBe(true);
    expect(shellToolSecurityInternals.parseRegexRule('/^pwd$/g')).toBeUndefined();
    expect(shellToolSecurityInternals.parseRegexRule('/[invalid/')).toBeUndefined();
    expect(shellToolSecurityInternals.parseRegexRule('/[/')).toBeUndefined();
    expect(shellToolSecurityInternals.getPreviewCwd(undefined)).toBe('/workspace');
    expect(shellToolSecurityInternals.getPreviewCwd('packages/core')).toBe('/workspace/packages/core');
  });

  it('reuses merged rule snapshots until caches are reset', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.rules') {
        return {
          customcmd: true,
        };
      }

      return undefined;
    }));

    const firstRules = shellToolSecurityInternals.getMergedAutoApproveRules();
    const secondRules = shellToolSecurityInternals.getMergedAutoApproveRules();

    expect(firstRules).toBe(secondRules);

    shellToolSecurityInternals.resetShellToolSecurityCaches();

    const thirdRules = shellToolSecurityInternals.getMergedAutoApproveRules();

    expect(thirdRules).not.toBe(firstRules);
    expect(thirdRules.customcmd).toBe(true);
  });

  it('rejects invalid configured regex literals before evaluating approval rules', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/^customcmd$/g': true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured auto-approve regex rule /^customcmd$/g because it is not a valid regex literal or uses unsupported flags.',
    );
  });

  it('reuses cached invalid regex validation results across configuration snapshots', () => {
    let configVersion = 1;

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return configVersion === 1
          ? {
            '/^customcmd$/g': true,
          }
          : {
            '/^customcmd$/g': true,
            pwd: true,
          };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledTimes(1);

    configVersion = 2;

    expect(analyzeShellRunAutoApproval('customcmd')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('caches unsafe configured regex validation failures by rule key', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/(a+)+b$/': true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('aaaa')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(analyzeShellRunAutoApproval('aaaa')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('reuses configured and parsed regex caches when inputs stay stable', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.rules') {
        return {
          customcmd: true,
        };
      }

      return undefined;
    }));

    const firstConfiguredRules = shellToolSecurityInternals.getConfiguredAutoApproveRules();
    const secondConfiguredRules = shellToolSecurityInternals.getConfiguredAutoApproveRules();

    expect(firstConfiguredRules).toBe(secondConfiguredRules);

    expect(shellToolSecurityInternals.parseRegexRule('/[/')).toBeUndefined();
    expect(shellToolSecurityInternals.parseRegexRule('/[/')).toBeUndefined();
  });

  it('fails closed when regex validation throws unexpectedly', () => {
    shellToolSecurityInternals.setRegexRuleValidatorForTest(
      vi.fn(() => {
        throw new Error('boom');
      }),
    );

    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/^customcmd$/': true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledWith(
      'Ignoring configured auto-approve regex rule /^customcmd$/ because validation failed: boom.',
    );
  });

  it('clears cached rule validation state when requested', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return {
          '/(a+)+b$/': true,
        };
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('aaaa')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });
    expect(logWarn).toHaveBeenCalledTimes(1);

    shellToolSecurityInternals.resetShellToolSecurityCaches();
    expect(analyzeShellRunAutoApproval('aaaa')).toEqual({
      autoApprove: false,
      reason: 'One or more subcommands are not explicitly allowlisted for auto-approval.',
    });

    expect(logWarn).toHaveBeenCalledTimes(2);
  });
});
