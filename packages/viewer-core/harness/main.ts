// Harness entry: a thin host around createViewer() exposing window.__viewer test
// hooks plus a small dev bar (open a local IFC, pick a staged fixture, drop a
// file on the viewport). The Playwright specs drive the viewer exclusively
// through the hooks so the Node/browser split stays clean. Assets
// (web-ifc.wasm, fixtures) are served from /public by the Vite stage plugin.
import { createViewer } from '../src/viewer.js';
import { CancelledError } from '../src/engine/types.js';
import type { HarnessHooks } from './harness-types.js';

const app = document.getElementById('app');
if (!app) {
  throw new Error('harness: #app container missing');
}

// Scene-only specs pass ?panels=off so their canvas snapshots stay panel-free.
const params = new URLSearchParams(window.location.search);
const panels = params.get('panels') !== 'off';
// ?engine=inline forces the main-thread engine (worker comparison, debugging).
const useWorker = params.get('engine') !== 'inline';

const viewer = createViewer(app, {
  wasmPath: '/',
  wasmAbsolute: true,
  background: 0x1e1e1e,
  panels,
  worker: useWorker
    ? {
        factory: () =>
          new Worker(new URL('../src/engine/worker.entry.ts', import.meta.url), {
            type: 'module',
          }),
      }
    : false,
});

// Emulated VS Code theme variable sets. The dark set matches the CSS fallbacks
// used in the panels so it is visually consistent; light flips them.
const THEMES: Record<'light' | 'dark', Record<string, string>> = {
  dark: {
    '--vscode-editor-background': '#1e1e1e',
    '--vscode-editor-foreground': '#cccccc',
    '--vscode-editorWidget-background': '#252526',
    '--vscode-widget-border': '#3c3c3c',
    '--vscode-sideBarSectionHeader-background': '#2d2d2d',
    '--vscode-list-activeSelectionBackground': '#094771',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-button-background': '#0e639c',
    '--vscode-badge-background': '#4d4d4d',
    '--vscode-badge-foreground': '#ffffff',
    '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
  },
  light: {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#1f1f1f',
    '--vscode-editorWidget-background': '#f3f3f3',
    '--vscode-widget-border': '#c8c8c8',
    '--vscode-sideBarSectionHeader-background': '#e7e7e7',
    '--vscode-list-activeSelectionBackground': '#cce0ff',
    '--vscode-list-activeSelectionForeground': '#000000',
    '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-button-background': '#005fb8',
    '--vscode-badge-background': '#cccccc',
    '--vscode-badge-foreground': '#000000',
    '--vscode-scrollbarSlider-background': 'rgba(100, 100, 100, 0.4)',
  },
};

function setTheme(kind: 'light' | 'dark'): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(THEMES[kind])) {
    root.style.setProperty(key, value);
  }
  document.body.style.background = THEMES[kind]['--vscode-editor-background'];
  viewer.updateTheme();
}

let progressLog: string[] = [];

function logPhase(phase: string): void {
  if (progressLog[progressLog.length - 1] !== phase) progressLog.push(phase);
}

async function loadFixture(name: string): Promise<void> {
  progressLog = [];
  await viewer.load(
    { kind: 'url', url: `/fixtures/${name}.ifc`, fileName: `${name}.ifc` },
    { onProgress: (p) => logPhase(p.phase) },
  );
}

async function loadLocalFile(file: File): Promise<void> {
  progressLog = [];
  const bytes = new Uint8Array(await file.arrayBuffer());
  await viewer.load(bytes, { onProgress: (p) => logPhase(p.phase) });
}

