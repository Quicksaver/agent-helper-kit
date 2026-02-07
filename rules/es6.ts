import type { Linter } from 'eslint';

const es6Config: Linter.Config = {
  rules: {
    'no-confusing-arrow': [ 'error', {
      allowParens: true,
    } ],
    'no-new-symbol': 'error',
    'no-restricted-exports': [ 'error', {
      restrictedNamedExports: [
        'then',
      ],
    } ],
    'no-useless-constructor': 'error',
    'no-useless-rename': [ 'error', {
      ignoreDestructuring: false,
      ignoreExport: false,
      ignoreImport: false,
    } ],
    'no-var': 'error',
    'object-shorthand': [ 'error', 'always', {
      avoidQuotes: true,
      ignoreConstructors: false,
    } ],
    'prefer-arrow-callback': [ 'error', {
      allowNamedFunctions: true,
      allowUnboundThis: true,
    } ],
    'prefer-const': [ 'error', {
      destructuring: 'any',
      ignoreReadBeforeAssign: true,
    } ],
    'prefer-destructuring': [ 'error', {
      AssignmentExpression: {
        array: true,
        object: false,
      },
      VariableDeclarator: {
        array: false,
        object: true,
      },
    }, {
      enforceForRenamedProperties: false,
    } ],
    'prefer-numeric-literals': 'error',
    'prefer-rest-params': 'error',
    'prefer-spread': 'error',
    'prefer-template': 'error',
    'symbol-description': 'error',
  },
};

export default es6Config;
