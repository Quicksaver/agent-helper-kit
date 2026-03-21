import * as vscode from 'vscode';

import { getExtensionOutputChannel } from '@/logging';
import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';
import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';
import { registerShellTools } from '@/shellTools';

const BRING_TO_CHAT_ENABLED_KEY = 'bringToChat.enabled';
const SHELL_TOOLS_ENABLED_KEY = 'shellTools.enabled';

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
  let shellToolsRegistration: undefined | vscode.Disposable;
  const outputChannel = getExtensionOutputChannel();

  context.subscriptions.push(outputChannel);

  const applyFeatureConfiguration = (): void => {
    const isBringToChatEnabled = isFeatureEnabled(BRING_TO_CHAT_ENABLED_KEY);
    const isShellToolsEnabled = isFeatureEnabled(SHELL_TOOLS_ENABLED_KEY);

    if (isBringToChatEnabled && !bringToChatRegistration) {
      bringToChatRegistration = vscode.Disposable.from(
        registerReviewParticipant(),
        vscode.commands.registerCommand('agent-helper-kit.reviewCommentToChat', reviewCommentToChat),
      );
      context.subscriptions.push(bringToChatRegistration);
    }
    else if (!isBringToChatEnabled && bringToChatRegistration) {
      disposeAndRemoveSubscription(bringToChatRegistration, context.subscriptions);
      bringToChatRegistration = undefined;
    }

    if (isShellToolsEnabled && !shellToolsRegistration) {
      shellToolsRegistration = registerShellTools(context.extensionUri);
      context.subscriptions.push(shellToolsRegistration);
    }
    else if (!isShellToolsEnabled && shellToolsRegistration) {
      disposeAndRemoveSubscription(shellToolsRegistration, context.subscriptions);
      shellToolsRegistration = undefined;
    }
  };

  applyFeatureConfiguration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${BRING_TO_CHAT_ENABLED_KEY}`)
        || event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${SHELL_TOOLS_ENABLED_KEY}`)
      ) {
        applyFeatureConfiguration();
      }
    }),
  );
}