const hooks: HarnessHooks = {
  loadFixture,
  getStats: () => viewer.getStats(),
  setCamera: (pose) => viewer.setCamera(pose),
  getCamera: () => viewer.getCamera(),
  getViewport: () => viewer.getViewport(),
  fitToModel: () => viewer.fitToModel(),
  fitToElement: (expressID) => viewer.fitToElement(expressID),
  fitToSelection: () => viewer.fitToSelection(),
  setStandardView: (view) => viewer.setStandardView(view),
  getProjection: () => viewer.getProjection(),
  setProjection: (mode) => viewer.setProjection(mode),
  pickAt: (x, y) => viewer.pickAt(x, y),
  getSceneInfo: () => viewer.getSceneInfo(),
  getSpatialTree: () => viewer.getSpatialTree(),
  getSelection: () => viewer.getSelection(),
  select: (expressID) => viewer.select(expressID),
  clearSelection: () => viewer.clearSelection(),
  hideSelected: () => viewer.hideSelected(),
  isolateSelected: () => viewer.isolateSelected(),
  showAll: () => viewer.showAll(),
  isSubtreeVisible: (expressID) => viewer.isSubtreeVisible(expressID),
  toggleSubtreeVisible: (expressID) => viewer.toggleSubtreeVisible(expressID),
  setCategoryVisible: (category, visible) => viewer.setCategoryVisible(category, visible),
  isCategoryVisible: (category) => viewer.isCategoryVisible(category),
  showStatistics: () => viewer.showStatistics(),
  setTreeVisible: (visible) => viewer.setTreeVisible(visible),
  isTreeVisible: () => viewer.isTreeVisible(),
  setPropertiesVisible: (visible) => viewer.setPropertiesVisible(visible),
  arePropertiesVisible: () => viewer.arePropertiesVisible(),
  setPanelsVisible: (visible) => viewer.setPanelsVisible(visible),
  arePanelsVisible: () => viewer.arePanelsVisible(),
  togglePanels: () => viewer.togglePanels(),
  getSectionState: () => viewer.getSectionState(),
  setSectionEnabled: (enabled) => viewer.setSectionEnabled(enabled),
  setSectionAxis: (axis) => viewer.setSectionAxis(axis),
  setSectionPosition: (position) => viewer.setSectionPosition(position),
  setSectionFlipped: (flipped) => viewer.setSectionFlipped(flipped),
  resetSection: () => viewer.resetSection(),
  getFilterOptions: () => viewer.getFilterOptions(),
  getTypeFilter: () => viewer.getTypeFilter(),
  setTypeFilter: (types) => viewer.setTypeFilter(types),
  getStoreyFilter: () => viewer.getStoreyFilter(),
  setStoreyFilter: (storeys) => viewer.setStoreyFilter(storeys),
  resetFilters: () => viewer.resetFilters(),
  getViewState: () => viewer.getViewState(),
  applyViewState: (state) => viewer.applyViewState(state),
  setTheme: (kind) => setTheme(kind),
  getProgressLog: () => progressLog,
  getRendererInfo: () => viewer.getRendererInfo(),
  dispose: () => viewer.dispose(),
  getProperties: (expressID) => viewer.getProperties(expressID),
  isReady: () => viewer.isReady(),
  render: () => viewer.render(),
  setPerfHud: () => viewer.togglePerfHud(),
  getLoadTimeline: () => viewer.getLoadTimeline(),
  cancelLoad: () => viewer.cancelLoad(),
  getResolutionScale: () => viewer.getResolutionScale(),
};

window.__viewer = hooks;

// -- dev bar (harness only, not part of the shipped viewer) -----------------

interface FixtureEntry {
  name: string;
  bytes: number;
}

