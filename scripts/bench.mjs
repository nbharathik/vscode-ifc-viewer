// Load benchmark against the built harness. Opens each staged fixture in
// headless Chromium and reports wall time, phase timings, draw calls and heap.
//
//   node scripts/bench.mjs               # all staged fixtures (small first)
//   node scripts/bench.mjs big model_68  # specific fixtures by name
//   node scripts/bench.mjs --gpu         # real GPU instead of SwiftShader
//   node scripts/bench.mjs --json out.json
//   node scripts/bench.mjs --ab --repeat 3   # alternate page-alone and
//                                        # page-plus-session, report the change
//   node scripts/bench.mjs --ab --defer      # same, but the session opens after
//                                        # the page is done (the shipped behaviour)
//   node scripts/bench.mjs --session     # also open each model in the Python
//                                        # model server while the page loads,
//                                        # then time edits (needs IfcOpenShell)
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
const withSession = args.includes('--session');
const abMode = args.includes('--ab');
const deferSession = args.includes('--defer');
// --repeat N runs every fixture N times and prints the best run of each: on a
// busy machine a single wall-clock number says more about the machine.
const repeatIndex = args.indexOf('--repeat');
const repeat = repeatIndex >= 0 ? Math.max(1, Number(args[repeatIndex + 1]) || 1) : 1;
const jsonIndex = args.indexOf('--json');
const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
const repeatValue = repeatIndex >= 0 ? args[repeatIndex + 1] : null;
const nameFilter = args.filter((a) => !a.startsWith('--') && a !== jsonOut && a !== repeatValue);

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

/** Minimal client for the Python model server (Content-Length framed JSON-RPC). */
class ModelServerClient {
  constructor() {
    this.proc = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'ifc_viewer_server'], {
      cwd: resolve(repoRoot, 'packages/model-server'),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.waiting = new Map();
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())[1]);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
        this.buffer = this.buffer.subarray(end + 4 + length);
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((done, fail) => {
      this.waiting.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    });
  }

  close() {
    this.proc.stdin.end();
  }
}

