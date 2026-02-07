import type { Linter } from 'eslint';

const styleConfig: Linter.Config = {
  rules: {
    '@stylistic/array-bracket-spacing': [ 'error', 'always' ],
    '@stylistic/arrow-parens': [ 'error', 'as-needed' ],
    '@stylistic/function-call-argument-newline': [ 'error', 'consistent' ],
    '@stylistic/function-call-spacing': [ 'error', 'never' ],
    '@stylistic/function-paren-newline': [ 'error', 'multiline-arguments' ],
    '@stylistic/implicit-arrow-linebreak': [ 'error', 'beside' ],
    '@stylistic/indent': [ 'error', 2, {
      ArrayExpression: 1,
      CallExpression: { arguments: 1 },
      flatTernaryExpressions: false,
      FunctionDeclaration: { body: 1, parameters: 1, returnType: 1 },
      FunctionExpression: { body: 1, parameters: 1, returnType: 1 },
      ignoreComments: false,
      ignoredNodes: [
        'TSUnionType',
        'TSIntersectionType',
      ],
      ImportDeclaration: 1,
      MemberExpression: 1,
      ObjectExpression: 1,
      offsetTernaryExpressions: false,
      outerIIFEBody: 1,
      SwitchCase: 1,
      tabLength: 2,
      VariableDeclarator: 1,
    } ],
    '@stylistic/jsx-max-props-per-line': [ 'error', { maximum: 1 } ],
    '@stylistic/linebreak-style': [ 'error', 'unix' ],
    '@stylistic/max-len': [ 'error', 120, 2, {
      ignoreComments: false,
      ignoreRegExpLiterals: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreUrls: true,
    } ],
    '@stylistic/newline-per-chained-call': [ 'error', { ignoreChainWithDepth: 4 } ],
    '@stylistic/no-extra-semi': 'error',
    '@stylistic/nonblock-statement-body-position': [ 'error', 'beside', { overrides: {} } ],
    '@stylistic/object-curly-newline': [ 'error', {
      ExportDeclaration: {
        consistent: true,
        minProperties: 4,
        multiline: true,
      },
      ImportDeclaration: {
        consistent: true,
        minProperties: 4,
        multiline: true,
      },
      ObjectExpression: {
        consistent: true,
        minProperties: 4,
        multiline: true,
      },
      ObjectPattern: {
        consistent: true,
        minProperties: 4,
        multiline: true,
      },
    } ],
    '@stylistic/object-property-newline': [ 'error', {
      allowAllPropertiesOnSameLine: true,
    } ],
    '@stylistic/one-var-declaration-per-line': [ 'error', 'always' ],
    '@stylistic/semi-style': [ 'error', 'last' ],
    '@stylistic/switch-colon-spacing': [ 'error', { after: true, before: false } ],
    camelcase: [ 'error', {
      ignoreDestructuring: false,
      properties: 'never',
    } ],
    'func-names': 'warn',
    'new-cap': [ 'error', {
      capIsNew: false,
      capIsNewExceptions: [ 'Immutable.Map', 'Immutable.Set', 'Immutable.List' ],
      newIsCap: true,
      newIsCapExceptions: [],
    } ],
    'no-bitwise': 'error',
    'no-lonely-if': 'error',
    'no-multi-assign': [ 'error' ],
    'no-nested-ternary': 'error',
    'no-object-constructor': 'error',
    'no-restricted-syntax': [
      'error',
      {
        message: 'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.',
        selector: 'ForInStatement',
      },
      {
        message: '`with` is disallowed in strict mode because it makes code impossible to predict and optimize.',
        selector: 'WithStatement',
      },
    ],
    'no-unneeded-ternary': [ 'error', { defaultAssignment: false } ],
    'one-var': [ 'error', 'never' ],
    'operator-assignment': [ 'error', 'always' ],
    'prefer-exponentiation-operator': 'error',
    'prefer-object-spread': 'error',
    'unicode-bom': [ 'error', 'never' ],
  },
};

export default styleConfig;
