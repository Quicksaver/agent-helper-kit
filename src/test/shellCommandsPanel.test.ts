import * as fs from 'node:fs';
import * as path from 'node:path';

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

const logError = vi.hoisted(() => vi.fn());

type MessageHandler = (message: unknown) => Promise<void> | void;

const capturedProviders: unknown[] = [];
const shellCommandsPanelWebviewScriptSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'webviews', 'shellCommandsPanelWebview.ts'),
  'utf8',
);
const shellCommandsPanelWebviewStylesSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'webviews', 'shellCommandsPanelWebview.css'),
  'utf8',
);

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
  Uri: {
    joinPath: vi.fn((base: { fsPath?: string; path?: string }, ...segments: string[]) => {
      const basePath = base.fsPath ?? base.path ?? '';
      const joinedPath = path.posix.join(basePath, ...segments);

      return {
        fsPath: joinedPath,
        path: joinedPath,
        toString: () => joinedPath,
      };
    }),
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
vi.mock('@/logging', () => ({ logError }));

function createCommand(overrides: Partial<ShellCommandListItem> = {}): ShellCommandListItem {
  const isRunning = overrides.isRunning ?? true;

  return {
    command: 'printf test',
    completedAt: null,
    cwd: '/workspace/project',
    exitCode: null,
    id: 'shell-1234abcd',
    isRunning,
    killedByUser: false,
    phase: isRunning ? 'running' : 'completed',
    shell: '/bin/zsh',
    signal: null,
    startedAt: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

function createDetails(overrides: Partial<ShellCommandDetails> = {}): ShellCommandDetails {
  const isRunning = overrides.isRunning ?? true;

  return {
    ...createCommand({
      isRunning,
      phase: overrides.phase ?? (isRunning ? 'running' : 'completed'),
    }),
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
        approval: detailsRef.current.approval,
        command: detailsRef.current.command,
        completedAt: detailsRef.current.completedAt,
        cwd: detailsRef.current.cwd,
        exitCode: detailsRef.current.exitCode,
        id: detailsRef.current.id,
        isRunning: detailsRef.current.isRunning,
        killedByUser: detailsRef.current.killedByUser,
        phase: detailsRef.current.phase,
        request: detailsRef.current.request,
        shell: detailsRef.current.shell,
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
  triggerDispose: () => void;
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
  let disposeHandler: (() => void) | undefined;
  const onDidReceiveMessage = vi.fn((listener: MessageHandler) => {
    messageHandler = listener;
    return { dispose: vi.fn() };
  });
  const onDidDispose = vi.fn((listener: () => void) => {
    disposeHandler = listener;
    return { dispose: vi.fn() };
  });
  const postMessage = vi.fn(async () => true);

  return {
    getMessageHandler: () => messageHandler,
    onDidReceiveMessage,
    postMessage,
    triggerDispose: () => {
      disposeHandler?.();
    },
    webviewView: {
      onDidDispose,
      webview: {
        html: '',
        onDidReceiveMessage,
        options: {},
        postMessage,
      },
    },
  };
}

function getRegisteredCommandHandler(commandId: string) {
  const call = (vscode.commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls
    .find(([ registeredCommandId ]) => registeredCommandId === commandId);

  if (!call) {
    throw new Error(`Command not registered: ${commandId}`);
  }

  return call[1] as (item?: unknown) => Promise<void>;
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

  it('resolves webview asset URIs from the extension URI when available', async () => {
    const detailsRef = {
      current: createDetails({ isRunning: false, phase: 'completed' }),
    };
    const runtime = createRuntime(detailsRef);
    const extensionUri = {
      fsPath: '/extension-root',
      path: '/extension-root',
      toString: () => '/extension-root',
    } as unknown as import('vscode').Uri;

    registerShellCommandsPanel(() => runtime, extensionUri);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const asWebviewUri = vi.fn((uri: { fsPath?: string; path?: string; toString: () => string }) => ({
      toString: () => `webview:${uri.fsPath ?? uri.path ?? uri.toString()}`,
    }));

    Object.assign(rawWebviewView.webview, {
      asWebviewUri,
      cspSource: 'vscode-webview-source',
    });

    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(vscode.Uri.joinPath).toHaveBeenCalledWith(extensionUri, 'dist', 'webviews');
    expect(vscode.Uri.joinPath).toHaveBeenCalledWith(extensionUri, 'dist', 'webviews', 'shellCommandsPanelWebview.js');
    expect(vscode.Uri.joinPath).toHaveBeenCalledWith(extensionUri, 'dist', 'webviews', 'shellCommandsPanelWebview.css');
    expect(asWebviewUri).toHaveBeenCalledTimes(2);
    expect(rawWebviewView.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [
        expect.objectContaining({ fsPath: '/extension-root/dist/webviews' }),
      ],
    });
    expect(rawWebviewView.webview.html).toContain('style-src vscode-webview-source; script-src vscode-webview-source;');
    expect(rawWebviewView.webview.html).toContain('href="webview:/extension-root/dist/webviews/shellCommandsPanelWebview.css"');
    expect(rawWebviewView.webview.html).toContain('src="webview:/extension-root/dist/webviews/shellCommandsPanelWebview.js"');
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

  it('logs polling errors when output updates fail to post to the webview', async () => {
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    detailsRef.current = createDetails({ output: 'first line\nsecond line\n' });
    postMessage.mockRejectedValueOnce(new Error('webview unavailable'));

    await vi.advanceTimersByTimeAsync(1000);
    await flushWebviewMessageMicrotasks();

    expect(logError).toHaveBeenCalledWith('Failed to refresh running shell command output: Error: webview unavailable');
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

  it('renders inline ANSI declarations for RGB foreground and background colors', async () => {
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

    detailsRef.current = createDetails({
      output: '\u001B[38;2;1;2;3;48;2;4;5;6mstyled\u001B[0m\n',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const outputHtml = firstMessage?.outputHtml;

    expect(outputHtml).toBeTypeOf('string');
    expect(outputHtml).toContain('color: rgb(1, 2, 3)');
    expect(outputHtml).toContain('background-color: rgb(4, 5, 6)');
  });

  it('renders inverse ANSI colors and removes styling after reset codes', async () => {
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    detailsRef.current = createDetails({
      output: '\u001B[31;44;7mA\u001B[27mB\u001B[39;49mC\n',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const outputHtml = firstMessage?.outputHtml;

    expect(outputHtml).toBeTypeOf('string');
    expect(outputHtml).toContain('class="ansi-fg-4 ansi-bg-1"');
    expect(outputHtml).toContain('class="ansi-fg-1 ansi-bg-4"');
    expect(outputHtml).toContain('</span>C');
  });

  it('parses C1 ANSI sequences and 256-color palette values into RGB styles', async () => {
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    detailsRef.current = createDetails({
      output: '\u009B38;5;16;48;5;232mX\u001B[0m\u001B[38;5;21mY\u001B[0m\n',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const outputHtml = firstMessage?.outputHtml;

    expect(outputHtml).toBeTypeOf('string');
    expect(outputHtml).toContain('color: rgb(0, 0, 0)');
    expect(outputHtml).toContain('background-color: rgb(8, 8, 8)');
    expect(outputHtml).toContain('color: rgb(0, 0, 255)');
  });

  it('clears class-based ANSI emphasis flags after explicit reset codes', async () => {
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    detailsRef.current = createDetails({
      output: '\u001B[1;2;3;4;9mA\u001B[22;23;24;29mB\n',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const firstMessage = postMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const outputHtml = firstMessage?.outputHtml;

    expect(outputHtml).toBeTypeOf('string');
    expect(outputHtml).toContain('class="ansi-bold ansi-dim ansi-italic ansi-underline ansi-strikethrough"');
    expect(outputHtml).toContain('</span>B');
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
    expect(rawWebviewView.webview.html).not.toContain('data-metadata-field="status"');
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
    expect(rawWebviewView.webview.html).not.toContain('data-metadata-field="status"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="running"');
  });

  it('renders pending approval request details without the raw risk assessment result section', async () => {
    const detailsRef = {
      current: createDetails({
        approval: {
          decision: 'ask',
          modelAssessment: 'The command may overwrite checked out files.',
          reason: 'Risk assessment requested explicit approval before running this command.',
          riskAssessmentResult: {
            decision: 'request',
            kind: 'response',
            modelId: 'copilot:gpt-4.1',
            reason: 'The command may overwrite checked out files.',
          },
          source: 'risk-assessment',
        },
        command: 'git checkout main',
        completedAt: null,
        exitCode: null,
        isRunning: false,
        output: '',
        phase: 'pending-approval',
        request: {
          explanation: 'switch branches',
          goal: 'move to main',
          riskAssessment: 'This may replace files in the working tree.',
          riskAssessmentContext: [ 'git checkout main', 'src/shellTools.ts' ],
        },
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

    expect(rawWebviewView.webview.html).toContain('data-detail-section="request-details"');
    expect(rawWebviewView.webview.html).toContain('switch branches');
    expect(rawWebviewView.webview.html).toContain('git checkout main');
    expect(rawWebviewView.webview.html).toContain('src/shellTools.ts');
    expect(rawWebviewView.webview.html).toContain('risk-assessment');
    expect(rawWebviewView.webview.html).not.toContain('data-detail-section="risk-assessment-result"');
    expect(rawWebviewView.webview.html).not.toContain('data-metadata-field="status"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="pending"');
    expect(rawWebviewView.webview.html).toContain('class="status-indicator pending"');
    expect(rawWebviewView.webview.html).not.toContain('class="icon-action row-action"');
  });

  it('renders evaluating, queued, and denied command states in the list and details pane', async () => {
    const evaluatingCommand = createCommand({
      command: 'echo evaluate',
      id: 'shell-evaluating',
      isRunning: false,
      phase: 'evaluating',
    });
    const queuedCommand = createCommand({
      command: 'echo queued',
      id: 'shell-queued',
      isRunning: false,
      phase: 'queued',
    });
    const deniedCommand = createCommand({
      command: 'rm -rf build',
      completedAt: '2026-03-10T00:01:00.000Z',
      id: 'shell-denied',
      isRunning: false,
      phase: 'denied',
    });
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async (commandId: string) => {
        if (commandId === queuedCommand.id) {
          return createDetails({
            approval: {
              decision: 'allow',
              reason: 'Every parsed subcommand matched an allow rule.',
              source: 'rule',
            },
            command: queuedCommand.command,
            id: queuedCommand.id,
            isRunning: false,
            output: '',
            phase: 'queued',
          });
        }

        throw new Error('unexpected command');
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [ queuedCommand, evaluatingCommand, deniedCommand ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(rawWebviewView.webview.html).toContain('class="status-indicator queued"');
    expect(rawWebviewView.webview.html).toContain('class="status-indicator evaluating"');
    expect(rawWebviewView.webview.html).toContain('class="status-indicator denied"');
    expect(rawWebviewView.webview.html).toContain('data-action="delete"');
  });

  it('renders denied details with terminal status metadata and a completion timestamp', async () => {
    const detailsRef = {
      current: createDetails({
        approval: {
          decision: 'deny',
          reason: 'The shell approval policy denied this command.',
          source: 'rule',
        },
        command: 'rm -rf build',
        completedAt: '2026-03-10T00:01:00.000Z',
        id: 'shell-denied-selected',
        isRunning: false,
        output: '',
        phase: 'denied',
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

    expect(rawWebviewView.webview.html).not.toContain('data-metadata-field="status"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="error"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-field="completed"');
    expect(rawWebviewView.webview.html).toContain('The shell approval policy denied this command.');
    expect(rawWebviewView.webview.html).toContain('class="status-indicator denied"');
    expect(rawWebviewView.webview.html).toContain('data-action="delete"');
  });

  it('renders evaluating details without a risk assessment result section', async () => {
    const detailsRef = {
      current: createDetails({
        command: 'git status',
        id: 'shell-evaluating-selected',
        isRunning: false,
        output: '',
        phase: 'evaluating',
        request: {
          explanation: '',
        },
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

    expect(rawWebviewView.webview.html).not.toContain('data-metadata-field="status"');
    expect(rawWebviewView.webview.html).toContain('data-metadata-status="queued"');
    expect(rawWebviewView.webview.html).toContain('(not provided)');
    expect(rawWebviewView.webview.html).toContain('class="status-indicator evaluating"');
    expect(rawWebviewView.webview.html).not.toContain('data-detail-section="risk-assessment-result"');
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

  it('handles kill messages by stopping the running command and refreshing the panel', async () => {
    const killBackgroundCommand = vi.fn(() => true);
    const detailsRef = {
      current: createDetails(),
    };
    const baseRuntime = createRuntime(detailsRef);
    const runtime = {
      clearCompletedCommands: () => baseRuntime.clearCompletedCommands(),
      deleteCompletedCommand: (commandId: string) => baseRuntime.deleteCompletedCommand(commandId),
      getCommandDetails: (commandId: string) => baseRuntime.getCommandDetails(commandId),
      killBackgroundCommand,
      listCommands: () => baseRuntime.listCommands(),
      onDidChangeCommands: (listener: () => void) => baseRuntime.onDidChangeCommands(listener),
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    await getMessageHandler()?.({
      commandId: 'shell-1234abcd',
      type: 'kill',
    });
    await flushWebviewMessageMicrotasks();

    expect(killBackgroundCommand).toHaveBeenCalledWith('shell-1234abcd');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'replacePanelState',
    }));
  });

  it('handles delete messages by clearing the selected command when it is removed', async () => {
    let commands: ShellCommandListItem[] = [
      createCommand({
        completedAt: '2026-03-10T00:01:00.000Z',
        exitCode: 0,
        id: 'shell-1234abcd',
        isRunning: false,
      }),
    ];
    const deleteCompletedCommand = vi.fn((commandId: string) => {
      commands = commands.filter(command => command.id !== commandId);
      return true;
    });
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand,
      getCommandDetails: vi.fn(async (commandId: string) => {
        const exists = commands.some(command => command.id === commandId);

        if (!exists) {
          throw new Error('missing');
        }

        return createDetails({
          completedAt: '2026-03-10T00:01:00.000Z',
          exitCode: 0,
          id: commandId,
          isRunning: false,
        });
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => commands),
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    await getMessageHandler()?.({
      commandId: 'shell-1234abcd',
      type: 'delete',
    });
    await flushWebviewMessageMicrotasks();

    expect(deleteCompletedCommand).toHaveBeenCalledWith('shell-1234abcd');
    const deleteMessage = postMessage.mock.calls[0]?.[0] as undefined | {
      detailsHtml: string;
      type: string;
    };
    expect(deleteMessage?.type).toBe('replacePanelState');
    expect(deleteMessage?.detailsHtml).toContain('class="details-empty"');
  });

  it('handles clear messages by clearing a removed selected command and refreshing the panel', async () => {
    let commands: ShellCommandListItem[] = [
      createCommand({
        completedAt: '2026-03-10T00:01:00.000Z',
        exitCode: 0,
        id: 'shell-1234abcd',
        isRunning: false,
      }),
    ];
    const clearCompletedCommands = vi.fn(() => {
      commands = [];
      return 1;
    });
    const runtime = {
      clearCompletedCommands,
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async (commandId: string) => {
        const exists = commands.some(command => command.id === commandId);

        if (!exists) {
          throw new Error('missing');
        }

        return createDetails({
          completedAt: '2026-03-10T00:01:00.000Z',
          exitCode: 0,
          id: commandId,
          isRunning: false,
        });
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => commands),
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    await getMessageHandler()?.({ type: 'clear' });
    await flushWebviewMessageMicrotasks();

    expect(clearCompletedCommands).toHaveBeenCalledOnce();
    const clearMessage = postMessage.mock.calls[0]?.[0] as undefined | {
      detailsHtml: string;
      type: string;
    };
    expect(clearMessage?.type).toBe('replacePanelState');
    expect(clearMessage?.detailsHtml).toContain('class="details-empty"');
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

  it('loads external webview assets and keeps the scroll restore logic in the extracted script', async () => {
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

    expect(rawWebviewView.webview.html).toContain('href="shellCommandsPanelWebview.css"');
    expect(rawWebviewView.webview.html).toContain('src="shellCommandsPanelWebview.js" defer');
    expect(rawWebviewView.webview.html).not.toContain('<style');
    expect(rawWebviewView.webview.html).not.toContain('const getCurrentState = () => vscodeApi.getState() || {};');
    expect(shellCommandsPanelWebviewScriptSource).toContain('const getCurrentState = (): PersistedWebviewState => vscodeApi.getState() ?? {};');
    expect(shellCommandsPanelWebviewScriptSource).toContain('const savedCommandListScrollTop = getCurrentState().commandListScrollTop;');
    expect(shellCommandsPanelWebviewScriptSource).toContain('const savedOutputScrollState = getCurrentState().outputScrollState;');
  });

  it('keeps the details wrapper as a constrained flex column in the extracted stylesheet', async () => {
    const detailsRef = {
      current: createDetails({
        output: Array.from({ length: 200 }, (_, index) => `line ${String(index)}`).join('\n'),
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

    expect(rawWebviewView.webview.html).toContain('<div id="details-pane" class="details-pane">');
    expect(rawWebviewView.webview.html).toContain('href="shellCommandsPanelWebview.css"');
    expect(shellCommandsPanelWebviewStylesSource).toContain('.details-pane {');
    expect(shellCommandsPanelWebviewStylesSource).toContain('display: flex;');
    expect(shellCommandsPanelWebviewStylesSource).toContain('flex-direction: column;');
    expect(shellCommandsPanelWebviewStylesSource).toContain('overflow: hidden;');
  });

  it('renders the empty details state when command details cannot be resolved', async () => {
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => {
        throw new Error('missing');
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [
        createCommand({
          completedAt: '2026-03-10T00:01:00.000Z',
          exitCode: 0,
          id: 'shell-missing',
          isRunning: false,
        }),
      ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    expect(rawWebviewView.webview.html).toContain('class="details-empty"');
    expect(rawWebviewView.webview.html).toContain('id="output-block" class="output-block"');
  });

  it('ignores copy messages when command details cannot be loaded', async () => {
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => {
        throw new Error('missing');
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [ createCommand() ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

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

    await getMessageHandler()?.({
      commandId: 'shell-1234abcd',
      copyField: 'command',
      type: 'copy',
    });
    await flushWebviewMessageMicrotasks();

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('registers openEntry and reveals the selected command in the shell runs panel', async () => {
    const detailsRef = {
      current: createDetails({
        command: 'printf selected',
        id: 'shell-beefcafe',
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

    const openEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.openEntry');

    await openEntry({
      commandRun: {
        id: 'shell-beefcafe',
      },
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.view.extension.agent-helper-kit-shellCommandsPanel',
    );

    const latestHtml = rawWebviewView.webview.html;
    expect(latestHtml).toContain('data-command-id="shell-beefcafe"');
  });

  it('registers kill and delete commands that act on explicit items', async () => {
    const deleteCompletedCommand = vi.fn(() => true);
    const killBackgroundCommand = vi.fn(() => true);
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand,
      getCommandDetails: vi.fn(async (commandId: string) => createDetails({
        command: 'printf explicit',
        completedAt: '2026-03-10T00:01:00.000Z',
        exitCode: 0,
        id: commandId,
        isRunning: false,
      })),
      killBackgroundCommand,
      listCommands: vi.fn(() => []),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;
    await provider.resolveWebviewView(webviewView);

    const killEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.killEntry');
    const deleteEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.deleteEntry');

    await killEntry('shell-1234abcd');
    await deleteEntry('shell-1234abcd');

    expect(killBackgroundCommand).toHaveBeenCalledWith('shell-1234abcd');
    expect(deleteCompletedCommand).toHaveBeenCalledWith('shell-1234abcd');
    expect(rawWebviewView.webview.html).toContain('class="details-empty"');
  });

  it('registers clearFinished and skips refresh when nothing was removed', async () => {
    const clearCompletedCommands = vi.fn(() => 0);
    const runtime = {
      clearCompletedCommands,
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => createDetails()),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [ createCommand() ]),
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

    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    const clearFinished = getRegisteredCommandHandler('agent-helper-kit.shellCommands.clearFinished');
    await clearFinished();

    expect(clearCompletedCommands).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('renders ANSI class styles and fallback labels for completed killed commands', async () => {
    const detailsRef = {
      current: createDetails({
        command: '   ',
        completedAt: '2026-03-10T00:01:00.000Z',
        exitCode: 1,
        isRunning: false,
        killedByUser: true,
        output: '\u001B[31;44;1;2;3;4;9mstyled\u001B[0m\n',
        shell: '   ',
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

    const { html } = rawWebviewView.webview;
    expect(html).toContain('class="status-indicator killed"');
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('title="Delete"');
    expect(html).toContain('class="ansi-fg-1 ansi-bg-4 ansi-bold ansi-dim ansi-italic ansi-underline ansi-strikethrough"');
  });

  it('renders fallback labels for empty commands, unknown shells, invalid timestamps, and signal-only exits', async () => {
    const selectedDetails = createDetails({
      command: '   ',
      completedAt: 'not-a-date',
      exitCode: null,
      id: 'shell-badf00d',
      isRunning: false,
      killedByUser: false,
      shell: '   ',
      signal: 'SIGINT',
    });
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => selectedDetails),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [
        createCommand({
          command: '   ',
          completedAt: 'not-a-date',
          exitCode: null,
          id: 'shell-badf00d',
          isRunning: false,
          killedByUser: false,
          shell: '   ',
          signal: 'SIGINT',
        }),
      ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);

    const { html } = rawWebviewView.webview;
    expect(html).toContain('(empty command)');
    expect(html).toContain('>unknown<');
    expect(html).toContain('>SIGINT<');
    expect(html).toContain('>not-a-date<');
  });

  it('renders placeholder exit codes for completed commands without an exit code', async () => {
    const detailsRef = {
      current: createDetails({
        command: 'printf no-exit',
        completedAt: '2026-03-10T00:01:00.000Z',
        exitCode: null,
        id: 'shell-no-exit',
        isRunning: false,
        output: '',
        phase: 'completed',
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

    expect(rawWebviewView.webview.html).toContain('data-metadata-field="exit-code"');
    expect(rawWebviewView.webview.html).toContain('>--<');
  });

  it('copies the command text when copyField is omitted', async () => {
    const detailsRef = {
      current: createDetails({
        command: 'printf copied-command',
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

    await getMessageHandler()?.({
      commandId: 'shell-1234abcd',
      type: 'copy',
    });
    await flushWebviewMessageMicrotasks();

    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('printf copied-command');
  });

  it('stops posting updates after the webview is disposed', async () => {
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
      triggerDispose,
      webviewView: rawWebviewView,
    } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;

    await provider.resolveWebviewView(webviewView);
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    triggerDispose();
    detailsRef.current = createDetails({ output: 'first line\nsecond line\n' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls back to a full panel refresh when polled command details disappear', async () => {
    let shouldThrow = false;
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => {
        if (shouldThrow) {
          throw new Error('missing');
        }

        return createDetails();
      }),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [ createCommand() ]),
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    shouldThrow = true;

    await vi.advanceTimersByTimeAsync(1000);

    const missingDetailsMessage = postMessage.mock.calls[0]?.[0] as undefined | {
      detailsHtml: string;
      type: string;
    };
    expect(missingDetailsMessage?.type).toBe('replacePanelState');
    expect(missingDetailsMessage?.detailsHtml).toContain('class="details-empty"');
  });

  it('falls back to a full panel refresh when the selected command finishes during polling', async () => {
    let details: ShellCommandDetails = createDetails();
    const runtime = {
      clearCompletedCommands: vi.fn(() => 0),
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => details),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => [ createCommand({
        completedAt: details.completedAt,
        exitCode: details.exitCode,
        id: details.id,
        isRunning: details.isRunning,
      }) ]),
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
    await getMessageHandler()?.({ type: 'ready' });
    await flushWebviewMessageMicrotasks();
    postMessage.mockClear();

    details = createDetails({
      completedAt: '2026-03-10T00:01:00.000Z',
      exitCode: 0,
      isRunning: false,
      output: 'first line\nfinished line\n',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const finishedMessage = postMessage.mock.calls[0]?.[0] as undefined | {
      detailsHtml: string;
      type: string;
    };
    expect(finishedMessage?.type).toBe('replacePanelState');
    expect(finishedMessage?.detailsHtml).toContain('finished line');
  });

  it('uses the selected command fallback for registered delete and kill commands', async () => {
    const detailsRef = {
      current: createDetails({
        command: 'printf selected-fallback',
        id: 'shell-selected',
      }),
    };
    const deleteCompletedCommand = vi.fn(() => true);
    const killBackgroundCommand = vi.fn(() => true);
    const runtime = {
      clearCompletedCommands: vi.fn(() => 1),
      deleteCompletedCommand,
      getCommandDetails: vi.fn(async () => detailsRef.current),
      killBackgroundCommand,
      listCommands: vi.fn(() => [
        createCommand({
          command: detailsRef.current.command,
          id: detailsRef.current.id,
          isRunning: true,
        }),
      ]),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;
    await provider.resolveWebviewView(webviewView);

    const openEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.openEntry');
    const killEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.killEntry');
    const deleteEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.deleteEntry');

    await openEntry('shell-selected');
    await killEntry();
    await deleteEntry();

    expect(killBackgroundCommand).toHaveBeenCalledWith('shell-selected');
    expect(deleteCompletedCommand).toHaveBeenCalledWith('shell-selected');
  });

  it('returns early for registered delete and kill commands when nothing is selected', async () => {
    const deleteCompletedCommand = vi.fn(() => true);
    const killBackgroundCommand = vi.fn(() => true);
    const runtime = {
      clearCompletedCommands: vi.fn(() => 1),
      deleteCompletedCommand,
      getCommandDetails: vi.fn(async () => undefined),
      killBackgroundCommand,
      listCommands: vi.fn(() => []),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;
    await provider.resolveWebviewView(webviewView);

    const killEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.killEntry');
    const deleteEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.deleteEntry');

    await killEntry();
    await deleteEntry();

    expect(killBackgroundCommand).not.toHaveBeenCalled();
    expect(deleteCompletedCommand).not.toHaveBeenCalled();
  });

  it('clears the selected command when clearFinished removes it', async () => {
    const clearCompletedCommands = vi.fn(() => 1);
    const runtime = {
      clearCompletedCommands,
      deleteCompletedCommand: vi.fn(() => false),
      getCommandDetails: vi.fn(async () => undefined),
      killBackgroundCommand: vi.fn(() => true),
      listCommands: vi.fn(() => []),
      onDidChangeCommands: vi.fn(() => () => undefined),
    } as unknown as ShellRuntime;

    registerShellCommandsPanel(() => runtime);

    const provider = capturedProviders[0] as {
      resolveWebviewView: (view: import('vscode').WebviewView) => Promise<void>;
    };
    const { webviewView: rawWebviewView } = createWebviewView();
    const webviewView = rawWebviewView as unknown as import('vscode').WebviewView;
    await provider.resolveWebviewView(webviewView);

    const openEntry = getRegisteredCommandHandler('agent-helper-kit.shellCommands.openEntry');
    const clearFinished = getRegisteredCommandHandler('agent-helper-kit.shellCommands.clearFinished');

    await openEntry('shell-selected');
    await clearFinished();

    expect(clearCompletedCommands).toHaveBeenCalledOnce();
    expect(rawWebviewView.webview.html).toContain('class="details-empty"');
  });
});
