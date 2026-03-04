import {
  beforeEach,
  describe, expect, it, vi,
} from 'vitest';

import { activate } from '@/extension';
import { reviewCommentToChat } from '@/reviewComments';
import { TERMINAL_TOOL_NAMES } from '@/terminalToolContracts';

type ConfigurationChangeEventLike = {
  affectsConfiguration: (section: string) => boolean;
};

const vscode = vi.hoisted(() => {
  const commandDisposable = { dispose: vi.fn() };
  const participantDisposable = { dispose: vi.fn() };
  const toolDisposable = { dispose: vi.fn() };
  const onDidChangeDisposable = { dispose: vi.fn() };
  const changeHandlers: ((event: { affectsConfiguration: (section: string) => boolean }) => void)[] = [];
  const getConfiguration = vi.fn(() => ({
    get: vi.fn((key: string, defaultValue: boolean) => {
      if (key === 'bringToChat.enabled' || key === 'terminalTools.enabled') {
        return defaultValue;
      }

      return defaultValue;
    }),
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
    lm: {
      registerTool: vi.fn(() => toolDisposable),
    },
    ThemeIcon: vi.fn(),
    toolDisposable,
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: vi.fn(
        (listener: (event: ConfigurationChangeEventLike) => void) => {
          changeHandlers.push(listener);
          return onDidChangeDisposable;
        },
      ),
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
  });

  it('should register the reviewCommentToChat command on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'custom-vscode.reviewCommentToChat',
      reviewCommentToChat,
    );
  });

  it('should register the chat participant on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith(
      'custom-vscode.bringCommentsToChat',
      expect.any(Function),
    );
  });

  it('should register custom terminal tools on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.runInSyncTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.runInAsyncTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.awaitTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.getTerminalOutput,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.killTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.terminalLastCommand,
      expect.any(Object),
    );
  });

  it('does not register bring-to-chat feature when disabled', () => {
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
      'custom-vscode.reviewCommentToChat',
      reviewCommentToChat,
    );
    expect(vscode.chat.createChatParticipant).not.toHaveBeenCalledWith(
      'custom-vscode.bringCommentsToChat',
      expect.any(Function),
    );
  });

  it('unregisters terminal tools when setting changes to disabled', () => {
    const context = createMockContext();
    const getConfigurationMock = vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>;
    let terminalEnabled = true;

    getConfigurationMock.mockReturnValue({
      get: vi.fn((key: string, defaultValue: boolean) => {
        if (key === 'terminalTools.enabled') {
          return terminalEnabled;
        }

        return defaultValue;
      }),
    });

    activate(context);

    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.runInSyncTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.runInAsyncTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.awaitTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.getTerminalOutput,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.killTerminal,
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      TERMINAL_TOOL_NAMES.terminalLastCommand,
      expect.any(Object),
    );

    const handlers = vscode.changeHandlers as ((event: ConfigurationChangeEventLike) => void)[];
    terminalEnabled = false;
    handlers[0]?.({
      affectsConfiguration: (section: string) => section === 'custom-vscode.terminalTools.enabled',
    });

    expect(vscode.lm.registerTool).toHaveBeenCalled();
    expect(vscode.toolDisposable.dispose).toHaveBeenCalled();
  });
});