/** Time the operations a user or agent triggers on an open model. */
async function timeSessionOps(client, doc) {
  const time = async (fn) => {
    const t = performance.now();
    const value = await fn();
    return [Math.round((performance.now() - t) * 10) / 10, value];
  };
  const [treeMs] = await time(() => client.call('tree', { doc }));
  const picked = await client.call('query', {
    doc,
    code:
      "ps = [p for p in model.by_type('IfcWall') if p.Representation] or [p for p in model.by_type('IfcProduct') if p.Representation]\n" +
      'print(ps[0].id() if ps else -1)\n',
  });
  const id = Number(picked.output.trim());
  if (!(id > 0)) return { treeMs };
  const [propsMs] = await time(() => client.call('properties', { doc, id }));
  const [editMs] = await time(() =>
    client.call('edit', { doc, ops: [{ op: 'setAttribute', id, name: 'Name', value: 'bench' }] }),
  );
  const [moveMs, moved] = await time(() =>
    client.call('edit', { doc, ops: [{ op: 'setPlacement', id, location: [1, 2, 0] }] }),
  );
  const [undoMs] = await time(() => client.call('undo', { doc }));
  return { treeMs, propsMs, editMs, moveMs, undoMs, patchTriangles: moved.patch ? moved.patch.geometries.reduce((n, g) => n + g.indexCount / 3, 0) : 0 };
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
  const client = withSession || abMode ? new ModelServerClient() : null;
  if (client) await client.call('ping');
  // --ab alternates "page alone" and "page plus session" for every model and
  // round, so slow drift on a busy machine hits both sides equally.
  const jobs = [];
  for (let round = 0; round < repeat; round++) {
    for (const fixture of fixtures) {
      if (abMode) jobs.push({ fixture, session: false }, { fixture, session: true });
      else jobs.push({ fixture, session: withSession });
    }
  }
  for (const { fixture, session: jobSession } of jobs) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/?panels=off&devbar=off`);
    await page.waitForFunction(() => !!window.__viewer);

    // With --session the model opens in the Python server at the same moment
    // the page starts loading, which is what really happens in the editor.
    // With --defer it opens only after the page has finished (what the
    // extension does now), and readyMs is counted from that moment.
    let sessionStart = Date.now();
    const openSession = () => {
      sessionStart = Date.now();
      return client
        .call('open', { doc: fixture.name, path: resolve(repoRoot, 'fixtures', `${fixture.name}.ifc`) })
        .then(
          (info) => ({ info, readyMs: Date.now() - sessionStart }),
          (err) => ({ error: String(err) }),
        );
    };
    let opening = client && jobSession && !deferSession ? openSession() : null;

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
    if (client && jobSession && deferSession && !failed) opening = openSession();

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
      withSession: jobSession,
    };
    if (opening) {
      const opened = await opening;
      if (opened.error) {
        r.sessionError = opened.error;
      } else {
        r.sessionReadyMs = opened.readyMs;
        r.sessionMb = opened.info.memoryMb;
        // Close the page first: edits are timed on an idle machine, so the
        // numbers are the server's own cost, not contention with rendering.
        await page.close();
        page.__closed = true;
        Object.assign(r, await timeSessionOps(client, fixture.name));
        await client.call('close', { doc: fixture.name });
      }
    }
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
    if (opening) {
      log(
        r.sessionError
          ? `  session: ${r.sessionError}`
          : `  session: ready ${fmt(r.sessionReadyMs, ' ms')}  rss ${fmt(r.sessionMb, ' MB')} ` +
              `(${r.sessionMb ? (r.sessionMb / (fixture.bytes / 1e6)).toFixed(1) : '-'}x file)  ` +
              `tree ${fmt(r.treeMs, ' ms')}  props ${fmt(r.propsMs, ' ms')}  edit ${fmt(r.editMs, ' ms')}  ` +
              `move ${fmt(r.moveMs, ' ms')} (${fmt(r.patchTriangles, ' tris')})  undo ${fmt(r.undoMs, ' ms')}`,
      );
    }
    if (errors.length) log(`  page errors: ${errors.join(' | ')}`);
    if (!page.__closed) await page.close();
  }

  client?.close();
  await browser.close();
  if (abMode) {
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    log(`\nA/B over ${repeat} round(s): page alone (A) versus page plus model server opening at the same time (B)`);
    for (const fixture of fixtures) {
      const a = results.filter((x) => x.name === fixture.name && !x.withSession && !x.failed);
      const b = results.filter((x) => x.name === fixture.name && x.withSession && !x.failed);
      if (!a.length || !b.length) continue;
      const row = (key) => {
        const ma = median(a.map((x) => x[key]));
        const mb = median(b.map((x) => x[key]));
        return `${key} ${ma} -> ${mb} ms (${((mb / ma - 1) * 100).toFixed(0)}%)`;
      };
      log(`${fixture.name.padEnd(12)} ${row('wallMs')}   ${row('firstGeometryMs')}   session ready ${median(b.map((x) => x.sessionReadyMs ?? NaN))} ms`);
    }
  }
  if (repeat > 1 && !abMode) {
    log(`\nbest of ${repeat} (lowest total per model):`);
    for (const fixture of fixtures) {
      const runs = results.filter((x) => x.name === fixture.name && !x.failed);
      if (runs.length === 0) continue;
      const best = runs.reduce((a, b) => (b.wallMs < a.wallMs ? b : a));
      const min = (key) => Math.min(...runs.map((x) => x[key]).filter((v) => typeof v === 'number'));
      log(
        `${best.name.padEnd(12)} total ${String(best.wallMs).padStart(6)} ms  first ${String(best.firstGeometryMs).padStart(6)} ms` +
          (withSession
            ? `  | session ready ${fmt(min('sessionReadyMs'), ' ms')}  rss ${fmt(best.sessionMb, ' MB')}  ` +
              `props ${fmt(min('propsMs'), ' ms')}  edit ${fmt(min('editMs'), ' ms')}  move ${fmt(min('moveMs'), ' ms')}  undo ${fmt(min('undoMs'), ' ms')}`
            : ''),
      );
    }
  }
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
