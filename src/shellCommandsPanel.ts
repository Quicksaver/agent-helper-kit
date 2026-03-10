import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import ansiRegex from 'ansi-regex';

import {
  type ShellCommandDetails,
  type ShellCommandListItem,
  type ShellRuntime,
} from '@/shellRuntime';

const SHELL_COMMANDS_VIEW_ID = 'agent-helper-kit.shellCommandsView';
const SHELL_COMMANDS_PANEL_CONTAINER_ID = 'agent-helper-kit-shellCommandsPanel';
const RUNNING_POLL_MS = 1000;

const ANSI_STANDARD_COLORS = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
];

const ANSI_BRIGHT_COLORS = [
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];

type ShellCommandTreeItem = {
  commandRun: {
    id: string;
  };
};

type WebviewMessage = {
  commandId?: string;
  type: 'clear' | 'copy' | 'delete' | 'kill' | 'select';
};

type ExtensionWebviewMessage = {
  commandId: string;
  isRunning: boolean;
  outputHtml: string;
  type: 'replaceOutput';
};

interface AnsiRenderState {
  backgroundColor?: string;
  bold: boolean;
  dim: boolean;
  foregroundColor?: string;
  inverse: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function formatTimestamp(value: null | string): string {
  if (!value) {
    return '—';
  }

  const asDate = new Date(value);

  if (Number.isNaN(asDate.getTime())) {
    return value;
  }

  return asDate.toLocaleString();
}

function getCommandListLabel(commandText: string): string {
  const normalized = commandText.replaceAll(/\s+/gu, ' ').trim();

  if (normalized.length === 0) {
    return '(empty command)';
  }

  return normalized;
}

function getShellLabel(shellPath: string): string {
  const normalizedPath = shellPath.trim();

  if (normalizedPath.length === 0) {
    return 'unknown';
  }

  const shellName = normalizedPath
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.(bat|cmd|exe)$/iu, '')
    .trim()
    .toLowerCase();

  return shellName && shellName.length > 0 ? shellName : normalizedPath;
}

function getCommandStatusClass(command: ShellCommandListItem): string {
  if (command.isRunning) {
    return 'running';
  }

  if (command.killedByUser) {
    return 'killed';
  }

  if (command.exitCode === 0) {
    return 'success';
  }

  return 'error';
}

function getCommandStatusIcon(command: ShellCommandListItem): string {
  const statusClass = getCommandStatusClass(command);

  if (statusClass === 'running') {
    return '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M7.99909 3C10.7605 3 12.9991 5.23858 12.9991 8C12.9991 10.7614 10.7605 13 7.99909 13C5.39117 13 3.2491 11.003 3.0195 8.45512C2.99471 8.1801 2.75167 7.97723 2.47664 8.00202C2.20161 8.0268 1.99875 8.26985 2.02353 8.54488C2.29916 11.6035 4.86898 14 7.99909 14C11.3128 14 13.9991 11.3137 13.9991 8C13.9991 4.68629 11.3128 2 7.99909 2C6.20656 2 4.59815 2.78613 3.49909 4.03138V2.5C3.49909 2.22386 3.27524 2 2.99909 2C2.72295 2 2.49909 2.22386 2.49909 2.5V5.5C2.49909 5.77614 2.72295 6 2.99909 6H3.08812C3.09498 6.00014 3.10184 6.00014 3.10868 6H5.99909C6.27524 6 6.49909 5.77614 6.49909 5.5C6.49909 5.22386 6.27524 5 5.99909 5H3.99863C4.91128 3.78495 6.36382 3 7.99909 3ZM7.99909 5.5C7.99909 5.22386 7.77524 5 7.49909 5C7.22295 5 6.99909 5.22386 6.99909 5.5V8.5C6.99909 8.77614 7.22295 9 7.49909 9H9.49909C9.77524 9 9.99909 8.77614 9.99909 8.5C9.99909 8.22386 9.77524 8 9.49909 8H7.99909V5.5Z"/></svg>';
  }

  if (statusClass === 'success') {
    return '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"/></svg>';
  }

  return '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 1C4.14 1 1 4.14 1 8C1 11.86 4.14 15 8 15C11.86 15 15 11.86 15 8C15 4.14 11.86 1 8 1ZM8 14C4.691 14 2 11.309 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 11.309 11.309 14 8 14ZM10.854 5.854L8.708 8L10.854 10.146C11.049 10.341 11.049 10.658 10.854 10.853C10.756 10.951 10.628 10.999 10.5 10.999C10.372 10.999 10.244 10.95 10.146 10.853L8 8.707L5.854 10.853C5.756 10.951 5.628 10.999 5.5 10.999C5.372 10.999 5.244 10.95 5.146 10.853C4.951 10.658 4.951 10.341 5.146 10.146L7.292 8L5.146 5.854C4.951 5.659 4.951 5.342 5.146 5.147C5.341 4.952 5.658 4.952 5.853 5.147L7.999 7.293L10.145 5.147C10.34 4.952 10.657 4.952 10.852 5.147C11.047 5.342 11.047 5.659 10.852 5.854H10.854Z"/></svg>';
}

