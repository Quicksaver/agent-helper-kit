import os from 'node:os';

import {
  afterAll,
  afterEach,
  beforeEach,
} from 'vitest';

function getDefaultTestShell(): string {
  if (os.platform() === 'win32') {
    return 'pwsh.exe';
  }

  if (os.platform() === 'darwin') {
    return '/bin/zsh';
  }

  return '/bin/bash';
}

const DEFAULT_TEST_SHELL = getDefaultTestShell();

const CONTROLLED_TEST_ENV = {
  CLICOLOR: '1',
  CLICOLOR_FORCE: '1',
  COLORTERM: 'truecolor',
  COLUMNS: '240',
  FORCE_COLOR: '3',
  LINES: '80',
  SHELL: DEFAULT_TEST_SHELL,
  TERM: 'xterm-256color',
} as const;

const originalEnvironmentEntries = Object.entries(process.env);

function restoreEnvironment(entries: [ string, string | undefined ][]): void {
  for (const variableName of Object.keys(process.env)) {
    Reflect.deleteProperty(process.env, variableName);
  }

  for (const [ variableName, value ] of entries) {
    if (value !== undefined) {
      process.env[variableName] = value;
    }
  }
}

function applyControlledTestEnvironment(): void {
  restoreEnvironment(originalEnvironmentEntries);

  for (const [ variableName, value ] of Object.entries(CONTROLLED_TEST_ENV)) {
    process.env[variableName] = value;
  }

  Reflect.deleteProperty(process.env, 'NO_COLOR');
  Reflect.deleteProperty(process.env, 'NODE_OPTIONS');
}

beforeEach(() => {
  applyControlledTestEnvironment();
});

afterEach(() => {
  restoreEnvironment(originalEnvironmentEntries);
});

afterAll(() => {
  restoreEnvironment(originalEnvironmentEntries);
});
