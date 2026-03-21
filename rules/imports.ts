import type { Linter } from 'eslint';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

const importsConfig: Linter.Config = {
  rules: {
    'import-x/extensions': [ 'error', 'ignorePackages', {
      js: 'never',
      mjs: 'never',
      ts: 'never',
    } ],
    'import-x/first': 'error',
    'import-x/newline-after-import': 'error',
    'import-x/no-absolute-path': 'error',
    'import-x/no-amd': 'error',
    'import-x/no-cycle': [ 'error', { maxDepth: '∞' } ],
    'import-x/no-dynamic-require': 'error',
    'import-x/no-extraneous-dependencies': [ 'error', {
      devDependencies: [
        '**/eslint.config.ts',
        'rules/**',
        'src/test/**',
        '*.config.*',
        'esbuild.mjs',
      ],
      optionalDependencies: false,
    } ],
    'import-x/no-import-module-exports': [ 'error', {
      exceptions: [],
    } ],
    'import-x/no-mutable-exports': 'error',
    'import-x/no-named-default': 'error',
    'import-x/no-relative-packages': 'error',
    'import-x/no-self-import': 'error',
    'import-x/no-unresolved': [ 'error', {
      caseSensitive: true,
      commonjs: true,
    } ],
    'import-x/no-useless-path-segments': [ 'error', { commonjs: true } ],
    'import-x/no-webpack-loader-syntax': 'error',
    'import-x/order': [ 'error', {
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
    'import-x/core-modules': [ 'vscode' ],
    'import-x/extensions': [
      '.js',
      '.mjs',
    ],
    'import-x/ignore': [
      'node_modules',
    ],
    'import-x/resolver-next': [
      createTypeScriptImportResolver(),
    ],
  },
};

export default importsConfig;
