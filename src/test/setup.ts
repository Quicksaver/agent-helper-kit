import {
  afterAll,
  afterEach,
  beforeEach,
} from 'vitest';

const CONTROLLED_TEST_ENV = {
  CLICOLOR: '1',
  CLICOLOR_FORCE: '1',
  COLORTERM: 'truecolor',
  COLUMNS: '240',
  FORCE_COLOR: '3',
  LINES: '80',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color',
} as const;

const CLEARED_TEST_ENV_VARS = [
  'NO_COLOR',
  'NODE_OPTIONS',
] as const;

const trackedEnvVarNames = [
  ...Object.keys(CONTROLLED_TEST_ENV),
  ...CLEARED_TEST_ENV_VARS,
] as const;

const originalEnvironment = new Map(
  trackedEnvVarNames.map(variableName => [ variableName, process.env[variableName] ]),
);

function applyControlledTestEnvironment(): void {
  for (const [ variableName, value ] of Object.entries(CONTROLLED_TEST_ENV)) {
    process.env[variableName] = value;
  }

  for (const variableName of CLEARED_TEST_ENV_VARS) {
    Reflect.deleteProperty(process.env, variableName);
  }
}

beforeEach(() => {
  applyControlledTestEnvironment();
});

afterEach(() => {
  applyControlledTestEnvironment();
});

afterAll(() => {
  for (const [ variableName, value ] of originalEnvironment) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, variableName);
    }
    else {
      process.env[variableName] = value;
    }
  }
});
