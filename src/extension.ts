import * as vscode from 'vscode';

import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';
import { registerTerminalTools } from '@/terminalTools';

export function activate(context: vscode.ExtensionContext): void {
  registerReviewParticipant(context);
  registerTerminalTools(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('custom-vscode.reviewCommentToChat', reviewCommentToChat),
  );
}
