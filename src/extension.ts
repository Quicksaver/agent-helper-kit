import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('custom-vscode.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from Custom VS Code!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // Clean up resources here
}
