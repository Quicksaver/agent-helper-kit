import * as vscode from 'vscode';

import ansiRegex from 'ansi-regex';

import { logError } from '@/logging';
import type {
  CopyField,
  ExtensionWebviewMessage,
  WebviewMessage,
} from '@/shellCommandsPanelWebviewContracts';
import {
  type ShellCommandDetails,
  type ShellCommandListItem,
  type ShellRuntime,
  toPublicCommandId,
} from '@/shellRuntime';

const SHELL_COMMANDS_VIEW_ID = 'agent-helper-kit.shellCommandsView';
const SHELL_COMMANDS_PANEL_CONTAINER_ID = 'agent-helper-kit-shellCommandsPanel';
const RUNNING_POLL_MS = 1000;
const WEBVIEW_ASSET_DIRECTORY = [ 'dist', 'webviews' ] as const;
const WEBVIEW_SCRIPT_FILE = 'shellCommandsPanelWebview.js';
const WEBVIEW_STYLE_FILE = 'shellCommandsPanelWebview.css';

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

function buildMetadataFieldMarkup(
  label: string,
  value: string,
  options?: {
    commandId?: string;
    copyField?: CopyField;
    emphasized?: boolean;
    fieldId?: string;
    statusClass?: string;
    truncateFromStart?: boolean;
  },
): string {
  const emphasizedClass = options?.emphasized === true ? ' metadata-item-emphasized' : '';
  const statusClass = options?.statusClass ? ` ${options.statusClass}` : '';
  const truncationClass = options?.truncateFromStart === true ? ' metadata-value-truncate-start' : '';
  const escapedCopyField = options?.copyField ? escapeHtml(options.copyField) : undefined;
  const fieldAttribute = options?.fieldId ? ` data-metadata-field="${escapeHtml(options.fieldId)}"` : '';
  const statusAttribute = options?.statusClass
    ? ` data-metadata-status="${escapeHtml(options.statusClass.replace('metadata-item-', ''))}"`
    : '';
  const truncateAttribute = options?.truncateFromStart === true ? ' data-truncate-from-start="true"' : '';
  const copyButtonMarkup = options?.copyField && options.commandId
    ? `
        <button
          class="icon-action metadata-copy"
          data-action="copy"
          data-copy-field="${escapedCopyField}"
          data-id="${escapeHtml(options.commandId)}"
          title="Copy ${escapeHtml(label.toLowerCase())}"
          aria-label="Copy ${escapeHtml(label.toLowerCase())}"
        >⧉</button>
      `
    : '';

  return `
    <div class="metadata-item${emphasizedClass}${statusClass}"${fieldAttribute}${statusAttribute}>
      <span class="metadata-label">${escapeHtml(label)}</span>
      <span class="metadata-value${truncationClass}"${truncateAttribute}>${escapeHtml(value)}</span>
      ${copyButtonMarkup}
    </div>
  `;
}

function getMetadataStatusClass(details: ShellCommandDetails): string {
  if (details.isRunning) {
    return 'metadata-item-running';
  }

  if (details.killedByUser || details.signal || details.exitCode !== 0) {
    return 'metadata-item-error';
  }

  return 'metadata-item-success';
}

function getExitCodeLabel(details: ShellCommandDetails): string {
  if (details.signal && details.exitCode !== null) {
    return `${details.signal} (${String(details.exitCode)})`;
  }

  if (details.signal) {
    return details.signal;
  }

  if (details.exitCode === null) {
    return '--';
  }

  return String(details.exitCode);
}

function getCompletedLabel(details: ShellCommandDetails): string {
  if (details.isRunning) {
    return '--';
  }

  return formatTimestamp(details.completedAt);
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
      const attributeName = style.includes(':') ? 'style' : 'class';
      const escapedStyle = escapeHtml(style);

      html += style.length === 0
        ? escapedSegment
        : `<span ${attributeName}="${escapedStyle}">${escapedSegment}</span>`;
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
    const attributeName = style.includes(':') ? 'style' : 'class';
    const escapedStyle = escapeHtml(style);

    html += style.length === 0
      ? escapedSegment
      : `<span ${attributeName}="${escapedStyle}">${escapedSegment}</span>`;
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
    return '<div id="metadata-block" class="metadata-block"></div><div class="details-empty"></div><div id="output-block" class="output-block"></div>';
  }

  const publicCommandId = toPublicCommandId(details.id);
  const metadataFields = [
    buildMetadataFieldMarkup('Exit Code', getExitCodeLabel(details), {
      emphasized: true,
      fieldId: 'exit-code',
      statusClass: getMetadataStatusClass(details),
    }),
    buildMetadataFieldMarkup('Shell', details.shell, {
      fieldId: 'shell',
      truncateFromStart: true,
    }),
    buildMetadataFieldMarkup('CWD', details.cwd, {
      commandId: details.id,
      copyField: 'cwd',
      fieldId: 'cwd',
      truncateFromStart: true,
    }),
    buildMetadataFieldMarkup('Started', formatTimestamp(details.startedAt), {
      fieldId: 'started',
    }),
    buildMetadataFieldMarkup('Completed', getCompletedLabel(details), {
      fieldId: 'completed',
    }),
    buildMetadataFieldMarkup('ID', publicCommandId, {
      commandId: details.id,
      copyField: 'id',
      fieldId: 'id',
    }),
  ].join('');

  return `
    <div id="metadata-block" class="metadata-block">${metadataFields}</div>
    <div class="command-header">
      <pre class="command-block">${escapeHtml(details.command)}</pre>
      <div class="command-actions">
        <button
          class="icon-action"
          data-action="copy"
          data-copy-field="command"
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

function buildCommandItemsMarkup(
  commands: ShellCommandListItem[],
  selectedCommandId: string | undefined,
): string {
  return commands.map(command => {
    const commandPreview = getCommandListLabel(command.command);
    const shellLabel = getShellLabel(command.shell);
    const publicCommandId = toPublicCommandId(command.id);
    const selectedClass = command.id === selectedCommandId ? 'selected' : '';
    const rowAction = command.isRunning ? 'kill' : 'delete';
    const rowActionIcon = command.isRunning ? '■' : '✕';
    const rowActionTitle = command.isRunning ? 'Kill' : 'Delete';

    return `
      <div
        class="command-item ${selectedClass}"
        data-action="select"
        data-id="${escapeHtml(command.id)}"
        data-filter-command="${escapeHtml(command.command.toLowerCase())}"
        data-filter-id="${escapeHtml(publicCommandId.toLowerCase())}"
        data-filter-shell="${escapeHtml(shellLabel)}"
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
}

