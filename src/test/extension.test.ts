import {
  beforeEach,
  describe, expect, it, vi,
} from 'vitest';

import { activate } from '@/extension';
import { MCP_PROVIDER_ID } from '@/mcpProvider';

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
      registerMcpServerDefinitionProvider: vi.fn(() => disposable),
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

  it('should push expected core subscriptions on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(1);
    expect(vscode.chat.createChatParticipant).toHaveBeenCalledTimes(1);
    expect(vscode.lm.registerMcpServerDefinitionProvider).toHaveBeenCalledTimes(1);
    expect(vscode.lm.registerTool).toHaveBeenCalledTimes(5);
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(8);
  });

  it('should register MCP server definition provider on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.lm.registerMcpServerDefinitionProvider).toHaveBeenCalledWith(
      MCP_PROVIDER_ID,
      expect.any(Object),
    );
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