function buildCommandTooltip(command: ShellCommandListItem): string {
  const lines = [
    `Id: ${command.id}`,
    `Shell: ${command.shell}`,
    `Started: ${formatTimestamp(command.startedAt)}`,
  ];

  if (!command.isRunning) {
    lines.push(`Completed: ${formatTimestamp(command.completedAt)}`);
    lines.push(`Exit Code: ${String(command.exitCode)}`);
  }

  if (command.signal) {
    lines.push(`Termination Signal: ${command.signal}`);
  }

  return lines.join('\n');
}

function getAnsiColorFromCode(code: number, isBackground: boolean): string | undefined {
  if (code >= 30 && code <= 37) {
    return ANSI_STANDARD_COLORS[code - 30];
  }

  if (code >= 90 && code <= 97) {
    return ANSI_BRIGHT_COLORS[code - 90];
  }

  if (isBackground && code >= 40 && code <= 47) {
    return ANSI_STANDARD_COLORS[code - 40];
  }

  if (isBackground && code >= 100 && code <= 107) {
    return ANSI_BRIGHT_COLORS[code - 100];
  }

  return undefined;
}

function toAnsi256Rgb(code: number): string {
  if (code < 16) {
    const colors = [
      ...ANSI_STANDARD_COLORS,
      ...ANSI_BRIGHT_COLORS,
    ];

    return colors[code] ?? '#ffffff';
  }

  if (code >= 16 && code <= 231) {
    const colorOffset = code - 16;
    const red = Math.floor(colorOffset / 36);
    const green = Math.floor((colorOffset % 36) / 6);
    const blue = colorOffset % 6;
    const rgbComponent = (component: number) => (component === 0 ? 0 : (component * 40) + 55);

    return `rgb(${String(rgbComponent(red))}, ${String(rgbComponent(green))}, ${String(rgbComponent(blue))})`;
  }

  const gray = 8 + ((code - 232) * 10);
  return `rgb(${String(gray)}, ${String(gray)}, ${String(gray)})`;
}

function applyAnsiCodes(state: AnsiRenderState, codes: number[]): void {
  const normalizedCodes = codes.length === 0 ? [ 0 ] : codes;

  for (let index = 0; index < normalizedCodes.length; index += 1) {
    const code = normalizedCodes[index] ?? 0;

    if (code === 0) {
      state.backgroundColor = undefined;
      state.bold = false;
      state.dim = false;
      state.foregroundColor = undefined;
      state.inverse = false;
      state.italic = false;
      state.strikethrough = false;
      state.underline = false;
      continue;
    }

    if (code === 1) {
      state.bold = true;
      continue;
    }

    if (code === 2) {
      state.dim = true;
      continue;
    }

    if (code === 3) {
      state.italic = true;
      continue;
    }

    if (code === 4) {
      state.underline = true;
      continue;
    }

    if (code === 7) {
      state.inverse = true;
      continue;
    }

    if (code === 9) {
      state.strikethrough = true;
      continue;
    }

    if (code === 22) {
      state.bold = false;
      state.dim = false;
      continue;
    }

    if (code === 23) {
      state.italic = false;
      continue;
    }

    if (code === 24) {
      state.underline = false;
      continue;
    }

    if (code === 27) {
      state.inverse = false;
      continue;
    }

    if (code === 29) {
      state.strikethrough = false;
      continue;
    }

    if (code === 39) {
      state.foregroundColor = undefined;
      continue;
    }

    if (code === 49) {
      state.backgroundColor = undefined;
      continue;
    }

    if (code === 38 || code === 48) {
      const colorType = normalizedCodes[index + 1];

      if (colorType === 5) {
        const paletteIndex = normalizedCodes[index + 2];

        if (typeof paletteIndex === 'number' && paletteIndex >= 0 && paletteIndex <= 255) {
          const resolvedColor = toAnsi256Rgb(paletteIndex);

          if (code === 38) {
            state.foregroundColor = resolvedColor;
          }
          else {
            state.backgroundColor = resolvedColor;
          }
        }

        index += 2;
        continue;
      }

      if (colorType === 2) {
        const red = normalizedCodes[index + 2];
        const green = normalizedCodes[index + 3];
        const blue = normalizedCodes[index + 4];

        if (
          typeof red === 'number'
          && typeof green === 'number'
          && typeof blue === 'number'
        ) {
          const resolvedColor = `rgb(${String(red)}, ${String(green)}, ${String(blue)})`;

          if (code === 38) {
            state.foregroundColor = resolvedColor;
          }
          else {
            state.backgroundColor = resolvedColor;
          }
        }

        index += 4;
      }

      continue;
    }

    const foreground = getAnsiColorFromCode(code, false);

    if (foreground) {
      state.foregroundColor = foreground;
      continue;
    }

    const background = getAnsiColorFromCode(code, true);

    if (background) {
      state.backgroundColor = background;
    }
  }
}

