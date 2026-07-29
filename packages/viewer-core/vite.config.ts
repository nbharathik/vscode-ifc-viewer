import {
  cpSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const publicDir = resolve(here, 'harness/public');

/** Copy only when size or mtime differ; local fixtures can be hundreds of MB. */
function copyIfChanged(src: string, dest: string): void {
  if (existsSync(dest)) {
    const s = statSync(src);
    const d = statSync(dest);
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return;
  }
  cpSync(src, dest);
}

// web-ifc.wasm and the IFC fixtures must be fetchable by the harness page. We
// stage them into harness/public (gitignored) so both the dev server and the
// production build (vite preview, used by Playwright) serve them as static
// files. fixtures/index.json lists what was staged for the dev bar dropdown.
function stageAssets(): Plugin {
  const copy = () => {
    mkdirSync(resolve(publicDir, 'fixtures'), { recursive: true });
    copyIfChanged(
      resolve(repoRoot, 'node_modules/web-ifc/web-ifc.wasm'),
      resolve(publicDir, 'web-ifc.wasm'),
    );
    const fixturesSrc = resolve(repoRoot, 'fixtures');
    for (const file of readdirSync(fixturesSrc)) {
      if (file.endsWith('.ifc')) {
        copyIfChanged(resolve(fixturesSrc, file), resolve(publicDir, 'fixtures', file));
      }
    }
    // big.ifc is committed gzipped; decompress it for the harness.
    const bigGz = resolve(fixturesSrc, 'big.ifc.gz');
    if (existsSync(bigGz) && !existsSync(resolve(publicDir, 'fixtures', 'big.ifc'))) {
      writeFileSync(resolve(publicDir, 'fixtures', 'big.ifc'), gunzipSync(readFileSync(bigGz)));
    }
    // A deliberately invalid file to exercise the error card.
    writeFileSync(
      resolve(publicDir, 'fixtures', 'corrupt.ifc'),
      'This is not a valid IFC file.\n',
    );
    const staged = readdirSync(resolve(publicDir, 'fixtures'))
      .filter((f) => f.endsWith('.ifc'))
      .sort()
      .map((f) => ({
        name: f.replace(/\.ifc$/, ''),
        bytes: statSync(resolve(publicDir, 'fixtures', f)).size,
      }));
    writeFileSync(
      resolve(publicDir, 'fixtures', 'index.json'),
      JSON.stringify(staged, null, 2),
    );
  };
  return {
    name: 'stage-ifc-assets',
    buildStart: copy,
    configureServer: copy,
  };
}

// The harness page is the Playwright test target. Determinism concerns
// (devicePixelRatio, camera poses, no animation during snapshots) live in the
// specs and the viewer; this config only builds/serves the page + its assets.
export default defineConfig({
  root: 'harness',
  publicDir: 'public',
  plugins: [stageAssets()],
  build: {
    outDir: '../dist-harness',
    emptyOutDir: true,
    target: 'es2022',
    // Three.js + web-ifc are the app; the default 500 kB nag does not apply.
    chunkSizeWarningLimit: 6000,
  },
  preview: {
    port: 4317,
    strictPort: true,
    host: '127.0.0.1',
  },
  server: {
    port: 4317,
    strictPort: true,
    host: '127.0.0.1',
  },
});
