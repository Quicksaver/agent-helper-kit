import confusingBrowserGlobals from 'confusing-browser-globals';
import type { Linter } from 'eslint';

const variablesConfig: Linter.Config = {
  rules: {
    'no-label-var': 'error',
    'no-restricted-globals': [
      'error',
      {
        message: 'Use Number.isFinite instead https://github.com/airbnb/javascript#standard-library--isfinite',
        name: 'isFinite',
      },
      {
        message: 'Use Number.isNaN instead https://github.com/airbnb/javascript#standard-library--isnan',
        name: 'isNaN',
      },
      ...confusingBrowserGlobals,
    ],
    'no-undef-init': 'error',
  },
};

export default variablesConfig;
