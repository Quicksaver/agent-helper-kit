import type { Linter } from 'eslint';

const bestPracticesConfig: Linter.Config = {
  rules: {
    'array-callback-return': [ 'error', { allowImplicit: true } ],
    'block-scoped-var': 'error',
    'consistent-return': 'error',
    curly: [ 'error', 'all' ],
    'default-case': [ 'error', { commentPattern: '^no default$' } ],
    'default-case-last': 'error',
    'default-param-last': 'error',
    'dot-notation': [ 'error', { allowKeywords: true } ],
    eqeqeq: [ 'error', 'always', { null: 'ignore' } ],
    'grouped-accessor-pairs': 'error',
    'guard-for-in': 'error',
    'max-classes-per-file': [ 'error', 1 ],
    'no-alert': 'warn',
    'no-caller': 'error',
    'no-constructor-return': 'error',
    'no-else-return': [ 'error', { allowElseIf: false } ],
    'no-empty-function': [ 'error', {
      allow: [
        'arrowFunctions',
        'functions',
        'methods',
      ],
    } ],
    'no-eval': 'error',
    'no-extend-native': 'error',
    'no-extra-bind': 'error',
    'no-extra-label': 'error',
    'no-fallthrough': [ 'error', { commentPattern: 'no[\\s\\w]*break' } ],
    'no-implied-eval': 'error',
    'no-iterator': 'error',
    'no-labels': [ 'error', { allowLoop: false, allowSwitch: false } ],
    'no-lone-blocks': 'error',
    'no-loop-func': 'error',
    'no-multi-str': 'error',
    'no-new': 'error',
    'no-new-func': 'error',
    'no-new-wrappers': 'error',
    'no-octal-escape': 'error',
    'no-proto': 'error',
    'no-restricted-properties': [ 'error', {
      message: 'arguments.callee is deprecated',
      object: 'arguments',
      property: 'callee',
    }, {
      message: 'Please use Number.isFinite instead',
      object: 'global',
      property: 'isFinite',
    }, {
      message: 'Please use Number.isFinite instead',
      object: 'self',
      property: 'isFinite',
    }, {
      message: 'Please use Number.isFinite instead',
      object: 'window',
      property: 'isFinite',
    }, {
      message: 'Please use Number.isNaN instead',
      object: 'global',
      property: 'isNaN',
    }, {
      message: 'Please use Number.isNaN instead',
      object: 'self',
      property: 'isNaN',
    }, {
      message: 'Please use Number.isNaN instead',
      object: 'window',
      property: 'isNaN',
    }, {
      message: 'Please use Object.defineProperty instead.',
      property: '__defineGetter__',
    }, {
      message: 'Please use Object.defineProperty instead.',
      property: '__defineSetter__',
    }, {
      message: 'Use the exponentiation operator (**) instead.',
      object: 'Math',
      property: 'pow',
    } ],
    'no-return-assign': [ 'error', 'always' ],
    'no-script-url': 'error',
    'no-self-compare': 'error',
    'no-sequences': 'error',
    'no-throw-literal': 'error',
    'no-useless-concat': 'error',
    'no-useless-return': 'error',
    'no-void': [ 'error', {
      allowAsStatement: true,
    } ],
    'prefer-promise-reject-errors': [ 'error', { allowEmptyReject: true } ],
    'prefer-regex-literals': [ 'error', {
      disallowRedundantWrapping: true,
    } ],
    radix: 'error',
    'vars-on-top': 'error',
    yoda: 'error',
  },
};

export default bestPracticesConfig;
