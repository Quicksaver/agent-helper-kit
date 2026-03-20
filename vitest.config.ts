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
        autoUpdate: true,
        branches: 89.26,
        functions: 96.92,
        lines: 95.91,
        statements: 95.8,
      },
    },
    globals: false,
    include: [ 'src/**/*.test.ts' ],
    restoreMocks: true,
  },
});
