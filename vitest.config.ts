import path from 'node:path';

import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    coverage: {
      exclude: [
        'src/test/**',
        'src/types/**',
        'src/extension.ts',
        ...coverageConfigDefaults.exclude,
      ],
      include: [ 'src/**/*.ts' ],
      reporter: [ 'text', 'lcov' ],
      thresholds: {
        // autoUpdate means thresholds update ONLY if the new coverage is above the current threshold. Higher thresholds
        // are always acceptable regardless of the task in progress. Lower thresholds are only acceptable with an
        // extremely good reason; i.e. a new feature contains code that is impossible to hit via automated tests alone.
        autoUpdate: true,
        branches: 92.37,
        functions: 98.72,
        lines: 98.02,
        statements: 97.96,
      },
    },
    globals: false,
    include: [ 'src/**/*.test.ts' ],
    restoreMocks: true,
    setupFiles: [ 'src/test/setup.ts' ],
  },
});
