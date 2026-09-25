// Webview entry (bundled by esbuild into dist/webview.js). Hosts the bundled
// viewer-core and bridges the typed protocol to the extension host. This file
// may import @vscode-ifc-viewer/core (which brings Three.js + web-ifc) but never
// imports `three`/`web-ifc` directly - the layer ban only forbids direct imports.
import { createViewer, CancelledError } from '@vscode-ifc-viewer/core';
import type { ToolbarButtonHandle, ViewerViewState } from '@vscode-ifc-viewer/core';
import type {
  AgentStatus,
  BridgeCommand,
  HostToWebview,
  WebviewConfig,
  WebviewToHost,
} from '../protocol.js';
import { applyBridgeCommand, DEFAULT_HIGHLIGHT_LABEL, describeElement } from './bridgeOps.js';

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
  reload: boolean;
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

// -- agent bridge -------------------------------------------------------------
// Everything here is inert until the host reports a connection: no selection
// messages, no GlobalId index, no state reports.
let agent: AgentStatus = { available: false, connected: false };
let config: WebviewConfig = { showLegend: true, revealHiddenCategories: true };

/** Agent highlight groups and isolate, kept by GlobalId so a reload can re-apply them. */
const agentHighlights = new Map<string, { globalIds: string[]; color: string }>();
let agentIsolate: string[] | null = null;

const PLUG_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M6 1.5v3M10 1.5v3M8 11.5v3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
  '<path d="M4 4.5h8v2.5a4 4 0 0 1-8 0V4.5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '</svg>';

/** Created on the first "available" status, so a disabled bridge adds no button. */
let agentButton: ToolbarButtonHandle | null = null;

function renderAgentButton(): void {
  if (!agent.available) {
    agentButton?.remove();
    agentButton = null;
    return;
  }
  agentButton ??= viewer.addToolbarButton({
    id: 'btn-agent',
    label: 'Connect to agent',
    icon: PLUG_ICON,
    onClick: () => post({ type: 'agentToggle' }),
  });
  const where = agent.folderName ? ` for "${agent.folderName}"` : '';
  const label = agent.blockedReason
    ? `Connect to agent: ${agent.blockedReason}`
    : agent.connected
      ? `Connected to agent${where}. Click to disconnect.`
      : `Connect to agent${where}: lets an AI agent see your selection and highlight elements (writes .ifc-skills/viewer/).`;
  agentButton?.setLabel(label);
  agentButton?.setActive(agent.connected);
  agentButton?.setDisabled(Boolean(agent.blockedReason));
}

let selectionSeq = 0;
async function reportSelection(): Promise<void> {
  if (!agent.connected || !viewer.isReady()) return;
  const seq = ++selectionSeq;
  const expressID = viewer.getSelection();
  const selection = expressID === null ? null : await describeElement(viewer, expressID);
  if (seq === selectionSeq && agent.connected) post({ type: 'selection', selection });
}

function reportViewerState(): void {
  if (!agent.connected || !viewer.isReady()) return;
  post({ type: 'viewerState', highlights: viewer.getHighlights(), isolated: viewer.isIsolated() });
}

/** Build the GlobalId index in the worker so the first click reports quickly. */
function prewarmGlobalIds(): void {
  if (agent.connected && viewer.isReady()) void viewer.resolveGlobalIds([]).catch(() => undefined);
}

/**
 * True from the start of a load until its agent state is back. Loads clear
 * groups and the isolate themselves; only user actions outside a load may
 * drop them from the agent memory.
 */
let loadingModel = false;

viewer.onSelectionChange(() => void reportSelection());
viewer.onHighlightsChange(() => {
  if (!loadingModel) {
    // A group cleared from the legend is no longer the agent's to re-apply.
    const live = new Set(viewer.getHighlights().map((h) => h.label));
    for (const label of agentHighlights.keys()) if (!live.has(label)) agentHighlights.delete(label);
  }
  reportViewerState();
});
viewer.onVisibilityChange(() => {
  if (!loadingModel && !viewer.isIsolated()) agentIsolate = null;
  reportViewerState();
});

function setAgentStatus(status: AgentStatus): void {
  const wasConnected = agent.connected;
  agent = status;
  renderAgentButton();
  if (agent.connected && !wasConnected) {
    prewarmGlobalIds();
    void reportSelection();
    reportViewerState();
  }
}

// Commands wait for the load in flight, so an agent can open and highlight
// in one go.
let currentLoad: Promise<void> = Promise.resolve();

