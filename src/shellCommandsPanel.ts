import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import ansiRegex from 'ansi-regex';

import {
  type TerminalCommandDetails,
  type TerminalCommandListItem,
  type TerminalRuntime,
} from '@/shellRuntime';

const SHELL_COMMANDS_VIEW_ID = 'custom-vscode.shellCommandsView';
const SHELL_COMMANDS_PANEL_CONTAINER_ID = 'custom-vscode-shellCommandsPanel';
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
  type: 'clear' | 'copy' | 'delete' | 'kill' | 'runInTerminal' | 'select';
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

function getCommandStatusClass(command: TerminalCommandListItem): string {
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

function buildCommandTooltip(command: TerminalCommandListItem): string {
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

function buildDetailsMarkup(details: TerminalCommandDetails | undefined): string {
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
        >📋</button>
        <button
          class="icon-action"
          data-action="runInTerminal"
          data-id="${escapeHtml(details.id)}"
          title="Run in terminal"
          aria-label="Run in terminal"
        >🖥</button>
      </div>
    </div>
    <div class="output-toolbar">
      <input
        id="output-find"
        class="output-find-input"
        type="text"
        placeholder="Find in output"
        aria-label="Find in output"
        autocomplete="off"
      />
      <button id="output-find-prev" class="icon-action" title="Previous match" aria-label="Previous match">↑</button>
      <button id="output-find-next" class="icon-action" title="Next match" aria-label="Next match">↓</button>
      <span id="output-find-status" class="output-find-status" aria-live="polite"></span>
    </div>
    <div id="output-block" class="output-block">${convertAnsiToHtml(details.output)}</div>
  `;
}

function getWebviewHtml(
  webview: vscode.Webview,
  commands: TerminalCommandListItem[],
  selectedCommandId: string | undefined,
  selectedDetails: TerminalCommandDetails | undefined,
): string {
  const scriptNonce = randomBytes(16).toString('hex');
  const styleNonce = randomBytes(16).toString('hex');
  const commandItems = commands.map(command => {
    const commandPreview = getCommandListLabel(command.command);
    const shellLabel = getShellLabel(command.shell);
    const selectedClass = command.id === selectedCommandId ? 'selected' : '';
    const rowAction = command.isRunning ? 'kill' : 'delete';
    const rowActionIcon = '✕';
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
        <span class="status-dot ${getCommandStatusClass(command)}"></span>
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
      }
      .layout {
        display: grid;
        grid-template-columns: var(--sidebar-width, 340px) 1px minmax(0, 1fr);
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
      }
      .command-item:hover { background: var(--vscode-list-hoverBackground); }
      .command-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: 0 0 auto;
      }
      .status-dot.running { background: var(--vscode-terminal-ansiYellow); }
      .status-dot.success { background: var(--vscode-terminal-ansiGreen); }
      .status-dot.error { background: var(--vscode-terminal-ansiRed); }
      .status-dot.killed { background: var(--vscode-terminal-ansiRed); }
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
        background: var(--vscode-sideBar-background);
      }
      .command-header {
        display: flex;
        align-items: stretch;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
      }
      .command-block {
        margin: 0;
        padding: 8px;
        background: var(--vscode-editorWidget-background);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 40%;
        overflow: auto;
        flex: 1 1 auto;
      }
      .command-actions {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        padding: 6px;
        background: var(--vscode-editorWidget-background);
        border-left: 1px solid var(--vscode-editorWidget-border);
      }
      .output-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
      }
      .output-find-input {
        min-width: 0;
        flex: 1 1 auto;
        border: none;
        background: transparent;
        color: var(--vscode-foreground);
        padding: 0;
      }
      .output-find-input:focus {
        outline: none;
      }
      .output-find-status {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        min-width: 64px;
        text-align: right;
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
      <div id="resizer" class="resizer" aria-hidden="true"></div>
      <main class="main-pane">${detailsMarkup}</main>
    </div>
    <script nonce="${scriptNonce}">
      const vscodeApi = acquireVsCodeApi();
      const root = document.documentElement;
      const layout = document.getElementById('layout');
      const resizer = document.getElementById('resizer');
      const filterInput = document.getElementById('command-filter');
      const outputBlock = document.getElementById('output-block');
      const outputFindInput = document.getElementById('output-find');
      const outputFindPrevious = document.getElementById('output-find-prev');
      const outputFindNext = document.getElementById('output-find-next');
      const outputFindStatus = document.getElementById('output-find-status');
      const previousState = vscodeApi.getState() || {};

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
          vscodeApi.setState({
            ...previousState,
            filterText,
            sidebarWidth: Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10),
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
          vscodeApi.setState({
            ...previousState,
            filterText: '',
            sidebarWidth: Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10),
          });
        });
      }

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

        const width = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);

        if (Number.isFinite(width)) {
          vscodeApi.setState({
            ...previousState,
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
        const nextWidth = Math.min(620, Math.max(180, event.clientX - bounds.left));
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

      const setFindStatus = message => {
        if (outputFindStatus instanceof HTMLElement) {
          outputFindStatus.textContent = message;
        }
      };

      const collapseSelectionToOutputEdge = backwards => {
        if (!(outputBlock instanceof HTMLElement)) {
          return;
        }

        const selection = window.getSelection();

        if (!selection) {
          return;
        }

        const range = document.createRange();
        range.selectNodeContents(outputBlock);
        range.collapse(backwards);
        selection.removeAllRanges();
        selection.addRange(range);
      };

      const selectionIsWithinOutput = () => {
        if (!(outputBlock instanceof HTMLElement)) {
          return false;
        }

        const selection = window.getSelection();

        if (!selection || !selection.anchorNode) {
          return false;
        }

        return outputBlock.contains(selection.anchorNode);
      };

      const findInOutput = backwards => {
        if (!(outputFindInput instanceof HTMLInputElement)) {
          return;
        }

        const term = outputFindInput.value.trim();

        if (term.length === 0) {
          setFindStatus('');
          return;
        }

        if (!selectionIsWithinOutput()) {
          collapseSelectionToOutputEdge(backwards);
        }

        let found = window.find(term, false, backwards, true, false, false, false);

        if (!found || !selectionIsWithinOutput()) {
          collapseSelectionToOutputEdge(backwards);
          found = window.find(term, false, backwards, true, false, false, false);
        }

        setFindStatus(found && selectionIsWithinOutput() ? '' : 'No matches');
      };

      outputFindInput?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') {
          return;
        }

        event.preventDefault();
        findInOutput(event.shiftKey);
      });

      outputFindPrevious?.addEventListener('click', event => {
        event.preventDefault();
        findInOutput(true);
      });

      outputFindNext?.addEventListener('click', event => {
        event.preventDefault();
        findInOutput(false);
      });

      window.addEventListener('keydown', event => {
        const isSelectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';

        if (!isSelectAll) {
          return;
        }

        if (filterInput instanceof HTMLInputElement && document.activeElement === filterInput) {
          event.preventDefault();
          filterInput.select();
          return;
        }

        event.preventDefault();
        selectOutputContents();
      });
    </script>
  </body>
</html>
  `;
}

class ShellCommandsPanelProvider implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly disposeRuntimeListener: () => void;
  private renderRequestId = 0;
  private runningPoller: NodeJS.Timeout | undefined;
  private selectedCommandId: string | undefined;
  private view: undefined | vscode.WebviewView;

  constructor(private readonly runtime: TerminalRuntime) {
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

    let selectedDetails: TerminalCommandDetails | undefined;

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

    if (message.type === 'runInTerminal' && message.commandId) {
      const details = await this.tryGetCommandDetails(message.commandId);

      if (!details) {
        return;
      }

      const terminal = vscode.window.createTerminal({
        name: `Shell Run (${getShellLabel(details.shell)})`,
        shellPath: details.shell,
      });

      terminal.show(true);
      terminal.sendText(details.command, true);
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

  private stopPolling(): void {
    if (!this.runningPoller) {
      return;
    }

    clearInterval(this.runningPoller);
    this.runningPoller = undefined;
  }

  private async tryGetCommandDetails(commandId: string): Promise<TerminalCommandDetails | undefined> {
    try {
      return await this.runtime.getCommandDetails(commandId);
    }
    catch {
      return undefined;
    }
  }

  private updatePolling(details: TerminalCommandDetails | undefined): void {
    if (!this.selectedCommandId || !details?.isRunning) {
      this.stopPolling();
      return;
    }

    if (this.runningPoller) {
      return;
    }

    this.runningPoller = setInterval(() => {
      void this.refresh();
    }, RUNNING_POLL_MS);
  }
}

export function registerShellCommandsPanel(getRuntime: () => TerminalRuntime): vscode.Disposable {
  const runtime = getRuntime();
  const provider = new ShellCommandsPanelProvider(runtime);
  const webviewViewRegistration = vscode.window.registerWebviewViewProvider(
    SHELL_COMMANDS_VIEW_ID,
    provider,
  );

  const openCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.openEntry',
    async (item?: ShellCommandTreeItem | string): Promise<void> => {
      const commandId = resolveCommandId(item);

      await provider.reveal(commandId);
    },
  );

  const killCommand = vscode.commands.registerCommand(
    'custom-vscode.shellCommands.killEntry',
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
    'custom-vscode.shellCommands.deleteEntry',
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
    'custom-vscode.shellCommands.clearFinished',
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
