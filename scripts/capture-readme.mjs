// One-off: regenerate docs/images/viewer.png from the harness (house.ifc).
// Run from the repo root with the harness serving on 4317.
import { chromium } from '@playwright/test';

const OUT = process.argv[2] ?? 'docs/images/viewer.png';

const browser = await chromium.launch({
  args: [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--force-device-scale-factor=2',
  ],
});
const page = await browser.newPage({ viewport: { width: 1260, height: 692 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4317/?devbar=off');
await page.waitForFunction(() => !!window.__viewer);
await page.evaluate(() => window.__viewer.loadFixture('house'));
await page.waitForFunction(() => window.__viewer.isReady(), undefined, { timeout: 60000 });

// A pleasant working view: selection shown in the tree and properties, and
// the toolbar visible over the viewport.
await page.evaluate(async () => {
  const viewer = window.__viewer;
  viewer.setStandardView('iso');
  const tree = viewer.getSpatialTree();
  let wall = 0;
  const walk = (n) => {
    if (n.type === 'IfcWall' && (n.name ?? '').includes('Front') && !wall) wall = n.expressID;
    n.children.forEach(walk);
  };
  walk(tree);
  viewer.select(wall);
  await viewer.getProperties(wall);
});
await page.waitForTimeout(600);
await page.screenshot({ path: OUT });
await browser.close();
console.log('wrote', OUT);
