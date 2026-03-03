import {
  beforeEach,
  describe, expect, it, vi,
} from 'vitest';

import { activate } from '@/extension';
import { reviewCommentToChat } from '@/reviewComments';
import { TERMINAL_TOOL_NAMES } from '@/terminalToolContracts';

const vscode = vi.hoisted(() => {
  const disposable = { dispose: vi.fn() };

  return {
    chat: {
      createChatParticipant: vi.fn(() => ({
        iconPath: undefined as unknown,
      })),
    },
    commands: {
      registerCommand: vi.fn(() => disposable),
    },
    lm: {
      registerTool: vi.fn(() => disposable),
    },
    ThemeIcon: vi.fn(),
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
});