function fmtMb(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} kB`;
}

function mountDevBar(): void {
  const GEAR_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  const bar = document.createElement('div');
  bar.id = 'devbar';
  bar.className = 'collapsed';
  bar.innerHTML = `
    <button id="devbar-toggle" title="Developer tools" aria-expanded="false">${GEAR_ICON}</button>
    <div id="devbar-menu">
      <button id="devbar-open">Open IFC…</button>
      <select id="devbar-fixtures" title="Staged fixtures"><option value="">Fixtures…</option></select>
      <button id="devbar-perf" title="Toggle performance HUD (P)">Performance HUD</button>
      <div id="devbar-status"></div>
    </div>
    <input id="devbar-file" type="file" accept=".ifc" style="display:none" />
  `;
  document.body.appendChild(bar);

  const style = document.createElement('style');
  style.textContent = `
    #devbar {
      /* Right of center so it never collides with the viewer toolbar (top
         left) or the properties panel (right edge). */
      position: absolute; top: 8px; right: 296px; z-index: 30;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font-family: system-ui, sans-serif; font-size: 11px;
      color: var(--vscode-editor-foreground, #ccc);
    }
    #devbar-toggle {
      width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
      padding: 0; cursor: pointer;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-editor-foreground, #ccc);
      border: 1px solid var(--vscode-widget-border, #3c3c3c);
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    #devbar-toggle:hover { filter: brightness(1.15); }
    #devbar-toggle svg { width: 16px; height: 16px; display: block; }
    #devbar-toggle[aria-expanded="true"] {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    #devbar-menu {
      display: flex; flex-direction: column; gap: 5px;
      min-width: 180px; max-width: 260px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #3c3c3c);
      border-radius: 6px; padding: 8px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
    }
    #devbar.collapsed #devbar-menu { display: none; }
    #devbar-menu button, #devbar-menu select {
      font: inherit; cursor: pointer; width: 100%; text-align: left;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid transparent; border-radius: 4px; padding: 4px 10px;
    }
    #devbar-menu button:hover, #devbar-menu select:hover { filter: brightness(1.15); }
    #devbar-status {
      opacity: 0.8; font-size: 10px; line-height: 1.5;
      overflow-wrap: break-word; white-space: normal;
    }
    #devbar-status:empty { display: none; }
    #devbar-drop {
      position: absolute; inset: 0; z-index: 29; display: none;
      align-items: center; justify-content: center;
      background: rgba(14, 99, 156, 0.25);
      border: 2px dashed var(--vscode-button-background, #0e639c);
      color: #fff; font: 600 16px system-ui, sans-serif; pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  const drop = document.createElement('div');
  drop.id = 'devbar-drop';
  drop.textContent = 'Drop IFC file to open';
  app!.appendChild(drop);

  const toggle = bar.querySelector<HTMLButtonElement>('#devbar-toggle')!;
  const select = bar.querySelector<HTMLSelectElement>('#devbar-fixtures')!;
  const openBtn = bar.querySelector<HTMLButtonElement>('#devbar-open')!;
  const perfBtn = bar.querySelector<HTMLButtonElement>('#devbar-perf')!;
  const fileInput = bar.querySelector<HTMLInputElement>('#devbar-file')!;
  const status = bar.querySelector<HTMLSpanElement>('#devbar-status')!;

  toggle.addEventListener('click', () => {
    const collapsed = bar.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
  perfBtn.addEventListener('click', () => viewer.togglePerfHud());

  const report = (label: string) => {
    const t = viewer.getLoadTimeline();
    const stats = viewer.getStats();
    if (!t || !stats) {
      status.textContent = label;
      return;
    }
    const total = t.totalMs !== undefined ? `${(t.totalMs / 1000).toFixed(2)}s` : '?';
    const first =
      t.firstGeometryMs !== undefined ? `${(t.firstGeometryMs / 1000).toFixed(2)}s` : '?';
    status.textContent =
      `${label}: ${total} (first geometry ${first}), ` +
      `${stats.meshCount} meshes, ${(stats.triangleCount / 1e6).toFixed(2)}M tris`;
    status.title = status.textContent;
  };

  const run = async (label: string, task: Promise<void>) => {
    status.textContent = `loading ${label}…`;
    try {
      await task;
      report(label);
    } catch (err) {
      status.textContent =
        err instanceof CancelledError ? 'cancelled' : `failed: ${String(err)}`;
    }
  };

  void fetch('/fixtures/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<FixtureEntry[]>) : []))
    .then((entries) => {
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.name;
        option.textContent = `${entry.name} (${fmtMb(entry.bytes)})`;
        select.appendChild(option);
      }
    })
    .catch(() => undefined);

  select.addEventListener('change', () => {
    if (select.value) void run(select.value, loadFixture(select.value));
  });

  openBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void run(file.name, loadLocalFile(file));
    fileInput.value = '';
  });

  let dragDepth = 0;
  app!.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    drop.style.display = 'flex';
  });
  app!.addEventListener('dragover', (e) => e.preventDefault());
  app!.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      drop.style.display = 'none';
    }
  });
  app!.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.style.display = 'none';
    const file = e.dataTransfer?.files?.[0];
    if (file) void run(file.name, loadLocalFile(file));
  });
}

// The dev bar is for humans; specs run with ?panels=off or ?devbar=off and
// never see it, so snapshots stay clean.
if (params.get('devbar') !== 'off' && panels) {
  mountDevBar();
}

const autoFixture = params.get('fixture');
if (autoFixture) {
  void loadFixture(autoFixture).catch(() => undefined);
}

app.setAttribute('data-harness-ready', 'true');
