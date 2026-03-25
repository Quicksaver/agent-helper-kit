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
        autoUpdate: true,
        branches: 90.16,
        functions: 97.63,
        lines: 96.83,
        statements: 96.77,
      },
    },
    globals: false,
    include: [ 'src/**/*.test.ts' ],
    restoreMocks: true,
    setupFiles: [ 'src/test/setup.ts' ],
  },
});
