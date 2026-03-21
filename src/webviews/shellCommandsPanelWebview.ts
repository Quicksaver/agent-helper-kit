/// <reference lib="dom" />
import type {
  CopyField,
  ExtensionWebviewMessage,
  WebviewMessage,
} from '@/shellCommandsPanelWebviewContracts';

import './shellCommandsPanelWebview.css';

type PersistedOutputScrollState = {
  atBottom: boolean;
  commandId: string;
  scrollTop: number;
};

type PersistedWebviewState = {
  commandListScrollTop?: number;
  filterText?: string;
  outputScrollState?: PersistedOutputScrollState;
  sidebarWidth?: number;
};

type VscodeApi = {
  getState(): PersistedWebviewState | undefined;
  postMessage(message: WebviewMessage): void;
  setState(state: PersistedWebviewState): void;
};

declare function acquireVsCodeApi(): VscodeApi;

const outputEndThreshold = 4;

function initializeShellCommandsPanelWebview(): void {
  const vscodeApi = acquireVsCodeApi();
  const root = document.documentElement;
  const layout = document.getElementById('layout');
  const resizer = document.getElementById('resizer');
  const filterInput = document.getElementById('command-filter');
  const getCommandList = () => document.getElementById('command-list');
  const getDetailsPane = () => document.getElementById('details-pane');
  const getOutputBlock = () => document.getElementById('output-block');
  const getCurrentState = (): PersistedWebviewState => vscodeApi.getState() ?? {};
  const previousState = getCurrentState();
  let currentState: PersistedWebviewState = { ...previousState };

  const persistState = (updates: PersistedWebviewState): void => {
    currentState = {
      ...currentState,
      ...updates,
    };
    vscodeApi.setState(currentState);
  };

  const getSidebarWidth = (): number => {
    const width = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);

    return Number.isFinite(width) ? width : 340;
  };

  const isNearOutputEnd = (element: HTMLElement): boolean => (
    element.scrollTop + element.clientHeight >= element.scrollHeight - outputEndThreshold
  );

  const syncCommandListScrollState = (): void => {
    const commandList = getCommandList();

    if (!(commandList instanceof HTMLElement)) {
      return;
    }

    persistState({
      commandListScrollTop: commandList.scrollTop,
    });
  };

  const restoreCommandListScrollState = (): void => {
    const commandList = getCommandList();

    if (!(commandList instanceof HTMLElement)) {
      return;
    }

    const savedCommandListScrollTop = getCurrentState().commandListScrollTop;

    if (typeof savedCommandListScrollTop === 'number') {
      commandList.scrollTop = savedCommandListScrollTop;
    }
  };

  const syncOutputScrollState = (): void => {
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

  const restoreOutputScroll = (): void => {
    const outputBlock = getOutputBlock();

    if (!(outputBlock instanceof HTMLElement)) {
      return;
    }

    const savedOutputScrollState = getCurrentState().outputScrollState;
    const commandId = outputBlock.dataset.commandId ?? '';
    if (
      savedOutputScrollState?.commandId !== commandId
      || savedOutputScrollState.atBottom
    ) {
      outputBlock.scrollTop = outputBlock.scrollHeight;
    }
    else {
      outputBlock.scrollTop = savedOutputScrollState.scrollTop;
    }

    syncOutputScrollState();
  };

  const bindOutputBlock = (): void => {
    const outputBlock = getOutputBlock();

    if (!(outputBlock instanceof HTMLElement) || outputBlock.dataset.scrollBound === 'true') {
      return;
    }

    outputBlock.dataset.scrollBound = 'true';
    outputBlock.addEventListener('scroll', () => {
      syncOutputScrollState();
    });

    requestAnimationFrame(() => {
      restoreOutputScroll();
    });
  };

  const replaceOutput = (message: ExtensionWebviewMessage): void => {
    if (message.type !== 'replaceOutput') {
      return;
    }

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

  const normalizeFilterValue = (value: string): string => value.trim().toLowerCase();

  const applyFilter = (value: string): void => {
    const normalized = normalizeFilterValue(value);
    const rows = document.querySelectorAll('.command-item');

    rows.forEach(row => {
      if (!(row instanceof HTMLElement)) {
        return;
      }

      if (normalized.length < 1) {
        row.style.display = '';
        return;
      }

      const commandText = row.getAttribute('data-filter-command') ?? '';
      const idText = row.getAttribute('data-filter-id') ?? '';
      const shellText = row.getAttribute('data-filter-shell') ?? '';
      const matches = commandText.includes(normalized)
        || idText.includes(normalized)
        || shellText.includes(normalized);

      row.style.display = matches ? '' : 'none';
    });
  };

  const replacePanelState = (message: ExtensionWebviewMessage): void => {
    if (message.type !== 'replacePanelState') {
      return;
    }

    const commandList = getCommandList();
    const detailsPane = getDetailsPane();

    if (!(commandList instanceof HTMLElement) || !(detailsPane instanceof HTMLElement)) {
      return;
    }

    syncCommandListScrollState();
    syncOutputScrollState();
    commandList.innerHTML = message.commandItemsHtml;
    detailsPane.innerHTML = message.detailsHtml;

    if (filterInput instanceof HTMLInputElement) {
      applyFilter(filterInput.value);
    }

    restoreCommandListScrollState();
    bindOutputBlock();
  };

  if (typeof previousState.sidebarWidth === 'number') {
    root.style.setProperty('--sidebar-width', `${String(previousState.sidebarWidth)}px`);
  }

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

  const commandList = getCommandList();

  if (commandList instanceof HTMLElement) {
    commandList.addEventListener('scroll', () => {
      syncCommandListScrollState();
    });

    requestAnimationFrame(() => {
      restoreCommandListScrollState();
    });
  }

  bindOutputBlock();

  window.addEventListener('message', event => {
    const message = event.data as ExtensionWebviewMessage | undefined;

    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'replaceOutput') {
      replaceOutput(message);
      return;
    }

    replacePanelState(message);
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
    root.style.setProperty('--sidebar-width', `${String(nextWidth)}px`);
  });

  document.addEventListener('click', event => {
    const { target } = event;

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
    const copyField = actionable.getAttribute('data-copy-field');

    vscodeApi.postMessage({
      commandId,
      copyField: copyField === 'command' || copyField === 'cwd' || copyField === 'id'
        ? copyField as CopyField
        : undefined,
      type: action as WebviewMessage['type'],
    });
  });

  document.addEventListener('keydown', event => {
    const { target } = event;

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

  const selectOutputContents = (): void => {
    const outputBlock = getOutputBlock();

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

  vscodeApi.postMessage({
    type: 'ready',
  });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    initializeShellCommandsPanelWebview();
  }, { once: true });
}
else {
  initializeShellCommandsPanelWebview();
}
