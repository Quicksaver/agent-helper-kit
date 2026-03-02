import * as vscode from 'vscode';

import { registerMcpServerProvider } from '@/mcpProvider';
import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';
import { registerTerminalTools } from '@/terminalTools';

export function activate(context: vscode.ExtensionContext): void {
  registerMcpServerProvider(context);
  registerReviewParticipant(context);
  registerTerminalTools(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('custom-vscode.reviewCommentToChat', reviewCommentToChat),
  );
}
