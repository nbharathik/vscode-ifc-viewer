// Flat ESLint config for the monorepo.
// Layer bans (no `three`/`web-ifc` in extension, no `vscode` in viewer-core) are
// enforced by dedicated vitest specs in tests/, not here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-harness/**',
      '**/out/**',
      '**/out-test/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/.vscode-test/**',
      '**/out-test/**',
      'artifacts/**',
      'fixtures/**',
      'playwright-report/**',
      'test-results/**',
      '.probe/**',
      '**/*.vsix',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // Build/config scripts run under Node and may use Node globals.
    files: ['**/*.config.{js,ts,mjs}', '**/esbuild.mjs', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        global: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    // bench.mjs evaluates snippets inside the harness page via Playwright.
    files: ['scripts/bench.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        performance: 'readonly',
      },
    },
  },
);
