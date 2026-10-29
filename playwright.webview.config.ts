import { defineConfig, devices } from '@playwright/test';

// Runs the real bundled webview (packages/extension/dist/webview.js) in
// Chromium with a stubbed VS Code API, to cover what only the extension's own
// webview adds: engine and agent status, the Agent and Engine tabs, and the
// messages they send. Build the extension first (npm run test:webview does).
export default defineConfig({
  testDir: './packages/extension/tests/webview',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-webgl',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--headless=new',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--disable-gpu-sandbox',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
});
