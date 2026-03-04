import * as vscode from 'vscode';

import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';
import { registerTerminalTools } from '@/terminalTools';

const EXTENSION_CONFIG_SECTION = 'custom-vscode';
const BRING_TO_CHAT_ENABLED_KEY = 'bringToChat.enabled';
const TERMINAL_TOOLS_ENABLED_KEY = 'terminalTools.enabled';

function isFeatureEnabled(key: string): boolean {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get<boolean>(key, true);
}

function disposeAndRemoveSubscription(
  disposable: vscode.Disposable,
  subscriptions: vscode.Disposable[],
): void {
  disposable.dispose();

  const subscriptionIndex = subscriptions.indexOf(disposable);
  if (subscriptionIndex >= 0) {
    subscriptions.splice(subscriptionIndex, 1);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  let bringToChatRegistration: undefined | vscode.Disposable;
  let terminalToolsRegistration: undefined | vscode.Disposable;

  const applyFeatureConfiguration = (): void => {
    const isBringToChatEnabled = isFeatureEnabled(BRING_TO_CHAT_ENABLED_KEY);
    const isTerminalToolsEnabled = isFeatureEnabled(TERMINAL_TOOLS_ENABLED_KEY);

    if (isBringToChatEnabled && !bringToChatRegistration) {
      bringToChatRegistration = vscode.Disposable.from(
        registerReviewParticipant(),
        vscode.commands.registerCommand('custom-vscode.reviewCommentToChat', reviewCommentToChat),
      );
      context.subscriptions.push(bringToChatRegistration);
    }
    else if (!isBringToChatEnabled && bringToChatRegistration) {
      disposeAndRemoveSubscription(bringToChatRegistration, context.subscriptions);
      bringToChatRegistration = undefined;
    }

    if (isTerminalToolsEnabled && !terminalToolsRegistration) {
      terminalToolsRegistration = registerTerminalTools();
      context.subscriptions.push(terminalToolsRegistration);
    }
    else if (!isTerminalToolsEnabled && terminalToolsRegistration) {
      disposeAndRemoveSubscription(terminalToolsRegistration, context.subscriptions);
      terminalToolsRegistration = undefined;
    }
  };

  applyFeatureConfiguration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${BRING_TO_CHAT_ENABLED_KEY}`)
        || event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${TERMINAL_TOOLS_ENABLED_KEY}`)
      ) {
        applyFeatureConfiguration();
      }
    }),
  );
}
