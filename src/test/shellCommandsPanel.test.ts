import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { registerShellCommandsPanel } from '@/shellCommandsPanel';
import type {
  ShellCommandDetails,
  ShellCommandListItem,
  ShellRuntime,
} from '@/shellRuntime';

type MessageHandler = (message: unknown) => Promise<void> | void;

const capturedProviders: unknown[] = [];

const vscode = vi.hoisted(() => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
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
  env: {
    clipboard: {
      writeText: vi.fn(async () => undefined),
    },
  },
  window: {
    registerWebviewViewProvider: vi.fn((viewId: string, provider: unknown) => {
      capturedProviders.push(provider);
      return {
        dispose: vi.fn(),
      };
    }),
  },
}));

vi.mock('vscode', () => vscode);

function createCommand(overrides: Partial<ShellCommandListItem> = {}): ShellCommandListItem {
  return {
    command: 'printf test',
    completedAt: null,
    exitCode: null,
    id: 'shell-1234abcd',
    isRunning: true,
    killedByUser: false,
    shell: '/bin/zsh',
    signal: null,
    startedAt: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

function createDetails(overrides: Partial<ShellCommandDetails> = {}): ShellCommandDetails {
  return {
    ...createCommand(),
    output: 'first line\n',
    ...overrides,
  };
}

function createRuntime(detailsRef: { current: ShellCommandDetails }): ShellRuntime {
  return {
    clearCompletedCommands: vi.fn(() => 0),
    deleteCompletedCommand: vi.fn(() => false),
    getCommandDetails: vi.fn(async () => detailsRef.current),
    killBackgroundCommand: vi.fn(() => true),
    listCommands: vi.fn(() => [
      createCommand({
        completedAt: detailsRef.current.completedAt,
        exitCode: detailsRef.current.exitCode,
        id: detailsRef.current.id,
        isRunning: detailsRef.current.isRunning,
        killedByUser: detailsRef.current.killedByUser,
        signal: detailsRef.current.signal,
      }),
    ]),
    onDidChangeCommands: vi.fn(() => () => undefined),
  } as unknown as ShellRuntime;
}

function createWebviewView(): {
  onDidReceiveMessage: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  webviewView: {
    onDidDispose: ReturnType<typeof vi.fn>;
    webview: {
      html: string;
      onDidReceiveMessage: ReturnType<typeof vi.fn>;
      options: Record<string, unknown>;
      postMessage: ReturnType<typeof vi.fn>;
    };
  };
} {
  const onDidReceiveMessage = vi.fn((listener: MessageHandler) => {
    void listener;
    return { dispose: vi.fn() };
  });
  const postMessage = vi.fn(async () => true);

  return {
    onDidReceiveMessage,
    postMessage,
    webviewView: {
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      webview: {
        html: '',
        onDidReceiveMessage,
        options: {},
        postMessage,
      },
    },
  };
}

describe('ShellCommandsPanelProvider polling', () => {
  beforeEach(() => {
    capturedProviders.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not post output updates when a running command has no new output', async () => {
    const detailsRef = {
      current: createDetails(),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);
    postMessage.mockClear();

    await vi.advanceTimersByTimeAsync(1000);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts only an output update when new output arrives for the selected running command', async () => {
    const detailsRef = {
      current: createDetails(),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);
    const initialHtml = rawWebviewView.webview.html;
    postMessage.mockClear();

    detailsRef.current = createDetails({ output: 'first line\nsecond line\n' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(rawWebviewView.webview.html).toBe(initialHtml);
    expect(postMessage).toHaveBeenCalledOnce();
    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

    expect(firstMessage).toEqual(expect.objectContaining({
      commandId: 'shell-1234abcd',
      isRunning: true,
      type: 'replaceOutput',
    }));
    expect(firstMessage?.outputHtml).toEqual(expect.stringContaining('second line'));
  });
});
