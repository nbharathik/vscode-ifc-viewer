// Webview entry (bundled by esbuild into dist/webview.js). Hosts the bundled
// viewer-core and bridges the typed protocol to the extension host. This file
// may import @vscode-ifc-viewer/core (which brings Three.js + web-ifc) but never
// imports `three`/`web-ifc` directly - the layer ban only forbids direct imports.
import { createViewer, CancelledError } from '@vscode-ifc-viewer/core';
import type { ViewerViewState } from '@vscode-ifc-viewer/core';
import type { HostToWebview, WebviewToHost } from '../protocol.js';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  setState(state: unknown): void;
  getState(): unknown;
}

/** Webview state persisted through VS Code across tab hide/restore/reload. */
interface PersistedState {
  fileName: string;
  view: ViewerViewState;
}
declare function acquireVsCodeApi(): VsCodeApi;
declare global {
  interface Window {
    __IFC_WASM_DIR__?: string;
    __IFC_WORKER_URL__?: string;
  }
}

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHost): void => vscode.postMessage(message);

const app = document.getElementById('app');
if (!app) {
  post({ type: 'error', message: 'webview: #app container missing' });
  throw new Error('#app missing');
}

const viewer = createViewer(app, {
  wasmPath: window.__IFC_WASM_DIR__ ?? '/',
  wasmAbsolute: true,
  panels: true,
  worker: window.__IFC_WORKER_URL__ ? { url: window.__IFC_WORKER_URL__ } : false,
});
// Boot the worker and wasm engine while the ready/load handshake with the
// extension host is in flight, so the first load starts parsing immediately.
viewer.warmup();

function showError(message: string): void {
  app!.insertAdjacentHTML(
    'beforeend',
    `<div role="alert" style="position:absolute;inset:auto 16px 16px 16px;max-width:480px;
      background:var(--vscode-inputValidation-errorBackground,#5a1d1d);
      color:var(--vscode-foreground,#fff);
      border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);
      border-radius:6px;padding:10px 12px;font-family:var(--vscode-font-family,sans-serif);
      font-size:12px;z-index:20;">
      <strong>Could not open IFC file</strong><br/>${escapeHtml(message)}</div>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

interface LoadRequest {
  source: { kind: 'url'; url: string; fileName?: string } | { kind: 'bytes'; bytes: Uint8Array };
  fileName: string;
  isUrl: boolean;
}

// -- view-state persistence -------------------------------------------------
// VS Code can rebuild a hidden webview from scratch; getState/setState keeps
// the working camera, panel, section and filter state across that.
let currentFileName: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function readPersisted(): PersistedState | null {
  const raw = vscode.getState();
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Partial<PersistedState>;
  return typeof state.fileName === 'string' && state.view ? (state as PersistedState) : null;
}

function saveViewState(): void {
  if (!currentFileName || !viewer.isReady()) return;
  vscode.setState({ fileName: currentFileName, view: viewer.getViewState() } satisfies PersistedState);
}

viewer.onViewChanged(() => {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveViewState();
  }, 250);
});

function restoreViewState(fileName: string): void {
  const persisted = readPersisted();
  if (persisted && persisted.fileName === fileName) {
    viewer.applyViewState(persisted.view);
  }
}

async function runLoad({ source, fileName, isUrl }: LoadRequest): Promise<void> {
  try {
    const model = await viewer.load(source, {
      onProgress: (p) =>
        post({
          type: 'progress',
          phase: p.phase,
          entities: p.entities,
          totalEntities: p.totalEntities,
          meshes: p.meshes,
          bytesLoaded: p.bytesLoaded,
          bytesTotal: p.bytesTotal,
        }),
    });
    currentFileName = fileName;
    restoreViewState(fileName);
    post({
      type: 'loaded',
      stats: {
        fileName,
        meshCount: model.stats.meshCount,
        triangleCount: model.stats.triangleCount,
        totalEntities: model.stats.totalEntities,
        parseMs: model.stats.parseMs,
        geometryMs: model.stats.geometryMs,
        downloadMs: model.stats.downloadMs,
        uploadMs: model.stats.uploadMs,
        fileBytes: model.stats.fileBytes,
      },
    });
  } catch (err) {
    if (err instanceof CancelledError) return;
    const message = err instanceof Error ? err.message : String(err);
    if (isUrl) {
      // The URI was not fetchable (virtual FS, auth) - ask for bytes instead.
      post({ type: 'log', message: `url load failed, requesting bytes: ${message}` });
      post({ type: 'loadUrlFailed', message });
      return;
    }
    showError(message);
    post({ type: 'error', message });
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      if (msg.src) {
        void runLoad({
          source: { kind: 'url', url: msg.src, fileName: msg.fileName },
          fileName: msg.fileName,
          isUrl: true,
        });
      } else if (msg.buffer) {
        void runLoad({
          source: { kind: 'bytes', bytes: new Uint8Array(msg.buffer) },
          fileName: msg.fileName,
          isUrl: false,
        });
      }
      break;
    case 'command':
      if (msg.command === 'resetView') viewer.fitToModel();
      else if (msg.command === 'showStatistics') viewer.showStatistics();
      else if (msg.command === 'toggleTree') viewer.toggleTree();
      else if (msg.command === 'toggleProperties') viewer.toggleProperties();
      break;
    case 'theme':
      // VS Code updates its CSS variables live; re-read them into the viewport.
      viewer.updateTheme();
      break;
  }
});

post({ type: 'ready' });
