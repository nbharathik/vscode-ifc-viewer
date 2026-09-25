// One-off: regenerate the README screenshots from the harness (house.ifc).
// Run from the repo root with the harness serving on 4317:
//   node scripts/capture-readme.mjs                          (viewer.png)
//   node scripts/capture-readme.mjs docs/images/agent.png agent
import { chromium } from '@playwright/test';

const OUT = process.argv[2] ?? 'docs/images/viewer.png';
const SCENE = process.argv[3] ?? 'viewer';

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
// the toolbar visible over the viewport. The agent scene adds the highlight
// groups an agent would send, with the legend showing.
await page.evaluate(async (scene) => {
  const viewer = window.__viewer;
  viewer.setStandardView('iso');
  const tree = viewer.getSpatialTree();
  const byType = {};
  let wall = 0;
  const walk = (n) => {
    (byType[n.type] ??= []).push(n.expressID);
    if (n.type === 'IfcWall' && (n.name ?? '').includes('Front') && !wall) wall = n.expressID;
    n.children.forEach(walk);
  };
  walk(tree);
  if (scene === 'agent') {
    viewer.setHighlight('Exterior walls', byType.IfcWall ?? [], '#e53935');
    viewer.setHighlight('Windows to check', byType.IfcWindow ?? [], '#1e88e5');
    viewer.setHighlight('Front door', byType.IfcDoor ?? [], '#43a047');
  }
  viewer.select(wall);
  await viewer.getProperties(wall);
}, SCENE);
await page.waitForTimeout(600);
await page.screenshot({ path: OUT });
await browser.close();
console.log('wrote', OUT);
