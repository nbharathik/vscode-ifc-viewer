// esbuild bundler for the extension host (CJS, node) and the webview script
// (IIFE, browser) which imports the bundled viewer-core.
import { build, context } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
const watch = process.argv.includes('--watch');
// --production: minified, no sourcemaps (used by `npm run package`).
const production = process.argv.includes('--production');

// web-ifc loads its wasm at runtime (not via import), so stage it next to the
// webview bundle; the provider serves it through asWebviewUri from dist/.
function copyWasm() {
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(
    resolve(repoRoot, 'node_modules/web-ifc/web-ifc.wasm'),
    join(root, 'dist/web-ifc.wasm'),
  );
}

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const webviewEntry = join(root, 'src/webview/main.ts');
/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: [webviewEntry],
  outfile: join(root, 'dist/webview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  loader: { '.wasm': 'file' },
};

// Parser worker: viewer-core's worker entry bundled standalone (esm module
// worker, no imports left) so the webview can boot it from a blob URL.
const workerEntry = resolve(repoRoot, 'packages/viewer-core/src/engine/worker.entry.ts');
/** @type {import('esbuild').BuildOptions} */
const workerConfig = {
  entryPoints: [workerEntry],
  outfile: join(root, 'dist/ifc-worker.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  loader: { '.wasm': 'file' },
};

const configs = [hostConfig];
if (existsSync(webviewEntry)) {
  configs.push(webviewConfig, workerConfig);
}

if (watch) {
  for (const cfg of configs) {
    const ctx = await context(cfg);
    await ctx.watch();
  }
  copyWasm();
  console.log('esbuild watching…');
} else {
  await Promise.all(configs.map((cfg) => build(cfg)));
  copyWasm();
}
