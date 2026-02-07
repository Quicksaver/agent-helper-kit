import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import type { Linter } from 'eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import rulesBestPractices from './rules/best-practices';
import rulesErrors from './rules/errors';
import rulesES6 from './rules/es6';
import rulesImports from './rules/imports';
import rulesReact from './rules/react';
import rulesReactA11y from './rules/react-a11y';
import rulesStrict from './rules/strict';
import rulesStyle from './rules/style';
import rulesVariables from './rules/variables';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const tsFiles = [ '**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts' ];

export default defineConfig([
  js.configs.recommended,

  // Use Next.js core web vitals config as base, but remove their TypeScript config as we'll be adding our own later and
  // that can lead to plugin definition conflicts.
  nextVitals.filter(config => config.name !== 'next/typescript'),

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

  // Rules ported from airbnb-config-base and airbnb-config-react, adapted, filtered, and migrated as (un)needed
  rulesBestPractices,
  rulesErrors,
  rulesStyle,
  rulesVariables,
  rulesES6,
  rulesImports,
  rulesStrict,
  rulesReact,
  rulesReactA11y,

  // Add `files` to these definitions to ensure only ts files go through the TS parser; while by default the TS
  // parser could parse JS files, it is much slower, and because we are using some type-aware rules, and thus enable
  // `projectService`, this would have trouble with some JS files.
  // Since we keep (m)js files to a minimum (tool config files only), we're not really losing a lot of coverage this
  // way, if any at all.
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
        ...globals.browser,
      },

      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
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

      'react-hooks/exhaustive-deps': 'error',
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
    // nextVitals ignores .next/, out/, build/, and next-env.d.ts
  ]),
]);
