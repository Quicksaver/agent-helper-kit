import * as vscode from 'vscode';

import {
  type TerminalCommandDetails,
  type TerminalCommandListItem,
  type TerminalRuntime,
} from '@/terminalRuntime';

const SHELL_COMMANDS_VIEW_ID = 'custom-vscode.shellCommandsView';
const SHELL_COMMANDS_OUTPUT_CHANNEL_NAME = 'Shell Commands';

function getCommandStatusIcon(command: TerminalCommandListItem): vscode.ThemeIcon {
  if (command.isRunning) {
    return new vscode.ThemeIcon('copilot-in-progress');
  }

  if (command.killedByUser) {
    return new vscode.ThemeIcon('copilot-blocked');
  }

  if (command.exitCode === 0) {
    return new vscode.ThemeIcon('copilot-success');
  }

  return new vscode.ThemeIcon('copilot-error');
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

function buildStatusBar(command: TerminalCommandListItem): string {
  const statusLabel = getCommandStatusLabel(command);
  const details = command.isRunning
    ? 'in progress'
    : `exit=${String(command.exitCode)} signal=${command.signal ?? 'none'}`;

  return `========== ${statusLabel} | ${details} ==========`;
}

type ShellCommandTreeItem = vscode.TreeItem & {
  commandRun: TerminalCommandListItem;
};

function createShellCommandTreeItem(commandRun: TerminalCommandListItem): ShellCommandTreeItem {
  const firstLine = commandRun.command.split('\n')[0]?.trim() || '(empty command)';
  const treeItem = new vscode.TreeItem(firstLine, vscode.TreeItemCollapsibleState.None) as ShellCommandTreeItem;

  treeItem.commandRun = commandRun;
  treeItem.description = commandRun.id;
  treeItem.contextValue = commandRun.isRunning ? 'running' : 'finished';
  treeItem.iconPath = getCommandStatusIcon(commandRun);
  treeItem.tooltip = commandRun.isRunning
    ? `${commandRun.id}\nRunning...`
    : `${commandRun.id}\n${getCommandStatusLabel(commandRun)}`;

  return treeItem;
}

class ShellCommandsTreeDataProvider implements vscode.Disposable, vscode.TreeDataProvider<ShellCommandTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ShellCommandTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly disposeRuntimeListener: () => void;

  constructor(private readonly runtime: TerminalRuntime) {
    this.disposeRuntimeListener = this.runtime.onDidChangeCommands(() => {
      this.refresh();
    });
  }

  dispose(): void {
    this.disposeRuntimeListener();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getChildren(): ShellCommandTreeItem[] {
    return this.runtime
      .listCommands()
      .map(createShellCommandTreeItem);
  }

  getTreeItem(element: ShellCommandTreeItem): vscode.TreeItem {
    return element;
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }
}

function renderCommandDetails(channel: vscode.OutputChannel, details: TerminalCommandDetails): void {
  const headerLines = [
    buildStatusBar(details),
    `Command: ${details.command}`,
    `ID: ${details.id}`,
    `Started: ${details.startedAt}`,
  ];

  if (!details.isRunning) {
    headerLines.push(`Completed: ${details.completedAt ?? 'unknown'}`);
  }

  headerLines.push('');

  channel.clear();
  channel.appendLine(headerLines.join('\n'));

  if (details.output.length > 0) {
    channel.append(details.output);

    if (!details.output.endsWith('\n')) {
      channel.appendLine('');
    }
  }
}

export function registerShellCommandsPanel(getRuntime: () => TerminalRuntime): vscode.Disposable {
  const runtime = getRuntime();
  const provider = new ShellCommandsTreeDataProvider(runtime);
  const outputChannel = vscode.window.createOutputChannel(SHELL_COMMANDS_OUTPUT_CHANNEL_NAME);
  const treeView = vscode.window.createTreeView(SHELL_COMMANDS_VIEW_ID, {
    showCollapseAll: false,
    treeDataProvider: provider,
  });

  let selectedCommandId: string | undefined;
  let activePoller: NodeJS.Timeout | undefined;

  const stopPolling = (): void => {
    if (activePoller) {
      clearInterval(activePoller);
      activePoller = undefined;
    }
  };

  const showDetails = async (commandId: string): Promise<void> => {
    selectedCommandId = commandId;

    const details = await runtime.getCommandDetails(commandId);

    renderCommandDetails(outputChannel, details);
    outputChannel.show(true);

    if (!details.isRunning) {
      stopPolling();
      return;
    }

    if (activePoller) {
      return;
    }

    activePoller = setInterval(async () => {
      if (!selectedCommandId) {
        stopPolling();
        return;
      }

      let currentDetails: TerminalCommandDetails;

      try {
        currentDetails = await runtime.getCommandDetails(selectedCommandId);
      }
      catch {
        stopPolling();
        selectedCommandId = undefined;
        return;
      }

      renderCommandDetails(outputChannel, currentDetails);

      if (!currentDetails.isRunning) {
        stopPolling();
      }
    }, 1000);
  };

  const openCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.openEntry',
    async (item: ShellCommandTreeItem): Promise<void> => {
      await showDetails(item.commandRun.id);
    },
  );

  const killCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.killEntry',
    async (item: ShellCommandTreeItem): Promise<void> => {
      runtime.killBackgroundCommand(item.commandRun.id);
      provider.refresh();
      await showDetails(item.commandRun.id);
    },
  );

  const deleteCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.deleteEntry',
    async (item: ShellCommandTreeItem): Promise<void> => {
      const deleted = runtime.deleteCompletedCommand(item.commandRun.id);

      if (!deleted) {
        return;
      }

      if (selectedCommandId === item.commandRun.id) {
        selectedCommandId = undefined;
        stopPolling();
        outputChannel.clear();
      }

      provider.refresh();
    },
  );

  const clearCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.clearFinished',
    () => {
      const removedCount = runtime.clearCompletedCommands();

      if (removedCount === 0) {
        return;
      }

      if (selectedCommandId) {
        const selectedStillExists = runtime.listCommands().some(command => command.id === selectedCommandId);

        if (!selectedStillExists) {
          selectedCommandId = undefined;
          stopPolling();
          outputChannel.clear();
        }
      }

      provider.refresh();
    },
  );

  const treeSelection = treeView.onDidChangeSelection(async event => {
    const selectedItem = event.selection.at(0);

    if (selectedItem === undefined) {
      return;
    }

    await showDetails(selectedItem.commandRun.id);
  });

  return vscode.Disposable.from(
    provider,
    outputChannel,
    treeView,
    openCommand,
    killCommand,
    deleteCommand,
    clearCommand,
    treeSelection,
    {
      dispose: () => {
        selectedCommandId = undefined;
        stopPolling();
      },
    },
  );
}
