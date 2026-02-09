import * as vscode from 'vscode';

import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';

export function activate(context: vscode.ExtensionContext): void {
  registerReviewParticipant(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('custom-vscode.reviewCommentToChat', reviewCommentToChat),
  );
}
