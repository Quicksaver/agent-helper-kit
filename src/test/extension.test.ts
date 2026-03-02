import {
  describe, expect, it, vi,
} from 'vitest';

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

// eslint-disable-next-line import/first -- must follow vi.mock
import { activate } from '@/extension';

function createMockContext() {
  return {
    subscriptions: [] as { dispose: () => void }[],
  } as unknown as import('vscode').ExtensionContext;
}

describe('Extension', () => {
  it('should register the reviewCommentToChat command on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'custom-vscode.reviewCommentToChat',
      expect.any(Function),
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

  it('should push two subscriptions on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(context.subscriptions).toHaveLength(7);
  });

  it('should register custom terminal tools on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'custom_run_in_terminal',
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'custom_await_terminal',
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'custom_get_terminal_output',
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'custom_kill_terminal',
      expect.any(Object),
    );
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      'custom_terminal_last_command',
      expect.any(Object),
    );
  });
});
