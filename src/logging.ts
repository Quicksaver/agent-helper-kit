import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Agent Helper Kit';

type LogLevel = 'ERROR' | 'INFO' | 'WARN';

let outputChannel: undefined | vscode.LogOutputChannel;

function getLogLines(message: string): string[] {
  return message
    .replace(/(?:\r?\n)+$/u, '')
    .split(/\r?\n/u);
}

function writeLogLine(channel: vscode.LogOutputChannel, level: LogLevel, line: string): void {
  if (typeof channel.appendLine === 'function' && typeof channel.info !== 'function') {
    channel.appendLine(line);
    return;
  }

  if (level === 'ERROR') {
    channel.error(line);
    return;
  }

  if (level === 'WARN') {
    channel.warn(line);
    return;
  }

  channel.info(line);
}

export function getExtensionOutputChannel(): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  }

  return outputChannel;
}

export function logToExtensionChannel(level: LogLevel, message: string): void {
  const channel = getExtensionOutputChannel();

  for (const line of getLogLines(message)) {
    writeLogLine(channel, level, line);
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
