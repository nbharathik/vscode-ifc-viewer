import { defineConfig, devices } from '@playwright/test';

// Visual + interaction suite against the viewer-core Vite harness.
// Determinism: headless Chromium with SwiftShader WebGL, devicePixelRatio
// pinned to 1, no animation during snapshots.
const PORT = 4317;

export default defineConfig({
  testDir: './packages/viewer-core/tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Pixel baselines are platform-specific (SwiftShader rasterizes slightly
  // differently per OS). Tagging by platform keeps a Windows baseline from being
  // compared against a Linux render. Structural assertions are the portable gate.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    deviceScaleFactor: 1,
    viewport: { width: 1024, height: 768 },
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
  webServer: {
    command: 'npm run harness:serve',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