async function runBridgeCommand(command: BridgeCommand): Promise<void> {
  await currentLoad;
  if (!viewer.isReady()) {
    post({
      type: 'bridgeAck',
      id: command.id,
      ok: false,
      requested: new Set(command.globalIds ?? []).size,
      applied: 0,
      missing: [],
      error: 'No model is loaded in this viewer.',
    });
    return;
  }
  const ack = await applyBridgeCommand(viewer, command, config);
  if (ack.ok) rememberAgentState(command, ack.applied);
  post({ type: 'bridgeAck', ...ack });
}

function rememberAgentState(command: BridgeCommand, applied: number): void {
  if (command.op === 'highlight') {
    const label = command.label?.trim() || DEFAULT_HIGHLIGHT_LABEL;
    const group = viewer.getHighlights().find((h) => h.label === label);
    // Re-insert so reload re-applies groups in their original order.
    agentHighlights.delete(label);
    if (group && applied > 0) {
      agentHighlights.set(label, { globalIds: command.globalIds ?? [], color: group.color });
    }
  } else if (command.op === 'isolate' && applied > 0) {
    agentIsolate = command.globalIds ?? [];
  }
}

/** Re-apply agent state by GlobalId after a reload (ids may have moved). */
async function reapplyAgentState(selectedGlobalId: string | null): Promise<void> {
  for (const [label, { globalIds, color }] of [...agentHighlights]) {
    const { found } = await viewer.resolveGlobalIds(globalIds);
    if (found.length > 0) viewer.setHighlight(label, found.map((f) => f.expressID), color);
    else agentHighlights.delete(label);
  }
  if (agentIsolate) {
    const { found } = await viewer.resolveGlobalIds(agentIsolate);
    if (found.length > 0) viewer.isolate(found.map((f) => f.expressID));
  }
  if (selectedGlobalId) {
    const { found } = await viewer.resolveGlobalIds([selectedGlobalId]);
    if (found.length > 0) viewer.select(found[0].expressID);
  }
}

/**
 * Camera and selection a reload restores. Captured from the model on screen;
 * a reload that replaces a load still in flight keeps the earlier snapshot.
 */
let pendingRestore: { view: ViewerViewState | null; selectedGlobalId: string | null } | null = null;

async function runLoad({ source, fileName, isUrl, reload }: LoadRequest): Promise<void> {
  if (!reload) {
    pendingRestore = null;
    agentHighlights.clear();
    agentIsolate = null;
  } else if (viewer.isReady()) {
    const selected = viewer.getSelection();
    pendingRestore = {
      view: viewer.getViewState(),
      selectedGlobalId: selected === null ? null : await viewer.globalIdOf(selected).catch(() => null),
    };
  }
  loadingModel = true;
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
    const restore = pendingRestore;
    pendingRestore = null;
    if (restore?.view) viewer.applyViewState(restore.view);
    else restoreViewState(fileName);
    if (reload) {
      // The model is on screen; failing to re-apply extras must not turn
      // into a failed load.
      try {
        await reapplyAgentState(restore?.selectedGlobalId ?? null);
      } catch (err) {
        post({ type: 'log', message: `could not re-apply agent state: ${String(err)}` });
      }
    }
    loadingModel = false;
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
    prewarmGlobalIds();
    void reportSelection();
    reportViewerState();
  } catch (err) {
    // A cancelled load was replaced by a newer one, which owns loadingModel
    // and the pending restore from here on.
    if (err instanceof CancelledError) return;
    loadingModel = false;
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

function startLoad(request: LoadRequest): void {
  currentLoad = runLoad(request);
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      if (msg.src) {
        startLoad({
          source: { kind: 'url', url: msg.src, fileName: msg.fileName },
          fileName: msg.fileName,
          isUrl: true,
          reload: msg.reload === true,
        });
      } else if (msg.buffer) {
        startLoad({
          source: { kind: 'bytes', bytes: new Uint8Array(msg.buffer) },
          fileName: msg.fileName,
          isUrl: false,
          reload: msg.reload === true,
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
    case 'bridge': {
      const { type: _type, ...command } = msg;
      void runBridgeCommand(command);
      break;
    }
    case 'agentStatus':
      setAgentStatus(msg.status);
      break;
    case 'config':
      config = msg.config;
      viewer.setHighlightLegendEnabled(config.showLegend);
      break;
    case 'getSelection': {
      const expressID = viewer.getSelection();
      const requestId = msg.requestId;
      void (expressID === null ? Promise.resolve(null) : describeElement(viewer, expressID))
        .catch(() => null)
        .then((selection) => post({ type: 'selectionResult', requestId, selection }));
      break;
    }
  }
});

post({ type: 'ready' });