function getAnsiStateStyle(state: AnsiRenderState): string {
  let { foregroundColor } = state;
  let { backgroundColor } = state;

  if (state.inverse) {
    const originalForeground = foregroundColor;
    foregroundColor = backgroundColor;
    backgroundColor = originalForeground;
  }

  const classes: string[] = [];

  const foregroundIndex = foregroundColor
    ? [
      ...ANSI_STANDARD_COLORS,
      ...ANSI_BRIGHT_COLORS,
    ].indexOf(foregroundColor)
    : -1;

  if (foregroundIndex >= 0) {
    classes.push(`ansi-fg-${String(foregroundIndex)}`);
  }

  const backgroundIndex = backgroundColor
    ? [
      ...ANSI_STANDARD_COLORS,
      ...ANSI_BRIGHT_COLORS,
    ].indexOf(backgroundColor)
    : -1;

  if (backgroundIndex >= 0) {
    classes.push(`ansi-bg-${String(backgroundIndex)}`);
  }

  if (state.bold) {
    classes.push('ansi-bold');
  }

  if (state.dim) {
    classes.push('ansi-dim');
  }

  if (state.italic) {
    classes.push('ansi-italic');
  }

  if (state.underline) {
    classes.push('ansi-underline');
  }

  if (state.strikethrough) {
    classes.push('ansi-strikethrough');
  }

  if (classes.length > 0) {
    return classes.join(' ');
  }

  const declarations: string[] = [];

  if (foregroundColor) {
    declarations.push(`color: ${foregroundColor}`);
  }

  if (backgroundColor) {
    declarations.push(`background-color: ${backgroundColor}`);
  }

  if (state.bold) {
    declarations.push('font-weight: 700');
  }

  if (state.dim) {
    declarations.push('opacity: 0.7');
  }

  if (state.italic) {
    declarations.push('font-style: italic');
  }

  if (state.underline) {
    declarations.push('text-decoration: underline');
  }

  if (state.strikethrough) {
    declarations.push('text-decoration: line-through');
  }

  return declarations.join('; ');
}

function convertAnsiToHtml(value: string): string {
  const sequencePattern = ansiRegex();
  const state: AnsiRenderState = {
    bold: false,
    dim: false,
    inverse: false,
    italic: false,
    strikethrough: false,
    underline: false,
  };

  let html = '';
  let cursor = 0;
  let match: null | RegExpExecArray = sequencePattern.exec(value);

  while (match !== null) {
    const segment = value.slice(cursor, match.index);
    const style = getAnsiStateStyle(state);

    if (segment.length > 0) {
      const escapedSegment = escapeHtml(segment);
      html += style.length === 0
        ? escapedSegment
        : `<span class="${style}">${escapedSegment}</span>`;
    }

    const sequence = match[0];
    let rawCodes: string | undefined;

    if (sequence.endsWith('m') && sequence.startsWith('\u001B[')) {
      rawCodes = sequence.slice(2, -1);
    }
    else if (sequence.endsWith('m') && sequence.startsWith('\u009B')) {
      rawCodes = sequence.slice(1, -1);
    }

    if (typeof rawCodes === 'string') {
      const codes = rawCodes.length === 0
        ? [ 0 ]
        : rawCodes
          .split(';')
          .map(part => Number.parseInt(part, 10))
          .filter(code => Number.isFinite(code));

      applyAnsiCodes(state, codes);
    }

    cursor = match.index + sequence.length;
    match = sequencePattern.exec(value);
  }

  if (cursor < value.length) {
    const segment = value.slice(cursor);
    const style = getAnsiStateStyle(state);
    const escapedSegment = escapeHtml(segment);

    html += style.length === 0
      ? escapedSegment
      : `<span class="${style}">${escapedSegment}</span>`;
  }

  return html;
}

