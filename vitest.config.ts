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
        'src/extension.ts',
        ...coverageConfigDefaults.exclude,
      ],
      include: [ 'src/**/*.ts' ],
      reporter: [ 'text', 'lcov' ],
      thresholds: {
        branches: 86.94,
        functions: 96.44,
        lines: 94.86,
        statements: 94.76,
      },
    },
    globals: false,
    include: [ 'src/**/*.test.ts' ],
    restoreMocks: true,
  },
});
