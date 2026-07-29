import { defineConfig } from 'vitest/config';

// Node-only unit suite: engine adapter logic, spatial tree building, property /
// pset extraction, expressID mapping, and the architecture (layer-ban) tests.
// Visual/browser tests live in *.spec.ts and run under Playwright, not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'packages/viewer-core/tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
