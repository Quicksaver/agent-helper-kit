import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import {
  type TerminalCommandDetails,
  type TerminalCommandListItem,
  type TerminalRuntime,
} from '@/shellRuntime';

const SHELL_COMMANDS_VIEW_ID = 'custom-vscode.shellCommandsView';
const SHELL_COMMANDS_PANEL_CONTAINER_ID = 'custom-vscode-shellCommandsPanel';
const RUNNING_POLL_MS = 1000;

type ShellCommandTreeItem = {
  commandRun: {
    id: string;
  };
};

type WebviewMessage = {
  commandId?: string;
  type: 'clear' | 'delete' | 'kill' | 'select';
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function formatTimestamp(value: null | string): string {
  if (!value) {
    return '—';
  }

  const asDate = new Date(value);

  if (Number.isNaN(asDate.getTime())) {
    return value;
  }

  return asDate.toLocaleString();
}

function getCommandStatusLabel(command: TerminalCommandListItem): string {
  if (command.isRunning) {
    return 'RUNNING';
  }

  if (command.killedByUser) {
    return 'KILLED';
  }

  if (command.exitCode === 0) {
    return 'SUCCESS';
  }

  return 'ERROR';
}

function getCommandStatusClass(command: TerminalCommandListItem): string {
  if (command.isRunning) {
    return 'running';
  }

  if (command.killedByUser) {
    return 'killed';
  }

  if (command.exitCode === 0) {
    return 'success';
  }

  return 'error';
}

function resolveCommandId(target: unknown): string | undefined {
  if (typeof target === 'string' && target.length > 0) {
    return target;
  }

  if (
    typeof target === 'object'
    && target !== null
    && 'commandRun' in target
  ) {
    const candidate = target as ShellCommandTreeItem;

    if (typeof candidate.commandRun.id === 'string' && candidate.commandRun.id.length > 0) {
      return candidate.commandRun.id;
    }
  }

  return undefined;
}

function buildDetailsMarkup(details: TerminalCommandDetails | undefined): string {
  if (!details) {
    return `
      <div class="empty-detail">
        <p>Select a command from the list to inspect it.</p>
      </div>
    `;
  }

  const statusLabel = getCommandStatusLabel(details);
  const canKill = details.isRunning;
  const canDelete = !details.isRunning;

  return `
    <header class="details-header">
      <div class="details-title-row">
        <h2>${escapeHtml(details.id)}</h2>
        <span class="status-chip ${getCommandStatusClass(details)}">${statusLabel}</span>
      </div>
      <div class="details-actions">
        <button data-action="kill" data-id="${escapeHtml(details.id)}" ${canKill ? '' : 'disabled'}>Kill</button>
        <button data-action="delete" data-id="${escapeHtml(details.id)}" ${canDelete ? '' : 'disabled'}>Delete</button>
      </div>
    </header>
    <section class="metadata-grid">
      <div><strong>Started</strong><span>${escapeHtml(formatTimestamp(details.startedAt))}</span></div>
      <div><strong>Completed</strong><span>${escapeHtml(formatTimestamp(details.completedAt))}</span></div>
      <div><strong>Exit</strong><span>${escapeHtml(String(details.exitCode))}</span></div>
      <div><strong>Signal</strong><span>${escapeHtml(details.signal ?? 'none')}</span></div>
    </section>
    <section class="content-block">
      <h3>Command</h3>
      <pre>${escapeHtml(details.command)}</pre>
    </section>
    <section class="content-block">
      <h3>Output</h3>
      <pre>${escapeHtml(details.output)}</pre>
    </section>
  `;
}

function getWebviewHtml(
  webview: vscode.Webview,
  commands: TerminalCommandListItem[],
  selectedCommandId: string | undefined,
  selectedDetails: TerminalCommandDetails | undefined,
): string {
  const nonce = randomBytes(16).toString('hex');
  const commandItems = commands.map(command => {
    const firstLine = command.command.split('\n')[0]?.trim() || '(empty command)';
    const selectedClass = command.id === selectedCommandId ? 'selected' : '';
    const statusLabel = getCommandStatusLabel(command);

    return `
      <button class="command-item ${selectedClass}" data-action="select" data-id="${escapeHtml(command.id)}">
        <div class="command-item-head">
          <span class="status-dot ${getCommandStatusClass(command)}"></span>
          <span class="command-preview">${escapeHtml(firstLine)}</span>
        </div>
        <div class="command-item-meta">
          <span>${escapeHtml(statusLabel)}</span>
          <span>${escapeHtml(command.id)}</span>
        </div>
      </button>
    `;
  }).join('');

  const detailsMarkup = buildDetailsMarkup(selectedDetails);

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root { color-scheme: light dark; }
      html, body { height: 100%; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(220px, 32%) 1fr;
        height: 100%;
      }
      .sidebar {
        border-right: 1px solid var(--vscode-editorWidget-border);
        background: var(--vscode-sideBar-background);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .sidebar-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 8px;
      }
      .sidebar-header h2 {
        font-size: 12px;
        margin: 0;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
      }
      .sidebar-header button,
      .details-actions button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid var(--vscode-button-border);
        border-radius: 4px;
        padding: 2px 8px;
        cursor: pointer;
      }
      .sidebar-header button:hover,
      .details-actions button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
      .sidebar-header button:disabled,
      .details-actions button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .command-list {
        overflow: auto;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .command-item {
        all: unset;
        display: flex;
        flex-direction: column;
        gap: 6px;
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 6px;
        padding: 8px;
        cursor: pointer;
        background: var(--vscode-editor-background);
      }
      .command-item.selected {
        border-color: var(--vscode-focusBorder);
        outline: 1px solid var(--vscode-focusBorder);
      }
      .command-item-head {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: 0 0 auto;
      }
      .status-dot.running { background: var(--vscode-terminal-ansiBlue); }
      .status-dot.success { background: var(--vscode-terminal-ansiGreen); }
      .status-dot.error { background: var(--vscode-terminal-ansiRed); }
      .status-dot.killed { background: var(--vscode-terminal-ansiYellow); }
      .command-preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .command-item-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      .details {
        min-height: 0;
        overflow: auto;
        padding: 12px;
        background: var(--vscode-editor-background);
      }
      .details-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 12px;
      }
      .details-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .details-title-row h2 {
        margin: 0;
        font-size: 13px;
      }
      .status-chip {
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
      }
      .status-chip.running { color: var(--vscode-terminal-ansiBlue); }
      .status-chip.success { color: var(--vscode-terminal-ansiGreen); }
      .status-chip.error { color: var(--vscode-terminal-ansiRed); }
      .status-chip.killed { color: var(--vscode-terminal-ansiYellow); }
      .details-actions {
        display: flex;
        gap: 8px;
      }
      .metadata-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 12px;
      }
      .metadata-grid div {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .metadata-grid strong {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-transform: uppercase;
      }
      .content-block {
        margin-bottom: 12px;
      }
      .content-block h3 {
        margin: 0 0 6px 0;
        font-size: 12px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
      }
      .content-block pre {
        margin: 0;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid var(--vscode-editorWidget-border);
        background: var(--vscode-textCodeBlock-background);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty-detail {
        display: grid;
        place-items: center;
        height: 100%;
        color: var(--vscode-descriptionForeground);
      }
      .empty-list {
        color: var(--vscode-descriptionForeground);
        padding: 8px;
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <h2>Commands</h2>
          <button data-action="clear">Clear Finished</button>
        </div>
        <div class="command-list">
          ${commands.length === 0 ? '<div class="empty-list">No commands yet.</div>' : commandItems}
        </div>
      </aside>
      <main class="details">${detailsMarkup}</main>
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      const clickable = document.querySelectorAll('[data-action]');

      for (const element of clickable) {
        element.addEventListener('click', () => {
          const action = element.getAttribute('data-action');
          const commandId = element.getAttribute('data-id') ?? undefined;

          if (!action) {
            return;
          }

          vscodeApi.postMessage({
            commandId,
            type: action,
          });
        });
      }
    </script>
  </body>
</html>
  `;
}

class ShellCommandsPanelProvider implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly disposeRuntimeListener: () => void;
  private renderRequestId = 0;
  private runningPoller: NodeJS.Timeout | undefined;
  private selectedCommandId: string | undefined;
  private view: undefined | vscode.WebviewView;

  constructor(private readonly runtime: TerminalRuntime) {
    this.disposeRuntimeListener = this.runtime.onDidChangeCommands(() => {
      void this.refresh();
    });
  }

  dispose(): void {
    this.disposeRuntimeListener();
    this.stopPolling();
    this.view = undefined;
  }

  getSelectedCommandId(): string | undefined {
    return this.selectedCommandId;
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const { view } = this;

    const requestId = ++this.renderRequestId;
    const commands = this.runtime.listCommands();

    if (!this.selectedCommandId || !commands.some(command => command.id === this.selectedCommandId)) {
      this.selectedCommandId = commands[0]?.id;
    }

    let selectedDetails: TerminalCommandDetails | undefined;

    if (this.selectedCommandId) {
      try {
        selectedDetails = await this.runtime.getCommandDetails(this.selectedCommandId);
      }
      catch {
        selectedDetails = undefined;
      }
    }

    if (requestId !== this.renderRequestId || view !== this.view) {
      return;
    }

    view.webview.html = getWebviewHtml(
      view.webview,
      commands,
      this.selectedCommandId,
      selectedDetails,
    );

    this.updatePolling(selectedDetails);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.onDidDispose(() => {
      this.stopPolling();
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    await this.refresh();
  }

  async reveal(commandId?: string): Promise<void> {
    if (commandId) {
      this.selectedCommandId = commandId;
    }

    await vscode.commands.executeCommand(`workbench.view.extension.${SHELL_COMMANDS_PANEL_CONTAINER_ID}`);
    await this.refresh();
  }

  setSelectedCommandId(commandId: string | undefined): void {
    this.selectedCommandId = commandId;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'select' && message.commandId) {
      this.selectedCommandId = message.commandId;
      await this.refresh();
      return;
    }

    if (message.type === 'kill' && message.commandId) {
      this.runtime.killBackgroundCommand(message.commandId);
      await this.refresh();
      return;
    }

    if (message.type === 'delete' && message.commandId) {
      this.runtime.deleteCompletedCommand(message.commandId);

      if (this.selectedCommandId === message.commandId) {
        this.selectedCommandId = undefined;
      }

      await this.refresh();
      return;
    }

    if (message.type === 'clear') {
      this.runtime.clearCompletedCommands();

      if (this.selectedCommandId) {
        const selectedStillExists = this.runtime.listCommands().some(command => command.id === this.selectedCommandId);

        if (!selectedStillExists) {
          this.selectedCommandId = undefined;
        }
      }

      await this.refresh();
    }
  }

  private stopPolling(): void {
    if (!this.runningPoller) {
      return;
    }

    clearInterval(this.runningPoller);
    this.runningPoller = undefined;
  }

  private updatePolling(details: TerminalCommandDetails | undefined): void {
    if (!this.selectedCommandId || !details?.isRunning) {
      this.stopPolling();
      return;
    }

    if (this.runningPoller) {
      return;
    }

    this.runningPoller = setInterval(() => {
      void this.refresh();
    }, RUNNING_POLL_MS);
  }
}

export function registerShellCommandsPanel(getRuntime: () => TerminalRuntime): vscode.Disposable {
  const runtime = getRuntime();
  const provider = new ShellCommandsPanelProvider(runtime);
  const webviewViewRegistration = vscode.window.registerWebviewViewProvider(
    SHELL_COMMANDS_VIEW_ID,
    provider,
  );

  const openCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.openEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item);

      await provider.reveal(commandId);
    },
  );

  const killCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.killEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item) ?? provider.getSelectedCommandId();

      if (!commandId) {
        return;
      }

      runtime.killBackgroundCommand(commandId);
      provider.setSelectedCommandId(commandId);
      await provider.refresh();
    },
  );

  const deleteCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.deleteEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item) ?? provider.getSelectedCommandId();

      if (!commandId) {
        return;
      }

      const deleted = runtime.deleteCompletedCommand(commandId);

      if (!deleted) {
        return;
      }

      if (provider.getSelectedCommandId() === commandId) {
        provider.setSelectedCommandId(undefined);
      }

      await provider.refresh();
    },
  );

  const clearCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.clearFinished',
    async () => {
      const removedCount = runtime.clearCompletedCommands();

      if (removedCount === 0) {
        return;
      }

      const selectedCommandId = provider.getSelectedCommandId();

      if (selectedCommandId) {
        const selectedStillExists = runtime.listCommands().some(command => command.id === selectedCommandId);

        if (!selectedStillExists) {
          provider.setSelectedCommandId(undefined);
        }
      }

      await provider.refresh();
    },
  );

  return vscode.Disposable.from(
    provider,
    webviewViewRegistration,
    openCommand,
    killCommand,
    deleteCommand,
    clearCommand,
  );
}
