import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Agent Helper Kit';

let outputChannel: undefined | vscode.OutputChannel;

function getLogLines(message: string): string[] {
  return message
    .replace(/(?:\r?\n)+$/u, '')
    .split(/\r?\n/u);
}

function getTimestamp(): string {
  return new Date().toISOString();
}

export function getExtensionOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }

  return outputChannel;
}

export function logToExtensionChannel(level: 'ERROR' | 'INFO' | 'WARN', message: string): void {
  const channel = getExtensionOutputChannel();
  const prefix = `[${getTimestamp()}] [${level}] `;

  for (const line of getLogLines(message)) {
    channel.appendLine(`${prefix}${line}`);
  }
}

export function logError(message: string): void {
  logToExtensionChannel('ERROR', message);
}

export function logInfo(message: string): void {
  logToExtensionChannel('INFO', message);
}

export function logWarn(message: string): void {
  logToExtensionChannel('WARN', message);
}

export function resetExtensionOutputChannelForTest(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
