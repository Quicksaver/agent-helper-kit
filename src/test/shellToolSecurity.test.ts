import * as os from 'node:os';

import {
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
    workspaceFoldersState.value = [
      {
        uri: {
          fsPath: '/workspace',
        },
      },
    ];
    getConfiguration.mockReturnValue(createConfiguration());
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

  it('ignores malformed rule configuration payloads', () => {
    getConfiguration.mockReturnValue(createConfiguration(key => {
      if (key === 'shellTools.autoApprove.enabled' || key === 'shellTools.autoApprove.warningAccepted') {
        return true;
      }

      if (key === 'shellTools.autoApprove.rules') {
        return 'not-an-object';
      }

      return undefined;
    }));

    expect(analyzeShellRunAutoApproval('customcmd')).toEqual({
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
    expect(analyzeShellRunAutoApproval('echo `pwd`')).toEqual({
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
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd & which node')).toEqual([
      'pwd',
      'which node',
    ]);
    expect(shellToolSecurityInternals.splitShellSubcommands('pwd || which node')).toEqual([
      'pwd',
      'which node',
    ]);
  });

  it('rejects subcommand splitting when the syntax is ambiguous or unsafe', () => {
    expect(shellToolSecurityInternals.splitShellSubcommands('echo `pwd`')).toBeUndefined();
    expect(shellToolSecurityInternals.splitShellSubcommands('echo $(pwd)')).toBeUndefined();
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
    expect(shellToolSecurityInternals.parseRegexRule('/[invalid/')).toBeUndefined();
    expect(shellToolSecurityInternals.getPreviewCwd(undefined)).toBe('/workspace');
    expect(shellToolSecurityInternals.getPreviewCwd('packages/core')).toBe('/workspace/packages/core');
  });
});
