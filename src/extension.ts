import * as vscode from 'vscode';

import { registerReviewParticipant, reviewCommentToChat } from './reviewComments.js';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('custom-vscode.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from Custom VS Code!');
  });

  context.subscriptions.push(disposable);

  registerReviewParticipant(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('custom-vscode.reviewCommentToChat', reviewCommentToChat),
  );
}
