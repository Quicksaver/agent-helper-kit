import { EventEmitter } from 'node:events';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { activate } from '@/extension';
import { resetExtensionOutputChannelForTest } from '@/logging';
import { reviewCommentToChat } from '@/reviewComments';
import { SHELL_TOOL_NAMES } from '@/shellToolContracts';
import * as shellToolSecurity from '@/shellToolSecurity';
import { SHELL_TOOLS_APPROVAL_RULES_KEY } from '@/shellToolSecurity';

type ConfigurationChangeEventLike = {
  affectsConfiguration: (section: string) => boolean;
};

const vscode = vi.hoisted(() => {
  class TestEventEmitter<T> {
    private readonly emitter = new EventEmitter();

    dispose(): void {
      this.emitter.removeAllListeners();
    }

    readonly event = (listener: (value: T) => void) => {
      this.emitter.on('event', listener as (value: unknown) => void);

      return {
        dispose: () => {
          this.emitter.off('event', listener as (value: unknown) => void);
        },
      };
    };

    fire(value: T): void {
      this.emitter.emit('event', value);
    }
  }

  function TreeItem(this: { collapsibleState: number; label: string }, label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }

  const commandDisposable = { dispose: vi.fn() };
  const participantDisposable = { dispose: vi.fn() };
  const toolDisposable = { dispose: vi.fn() };
  const onDidChangeDisposable = { dispose: vi.fn() };
  const changeHandlers: ((event: { affectsConfiguration: (section: string) => boolean }) => void)[] = [];
  const getConfiguration = vi.fn(() => ({
    get: vi.fn((_: string, defaultValue: boolean) => defaultValue),
  }));

  return {
    changeHandlers,
    chat: {
      createChatParticipant: vi.fn(() => ({
        ...participantDisposable,
        iconPath: undefined as unknown,
      })),
    },
    commands: {
      registerCommand: vi.fn(() => commandDisposable),
    },
    Disposable: {
      from: vi.fn((...disposables: { dispose: () => void }[]) => ({
        dispose: () => {
          for (const disposable of disposables) {
            disposable.dispose();
          }
        },
      })),
    },
    EventEmitter: TestEventEmitter,
    LanguageModelChatMessage: {
      User: vi.fn((value: string) => ({ role: 'user', value })),
    },
    lm: {
      registerTool: vi.fn(() => toolDisposable),
      selectChatModels: vi.fn(async () => []),
    },
    ThemeIcon: vi.fn(),
    toolDisposable,
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        append: vi.fn(),
        appendLine: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
        show: vi.fn(),
      })),
      createTreeView: vi.fn(() => ({
        dispose: vi.fn(),
        onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
      })),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: vi.fn((listener: (event: ConfigurationChangeEventLike) => void) => {
        changeHandlers.push(listener);
        return onDidChangeDisposable;
      }),
    },
  };
});

vi.mock('vscode', () => vscode);

function createMockContext() {
  return {
    subscriptions: [] as { dispose: () => void }[],
  } as unknown as import('vscode').ExtensionContext;
}

describe('Extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExtensionOutputChannelForTest();
  });

  it('registers the reviewCommentToChat command on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'agent-helper-kit.reviewCommentToChat',
      reviewCommentToChat,
    );
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Agent Helper Kit', { log: true });
  });

  it('registers the chat participant on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith(
      'agent-helper-kit.bringCommentsToChat',
      expect.any(Function),
    );
  });

  it('registers shell tools on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.runInShell,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.awaitShell,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.getShellOutput,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.sendToShell,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.killShell,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.getShellCommand,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      SHELL_TOOL_NAMES.getLastShellCommand,
      expect.any(Object),
    );
  });

  it('does not register bring-to-chat when disabled', () => {
    const context = createMockContext();
    const getConfigurationMock = vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>;

    getConfigurationMock.mockReturnValue({
      get: vi.fn((key: string, defaultValue: boolean) => {
        if (key === 'bringToChat.enabled') {
          return false;
        }

        return defaultValue;
      }),
    });

    activate(context);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith(
      'agent-helper-kit.reviewCommentToChat',
      reviewCommentToChat,
    );
    expect(vscode.chat.createChatParticipant).not.toHaveBeenCalledWith(
      'agent-helper-kit.bringCommentsToChat',
      expect.any(Function),
    );
  });

  it('unregisters shell tools when the feature setting changes to disabled', () => {
    const context = createMockContext();
    const getConfigurationMock = vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>;
    let shellToolsEnabled = true;

    getConfigurationMock.mockReturnValue({
      get: vi.fn((key: string, defaultValue: boolean) => {
        if (key === 'shellTools.enabled') {
          return shellToolsEnabled;
        }

        return defaultValue;
      }),
    });

    activate(context);

    const handlers = vscode.changeHandlers as ((event: ConfigurationChangeEventLike) => void)[];
    shellToolsEnabled = false;
    handlers[0]?.({
      affectsConfiguration: (section: string) => section === 'agent-helper-kit.shellTools.enabled',
    });

    expect(vscode.toolDisposable.dispose).toHaveBeenCalled();
  });

  it('clears cached shell security rules when approval rules change', () => {
    const context = createMockContext();
    const resetShellToolSecurityCachesSpy = vi.spyOn(shellToolSecurity, 'resetShellToolSecurityCaches');

    activate(context);

    const handlers = vscode.changeHandlers as ((event: ConfigurationChangeEventLike) => void)[];

    handlers[0]?.({
      affectsConfiguration: (section: string) => section === `agent-helper-kit.${SHELL_TOOLS_APPROVAL_RULES_KEY}`,
    });

    expect(resetShellToolSecurityCachesSpy).toHaveBeenCalledTimes(1);
  });
});
