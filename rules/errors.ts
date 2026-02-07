import type { Linter } from 'eslint';

const errorsConfig: Linter.Config = {
  rules: {
    'no-await-in-loop': 'error',
    'no-cond-assign': [ 'error', 'always' ],
    'no-console': 'warn',
    'no-constant-condition': 'warn',
    'no-inner-declarations': 'error',
    'no-promise-executor-return': 'error',
    'no-template-curly-in-string': 'error',
    'no-unreachable-loop': [ 'error', {
      ignore: [],
    } ],
    'no-unsafe-optional-chaining': [ 'error', { disallowArithmeticOperators: true } ],
    'valid-typeof': [ 'error', { requireStringLiterals: true } ],
  },
};

export default errorsConfig;
