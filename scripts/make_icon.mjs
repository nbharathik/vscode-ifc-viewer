// Render media/icon.svg -> media/icon.png (128x128) using the Playwright Chromium
// that's already a dev dependency. Deterministic; run when the SVG changes.
//   node scripts/make_icon.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(here, '../packages/extension/media');
const svg = readFileSync(resolve(mediaDir, 'icon.svg'), 'utf8');

const browser = await chromium.launch({ args: ['--headless=new'] });
const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
  { waitUntil: 'load' },
);
await page.locator('svg').screenshot({ path: resolve(mediaDir, 'icon.png'), omitBackground: true });
await browser.close();
console.log('wrote packages/extension/media/icon.png');