function getCopyValue(details: ShellCommandDetails, copyField: CopyField | undefined): string {
  if (copyField === 'cwd') {
    return details.cwd;
  }

  if (copyField === 'id') {
    return toPublicCommandId(details.id);
  }

  return details.command;
}

function getWebviewAssetUri(
  webview: vscode.Webview,
  extensionUri: undefined | vscode.Uri,
  filename: string,
): string {
  if (!extensionUri || typeof webview.asWebviewUri !== 'function') {
    return filename;
  }

  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_DIRECTORY, filename)).toString();
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: undefined | vscode.Uri,
  commands: ShellCommandListItem[],
  selectedCommandId: string | undefined,
  selectedDetails: ShellCommandDetails | undefined,
): string {
  const commandItems = buildCommandItemsMarkup(commands, selectedCommandId);
  const detailsMarkup = buildDetailsMarkup(selectedDetails);
  const cspSource = typeof webview.cspSource === 'string' && webview.cspSource.length > 0
    ? webview.cspSource
    : '\'self\'';
  const scriptUri = getWebviewAssetUri(webview, extensionUri, WEBVIEW_SCRIPT_FILE);
  const styleUri = getWebviewAssetUri(webview, extensionUri, WEBVIEW_STYLE_FILE);

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src ${cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${escapeHtml(styleUri)}" />
  </head>
  <body>
    <div class="layout" id="layout">
      <main class="main-pane"><div id="details-pane" class="details-pane">${detailsMarkup}</div></main>
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
        <div id="command-list" class="command-list">${commandItems}</div>
      </aside>
    </div>
    <script src="${escapeHtml(scriptUri)}" defer></script>
  </body>
</html>
  `;
}

class ShellCommandsPanelProvider implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly disposeRuntimeListener: () => void;
  private hasRenderedWebview = false;
  private isWebviewReady = false;
  private renderedSelectedCommandId: string | undefined;
  private renderedSelectedOutputLength = 0;
  private renderRequestId = 0;
  private runningPoller: NodeJS.Timeout | undefined;
  private selectedCommandId: string | undefined;
  private view: undefined | vscode.WebviewView;

  constructor(
    private readonly runtime: ShellRuntime,
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.disposeRuntimeListener = this.runtime.onDidChangeCommands(() => {
      void this.refresh().catch((error: unknown) => {
        logError(`Failed to refresh shell commands panel after runtime update: ${String(error)}`);
      });
    });
  }

  dispose(): void {
    this.hasRenderedWebview = false;
    this.isWebviewReady = false;
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

    if (!this.hasRenderedWebview) {
      view.webview.html = getWebviewHtml(
        view.webview,
        this.extensionUri,
        commands,
        this.selectedCommandId,
        selectedDetails,
      );
      this.hasRenderedWebview = true;
    }
    else if (this.isWebviewReady) {
      const message: ExtensionWebviewMessage = {
        commandItemsHtml: buildCommandItemsMarkup(commands, this.selectedCommandId),
        detailsHtml: buildDetailsMarkup(selectedDetails),
        type: 'replacePanelState',
      };

      await view.webview.postMessage(message);
    }

    this.renderedSelectedCommandId = selectedDetails?.id;
    this.renderedSelectedOutputLength = selectedDetails?.output.length ?? 0;

    this.updatePolling(selectedDetails);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.extensionUri
        ? [ vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_ASSET_DIRECTORY) ]
        : undefined,
    };

    webviewView.onDidDispose(() => {
      this.hasRenderedWebview = false;
      this.isWebviewReady = false;
      this.stopPolling();
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message).catch((error: unknown) => {
        logError(`Failed to handle shell commands panel message: ${String(error)}`);
      });
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
    if (message.type === 'ready') {
      this.isWebviewReady = true;
      await this.refresh();
      return;
    }

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

      await vscode.env.clipboard.writeText(getCopyValue(details, message.copyField));
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

    if (!this.isWebviewReady) {
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
      void this.refreshRunningCommandOutput().catch((error: unknown) => {
        logError(`Failed to refresh running shell command output: ${String(error)}`);
      });
    }, RUNNING_POLL_MS);
  }
}

export function registerShellCommandsPanel(
  getRuntime: () => ShellRuntime,
  extensionUri?: vscode.Uri,
): vscode.Disposable {
  const runtime = getRuntime();
  const provider = new ShellCommandsPanelProvider(runtime, extensionUri);
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