function resolveCommandId(target: unknown): string | undefined {
  if (typeof target === 'string' && target.length > 0) {
    return target;
  }

  if (
    typeof target === 'object'
    && target !== null
    && 'commandRun' in target
  ) {
    const candidate = target as ShellCommandTreeItem;

    if (typeof candidate.commandRun.id === 'string' && candidate.commandRun.id.length > 0) {
      return candidate.commandRun.id;
    }
  }

  return undefined;
}

function buildDetailsMarkup(details: ShellCommandDetails | undefined): string {
  if (!details) {
    return '<div class="details-empty"></div><div id="output-block" class="output-block"></div>';
  }

  return `
    <div class="command-header">
      <pre class="command-block">${escapeHtml(details.command)}</pre>
      <div class="command-actions">
        <button
          class="icon-action"
          data-action="copy"
          data-id="${escapeHtml(details.id)}"
          title="Copy command"
          aria-label="Copy command"
        >⧉</button>
      </div>
    </div>
    <div
      id="output-block"
      class="output-block"
      data-command-id="${escapeHtml(details.id)}"
      data-command-running="${details.isRunning ? 'true' : 'false'}"
    >${convertAnsiToHtml(details.output)}</div>
  `;
}

function getWebviewHtml(
  webview: vscode.Webview,
  commands: ShellCommandListItem[],
  selectedCommandId: string | undefined,
  selectedDetails: ShellCommandDetails | undefined,
): string {
  const scriptNonce = randomBytes(16).toString('hex');
  const styleNonce = randomBytes(16).toString('hex');
  const commandItems = commands.map(command => {
    const commandPreview = getCommandListLabel(command.command);
    const shellLabel = getShellLabel(command.shell);
    const selectedClass = command.id === selectedCommandId ? 'selected' : '';
    const rowAction = command.isRunning ? 'kill' : 'delete';
    const rowActionIcon = command.isRunning ? '■' : '✕';
    const rowActionTitle = command.isRunning ? 'Kill' : 'Delete';
    const tooltip = buildCommandTooltip(command);

    return `
      <div
        class="command-item ${selectedClass}"
        data-action="select"
        data-id="${escapeHtml(command.id)}"
        data-filter-command="${escapeHtml(command.command.toLowerCase())}"
        data-filter-id="${escapeHtml(command.id.toLowerCase())}"
        data-filter-shell="${escapeHtml(shellLabel)}"
        title="${escapeHtml(tooltip)}"
        role="button"
        tabindex="0"
      >
        <span class="status-indicator ${getCommandStatusClass(command)}">${getCommandStatusIcon(command)}</span>
        <span class="command-preview">${escapeHtml(commandPreview)}</span>
        <span class="command-shell">${escapeHtml(shellLabel)}</span>
        <button
          class="icon-action row-action"
          data-action="${rowAction}"
          data-id="${escapeHtml(command.id)}"
          title="${rowActionTitle}"
          aria-label="${rowActionTitle}"
        >${rowActionIcon}</button>
      </div>
    `;
  }).join('');

  const detailsMarkup = buildDetailsMarkup(selectedDetails);

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${styleNonce}' 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style nonce="${styleNonce}">
      :root { color-scheme: light dark; }
      html, body { height: 100%; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        user-select: none;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 1px var(--sidebar-width, 340px);
        height: 100%;
      }
      .sidebar {
        background: var(--vscode-sideBar-background);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .sidebar-toolbar {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 6px;
        min-height: 26px;
        padding: 4px 6px;
      }
      .filter-input {
        min-width: 0;
        flex: 1 1 auto;
        border: none;
        background: transparent;
        color: var(--vscode-foreground);
        padding: 0;
        user-select: text;
      }
      .filter-input:focus {
        outline: none;
      }
      .command-list {
        overflow: auto;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .command-item {
        outline: none;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 8px;
        cursor: pointer;
        position: relative;
      }
      .command-item:hover { background: var(--vscode-list-hoverBackground); }
      .command-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }
      .status-indicator {
        flex: 0 0 auto;
        width: 16px;
        text-align: center;
        font-size: 12px;
        line-height: 1;
      }
      .status-indicator.running { color: var(--vscode-terminal-ansiYellow); }
      .status-indicator.success { color: var(--vscode-terminal-ansiGreen); }
      .status-indicator.error { color: var(--vscode-terminal-ansiRed); }
      .status-indicator.killed { color: var(--vscode-terminal-ansiRed); }
      .command-preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
      }
      .command-shell {
        margin-left: auto;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        white-space: nowrap;
      }
      .icon-action {
        border: none;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        padding: 0 4px;
        font-size: 13px;
        line-height: 1;
        opacity: 0.9;
      }
      .icon-action:hover {
        color: var(--vscode-foreground);
        opacity: 1;
      }
      .row-action {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        opacity: 0;
        pointer-events: none;
        background: var(--vscode-sideBar-background);
      }
      .command-item:hover .row-action,
      .command-item:focus-within .row-action {
        opacity: 1;
        pointer-events: auto;
      }
      .resizer {
        cursor: col-resize;
        background: var(--vscode-editorWidget-border);
        position: relative;
      }
      .resizer::before {
        content: '';
        position: absolute;
        top: 0;
        right: -3px;
        bottom: 0;
        left: -3px;
      }
      .main-pane {
        min-height: 0;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .command-header {
        display: flex;
        align-items: stretch;
        max-height: 40%;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
      }
      .command-block {
        margin: 0;
        padding: 8px;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
        flex: 1 1 auto;
      }
      .command-actions {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        padding: 6px;
        border-left: 1px solid var(--vscode-editorWidget-border);
      }
      .output-block {
        padding: 8px;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        user-select: text;
      }
      .output-block .ansi-fg-0 { color: #000000; }
      .output-block .ansi-fg-1 { color: #cd3131; }
      .output-block .ansi-fg-2 { color: #0dbc79; }
      .output-block .ansi-fg-3 { color: #e5e510; }
      .output-block .ansi-fg-4 { color: #2472c8; }
      .output-block .ansi-fg-5 { color: #bc3fbc; }
      .output-block .ansi-fg-6 { color: #11a8cd; }
      .output-block .ansi-fg-7 { color: #e5e5e5; }
      .output-block .ansi-fg-8 { color: #666666; }
      .output-block .ansi-fg-9 { color: #f14c4c; }
      .output-block .ansi-fg-10 { color: #23d18b; }
      .output-block .ansi-fg-11 { color: #f5f543; }
      .output-block .ansi-fg-12 { color: #3b8eea; }
      .output-block .ansi-fg-13 { color: #d670d6; }
      .output-block .ansi-fg-14 { color: #29b8db; }
      .output-block .ansi-fg-15 { color: #ffffff; }
      .output-block .ansi-bg-0 { background-color: #000000; }
      .output-block .ansi-bg-1 { background-color: #cd3131; }
      .output-block .ansi-bg-2 { background-color: #0dbc79; }
      .output-block .ansi-bg-3 { background-color: #e5e510; }
      .output-block .ansi-bg-4 { background-color: #2472c8; }
      .output-block .ansi-bg-5 { background-color: #bc3fbc; }
      .output-block .ansi-bg-6 { background-color: #11a8cd; }
      .output-block .ansi-bg-7 { background-color: #e5e5e5; }
      .output-block .ansi-bg-8 { background-color: #666666; }
      .output-block .ansi-bg-9 { background-color: #f14c4c; }
      .output-block .ansi-bg-10 { background-color: #23d18b; }
      .output-block .ansi-bg-11 { background-color: #f5f543; }
      .output-block .ansi-bg-12 { background-color: #3b8eea; }
      .output-block .ansi-bg-13 { background-color: #d670d6; }
      .output-block .ansi-bg-14 { background-color: #29b8db; }
      .output-block .ansi-bg-15 { background-color: #ffffff; }
      .output-block .ansi-bold { font-weight: 700; }
      .output-block .ansi-dim { opacity: 0.7; }
      .output-block .ansi-italic { font-style: italic; }
      .output-block .ansi-underline { text-decoration: underline; }
      .output-block .ansi-strikethrough { text-decoration: line-through; }
    </style>
  </head>
  <body>
    <div class="layout" id="layout">
      <main class="main-pane">${detailsMarkup}</main>
      <div id="resizer" class="resizer" aria-hidden="true"></div>
      <aside class="sidebar">
        <div class="sidebar-toolbar">
          <input
            id="command-filter"
            class="filter-input"
            type="text"
            placeholder="Filter"
            aria-label="Filter commands"
            autocomplete="off"
          />
          <button class="icon-action" data-action="clear" title="Clear Finished" aria-label="Clear Finished">✕</button>
        </div>
        <div class="command-list">${commandItems}</div>
      </aside>
    </div>
    <script nonce="${scriptNonce}">
      const vscodeApi = acquireVsCodeApi();
      const root = document.documentElement;
      const layout = document.getElementById('layout');
      const resizer = document.getElementById('resizer');
      const filterInput = document.getElementById('command-filter');
      const getOutputBlock = () => document.getElementById('output-block');
      const outputEndThreshold = 4;
      const previousState = vscodeApi.getState() || {};
      let currentState = { ...previousState };

      const persistState = updates => {
        currentState = {
          ...currentState,
          ...updates,
        };
        vscodeApi.setState(currentState);
      };

      const getSidebarWidth = () => {
        const width = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);

        return Number.isFinite(width) ? width : 340;
      };

      const isNearOutputEnd = element => (element.scrollTop + element.clientHeight) >= (element.scrollHeight - outputEndThreshold);

      const syncOutputScrollState = () => {
        const outputBlock = getOutputBlock();

        if (!(outputBlock instanceof HTMLElement)) {
          return;
        }

        persistState({
          outputScrollState: {
            atBottom: isNearOutputEnd(outputBlock),
            commandId: outputBlock.dataset.commandId ?? '',
            scrollTop: outputBlock.scrollTop,
          },
        });
      };

      const restoreOutputScroll = () => {
        const outputBlock = getOutputBlock();

        if (!(outputBlock instanceof HTMLElement)) {
          return;
        }

        const savedOutputScrollState = currentState.outputScrollState;
        const commandId = outputBlock.dataset.commandId ?? '';
        const shouldScrollToEnd = !savedOutputScrollState
          || typeof savedOutputScrollState !== 'object'
          || savedOutputScrollState === null
          || savedOutputScrollState.commandId !== commandId
          || savedOutputScrollState.atBottom === true;

        if (shouldScrollToEnd) {
          outputBlock.scrollTop = outputBlock.scrollHeight;
        }
        else if (typeof savedOutputScrollState.scrollTop === 'number') {
          outputBlock.scrollTop = savedOutputScrollState.scrollTop;
        }

        syncOutputScrollState();
      };

      const replaceOutput = message => {
        const outputBlock = getOutputBlock();

        if (!(outputBlock instanceof HTMLElement)) {
          return;
        }

        if ((outputBlock.dataset.commandId ?? '') !== message.commandId) {
          return;
        }

        syncOutputScrollState();
        outputBlock.innerHTML = message.outputHtml;
        outputBlock.dataset.commandRunning = message.isRunning ? 'true' : 'false';
        restoreOutputScroll();
      };

      if (typeof previousState.sidebarWidth === 'number') {
        root.style.setProperty('--sidebar-width', String(previousState.sidebarWidth) + 'px');
      }

      const normalizeFilterValue = value => value.trim().toLowerCase();

      const applyFilter = value => {
        const normalized = normalizeFilterValue(value);
        const rows = document.querySelectorAll('.command-item');

        for (const row of rows) {
          if (!(row instanceof HTMLElement)) {
            continue;
          }

          if (normalized.length < 1) {
            row.style.display = '';
            continue;
          }

          const commandText = row.getAttribute('data-filter-command') ?? '';
          const idText = row.getAttribute('data-filter-id') ?? '';
          const shellText = row.getAttribute('data-filter-shell') ?? '';
          const matches = commandText.includes(normalized) || idText.includes(normalized) || shellText.includes(normalized);

          row.style.display = matches ? '' : 'none';
        }
      };

      if (filterInput instanceof HTMLInputElement) {
        const initialFilter = typeof previousState.filterText === 'string' ? previousState.filterText : '';
        filterInput.value = initialFilter;
        applyFilter(initialFilter);

        filterInput.addEventListener('input', () => {
          const filterText = filterInput.value;

          applyFilter(filterText);
          persistState({
            filterText,
            sidebarWidth: getSidebarWidth(),
          });
        });

        filterInput.addEventListener('keydown', event => {
          if (event.key !== 'Escape') {
            return;
          }

          event.preventDefault();

          if (filterInput.value.length === 0) {
            return;
          }

          filterInput.value = '';
          applyFilter('');
          persistState({
            filterText: '',
            sidebarWidth: getSidebarWidth(),
          });
        });
      }

      const outputBlock = getOutputBlock();

      if (outputBlock instanceof HTMLElement) {
        outputBlock.addEventListener('scroll', () => {
          syncOutputScrollState();
        });

        requestAnimationFrame(() => {
          restoreOutputScroll();
        });
      }

      window.addEventListener('message', event => {
        const message = event.data;

        if (!message || typeof message !== 'object') {
          return;
        }

        if (message.type === 'replaceOutput') {
          replaceOutput(message);
        }
      });

      let isResizing = false;

      resizer?.addEventListener('mousedown', event => {
        event.preventDefault();
        isResizing = true;
      });

      window.addEventListener('mouseup', () => {
        if (!isResizing) {
          return;
        }

        isResizing = false;

        const width = getSidebarWidth();

        if (Number.isFinite(width)) {
          persistState({
            filterText: filterInput instanceof HTMLInputElement ? filterInput.value : '',
            sidebarWidth: width,
          });
        }
      });

      window.addEventListener('mousemove', event => {
        if (!isResizing || !layout) {
          return;
        }

        const bounds = layout.getBoundingClientRect();
        const nextWidth = Math.min(620, Math.max(180, bounds.right - event.clientX));
        root.style.setProperty('--sidebar-width', String(nextWidth) + 'px');
      });

      document.addEventListener('click', event => {
        const target = event.target;

        if (!(target instanceof Element)) {
          return;
        }

        const actionable = target.closest('[data-action]');

        if (!(actionable instanceof Element)) {
          return;
        }

        const action = actionable.getAttribute('data-action');

        if (!action) {
          return;
        }

        const commandId = actionable.getAttribute('data-id') ?? undefined;

        vscodeApi.postMessage({
          commandId,
          type: action,
        });
      });

      document.addEventListener('keydown', event => {
        const target = event.target;

        if (!(target instanceof HTMLElement)) {
          return;
        }

        if (!target.classList.contains('command-item')) {
          return;
        }

        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }

        event.preventDefault();

        const commandId = target.getAttribute('data-id') ?? undefined;

        vscodeApi.postMessage({
          commandId,
          type: 'select',
        });
      });

      const selectOutputContents = () => {
        if (!(outputBlock instanceof HTMLElement)) {
          return;
        }

        const selection = window.getSelection();

        if (!selection) {
          return;
        }

        const range = document.createRange();
        range.selectNodeContents(outputBlock);
        selection.removeAllRanges();
        selection.addRange(range);
      };

      window.addEventListener('keydown', event => {
        const isSelectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';

        if (!isSelectAll) {
          return;
        }

        if (filterInput instanceof HTMLInputElement && document.activeElement === filterInput) {
          event.preventDefault();
          event.stopPropagation();
          filterInput.select();
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        selectOutputContents();
      }, true);
    </script>
  </body>
</html>
  `;
}

class ShellCommandsPanelProvider implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly disposeRuntimeListener: () => void;
  private renderedSelectedCommandId: string | undefined;
  private renderedSelectedOutputLength = 0;
  private renderRequestId = 0;
  private runningPoller: NodeJS.Timeout | undefined;
  private selectedCommandId: string | undefined;
  private view: undefined | vscode.WebviewView;

  constructor(private readonly runtime: ShellRuntime) {
    this.disposeRuntimeListener = this.runtime.onDidChangeCommands(() => {
      void this.refresh();
    });
  }

  dispose(): void {
    this.disposeRuntimeListener();
    this.stopPolling();
    this.view = undefined;
  }

  getSelectedCommandId(): string | undefined {
    return this.selectedCommandId;
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const { view } = this;

    const requestId = ++this.renderRequestId;
    const commands = this.runtime.listCommands();

    if (!this.selectedCommandId || !commands.some(command => command.id === this.selectedCommandId)) {
      this.selectedCommandId = commands[0]?.id;
    }

    let selectedDetails: ShellCommandDetails | undefined;

    if (this.selectedCommandId) {
      try {
        selectedDetails = await this.runtime.getCommandDetails(this.selectedCommandId);
      }
      catch {
        selectedDetails = undefined;
      }
    }

    if (requestId !== this.renderRequestId || view !== this.view) {
      return;
    }

    view.webview.html = getWebviewHtml(
      view.webview,
      commands,
      this.selectedCommandId,
      selectedDetails,
    );

    this.renderedSelectedCommandId = selectedDetails?.id;
    this.renderedSelectedOutputLength = selectedDetails?.output.length ?? 0;

    this.updatePolling(selectedDetails);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.onDidDispose(() => {
      this.stopPolling();
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    await this.refresh();
  }

  async reveal(commandId?: string): Promise<void> {
    if (commandId) {
      this.selectedCommandId = commandId;
    }

    await vscode.commands.executeCommand(`workbench.view.extension.${SHELL_COMMANDS_PANEL_CONTAINER_ID}`);
    await this.refresh();
  }

  setSelectedCommandId(commandId: string | undefined): void {
    this.selectedCommandId = commandId;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'select' && message.commandId) {
      this.selectedCommandId = message.commandId;
      await this.refresh();
      return;
    }

    if (message.type === 'copy' && message.commandId) {
      const details = await this.tryGetCommandDetails(message.commandId);

      if (!details) {
        return;
      }

      await vscode.env.clipboard.writeText(details.command);
      return;
    }

    if (message.type === 'kill' && message.commandId) {
      this.runtime.killBackgroundCommand(message.commandId);
      await this.refresh();
      return;
    }

    if (message.type === 'delete' && message.commandId) {
      this.runtime.deleteCompletedCommand(message.commandId);

      if (this.selectedCommandId === message.commandId) {
        this.selectedCommandId = undefined;
      }

      await this.refresh();
      return;
    }

    if (message.type === 'clear') {
      this.runtime.clearCompletedCommands();

      if (this.selectedCommandId) {
        const selectedStillExists = this.runtime.listCommands().some(command => command.id === this.selectedCommandId);

        if (!selectedStillExists) {
          this.selectedCommandId = undefined;
        }
      }

      await this.refresh();
    }
  }

  private async refreshRunningCommandOutput(): Promise<void> {
    const { view } = this;
    const { selectedCommandId } = this;

    if (!view || !selectedCommandId) {
      this.stopPolling();
      return;
    }

    const details = await this.tryGetCommandDetails(selectedCommandId);

    if (!details) {
      await this.refresh();
      return;
    }

    if (selectedCommandId !== this.selectedCommandId || view !== this.view) {
      return;
    }

    if (!details.isRunning) {
      await this.refresh();
      return;
    }

    if (
      this.renderedSelectedCommandId !== details.id
      || this.renderedSelectedOutputLength === details.output.length
    ) {
      return;
    }

    const message: ExtensionWebviewMessage = {
      commandId: details.id,
      isRunning: details.isRunning,
      outputHtml: convertAnsiToHtml(details.output),
      type: 'replaceOutput',
    };

    this.renderedSelectedCommandId = details.id;
    this.renderedSelectedOutputLength = details.output.length;
    await view.webview.postMessage(message);
  }

  private stopPolling(): void {
    if (!this.runningPoller) {
      return;
    }

    clearInterval(this.runningPoller);
    this.runningPoller = undefined;
  }

  private async tryGetCommandDetails(commandId: string): Promise<ShellCommandDetails | undefined> {
    try {
      return await this.runtime.getCommandDetails(commandId);
    }
    catch {
      return undefined;
    }
  }

  private updatePolling(details: ShellCommandDetails | undefined): void {
    if (!this.selectedCommandId || !details?.isRunning) {
      this.stopPolling();
      return;
    }

    if (this.runningPoller) {
      return;
    }

    this.runningPoller = setInterval(() => {
      void this.refreshRunningCommandOutput();
    }, RUNNING_POLL_MS);
  }
}

export function registerShellCommandsPanel(getRuntime: () => ShellRuntime): vscode.Disposable {
  const runtime = getRuntime();
  const provider = new ShellCommandsPanelProvider(runtime);
  const webviewViewRegistration = vscode.window.registerWebviewViewProvider(
    SHELL_COMMANDS_VIEW_ID,
    provider,
  );

  const openCommand = vscode.commands.registerCommand(
    'agent-helper-kit.shellCommands.openEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item);

      await provider.reveal(commandId);
    },
  );

  const killCommand = vscode.commands.registerCommand(
    'agent-helper-kit.shellCommands.killEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item) ?? provider.getSelectedCommandId();

      if (!commandId) {
        return;
      }

      runtime.killBackgroundCommand(commandId);
      provider.setSelectedCommandId(commandId);
      await provider.refresh();
    },
  );

  const deleteCommand = vscode.commands.registerCommand(
    'agent-helper-kit.shellCommands.deleteEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item) ?? provider.getSelectedCommandId();

      if (!commandId) {
        return;
      }

      const deleted = runtime.deleteCompletedCommand(commandId);

      if (!deleted) {
        return;
      }

      if (provider.getSelectedCommandId() === commandId) {
        provider.setSelectedCommandId(undefined);
      }

      await provider.refresh();
    },
  );

  const clearCommand = vscode.commands.registerCommand(
    'agent-helper-kit.shellCommands.clearFinished',
    async () => {
      const removedCount = runtime.clearCompletedCommands();

      if (removedCount === 0) {
        return;
      }

      const selectedCommandId = provider.getSelectedCommandId();

      if (selectedCommandId) {
        const selectedStillExists = runtime.listCommands().some(command => command.id === selectedCommandId);

        if (!selectedStillExists) {
          provider.setSelectedCommandId(undefined);
        }
      }

      await provider.refresh();
    },
  );

  return vscode.Disposable.from(
    provider,
    webviewViewRegistration,
    openCommand,
    killCommand,
    deleteCommand,
    clearCommand,
  );
}
