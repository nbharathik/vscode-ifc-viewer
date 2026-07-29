// Load benchmark against the built harness. Opens each staged fixture in
// headless Chromium and reports wall time, phase timings, draw calls and heap.
//
//   node scripts/bench.mjs               # all staged fixtures (small first)
//   node scripts/bench.mjs big model_68  # specific fixtures by name
//   node scripts/bench.mjs --gpu         # real GPU instead of SwiftShader
//   node scripts/bench.mjs --json out.json
//
// Builds the harness (staging fixtures into harness/public), serves it with
// vite preview, and drives the same window.__viewer hooks the e2e tests use.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const useGpu = args.includes('--gpu');
const jsonIndex = args.indexOf('--json');
const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
const nameFilter = args.filter((a) => !a.startsWith('--') && a !== jsonOut);

function log(line) {
  process.stdout.write(`${line}\n`);
}

log('building harness (stages fixtures)...');
execSync('npx vite build', {
  cwd: resolve(repoRoot, 'packages/viewer-core'),
  stdio: 'inherit',
});

const indexPath = resolve(repoRoot, 'packages/viewer-core/harness/public/fixtures/index.json');
if (!existsSync(indexPath)) {
  console.error('fixtures/index.json missing after build');
  process.exit(1);
}
let fixtures = JSON.parse(readFileSync(indexPath, 'utf8')).filter((f) => f.name !== 'corrupt');
if (nameFilter.length > 0) {
  fixtures = fixtures.filter((f) => nameFilter.includes(f.name));
}
fixtures.sort((a, b) => a.bytes - b.bytes);
if (fixtures.length === 0) {
  console.error('no fixtures matched');
  process.exit(1);
}

// stdio must be consumed or ignored: an unread pipe fills up and blocks the
// server mid-response, deadlocking the bench.
const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: resolve(repoRoot, 'packages/viewer-core'), shell: true, stdio: 'ignore' },
);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite preview did not start');
}

const swiftshaderArgs = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
];

function fmt(v, unit = '') {
  if (v === undefined || v === null) return '-';
  return `${v}${unit}`;
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--headless=new',
      '--js-flags=--expose-gc',
      ...(useGpu ? ['--ignore-gpu-blocklist'] : swiftshaderArgs),
    ],
  });

  const results = [];
  for (const fixture of fixtures) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/?panels=off&devbar=off`);
    await page.waitForFunction(() => !!window.__viewer);

    const t0 = Date.now();
    let failed = null;
    try {
      await page.evaluate(
        (name) => window.__viewer.loadFixture(name),
        fixture.name,
      );
      await page.waitForFunction(() => window.__viewer.isReady(), undefined, {
        timeout: 300000,
      });
    } catch (err) {
      failed = String(err).split('\n')[0];
    }
    const wallMs = Date.now() - t0;

    if (failed) {
      results.push({ name: fixture.name, bytes: fixture.bytes, failed, wallMs });
      log(`${fixture.name.padEnd(12)} FAILED after ${wallMs} ms: ${failed}`);
      await page.close();
      continue;
    }

    // One interactive render after load so draw calls reflect a full frame.
    const sample = await page.evaluate(() => {
      const v = window.__viewer;
      v.fitToModel();
      const timeline = v.getLoadTimeline() ?? {};
      const stats = v.getStats() ?? {};
      const info = v.getRendererInfo();
      const scene = v.getSceneInfo();
      const memory = performance.memory;
      return {
        timeline,
        renderMs: undefined,
        drawCalls: info.calls,
        geometries: info.geometries,
        meshes: scene.meshCount,
        triangles: scene.triangleCount,
        entities: stats.totalEntities,
        heapMb: memory ? Math.round(memory.usedJSHeapSize / 1e6) : undefined,
      };
    });
    const renderMs = await page.evaluate(() => {
      const v = window.__viewer;
      const t = performance.now();
      v.fitToModel();
      return Math.round((performance.now() - t) * 10) / 10;
    });
    // Interior view: camera at the model center looking along +x, so cells
    // behind and beside the camera leave the frustum. Reports how many draw
    // calls per-chunk culling rejects during interior navigation.
    const zoom = await page.evaluate(() => {
      const v = window.__viewer;
      const b = v.getSceneInfo().bounds;
      const c = [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
      ];
      const ext = Math.max(b.max[0] - b.min[0], 1);
      v.setCamera({ position: c, target: [c[0] + ext, c[1], c[2]] });
      const t = performance.now();
      v.setCamera({ position: c, target: [c[0] + ext, c[1], c[2] + ext * 0.01] });
      const ms = Math.round((performance.now() - t) * 10) / 10;
      const calls = v.getRendererInfo().calls;
      v.fitToModel();
      return { ms, calls };
    });

    const r = {
      name: fixture.name,
      bytes: fixture.bytes,
      wallMs,
      firstGeometryMs: Math.round(sample.timeline.firstGeometryMs ?? -1),
      downloadMs: Math.round(sample.timeline.downloadMs ?? -1),
      parseMs: Math.round(sample.timeline.parseMs ?? -1),
      geometryMs: Math.round(sample.timeline.geometryMs ?? -1),
      uploadMs: Math.round(sample.timeline.uploadMs ?? -1),
      renderMs,
      zoomMs: zoom.ms,
      zoomCalls: zoom.calls,
      drawCalls: sample.drawCalls,
      geometries: sample.geometries,
      meshes: sample.meshes,
      triangles: sample.triangles,
      entities: sample.entities,
      heapMb: sample.heapMb,
      pageErrors: errors,
    };
    results.push(r);
    log(
      `${fixture.name.padEnd(12)} ${(fixture.bytes / 1e6).toFixed(1).padStart(6)} MB  ` +
        `total ${String(r.wallMs).padStart(6)} ms  first ${String(r.firstGeometryMs).padStart(6)} ms  ` +
        `parse ${String(r.parseMs).padStart(6)} ms  geom ${String(r.geometryMs).padStart(6)} ms  ` +
        `upload ${String(r.uploadMs).padStart(5)} ms  render ${String(renderMs).padStart(6)} ms  ` +
        `zoom ${String(r.zoomMs).padStart(5)} ms/${String(r.zoomCalls).padStart(4)}c  ` +
        `calls ${String(r.drawCalls).padStart(4)}  meshes ${String(r.meshes).padStart(6)}  ` +
        `tris ${(r.triangles / 1e6).toFixed(2).padStart(6)}M  heap ${fmt(r.heapMb, ' MB')}`,
    );
    if (errors.length) log(`  page errors: ${errors.join(' | ')}`);
    await page.close();
  }

  await browser.close();
  if (jsonOut) {
    writeFileSync(resolve(repoRoot, jsonOut), JSON.stringify(results, null, 2));
    log(`written ${jsonOut}`);
  }
} finally {
  server.kill('SIGTERM');
  // On Windows the shell-spawned tree needs a hard kill.
  if (process.platform === 'win32' && server.pid) {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}
