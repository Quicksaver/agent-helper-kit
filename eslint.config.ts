import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import type { Linter } from 'eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import rulesBestPractices from './rules/best-practices';
import rulesErrors from './rules/errors';
import rulesES6 from './rules/es6';
import rulesImports from './rules/imports';
import rulesStrict from './rules/strict';
import rulesStyle from './rules/style';
import rulesVariables from './rules/variables';

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const tsFiles = [ '**/*.ts', '**/*.mts', '**/*.cts' ];

export default defineConfig([
  js.configs.recommended,

  ...compat.config({
    extends: [
      'plugin:import/recommended',
    ],
  }),

  // Default rules at:
  // https://github.com/eslint-stylistic/eslint-stylistic/blob/main/packages/eslint-plugin/configs/customize.ts
  stylistic.configs.customize({
    blockSpacing: true,
    quoteProps: 'as-needed',
    semi: true,
  }),

  // Rules ported from airbnb-config-base, adapted and filtered for a VS Code extension project
  rulesBestPractices,
  rulesErrors,
  rulesStyle,
  rulesVariables,
  rulesES6,
  rulesImports,
  rulesStrict,

  // Add `files` to these definitions to ensure only ts files go through the TS parser
  tseslint.configs.strictTypeChecked.map(config => {
    const newConfig: Linter.Config = { ...config };
    if (!newConfig.files) {
      newConfig.files = tsFiles;
    }
    return newConfig;
  }),
  tseslint.configs.stylisticTypeChecked.map(config => {
    const newConfig: Linter.Config = { ...config };
    if (!newConfig.files) {
      newConfig.files = tsFiles;
    }
    return newConfig;
  }),

  perfectionist.configs['recommended-natural'],

  {
    languageOptions: {
      ecmaVersion: 'latest',

      globals: {
        ...globals.node,
      },

      parserOptions: {
        sourceType: 'module',
      },
    },

    plugins: {},

    rules: {
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-modules': 'off',
      'perfectionist/sort-named-imports': 'off',
      'perfectionist/sort-objects': [ 'error', {
        partitionByNewLine: true,
        type: 'natural',
      } ],
    },
  },

  {
    files: tsFiles,

    languageOptions: {
      parserOptions: {
        projectService: true,
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },

    rules: {
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-confusing-void-expression': [ 'error', {
        ignoreArrowShorthand: true,
        ignoreVoidReturningFunctions: true,
      } ],
      '@typescript-eslint/no-misused-promises': [ 'error', {
        checksVoidReturn: false,
      } ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-use-before-define': [ 'error', {
        classes: true,
        functions: true,
        variables: true,
      } ],
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': [ 'error', {
        allow: [
          {
            from: 'lib',
            name: [ 'Error', 'URL', 'URLSearchParams' ],
          },
        ],
        allowAny: true,
        allowBoolean: true,
        allowNullish: true,
        allowNumber: true,
        allowRegExp: true,
      } ],
      '@typescript-eslint/return-await': 'off',
    },
  },

  globalIgnores([
    // node_modules/ and .git/ are ignored by default.
    'dist/',
  ]),
]);
