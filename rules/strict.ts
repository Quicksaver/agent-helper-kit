import type { Linter } from 'eslint';

export const strictConfig: Linter.Config = {
  rules: {
    strict: [ 'error', 'never' ],
  },
};

export default strictConfig;
