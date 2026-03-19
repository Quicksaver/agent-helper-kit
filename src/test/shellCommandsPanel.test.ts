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
    cwd: '/workspace/project',
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
  getMessageHandler: () => MessageHandler | undefined;
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
  let messageHandler: MessageHandler | undefined;
  const onDidReceiveMessage = vi.fn((listener: MessageHandler) => {
    messageHandler = listener;
    return { dispose: vi.fn() };
  });
  const postMessage = vi.fn(async () => true);

  return {
    getMessageHandler: () => messageHandler,
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

async function flushWebviewMessageMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
      getMessageHandler,
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);
    const initialHtml = rawWebviewView.webview.html;

    await getMessageHandler()?.({
      type: 'ready',
    });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    expect(initialHtml).toContain('data-command-id="shell-1234abcd"');

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

  it('escapes shell output and uses inline styles for non-palette ANSI colors', async () => {
    const detailsRef = {
      current: createDetails(),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      getMessageHandler,
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    await getMessageHandler()?.({
      type: 'ready',
    });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    detailsRef.current = createDetails({ output: '\u001B[38;2;1;2;3m<script>\u001B[0m\n' });

    await vi.advanceTimersByTimeAsync(1000);

    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const outputHtml = firstMessage?.outputHtml;

    expect(outputHtml).toBeTypeOf('string');
    expect(outputHtml).toContain('style="color: rgb(1, 2, 3)"');
    expect(outputHtml).toContain('&lt;script&gt;');
    expect(outputHtml).not.toContain('<script>');
  });

  it('renders command metadata in the main pane without relying on list item tooltips', async () => {
    const detailsRef = {
      current: createDetails({
        completedAt: '2026-03-10T00:01:00.000Z',
        cwd: '/workspace/project',
        exitCode: 0,
        isRunning: false,
        signal: 'SIGTERM',
      }),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(rawWebviewView.webview.html).toContain('id="metadata-block"');
    expect(rawWebviewView.webview.html).toContain('>Exit Code<');
    expect(rawWebviewView.webview.html).toContain('>SIGTERM (0)<');
    expect(rawWebviewView.webview.html).toContain('>/workspace/project<');
    expect(rawWebviewView.webview.html).toContain('>1234abcd<');
    expect(rawWebviewView.webview.html).toContain('data-copy-field="cwd"');
    expect(rawWebviewView.webview.html).toContain('data-copy-field="id"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-field="shell"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-field="cwd"');
    expect(rawWebviewView.webview.html).toContain('data-truncate-from-start="true"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-field="exit-code"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="error"');
    expect(rawWebviewView.webview.html).not.toContain('>Termination Signal<');
    expect(rawWebviewView.webview.html).not.toContain('title="Id:');
  });

  it('shows running state in completed and exit code metadata while a command is in progress', async () => {
    const detailsRef = {
      current: createDetails({
        completedAt: null,
        exitCode: null,
        isRunning: true,
        signal: null,
      }),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(rawWebviewView.webview.html).toContain('>--<');
    expect(rawWebviewView.webview.html.match(/>--</g)?.length).toBe(2);
    expect(rawWebviewView.webview.html).not.toContain('>Running...<');
    expect(rawWebviewView.webview.html).toContain('data-metadata-field="exit-code"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="running"');
  });

  it('copies the public id and cwd from metadata actions', async () => {
    const detailsRef = {
      current: createDetails({
        cwd: '/workspace/project',
      }),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      getMessageHandler,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    const messageHandler = getMessageHandler();

    expect(messageHandler).toBeTypeOf('function');

    await messageHandler?.({
      commandId: 'shell-1234abcd',
      copyField: 'id',
      type: 'copy',
    });
    await flushWebviewMessageMicrotasks();
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('1234abcd');

    await messageHandler?.({
      commandId: 'shell-1234abcd',
      copyField: 'cwd',
      type: 'copy',
    });
    await flushWebviewMessageMicrotasks();
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('/workspace/project');
  });

  it('updates the selected command without rewriting the full webview html', async () => {
    const firstDetails = createDetails({
      command: 'printf first',
      id: 'shell-1234abcd',
      output: 'first line\n',
    });
    const secondDetails = createDetails({
      command: 'printf second',
      completedAt: '2026-03-10T00:01:00.000Z',
      exitCode: 0,
      id: 'shell-beefcafe',
      isRunning: false,
      output: 'second line\n',
    });
    const detailsById = new Map<string, ShellCommandDetails>([
      [ firstDetails.id, firstDetails ],
      [ secondDetails.id, secondDetails ],
    ]);
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async (commandId: string) => detailsById.get(commandId)),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [
        createCommand({
          command: firstDetails.command,
          id: firstDetails.id,
          isRunning: true,
        }),
        createCommand({
          command: secondDetails.command,
          completedAt: secondDetails.completedAt,
          exitCode: secondDetails.exitCode,
          id: secondDetails.id,
          isRunning: false,
        }),
      ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      getMessageHandler,
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);
    const initialHtml = rawWebviewView.webview.html;
    const messageHandler = getMessageHandler();

    await messageHandler?.({
      type: 'ready',
    });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    await messageHandler?.({
      commandId: secondDetails.id,
      type: 'select',
    });
    await flushWebviewMessageMicrotasks();

    expect(rawWebviewView.webview.html).toBe(initialHtml);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'replacePanelState',
    }));

    const firstMessage = postMessage.mock.calls[0]?.[0] as undefined | {
      commandItemsHtml: string;
      detailsHtml: string;
      type: string;
    };

    expect(firstMessage?.commandItemsHtml).toContain('data-id="shell-beefcafe"');
    expect(firstMessage?.commandItemsHtml).toContain('command-item selected');
    expect(firstMessage?.detailsHtml).toContain('printf second');
    expect(firstMessage?.detailsHtml).toContain('second line');
  });

  it('waits for the webview ready signal before posting incremental panel updates', async () => {
    const firstDetails = createDetails({
      command: 'printf first',
      id: 'shell-1234abcd',
      output: 'first line\n',
    });
    const secondDetails = createDetails({
      command: 'printf second',
      completedAt: '2026-03-10T00:01:00.000Z',
      exitCode: 0,
      id: 'shell-beefcafe',
      isRunning: false,
      output: 'second line\n',
    });
    const detailsById = new Map<string, ShellCommandDetails>([
      [ firstDetails.id, firstDetails ],
      [ secondDetails.id, secondDetails ],
    ]);
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async (commandId: string) => detailsById.get(commandId)),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [
        createCommand({
          command: firstDetails.command,
          id: firstDetails.id,
          isRunning: true,
        }),
        createCommand({
          command: secondDetails.command,
          completedAt: secondDetails.completedAt,
          exitCode: secondDetails.exitCode,
          id: secondDetails.id,
          isRunning: false,
        }),
      ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const {
      getMessageHandler,
      postMessage,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    const initialHtml = rawWebviewView.webview.html;
    const messageHandler = getMessageHandler();

    await messageHandler?.({
      commandId: secondDetails.id,
      type: 'select',
    });
    await flushWebviewMessageMicrotasks();

    expect(rawWebviewView.webview.html).toBe(initialHtml);
    expect(postMessage).not.toHaveBeenCalled();

    await messageHandler?.({
      type: 'ready',
    });
    await flushWebviewMessageMicrotasks();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'replacePanelState',
    }));
  });

  it('re-reads persisted scroll state inside the webview restore hooks', async () => {
    const detailsRef = {
      current: createDetails(),
    };
    const runtime = createRuntime(detailsRef);

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(rawWebviewView.webview.html).toContain('const getCurrentState = () => vscodeApi.getState() || {};');
    expect(rawWebviewView.webview.html).toContain('const savedCommandListScrollTop = getCurrentState().commandListScrollTop;');
    expect(rawWebviewView.webview.html).toContain('const savedOutputScrollState = getCurrentState().outputScrollState;');
  });
});
