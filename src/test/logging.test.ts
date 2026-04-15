import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  getExtensionOutputChannel,
  logError,
  logInfo,
  logWarn,
  resetExtensionOutputChannelForTest,
} from '@/logging';

const error = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const createOutputChannel = vi.hoisted(() => vi.fn(() => ({
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  error,
  info,
  show: vi.fn(),
  warn,
})));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel,
  },
}));

describe('logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExtensionOutputChannelForTest();
  });

  it('creates the extension output channel only once', () => {
    const firstChannel = getExtensionOutputChannel();
    const secondChannel = getExtensionOutputChannel();

    expect(firstChannel).toBe(secondChannel);
    expect(createOutputChannel).toHaveBeenCalledTimes(1);
    expect(createOutputChannel).toHaveBeenCalledWith('Agent Helper Kit', { log: true });
  });

  it('writes error, info, and warning messages with the log channel methods', () => {
    logError('first problem');
    logInfo('hello');
    logWarn('careful');

    expect(error).toHaveBeenNthCalledWith(1, 'first problem');
    expect(info).toHaveBeenNthCalledWith(1, 'hello');
    expect(warn).toHaveBeenNthCalledWith(1, 'careful');
  });

  it('prefixes each line when logging a multi-line message', () => {
    logInfo('hello\nworld');

    expect(info).toHaveBeenNthCalledWith(1, 'hello');
    expect(info).toHaveBeenNthCalledWith(2, 'world');
  });

  it('ignores trailing newline segments when logging', () => {
    logInfo('hello\n');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenNthCalledWith(1, 'hello');
  });

  it('disposes the cached channel when reset for tests is called', () => {
    const channel = getExtensionOutputChannel() as unknown as {
      dispose: ReturnType<typeof vi.fn>;
    };

    resetExtensionOutputChannelForTest();
    getExtensionOutputChannel();

    expect(channel.dispose.mock.calls).toHaveLength(1);
    expect(createOutputChannel).toHaveBeenCalledTimes(2);
  });
});
