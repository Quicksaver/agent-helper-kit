/// <reference lib="dom" />

import { JSDOM } from 'jsdom';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type PersistedWebviewState = {
  commandListScrollTop?: number;
  filterText?: string;
  outputScrollState?: {
    atBottom: boolean;
    commandId: string;
    scrollTop: number;
  };
  sidebarWidth?: number;
};

type TestVscodeApi = {
  getCurrentState: () => PersistedWebviewState;
  getState: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

function buildWebviewHtml(): string {
  return `
    <!doctype html>
    <html lang="en">
      <body>
        <div class="layout" id="layout">
          <main class="main-pane">
            <div id="details-pane" class="details-pane">
              <div class="command-header">
                <button id="copy-button" data-action="copy" data-id="shell-1" data-copy-field="cwd">Copy</button>
              </div>
              <div
                id="output-block"
                class="output-block"
                data-command-id="shell-1"
                data-command-running="true"
              >initial</div>
            </div>
          </main>
          <div id="resizer" class="resizer"></div>
          <aside class="sidebar">
            <div class="sidebar-toolbar">
              <input id="command-filter" class="filter-input" type="text" />
              <button id="clear-button" data-action="clear">Clear</button>
            </div>
            <div id="command-list" class="command-list">
              <div
                class="command-item"
                data-action="select"
                data-id="shell-1"
                data-filter-command="alpha task"
                data-filter-id="1234"
                data-filter-shell="zsh"
                tabindex="0"
              >alpha</div>
              <div
                class="command-item"
                data-action="select"
                data-id="shell-2"
                data-filter-command="beta task"
                data-filter-id="5678"
                data-filter-shell="bash"
                tabindex="0"
              >beta</div>
            </div>
          </aside>
        </div>
      </body>
    </html>
  `;
}

function setScrollMetrics(element: HTMLElement, metrics: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): void {
  let currentScrollTop = metrics.scrollTop;

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
}

function installDom(initialState: PersistedWebviewState): {
  api: TestVscodeApi;
  dom: JSDOM;
  selection: {
    addRange: ReturnType<typeof vi.fn>;
    removeAllRanges: ReturnType<typeof vi.fn>;
  };
} {
  const dom = new JSDOM(buildWebviewHtml(), {
    pretendToBeVisual: true,
    url: 'https://example.test',
  });
  let currentState = structuredClone(initialState);
  const api: TestVscodeApi = {
    getCurrentState: () => currentState,
    getState: vi.fn(() => currentState),
    postMessage: vi.fn(),
    setState: vi.fn((nextState: PersistedWebviewState) => {
      currentState = nextState;
    }),
  };
  const selection = {
    addRange: vi.fn(),
    removeAllRanges: vi.fn(),
  };

  Object.defineProperty(dom.window.document, 'readyState', {
    configurable: true,
    get: () => 'complete',
  });

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('MessageEvent', dom.window.MessageEvent);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal('acquireVsCodeApi', vi.fn(() => api));
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  Object.defineProperty(dom.window, 'getSelection', {
    configurable: true,
    value: vi.fn(() => selection),
  });

  const layout = dom.window.document.getElementById('layout');
  const commandList = dom.window.document.getElementById('command-list');
  const outputBlock = dom.window.document.getElementById('output-block');

  if (!(layout instanceof dom.window.HTMLElement)) {
    throw new Error('missing layout');
  }

  if (!(commandList instanceof dom.window.HTMLElement)) {
    throw new Error('missing command list');
  }

  if (!(outputBlock instanceof dom.window.HTMLElement)) {
    throw new Error('missing output block');
  }

  layout.getBoundingClientRect = vi.fn(() => ({
    bottom: 400,
    height: 400,
    left: 0,
    right: 900,
    toJSON: () => undefined,
    top: 0,
    width: 900,
    x: 0,
    y: 0,
  }));
  setScrollMetrics(commandList, {
    clientHeight: 120,
    scrollHeight: 800,
    scrollTop: 0,
  });
  setScrollMetrics(outputBlock, {
    clientHeight: 120,
    scrollHeight: 600,
    scrollTop: 0,
  });

  return {
    api,
    dom,
    selection,
  };
}

async function importWebviewModule(): Promise<void> {
  vi.resetModules();
  await import('../webviews/shellCommandsPanelWebview.js');
}

describe('shellCommandsPanelWebview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('initializes, restores persisted UI state, and handles webview interactions', async () => {
    const { api, dom, selection } = installDom({
      commandListScrollTop: 18,
      filterText: 'beta',
      outputScrollState: {
        atBottom: false,
        commandId: 'shell-1',
        scrollTop: 42,
      },
      sidebarWidth: 420,
    });

    await importWebviewModule();

    const filterInput = dom.window.document.getElementById('command-filter');
    const commandList = dom.window.document.getElementById('command-list');
    const commandRows = dom.window.document.querySelectorAll('.command-item');
    const outputBlock = dom.window.document.getElementById('output-block');
    const copyButton = dom.window.document.getElementById('copy-button');
    const resizer = dom.window.document.getElementById('resizer');

    if (!(filterInput instanceof dom.window.HTMLInputElement)) {
      throw new Error('missing filter input');
    }

    if (!(commandList instanceof dom.window.HTMLElement)) {
      throw new Error('missing command list');
    }

    if (!(outputBlock instanceof dom.window.HTMLElement)) {
      throw new Error('missing output block');
    }

    if (!(copyButton instanceof dom.window.HTMLElement)) {
      throw new Error('missing copy button');
    }

    if (!(resizer instanceof dom.window.HTMLElement)) {
      throw new Error('missing resizer');
    }

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(dom.window.document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('420px');
    expect(filterInput.value).toBe('beta');
    expect(commandList.scrollTop).toBe(18);
    expect(outputBlock.scrollTop).toBe(42);
    expect(outputBlock.dataset.scrollBound).toBe('true');
    expect((commandRows[0] as HTMLElement).style.display).toBe('none');
    expect((commandRows[1] as HTMLElement).style.display).toBe('');

    filterInput.value = 'alpha';
    filterInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(api.getCurrentState().filterText).toBe('alpha');
    expect((commandRows[0] as HTMLElement).style.display).toBe('');
    expect((commandRows[1] as HTMLElement).style.display).toBe('none');

    filterInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Escape',
    }));

    expect(filterInput.value).toBe('');
    expect(api.getCurrentState().filterText).toBe('');

    copyButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({
      commandId: 'shell-1',
      copyField: 'cwd',
      type: 'copy',
    });

    (commandRows[0] as HTMLElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
    }));
    expect(api.postMessage).toHaveBeenCalledWith({
      commandId: 'shell-1',
      type: 'select',
    });

    const filterSelect = vi.spyOn(filterInput, 'select');
    filterInput.focus();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      ctrlKey: true,
      key: 'a',
    }));
    expect(filterSelect).toHaveBeenCalledOnce();

    filterInput.blur();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      ctrlKey: true,
      key: 'a',
    }));
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledOnce();

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        commandId: 'shell-9',
        isRunning: false,
        outputHtml: 'ignored',
        type: 'replaceOutput',
      },
    }));
    expect(outputBlock.innerHTML).toBe('initial');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        commandId: 'shell-1',
        isRunning: false,
        outputHtml: '<strong>updated</strong>',
        type: 'replaceOutput',
      },
    }));
    expect(outputBlock.innerHTML).toBe('<strong>updated</strong>');
    expect(outputBlock.dataset.commandRunning).toBe('false');

    filterInput.value = 'omega';
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        commandItemsHtml: `
          <div class="command-item" data-id="shell-3" data-filter-command="omega task" data-filter-id="9999" data-filter-shell="fish" tabindex="0">omega</div>
          <div class="command-item" data-id="shell-4" data-filter-command="delta task" data-filter-id="0000" data-filter-shell="bash" tabindex="0">delta</div>
        `,
        detailsHtml: `
          <div id="metadata-block" class="metadata-block"></div>
          <div class="details-empty"></div>
          <div id="output-block" class="output-block" data-command-id="shell-3" data-command-running="true">replacement</div>
        `,
        type: 'replacePanelState',
      },
    }));

    const updatedRows = dom.window.document.querySelectorAll('.command-item');
    const replacementOutputBlock = dom.window.document.getElementById('output-block');

    if (!(replacementOutputBlock instanceof dom.window.HTMLElement)) {
      throw new Error('missing replacement output block');
    }

    setScrollMetrics(replacementOutputBlock, {
      clientHeight: 120,
      scrollHeight: 600,
      scrollTop: 7,
    });

    expect(updatedRows).toHaveLength(2);
    expect((updatedRows[0] as HTMLElement).style.display).toBe('');
    expect((updatedRows[1] as HTMLElement).style.display).toBe('none');
    expect(replacementOutputBlock.dataset.scrollBound).toBe('true');

    resizer.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      bubbles: true,
      clientX: 600,
    }));
    expect(dom.window.document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('300px');

    dom.window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    expect(api.getCurrentState().sidebarWidth).toBe(300);
  });

  it('waits for DOMContentLoaded when the document is still loading', async () => {
    const { api, dom } = installDom({});

    Object.defineProperty(dom.window.document, 'readyState', {
      configurable: true,
      get: () => 'loading',
    });

    await importWebviewModule();
    expect(api.postMessage).not.toHaveBeenCalled();

    dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });
});
