import type { Linter } from 'eslint';

const importsConfig: Linter.Config = {
  rules: {
    'import/export': 'error',
    'import/extensions': [ 'error', 'ignorePackages', {
      js: 'never',
      mjs: 'never',
      ts: 'never',
    } ],
    'import/first': 'error',
    'import/named': 'error',
    'import/newline-after-import': 'error',
    'import/no-absolute-path': 'error',
    'import/no-amd': 'error',
    'import/no-cycle': [ 'error', { maxDepth: '∞' } ],
    'import/no-dynamic-require': 'error',
    'import/no-extraneous-dependencies': [ 'error', {
      devDependencies: [
        '**/eslint.config.ts',
        'rules/**',
        'src/test/**',
        '*.config.*',
        'esbuild.mjs',
      ],
      optionalDependencies: false,
    } ],
    'import/no-import-module-exports': [ 'error', {
      exceptions: [],
    } ],
    'import/no-mutable-exports': 'error',
    'import/no-named-default': 'error',
    'import/no-relative-packages': 'error',
    'import/no-self-import': 'error',
    'import/no-unresolved': [ 'error', {
      caseSensitive: true,
      commonjs: true,
    } ],
    'import/no-useless-path-segments': [ 'error', { commonjs: true } ],
    'import/no-webpack-loader-syntax': 'error',
    'import/order': [ 'error', {
      alphabetize: {
        caseInsensitive: true,
        order: 'asc',
      },
      distinctGroup: true,
      groups: [ 'builtin', 'external', 'internal', 'parent', 'sibling' ],
      named: true,
      'newlines-between': 'always',
      pathGroups: [
        {
          group: 'internal',
          pattern: 'components/**',
          position: 'before',
        },
      ],
      warnOnUnassignedImports: true,
    } ],
  },

  settings: {
    'import/core-modules': [ 'vscode' ],
    'import/extensions': [
      '.js',
      '.mjs',
    ],
    'import/ignore': [
      'node_modules',
    ],
    'import/resolver': {
      node: {
        extensions: [ '.mjs', '.js', '.json' ],
      },
      typescript: true,
    },
  },
};

export default importsConfig;
