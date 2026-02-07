import { describe, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => {
  const disposable = { dispose: vi.fn() };

  return {
    commands: {
      registerCommand: vi.fn((_command: string, _callback: () => void) => disposable),
    },
    window: {
      showInformationMessage: vi.fn(),
    },
  };
});

vi.mock('vscode', () => vscode);

// Import after mock is set up
const { activate, deactivate } = await import('../extension');

function createMockContext() {
  return {
    subscriptions: [] as { dispose: () => void }[],
  } as unknown as import('vscode').ExtensionContext;
}

describe('Extension', () => {
  it('should register the helloWorld command on activation', () => {
    const context = createMockContext();

    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'custom-vscode.helloWorld',
      expect.any(Function),
    );
    expect(context.subscriptions).toHaveLength(1);
  });

  it('should deactivate without errors', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
