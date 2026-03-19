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

const appendLine = vi.hoisted(() => vi.fn());
const createOutputChannel = vi.hoisted(() => vi.fn(() => ({
  append: vi.fn(),
  appendLine,
  clear: vi.fn(),
  dispose: vi.fn(),
  show: vi.fn(),
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
    expect(createOutputChannel).toHaveBeenCalledWith('Agent Helper Kit');
  });

  it('writes formatted error, info, and warning messages to the channel', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    logError('first problem');
    logInfo('hello');
    logWarn('careful');

    expect(appendLine).toHaveBeenNthCalledWith(1, '[2026-03-19T12:00:00.000Z] [ERROR] first problem');
    expect(appendLine).toHaveBeenNthCalledWith(2, '[2026-03-19T12:00:00.000Z] [INFO] hello');
    expect(appendLine).toHaveBeenNthCalledWith(3, '[2026-03-19T12:00:00.000Z] [WARN] careful');
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
