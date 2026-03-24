import * as vscode from 'vscode';

import { getExtensionOutputChannel, logError } from '@/logging';
import { EXTENSION_CONFIG_SECTION } from '@/reviewCommentConfig';
import { registerReviewParticipant, reviewCommentToChat } from '@/reviewComments';
import { registerShellTools } from '@/shellTools';
import {
  resetShellToolSecurityCaches,
  SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY,
  SHELL_TOOLS_AUTO_APPROVE_RULES_KEY,
  SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY,
} from '@/shellToolSecurity';

const BRING_TO_CHAT_ENABLED_KEY = 'bringToChat.enabled';
const SHELL_TOOLS_ENABLED_KEY = 'shellTools.enabled';

function isFeatureEnabled(key: string): boolean {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION).get(key, true);
}

async function resetAutoApproveWarningIfDisabled(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  const isAutoApproveEnabled = configuration.get(SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY);
  const warningAccepted = configuration.get(SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY);

  if (isAutoApproveEnabled !== true && warningAccepted === true) {
    await configuration.update(
      SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY,
      false,
      vscode.ConfigurationTarget.Global,
    );
  }
}

function queueAutoApproveWarningReset(): void {
  void resetAutoApproveWarningIfDisabled().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    logError(`Failed to reset shell auto-approve warning acceptance: ${message}`);
  });
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
  queueAutoApproveWarningReset();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${BRING_TO_CHAT_ENABLED_KEY}`)
        || event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${SHELL_TOOLS_ENABLED_KEY}`)
      ) {
        applyFeatureConfiguration();
      }

      if (
        event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${SHELL_TOOLS_AUTO_APPROVE_ENABLED_KEY}`)
        || event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${SHELL_TOOLS_AUTO_APPROVE_WARNING_ACCEPTED_KEY}`)
      ) {
        queueAutoApproveWarningReset();
      }

      if (event.affectsConfiguration(`${EXTENSION_CONFIG_SECTION}.${SHELL_TOOLS_AUTO_APPROVE_RULES_KEY}`)) {
        resetShellToolSecurityCaches();
      }
    }),
  );
}
