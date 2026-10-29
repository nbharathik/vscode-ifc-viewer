// Public viewer entry point: wires the async IFC engine (worker-backed,
// inline fallback) to the scene. Loads are progressive; mesh batches render
// as they arrive. The webview and the browser harness share this surface.
import { WorkerEngine } from './engine/workerEngine.js';
import { InlineEngine } from './engine/inlineEngine.js';
import { SceneController } from './scene/scene.js';
import { ViewerControls } from './scene/controls.js';
import { PropertiesPanel } from './panels/properties.js';
import { TreePanel } from './panels/tree.js';
import { Toolbar } from './panels/toolbar.js';
import { StatsPanel } from './panels/stats.js';
import { HighlightLegend } from './panels/legend.js';
import type { ToolbarButtonHandle, ToolbarButtonSpec } from './panels/toolbar.js';
import { Sidebar } from './panels/sidebar.js';
import type { SidebarTabHandle, SidebarTabSpec } from './panels/sidebar.js';
import { ViewTab } from './panels/viewTab.js';
import { StatusBar } from './panels/statusbar.js';
import type { StatusItemHandle, StatusItemSpec } from './panels/statusbar.js';
import { CommandSearch } from './panels/commandSearch.js';
import { ContextMenu } from './panels/contextMenu.js';
import { Gizmo } from './panels/gizmo.js';
import { ActionRegistry } from './commands/registry.js';
import type { Action } from './commands/registry.js';
import { PerfHud } from './panels/perfHud.js';
import { LoadingOverlay, ErrorCard } from './panels/overlays.js';
import { CancelledError } from './engine/types.js';
import { READ_ONLY_SESSION } from './engine/session.js';
import type { Delta, EditOp, GeometryPatch, ModelSession, SessionState } from './engine/session.js';
import { unpackPatch } from './engine/patch.js';
import { buildSearchIndex, filterElementIDs } from './search.js';
import type { SearchIndex } from './search.js';
import { normalizeColor } from './scene/highlights.js';
import type { HighlightInfo } from './scene/highlights.js';
import type { CameraPose, ProjectionMode, SceneInfo, SectionAxis } from './scene/scene.js';
import type { PickResult, StandardView } from './scene/controls.js';
import type {
  AsyncIfcEngine,
  GlobalIdResolution,
  ItemProperties,
  LazyCategory,
  LoadProgress,
  LoadSource,
  LoadedModel,
  ModelBounds,
  ModelStats,
  SpatialNode,
} from './engine/types.js';

export * from './engine/types.js';
export * from './engine/session.js';
export { unpackPatch } from './engine/patch.js';
export type { CameraPose, ProjectionMode, SceneInfo, SectionAxis } from './scene/scene.js';
export type { StandardView } from './scene/controls.js';
export type { HighlightInfo } from './scene/highlights.js';
export type { ToolbarButtonHandle, ToolbarButtonSpec } from './panels/toolbar.js';
export type { StatusItemHandle, StatusItemSpec } from './panels/statusbar.js';
export type { SidebarTabHandle, SidebarTabSpec } from './panels/sidebar.js';
export type { Action } from './commands/registry.js';
export type { SearchEntry, SearchIndex, StoreyInfo } from './search.js';
export { buildSearchIndex, queryIndex } from './search.js';

export interface ViewerWorkerOptions {
  /** Bundled worker script URL (used with a blob fallback when cross-origin). */
  url?: string;
  /** Factory the host controls (Vite worker import). Preferred when set. */
  factory?: () => Worker;
}

export interface ViewerOptions {
  /** Directory/URL serving web-ifc.wasm (required in the browser). */
  wasmPath?: string;
  wasmAbsolute?: boolean;
  /** Initial viewport background color (overridden by theme later). */
  background?: number;
  /** Mount the overlay panels (tree/properties/toolbar). Default true. */
  panels?: boolean;
  /** Parser worker source; false forces the inline (main thread) engine. */
  worker?: ViewerWorkerOptions | false;
}

export interface ViewerLoadOptions {
  onProgress?: (progress: LoadProgress) => void;
}

export interface LoadTimeline {
  downloadMs?: number;
  parseMs?: number;
  geometryMs?: number;
  uploadMs?: number;
  fileBytes?: number;
  /** Wall time from load start to the first visible geometry. */
  firstGeometryMs?: number;
  /** Wall time for the whole load. */
  totalMs?: number;
}

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  /** Plane position along the axis, in model space. */
  position: number;
  /** false keeps the model below/before the plane; true keeps the other side. */
  flipped: boolean;
  /** Model extent along the current axis, for sliders; null before a load. */
  range: { min: number; max: number } | null;
}

export interface FilterOptions {
  /** Element types present in the scene, with element counts. */
  types: { type: string; count: number }[];
  /** Storeys from the spatial tree, in document order. */
  storeys: { expressID: number; name: string | null }[];
}

/** Serializable snapshot of the working view (used by webview persistence). */
export interface ViewerViewState {
  camera: CameraPose;
  projection: ProjectionMode;
  treeVisible: boolean;
  /** The sidebar (named for the panel it replaced). */
  propertiesVisible: boolean;
  /** The tool shelf. */
  shelfVisible?: boolean;
  /** Active sidebar tab id. */
  sidebarTab?: string;
  section: { enabled: boolean; axis: SectionAxis; position: number; flipped: boolean };
  typeFilter: string[] | null;
  storeyFilter: number[] | null;
}

export interface Viewer {
  /** Load a model from bytes or a URL. URL loads stream through the worker. */
  load(source: Uint8Array | LoadSource, options?: ViewerLoadOptions): Promise<LoadedModel>;
  /** Start booting the parser engine early so the first load skips the wait. */
  warmup(): void;
  /** Cancel the in-flight load, if any. */
  cancelLoad(): void;
  getStats(): ModelStats | null;
  getLoadTimeline(): LoadTimeline | null;
  getSceneInfo(): SceneInfo;
  getSpatialTree(): SpatialNode | null;
  /** Search index over the spatial tree; built once per load, null before one. */
  getSearchIndex(): SearchIndex | null;
  getProperties(expressID: number): Promise<ItemProperties | null>;
  /**
   * Attach (or detach, with null) the editing session that owns the model
   * data. While its state is `ready`, properties, ids and the tree come from
   * it and edits are possible; otherwise the viewer is read-only.
   */
  setSession(session: ModelSession | null, state: SessionState): void;
  getSessionState(): SessionState;
  /** Subscribe to session state changes; returns an unsubscribe function. */
  onSessionChange(listener: () => void): () => void;
  /** Apply an edit result: replace changed geometry, refresh the tree and panels. */
  applyDelta(delta: Delta, patch: GeometryPatch | null): void;
  /** Subscribe to applied edits; returns an unsubscribe function. */
  onModelEdited(listener: (delta: Delta) => void): () => void;
  /** Apply typed edit operations through the session (rejects when read-only). */
  editModel(ops: EditOp[]): Promise<void>;
  undoEdit(): Promise<void>;
  redoEdit(): Promise<void>;
  /**
   * Map IFC GlobalIds (IfcProduct and IfcProject instances) to expressIDs in
   * the loaded model. Without a model every id is missing. Rejects when the
   * model is replaced mid-lookup. The index builds on the first call.
   */
  resolveGlobalIds(globalIds: readonly string[]): Promise<GlobalIdResolution>;
  /** GlobalId of an element in the loaded model, or null. */
  globalIdOf(expressID: number): Promise<string | null>;
  /** Select an element: highlight + notify subscribers. null clears. */
  select(expressID: number | null): void;
  clearSelection(): void;
  getSelection(): number | null;
  /** Subscribe to selection changes; returns an unsubscribe function. */
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  /** Subscribe to model-loaded events; returns an unsubscribe function. */
  onModelLoaded(listener: () => void): () => void;
  /** Subscribe to view-state changes (camera, panels, section, filters). */
  onViewChanged(listener: () => void): () => void;
  /**
   * Colour a named group of elements. Spatial containers (storeys, ...) and
   * aggregates expand to their contents. Reusing a label replaces that group.
   * Newer groups win where groups overlap. Groups sit alongside selection,
   * hide/isolate and filters, and reset when a model loads. `color` is
   * '#rgb', '#rrggbb' or a CSS colour name; omitted, a default is picked.
   * Throws on an empty label or an unknown colour.
   */
  setHighlight(label: string, expressIDs: readonly number[], color?: string): void;
  /** Remove one highlight group, or all of them without a label. */
  clearHighlight(label?: string): void;
  /** Highlight groups, oldest first. */
  getHighlights(): HighlightInfo[];
  /** Subscribe to highlight group changes; returns an unsubscribe function. */
  onHighlightsChange(listener: () => void): () => void;
  /** Show or suppress the highlight legend (shown only while groups exist). */
  setHighlightLegendEnabled(enabled: boolean): void;
  /** Add an icon button to the toolbar; null when panels are not mounted. */
  addToolbarButton(spec: ToolbarButtonSpec): ToolbarButtonHandle | null;
  /** Add an entry to the status bar; null when panels are not mounted. */
  addStatusItem(spec: StatusItemSpec): StatusItemHandle | null;
  /**
   * Add an action to the command list (command search, shortcuts). Reusing an
   * id replaces that action. Returns a function that removes it.
   */
  registerAction(action: Action): () => void;
  /** Every registered action, in registration order. */
  getActions(): Action[];
  /** Run an action by id; false when it is unknown or disabled. */
  runAction(id: string): boolean;
  /** Open (or close) the command search. No-op when panels are not mounted. */
  toggleCommandSearch(): void;
  /**
   * Add a tab to the sidebar; null when panels are not mounted. The returned
   * `body` is the tab's content area, for the caller to fill.
   */
  addSidebarTab(spec: SidebarTabSpec): SidebarTabHandle | null;
  /** Show the sidebar with this tab in front ("item", "view", "model", or a host tab). */
  showSidebarTab(id: string): void;
  getSidebarTab(): string | null;
  /** The tool shelf (search, fit, hide, isolate, section), also toggled by T. */
  setShelfVisible(visible: boolean): void;
  isShelfVisible(): boolean;
  toggleShelf(): void;
  /** Visibility. */
  hideSelected(): void;
  isolateSelected(): void;
  /** Hide everything except these elements (containers expand). Empty is a no-op. */
  isolate(expressIDs: readonly number[]): void;
  /** True between an isolate and the next show-all (or load). */
  isIsolated(): boolean;
  /** Subscribe to hide/isolate/show-all changes; returns an unsubscribe function. */
  onVisibilityChange(listener: () => void): () => void;
  showAll(): void;
  setSubtreeVisible(expressID: number, visible: boolean): void;
  isSubtreeVisible(expressID: number): boolean;
  toggleSubtreeVisible(expressID: number): void;
  /** Lazy categories (spaces/openings), hidden by default. Resolves when loaded. */
  setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void>;
  isCategoryVisible(category: LazyCategory): boolean;
  /** Type/storey filters. Groups AND together; values within a group OR. */
  getFilterOptions(): FilterOptions;
  getTypeFilter(): string[] | null;
  setTypeFilter(types: string[] | null): void;
  getStoreyFilter(): number[] | null;
  setStoreyFilter(storeys: number[] | null): void;
  /** Clear both filter groups (manual hide/isolate state is untouched). */
  resetFilters(): void;
  /** Toggle the statistics overlay ("Show Statistics" command). */
  showStatistics(): void;
  /** Toggle the performance HUD (also bound to P). */
  togglePerfHud(): void;
  /** Independent side-panel visibility. */
  setTreeVisible(visible: boolean): void;
  isTreeVisible(): boolean;
  toggleTree(): void;
  setPropertiesVisible(visible: boolean): void;
  arePropertiesVisible(): boolean;
  toggleProperties(): void;
  /**
   * Convenience for both panels at once (kept for 1.1.0 compatibility):
   * hides both when either is visible, restores both when both are hidden.
   */
  setPanelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  togglePanels(): void;
  /** Single axis-aligned section plane (GPU clipping; no geometry rebuilds). */
  getSectionState(): SectionState;
  setSectionEnabled(enabled: boolean): void;
  setSectionAxis(axis: SectionAxis): void;
  setSectionPosition(position: number): void;
  setSectionFlipped(flipped: boolean): void;
  /** Re-center the plane on the current axis and clear the flip. */
  resetSection(): void;
  /** Re-read VS Code theme CSS variables and recolor the viewport. */
  updateTheme(): void;
  fitToModel(): CameraPose;
  fitToElement(expressID: number): CameraPose | null;
  /** Frame the current selection (subtree bounds); null without a selection. */
  fitToSelection(): CameraPose | null;
  /** Frame these elements (containers expand); null when none has geometry. */
  fitTo(expressIDs: readonly number[]): CameraPose | null;
  /** Deterministic standard camera poses (top/front/right/... and isometric). */
  setStandardView(view: StandardView): CameraPose;
  getProjection(): ProjectionMode;
  /** Switch projection, preserving the target and apparent model size. */
  setProjection(mode: ProjectionMode): void;
  pickAt(clientX: number, clientY: number): PickResult | null;
  getCamera(): CameraPose;
  getViewport(): { width: number; height: number; aspect: number };
  /** Drawing-buffer scale; below 1 only transiently during slow interaction. */
  getResolutionScale(): number;
  /** Live GPU resource counts (for leak detection). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number };
  setCamera(pose: CameraPose): void;
  /** Snapshot / restore of the working view for webview persistence. */
  getViewState(): ViewerViewState;
  applyViewState(state: Partial<ViewerViewState>): void;
  resize(width: number, height: number): void;
  render(): void;
  isReady(): boolean;
  dispose(): void;
}

/** Minimum ms between renders while mesh batches stream in. */
const PROGRESSIVE_RENDER_INTERVAL = 150;

/** Container classes applied while a side panel is hidden (see styles.ts). */
const TREE_HIDDEN_CLASS = 'ifc-tree-hidden';
const PROPS_HIDDEN_CLASS = 'ifc-props-hidden';
const SHELF_HIDDEN_CLASS = 'ifc-shelf-hidden';

function defaultSection(): SectionState {
  return { enabled: false, axis: 'y', position: 0, flipped: false, range: null };
}

class ViewerImpl implements Viewer {
  private engine: AsyncIfcEngine | null = null;
  private readonly scene: SceneController;
  private readonly controls: ViewerControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly sidebar: Sidebar | null;
  private readonly propertiesPanel: PropertiesPanel | null;
  private readonly viewTab: ViewTab | null;
  private readonly treePanel: TreePanel | null;
  private readonly toolbar: Toolbar | null;
  private readonly statsPanel: StatsPanel | null;
  private shelfVisible = true;
  private readonly legend: HighlightLegend | null;
  private readonly statusBar: StatusBar | null;
  private readonly commandSearch: CommandSearch | null;
  private readonly contextMenu: ContextMenu | null;
  private readonly gizmo: Gizmo | null;
  private readonly actions = new ActionRegistry();
  private readonly perfHud: PerfHud;
  private readonly loadingOverlay: LoadingOverlay;
  private readonly errorCard: ErrorCard;
  private initialized: Promise<AsyncIfcEngine> | null = null;
  private currentModelID: number | null = null;
  private stats: ModelStats | null = null;
  private timeline: LoadTimeline | null = null;
  private ready = false;
  private loading = false;
  private loadToken = 0;
  private selection: number | null = null;
  private treeVisible = true;
  private propsVisible = true;
  private section: SectionState = defaultSection();
  /** True once the plane position has been placed for the current model. */
  private sectionPositioned = false;
  private typeFilter: string[] | null = null;
  private storeyFilter: number[] | null = null;
  private cachedTree: SpatialNode | null = null;
  /** expressID -> spatial tree node, built on first use per model. */
  private nodeIndex: Map<number, SpatialNode> | null = null;
  private searchIndex: SearchIndex | null = null;
  private readonly loadedCategories = new Set<LazyCategory>();
  private readonly selectionListeners = new Set<(expressID: number | null) => void>();
  private readonly modelLoadedListeners = new Set<() => void>();
  private readonly viewChangedListeners = new Set<() => void>();
  private readonly highlightListeners = new Set<() => void>();
  private readonly visibilityListeners = new Set<() => void>();
  private isolated = false;
  private session: ModelSession | null = null;
  private sessionState: SessionState = READ_ONLY_SESSION;
  private readonly sessionListeners = new Set<() => void>();
  private readonly editedListeners = new Set<(delta: Delta) => void>();
  /** Edits that arrived while a model was still loading; applied once it is on screen. */
  private pendingDeltas: { delta: Delta; patch: GeometryPatch | null }[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ViewerOptions,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.tabIndex = 0;
    this.container.appendChild(this.canvas);

    this.scene = new SceneController(this.canvas, {
      background: options.background ?? 0x1e1e1e,
    });
    this.controls = new ViewerControls(this.scene, this.container, () => this.scene.render(), {
      onPick: (pick) => this.select(pick ? pick.expressID : null),
      onKey: (e) => {
        const action = this.actions.forKey(e);
        if (!action) return false;
        if (this.actions.isEnabled(action)) action.run();
        return true;
      },
      onContextMenu: (x, y, pick) => this.openContextMenu(x, y, pick),
      onInteractionEnd: () => this.emitViewChanged(),
    });

    const mountPanels = options.panels ?? true;
    this.sidebar = mountPanels ? new Sidebar(this.container, this) : null;
    const itemTab = this.sidebar?.addTab({ id: 'item', label: 'Item', order: 10 });
    const viewTab = this.sidebar?.addTab({ id: 'view', label: 'View', order: 20 });
    const modelTab = this.sidebar?.addTab({ id: 'model', label: 'Model', order: 30 });
    this.propertiesPanel = itemTab ? new PropertiesPanel(itemTab.body, this) : null;
    this.viewTab = viewTab ? new ViewTab(viewTab.body, this) : null;
    this.statsPanel = modelTab ? new StatsPanel(modelTab.body, this) : null;
    this.sidebar?.onTabShown('model', () => this.statsPanel?.refresh());
    this.onModelLoaded(() => this.statsPanel?.refresh());
    this.treePanel = mountPanels ? new TreePanel(this.container, this) : null;
    this.toolbar = mountPanels ? new Toolbar(this.container, this) : null;
    this.legend = mountPanels ? new HighlightLegend(this.container, this) : null;
    this.commandSearch = mountPanels ? new CommandSearch(this.container, this.actions) : null;
    this.contextMenu = mountPanels ? new ContextMenu(this.container, this.actions) : null;
    this.gizmo = mountPanels
      ? new Gizmo(this.container, {
          getCameraBasis: () => this.cameraBasis(),
          setStandardView: (view) => this.setStandardView(view),
        })
      : null;
    if (this.gizmo) this.scene.onRender(() => this.gizmo?.update());
    this.statusBar = mountPanels
      ? new StatusBar(this.container, {
          getSelection: () => this.selection,
          describeSelection: async (id) => {
            const props = await this.getProperties(id);
            if (!props) return null;
            const name = props.attributes.find((a) => a.name === 'Name')?.value;
            return { ifcClass: props.type, name: typeof name === 'string' && name !== '' ? name : null };
          },
          getTriangleCounts: () => {
            if (!this.ready) return null;
            const info = this.scene.getSceneInfo();
            return { visible: info.visibleTriangleCount, total: info.triangleCount };
          },
          onSelectionChange: (l) => this.onSelectionChange(l),
          onModelLoaded: (l) => this.onModelLoaded(l),
          onVisibilityChange: (l) => this.onVisibilityChange(l),
          onViewChanged: (l) => this.onViewChanged(l),
          onModelEdited: (l) => this.onModelEdited(l),
        })
      : null;
    this.registerBuiltinActions();
    this.perfHud = new PerfHud(this.container, {
      getRendererInfo: () => this.scene.getRendererInfo(),
      getRenderTiming: () => this.scene.getRenderTiming(),
      getResolutionScale: () => this.scene.getResolutionScale(),
      getLoadTimeline: () => this.timeline,
    });
    // Loading/error overlays are always mounted (independent of side panels).
    this.loadingOverlay = new LoadingOverlay(this.container, () => this.cancelLoad());
    this.errorCard = new ErrorCard(this.container);

    this.updateTheme();
    this.resizeToContainer();
  }

  /**
   * Engine strategy: worker when a source is configured and Workers exist,
   * inline otherwise. A worker that fails to boot degrades to inline so the
   * viewer always works.
   */
  private ensureInit(): Promise<AsyncIfcEngine> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const workerOpts = this.options.worker;
        if (workerOpts !== false && workerOpts && typeof Worker !== 'undefined') {
          const workerEngine = new WorkerEngine({
            wasmPath: this.options.wasmPath,
            wasmAbsolute: this.options.wasmAbsolute ?? false,
            spawn: { url: workerOpts.url, factory: workerOpts.factory },
          });
          try {
            await workerEngine.init();
            this.engine = workerEngine;
            return workerEngine;
          } catch (err) {
            console.warn('ifc-viewer: worker engine unavailable, using inline engine', err);
            workerEngine.terminate();
          }
        }
        const inline = new InlineEngine({
          wasmPath: this.options.wasmPath,
          wasmAbsolute: this.options.wasmAbsolute ?? false,
        });
        await inline.init();
        this.engine = inline;
        return inline;
      })();
    }
    return this.initialized;
  }

  warmup(): void {
    void this.ensureInit().catch(() => undefined);
  }

  private resizeToContainer(): void {
    const rect = this.container.getBoundingClientRect();
    this.scene.resize(rect.width || this.container.clientWidth, rect.height || this.container.clientHeight);
  }

  async load(source: Uint8Array | LoadSource, options: ViewerLoadOptions = {}): Promise<LoadedModel> {
    // Overlay first: the initial load pays the worker spawn and wasm compile,
    // which is otherwise dead time with no feedback.
    this.errorCard.hide();
    this.loadingOverlay.show();
    let engine: AsyncIfcEngine;
    try {
      engine = await this.ensureInit();
    } catch (err) {
      this.loadingOverlay.hide();
      this.errorCard.show(err instanceof Error ? err.message : String(err));
      throw err;
    }
    if (this.loading) {
      // A newer load supersedes the in-flight one.
      engine.cancel();
    }
    const token = ++this.loadToken;
    this.loading = true;
    this.ready = false;

    // Highlight groups hold expressIDs, which mean nothing in the next model.
    // Checked before clearModel, which drops them silently with the batcher.
    if (this.scene.getHighlightSets().length > 0) {
      this.scene.clearHighlightSet();
      this.emitHighlights();
    }
    if (this.currentModelID !== null) {
      this.scene.clearHighlight();
      this.scene.clearModel();
      engine.dispose(this.currentModelID);
      this.currentModelID = null;
    }
    if (this.selection !== null) {
      this.selection = null;
      this.emitSelection();
    }

    this.loadedCategories.clear();
    this.cachedTree = null;
    this.nodeIndex = null;
    this.searchIndex = null;
    this.stats = null;
    if (this.isolated) {
      this.isolated = false;
      this.emitVisibility();
    }
    // Per-model view tooling resets with the model it applied to.
    this.section = defaultSection();
    this.sectionPositioned = false;
    this.scene.clearSectionPlane();
    this.typeFilter = null;
    this.storeyFilter = null;
    this.scene.setFilter(null);
    this.toolbar?.syncSection();
    this.viewTab?.syncSection();
    this.viewTab?.syncFilters();

    const normalized: LoadSource =
      source instanceof Uint8Array ? { kind: 'bytes', bytes: source } : source;

    const t0 = performance.now();
    const timeline: LoadTimeline = {};
    this.timeline = timeline;
    let uploadMs = 0;
    let firstBatch = true;
    let lastRender = 0;
    // Progressive renders skip transparent sorting; restored before the
    // final render below (and on error/cancel).
    this.scene.setStreamingMode(true);

    try {
      const meta = await engine.loadModel(normalized, {
        onProgress: (p) => {
          if (token !== this.loadToken) return;
          this.loadingOverlay.update(p);
          options.onProgress?.(p);
        },
        onMeshBatch: (meshes) => {
          if (token !== this.loadToken) return;
          const u0 = performance.now();
          this.scene.addMeshes(meshes);
          uploadMs += performance.now() - u0;
          if (firstBatch) {
            firstBatch = false;
            timeline.firstGeometryMs = performance.now() - t0;
            this.resizeToContainer();
            this.controls.fitToModel();
          }
          const t = performance.now();
          if (t - lastRender > PROGRESSIVE_RENDER_INTERVAL) {
            lastRender = t;
            this.scene.render();
          }
        },
      });
      if (token !== this.loadToken) throw new CancelledError();

      this.currentModelID = meta.modelID;
      this.stats = { ...meta.stats, uploadMs };
      this.cachedTree = meta.tree;
      timeline.downloadMs = meta.stats.downloadMs;
      timeline.parseMs = meta.stats.parseMs;
      timeline.geometryMs = meta.stats.geometryMs;
      timeline.uploadMs = uploadMs;
      timeline.fileBytes = meta.stats.fileBytes;
      timeline.totalMs = performance.now() - t0;

      this.scene.setStreamingMode(false);
      this.resizeToContainer();
      this.controls.fitToModel();
      this.scene.render();
      this.loadingOverlay.hide();
      this.ready = true;
      this.loading = false;
      for (const queued of this.pendingDeltas.splice(0)) this.applyDelta(queued.delta, queued.patch);
      for (const listener of this.modelLoadedListeners) listener();
      return {
        modelID: meta.modelID,
        meshes: [],
        bounds: meta.bounds,
        stats: this.stats,
      };
    } catch (err) {
      if (token !== this.loadToken) throw err; // superseded; the newer load owns the UI
      this.scene.setStreamingMode(false);
      this.loading = false;
      this.loadingOverlay.hide();
      if (err instanceof CancelledError) {
        // User cancel: clear the partial model, no error card.
        this.scene.clearModel();
        this.scene.render();
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.errorCard.show(message);
      throw err;
    }
  }

  cancelLoad(): void {
    if (this.loading) this.engine?.cancel();
  }

  getStats(): ModelStats | null {
    return this.stats;
  }

  getLoadTimeline(): LoadTimeline | null {
    return this.timeline;
  }

  getSceneInfo(): SceneInfo {
    return this.scene.getSceneInfo();
  }

  getSpatialTree(): SpatialNode | null {
    return this.cachedTree;
  }

  getSearchIndex(): SearchIndex | null {
    if (!this.searchIndex && this.cachedTree) {
      this.searchIndex = buildSearchIndex(this.cachedTree);
    }
    return this.searchIndex;
  }

  /** The session that answers data requests, when it is up. */
  private liveSession(): ModelSession | null {
    return this.session && this.sessionState.state === 'ready' ? this.session : null;
  }

  async getProperties(expressID: number): Promise<ItemProperties | null> {
    if (this.currentModelID === null || !this.engine) return null;
    const session = this.liveSession();
    if (session) {
      try {
        return await session.getProperties(expressID);
      } catch {
        // fall back to the render engine's read of the file
      }
    }
    try {
      return await this.engine.getItemProperties(this.currentModelID, expressID);
    } catch {
      return null;
    }
  }

  async resolveGlobalIds(globalIds: readonly string[]): Promise<GlobalIdResolution> {
    if (this.currentModelID === null || !this.engine) {
      return { found: [], missing: [...new Set(globalIds)] };
    }
    const token = this.loadToken;
    const session = this.liveSession();
    let result: GlobalIdResolution | null = null;
    if (session) {
      try {
        result = await session.resolveGlobalIds(globalIds);
      } catch {
        result = null;
      }
    }
    result ??= await this.engine.resolveGlobalIds(this.currentModelID, globalIds);
    // expressIDs are per model; a reload in between makes them meaningless.
    if (token !== this.loadToken) throw new Error('The model was reloaded during the lookup.');
    return result;
  }

  async globalIdOf(expressID: number): Promise<string | null> {
    if (this.currentModelID === null || !this.engine) return null;
    const token = this.loadToken;
    try {
      const session = this.liveSession();
      let globalId: string | null | undefined;
      if (session) {
        try {
          globalId = await session.globalIdOf(expressID);
        } catch {
          globalId = undefined;
        }
      }
      globalId ??= await this.engine.globalIdOf(this.currentModelID, expressID);
      return token === this.loadToken ? globalId : null;
    } catch {
      return null;
    }
  }

  // -- editing session ----------------------------------------------------
  setSession(session: ModelSession | null, state: SessionState): void {
    this.session = session;
    this.sessionState = state;
    for (const listener of this.sessionListeners) listener();
  }

  getSessionState(): SessionState {
    return this.sessionState;
  }

  onSessionChange(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  onModelEdited(listener: (delta: Delta) => void): () => void {
    this.editedListeners.add(listener);
    return () => this.editedListeners.delete(listener);
  }

  // Properties panel hooks (structural PropertiesSource members).
  canEdit(): boolean {
    return this.liveSession() !== null && this.sessionState.canEdit;
  }

  canEnableEditing(): boolean {
    return this.session !== null && this.sessionState.state === 'idle';
  }

  enableEditing(): void {
    this.session?.start?.();
  }

  editAttribute(expressID: number, name: string, value: string | null): Promise<void> {
    return this.editModel([{ op: 'setAttribute', id: expressID, name, value }]);
  }

  editProperty(
    expressID: number,
    edit: {
      pset: string;
      psetId: number;
      kind: 'pset' | 'qto';
      name: string;
      value: string | number | boolean | null;
      valueType?: string;
    },
  ): Promise<void> {
    return this.editModel([
      {
        op: 'setProperty',
        id: expressID,
        pset: edit.pset,
        psetId: edit.psetId,
        kind: edit.kind,
        name: edit.name,
        value: edit.value,
        ...(edit.valueType ? { valueType: edit.valueType } : {}),
      },
    ]);
  }

  addPset(expressID: number, name: string): Promise<void> {
    return this.editModel([{ op: 'addPset', id: expressID, pset: name }]);
  }

  removeProperty(expressID: number, edit: { pset: string; psetId: number; name: string }): Promise<void> {
    return this.editModel([{ op: 'removeProperty', id: expressID, pset: edit.pset, psetId: edit.psetId, name: edit.name }]);
  }

  onModelChanged(listener: () => void): () => void {
    const offEdited = this.onModelEdited(() => listener());
    const offSession = this.onSessionChange(listener);
    return () => {
      offEdited();
      offSession();
    };
  }

  private requireEditable(): ModelSession {
    const session = this.liveSession();
    if (!session || !this.sessionState.canEdit) {
      throw new Error('Editing needs IfcOpenShell, which is not available for this file.');
    }
    return session;
  }

  editModel(ops: EditOp[]): Promise<void> {
    try {
      return this.requireEditable().edit(ops);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  undoEdit(): Promise<void> {
    try {
      return this.requireEditable().undo();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  redoEdit(): Promise<void> {
    try {
      return this.requireEditable().redo();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  applyDelta(delta: Delta, patch: GeometryPatch | null): void {
    if (!this.ready) {
      this.pendingDeltas.push({ delta, patch });
      return;
    }
    const retire = new Set<number>(delta.removed);
    for (const change of delta.changed) if (change.geometry) retire.add(change.id);
    if (retire.size > 0) this.scene.retireElements(retire);
    if (this.selection !== null && delta.removed.includes(this.selection)) this.clearSelection();
    if (patch) {
      const meshes = unpackPatch(patch);
      if (meshes.length > 0) this.scene.addMeshes(meshes);
    }
    this.scene.render();
    if (delta.treeDirty) void this.refreshTree();
    for (const listener of this.editedListeners) listener(delta);
  }

  /** Re-read the spatial tree from the session after containment or hierarchy edits. */
  private async refreshTree(): Promise<void> {
    const session = this.liveSession();
    if (!session) return;
    const token = this.loadToken;
    try {
      const tree = await session.getTree();
      if (token !== this.loadToken) return;
      this.cachedTree = tree;
      this.nodeIndex = null;
      this.searchIndex = null;
      // The tree panel and filter flyout rebuild from the new structure.
      for (const listener of this.modelLoadedListeners) listener();
    } catch {
      // keep the previous tree
    }
  }

  select(expressID: number | null): void {
    if (expressID === this.selection) return;
    if (expressID === null) {
      this.clearSelection();
      return;
    }
    this.scene.highlight(expressID);
    this.selection = expressID;
    this.scene.render();
    this.emitSelection();
  }

  clearSelection(): void {
    if (this.selection === null) return;
    this.scene.clearHighlight();
    this.selection = null;
    this.scene.render();
    this.emitSelection();
  }

  getSelection(): number | null {
    return this.selection;
  }

  onSelectionChange(listener: (expressID: number | null) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  onModelLoaded(listener: () => void): () => void {
    this.modelLoadedListeners.add(listener);
    return () => this.modelLoadedListeners.delete(listener);
  }

  onViewChanged(listener: () => void): () => void {
    this.viewChangedListeners.add(listener);
    return () => this.viewChangedListeners.delete(listener);
  }

  private emitSelection(): void {
    for (const listener of this.selectionListeners) listener(this.selection);
  }

  private emitViewChanged(): void {
    for (const listener of this.viewChangedListeners) listener();
  }

  // -- highlight groups ---------------------------------------------------
  setHighlight(label: string, expressIDs: readonly number[], color?: string): void {
    if (!label.trim()) throw new Error('A highlight group needs a label.');
    const normalized =
      color === undefined ? this.scene.nextHighlightColor() : normalizeColor(color);
    if (!normalized) throw new Error(`Unknown colour "${color}".`);
    const count = new Set(expressIDs).size;
    this.scene.setHighlightSet(label, this.expandSubtrees(expressIDs), normalized, count);
    this.scene.render();
    this.emitHighlights();
  }

  clearHighlight(label?: string): void {
    const before = this.scene.getHighlightSets().length;
    this.scene.clearHighlightSet(label);
    if (this.scene.getHighlightSets().length === before) return;
    this.scene.render();
    this.emitHighlights();
  }

  getHighlights(): HighlightInfo[] {
    return this.scene.getHighlightSets();
  }

  onHighlightsChange(listener: () => void): () => void {
    this.highlightListeners.add(listener);
    return () => this.highlightListeners.delete(listener);
  }

  private emitHighlights(): void {
    for (const listener of this.highlightListeners) listener();
  }

  setHighlightLegendEnabled(enabled: boolean): void {
    this.legend?.setEnabled(enabled);
  }

  addToolbarButton(spec: ToolbarButtonSpec): ToolbarButtonHandle | null {
    return this.toolbar ? this.toolbar.addButton(spec) : null;
  }

  addStatusItem(spec: StatusItemSpec): StatusItemHandle | null {
    return this.statusBar ? this.statusBar.addItem(spec) : null;
  }

  addSidebarTab(spec: SidebarTabSpec): SidebarTabHandle | null {
    return this.sidebar ? this.sidebar.addTab(spec) : null;
  }

  showSidebarTab(id: string): void {
    if (!this.sidebar?.hasTab(id)) return;
    this.setPropertiesVisible(true);
    this.sidebar.select(id);
  }

  getSidebarTab(): string | null {
    return this.sidebar?.getActive() ?? null;
  }

  setShelfVisible(visible: boolean): void {
    if (visible === this.shelfVisible) return;
    this.shelfVisible = visible;
    this.container.classList.toggle(SHELF_HIDDEN_CLASS, !visible);
    this.emitViewChanged();
  }

  isShelfVisible(): boolean {
    return this.shelfVisible;
  }

  toggleShelf(): void {
    this.setShelfVisible(!this.shelfVisible);
  }

  registerAction(action: Action): () => void {
    return this.actions.register(action);
  }

  getActions(): Action[] {
    return this.actions.list();
  }

  runAction(id: string): boolean {
    return this.actions.run(id);
  }

  toggleCommandSearch(): void {
    this.commandSearch?.toggle();
  }

  /** The camera's right, up and backward directions in the scene (for the gizmo). */
  private cameraBasis(): { right: [number, number, number]; up: [number, number, number]; back: [number, number, number] } {
    const e = this.scene.camera.matrixWorld.elements;
    return { right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], back: [e[8], e[9], e[10]] };
  }

  /** Right-click: select what is under the pointer (or clear), then offer actions for it. */
  private openContextMenu(x: number, y: number, pick: PickResult | null): void {
    if (!this.contextMenu) return;
    if (pick) this.select(pick.expressID);
    else this.clearSelection();
    const entries = this.selection !== null
      ? ['visibility.hide', 'visibility.isolate', 'view.fitSelection', 'selection.showOnlyType', 'selection.copyGlobalId', '-', 'visibility.showAll', 'filters.reset', 'view.fit']
      : ['visibility.showAll', 'filters.reset', 'view.fit', '-', 'search.open'];
    this.contextMenu.open(x, y, entries);
  }

  /** Everything the toolbar buttons and keys do, in one list (see commands/registry.ts). */
  private registerBuiltinActions(): void {
    const add = (action: Action): void => void this.actions.register(action);
    const hasSelection = (): boolean => this.selection !== null;
    const hasModel = (): boolean => this.ready;

    add({ id: 'search.open', label: 'Search commands', group: 'General', shortcut: 'F3', alsoBoundTo: ['ctrl+k'], run: () => this.toggleCommandSearch() });
    add({ id: 'selection.clear', label: 'Clear selection', group: 'Selection', shortcut: 'Escape', enabled: hasSelection, run: () => this.clearSelection() });

    add({ id: 'view.fit', label: 'Fit model', group: 'View', shortcut: 'F', enabled: hasModel, run: () => this.fitToModel() });
    add({ id: 'view.fitSelection', label: 'Fit selection', group: 'View', shortcut: '.', enabled: hasSelection, run: () => this.fitToSelection() });
    const views: [StandardView, string][] = [
      ['iso', 'Isometric view'],
      ['top', 'Top view'],
      ['front', 'Front view'],
      ['right', 'Right view'],
      ['left', 'Left view'],
      ['back', 'Back view'],
      ['bottom', 'Bottom view'],
    ];
    for (const [view, label] of views) {
      add({ id: `view.${view}`, label, group: 'View', enabled: hasModel, run: () => this.setStandardView(view) });
    }
    add({
      id: 'view.projection',
      label: 'Orthographic projection',
      group: 'View',
      checked: () => this.getProjection() === 'orthographic',
      run: () => this.setProjection(this.getProjection() === 'orthographic' ? 'perspective' : 'orthographic'),
    });

    add({ id: 'visibility.hide', label: 'Hide selected', group: 'Visibility', shortcut: 'H', enabled: hasSelection, run: () => this.hideSelected() });
    add({ id: 'visibility.isolate', label: 'Isolate selected', group: 'Visibility', shortcut: 'I', enabled: hasSelection, run: () => this.isolateSelected() });
    const typeOfSelection = (): string | null => (this.selection === null ? null : (this.findNode(this.selection)?.type ?? null));
    add({
      id: 'selection.showOnlyType',
      label: 'Show only this type',
      group: 'Selection',
      enabled: () => typeOfSelection() !== null,
      run: () => {
        const type = typeOfSelection();
        if (type) this.setTypeFilter([type]);
      },
    });
    add({
      id: 'selection.copyGlobalId',
      label: 'Copy GlobalId',
      group: 'Selection',
      enabled: hasSelection,
      run: () => {
        const id = this.selection;
        if (id === null) return;
        void this.globalIdOf(id)
          .then((gid) => (gid ? navigator.clipboard?.writeText(gid) : undefined))
          .catch(() => undefined);
      },
    });
    add({ id: 'visibility.showAll', label: 'Show all', group: 'Visibility', shortcut: 'A', run: () => this.showAll() });
    const categories: [LazyCategory, string][] = [
      ['IfcSpace', 'Show spaces'],
      ['IfcOpeningElement', 'Show openings'],
    ];
    for (const [category, label] of categories) {
      add({
        id: `visibility.${category}`,
        label,
        group: 'Visibility',
        enabled: hasModel,
        checked: () => this.isCategoryVisible(category),
        run: () => void this.setCategoryVisible(category, !this.isCategoryVisible(category)),
      });
    }

    add({
      id: 'section.toggle',
      label: 'Section plane',
      group: 'Section',
      enabled: hasModel,
      checked: () => this.section.enabled,
      run: () => this.setSectionEnabled(!this.section.enabled),
    });
    for (const axis of ['x', 'y', 'z'] as const) {
      add({ id: `section.axis.${axis}`, label: `Section axis ${axis.toUpperCase()}`, group: 'Section', enabled: hasModel, checked: () => this.section.axis === axis, run: () => this.setSectionAxis(axis) });
    }
    add({ id: 'section.flip', label: 'Flip section side', group: 'Section', enabled: () => this.section.enabled, run: () => this.setSectionFlipped(!this.section.flipped) });
    add({ id: 'section.reset', label: 'Reset section', group: 'Section', enabled: () => this.section.enabled, run: () => this.resetSection() });
    add({ id: 'filters.reset', label: 'Reset filters', group: 'Filters', enabled: () => this.typeFilter !== null || this.storeyFilter !== null, run: () => this.resetFilters() });

    add({ id: 'panel.tree', label: 'Spatial tree', group: 'Panels', shortcut: 'O', checked: () => this.treeVisible, run: () => this.toggleTree() });
    add({ id: 'panel.properties', label: 'Sidebar', group: 'Panels', shortcut: 'N', checked: () => this.propsVisible, run: () => this.toggleProperties() });
    add({ id: 'panel.shelf', label: 'Tool shelf', group: 'Panels', shortcut: 'T', checked: () => this.shelfVisible, run: () => this.toggleShelf() });
    const tabs: [string, string][] = [
      ['item', 'Item properties'],
      ['view', 'View controls'],
      ['model', 'Model statistics'],
    ];
    for (const [id, label] of tabs) {
      add({ id: `sidebar.${id}`, label, group: 'Sidebar', run: () => this.showSidebarTab(id) });
    }
    add({ id: 'panel.perf', label: 'Performance overlay', group: 'Panels', shortcut: 'P', run: () => this.togglePerfHud() });
  }

  isIsolated(): boolean {
    return this.isolated;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  private emitVisibility(): void {
    for (const listener of this.visibilityListeners) listener();
  }

  // -- visibility ---------------------------------------------------------
  /**
   * The given expressIDs plus everything below them in the spatial tree
   * (contained and aggregated). Ids outside the tree pass through unchanged.
   */
  private expandSubtrees(expressIDs: Iterable<number>): Set<number> {
    const out = new Set<number>();
    const walk = (n: SpatialNode): void => {
      // A node already present was walked (or has no children to add).
      if (out.has(n.expressID)) return;
      out.add(n.expressID);
      n.children.forEach(walk);
    };
    for (const id of expressIDs) {
      const node = this.findNode(id);
      if (node) walk(node);
      else out.add(id);
    }
    return out;
  }

  /** expressIDs in the subtree rooted at `expressID` that have geometry. */
  private subtreeElementIds(expressID: number): number[] {
    return [...this.expandSubtrees([expressID])].filter((id) => this.scene.hasElement(id));
  }

  private findNode(expressID: number): SpatialNode | null {
    if (!this.nodeIndex && this.cachedTree) {
      const index = new Map<number, SpatialNode>();
      const walk = (n: SpatialNode): void => {
        index.set(n.expressID, n);
        n.children.forEach(walk);
      };
      walk(this.cachedTree);
      this.nodeIndex = index;
    }
    return this.nodeIndex?.get(expressID) ?? null;
  }

  hideSelected(): void {
    if (this.selection === null) return;
    this.scene.setHidden(this.subtreeElementIds(this.selection), true);
    this.scene.render();
    this.emitVisibility();
  }

  isolateSelected(): void {
    if (this.selection === null) return;
    this.isolate([this.selection]);
  }

  isolate(expressIDs: readonly number[]): void {
    if (expressIDs.length === 0) return;
    this.scene.isolate(this.expandSubtrees(expressIDs));
    this.scene.render();
    this.isolated = true;
    this.emitVisibility();
  }

  /** Clears manual hide/isolate state; active filters are left untouched. */
  showAll(): void {
    this.scene.showAll();
    this.scene.render();
    this.isolated = false;
    this.emitVisibility();
  }

  setSubtreeVisible(expressID: number, visible: boolean): void {
    this.scene.setHidden(this.subtreeElementIds(expressID), !visible);
    this.scene.render();
    this.emitVisibility();
  }

  isSubtreeVisible(expressID: number): boolean {
    const ids = this.subtreeElementIds(expressID);
    if (ids.length === 0) return true;
    return ids.every((id) => this.scene.isElementVisible(id));
  }

  toggleSubtreeVisible(expressID: number): void {
    this.setSubtreeVisible(expressID, !this.isSubtreeVisible(expressID));
  }

  async setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void> {
    if (this.currentModelID === null || !this.engine) return;
    // Flag first so isCategoryVisible reflects the toggle immediately; meshes
    // stream in behind it.
    this.scene.setCategoryVisible(category, visible);
    if (visible && !this.loadedCategories.has(category)) {
      this.loadedCategories.add(category);
      try {
        await this.engine.loadCategory(this.currentModelID, category, (meshes) => {
          this.scene.addMeshes(meshes);
        });
      } catch (err) {
        this.loadedCategories.delete(category);
        throw err;
      }
    }
    this.scene.render();
  }

  isCategoryVisible(category: LazyCategory): boolean {
    return this.scene.getCategoryVisible(category);
  }

  // -- filters ------------------------------------------------------------
  getFilterOptions(): FilterOptions {
    return {
      types: this.scene.typesWithCounts(),
      storeys: this.getSearchIndex()?.storeys ?? [],
    };
  }

  getTypeFilter(): string[] | null {
    return this.typeFilter ? [...this.typeFilter] : null;
  }

  setTypeFilter(types: string[] | null): void {
    this.typeFilter = types ? [...types] : null;
    this.applyFilters();
  }

  getStoreyFilter(): number[] | null {
    return this.storeyFilter ? [...this.storeyFilter] : null;
  }

  setStoreyFilter(storeys: number[] | null): void {
    this.storeyFilter = storeys ? [...storeys] : null;
    this.applyFilters();
  }

  resetFilters(): void {
    this.typeFilter = null;
    this.storeyFilter = null;
    this.applyFilters();
  }

  /**
   * Filters map to the same per-element GPU state used by hide/isolate, so
   * they never rebuild meshes or materials. Manual hiding stays independent.
   */
  private applyFilters(): void {
    const index = this.getSearchIndex();
    if (!index || (this.typeFilter === null && this.storeyFilter === null)) {
      this.scene.setFilter(null);
    } else {
      this.scene.setFilter(
        filterElementIDs(index, {
          types: this.typeFilter ? new Set(this.typeFilter) : null,
          storeys: this.storeyFilter ? new Set(this.storeyFilter) : null,
        }),
      );
    }
    this.scene.render();
    this.viewTab?.syncFilters();
    this.emitViewChanged();
  }

  showStatistics(): void {
    this.showSidebarTab('model');
  }

  togglePerfHud(): void {
    this.perfHud.toggle();
  }

  // -- side panels --------------------------------------------------------
  /**
   * The panels are overlays on top of the canvas, so hiding one is a single
   * class on the container: the model keeps its size and state, and the extra
   * viewport area becomes usable immediately.
   */
  setTreeVisible(visible: boolean): void {
    if (visible === this.treeVisible) return;
    this.treeVisible = visible;
    this.container.classList.toggle(TREE_HIDDEN_CLASS, !visible);
    // A hidden panel does not keep its scroll offset, so bring the selected
    // row back into view when the tree returns.
    if (visible) this.treePanel?.revealSelection();
    this.emitViewChanged();
  }

  isTreeVisible(): boolean {
    return this.treeVisible;
  }

  toggleTree(): void {
    this.setTreeVisible(!this.treeVisible);
  }

  setPropertiesVisible(visible: boolean): void {
    if (visible === this.propsVisible) return;
    this.propsVisible = visible;
    this.container.classList.toggle(PROPS_HIDDEN_CLASS, !visible);
    this.emitViewChanged();
  }

  arePropertiesVisible(): boolean {
    return this.propsVisible;
  }

  toggleProperties(): void {
    this.setPropertiesVisible(!this.propsVisible);
  }

  setPanelsVisible(visible: boolean): void {
    this.setTreeVisible(visible);
    this.setPropertiesVisible(visible);
  }

  arePanelsVisible(): boolean {
    return this.treeVisible || this.propsVisible;
  }

  togglePanels(): void {
    this.setPanelsVisible(!this.arePanelsVisible());
  }

  // -- section plane ------------------------------------------------------
  getSectionState(): SectionState {
    return { ...this.section, range: this.sectionRange() };
  }

  setSectionEnabled(enabled: boolean): void {
    if (enabled === this.section.enabled) return;
    this.section.enabled = enabled;
    if (enabled && !this.sectionPositioned) {
      // First enable for this model: start at the middle of the axis so the
      // slice is immediately visible.
      const range = this.sectionRange();
      if (range) {
        this.section.position = (range.min + range.max) / 2;
        this.sectionPositioned = true;
      }
    }
    this.applySection();
  }

  setSectionAxis(axis: SectionAxis): void {
    if (axis === this.section.axis) return;
    this.section.axis = axis;
    const range = this.sectionRange();
    if (range) this.section.position = (range.min + range.max) / 2;
    this.applySection();
  }

  setSectionPosition(position: number): void {
    this.section.position = position;
    this.applySection();
  }

  setSectionFlipped(flipped: boolean): void {
    if (flipped === this.section.flipped) return;
    this.section.flipped = flipped;
    this.applySection();
  }

  resetSection(): void {
    this.section.flipped = false;
    const range = this.sectionRange();
    if (range) this.section.position = (range.min + range.max) / 2;
    this.applySection();
  }

  /** Model extent along the current section axis, or null with no model. */
  private sectionRange(): { min: number; max: number } | null {
    const b: ModelBounds = this.scene.getBounds();
    const axis = this.section.axis;
    const min = b.min[axis];
    const max = b.max[axis];
    if (!(max > min)) return null;
    return { min, max };
  }

  /**
   * Recompute the clipping plane from the section state. Enabling attaches
   * one shared plane to the model materials; moving it is a uniform update.
   */
  private applySection(): void {
    const range = this.sectionRange();
    if (!this.section.enabled || !range) {
      this.scene.clearSectionPlane();
    } else {
      this.section.position = Math.min(range.max, Math.max(range.min, this.section.position));
      const normal: [number, number, number] = [0, 0, 0];
      const axisIndex = this.section.axis === 'x' ? 0 : this.section.axis === 'y' ? 1 : 2;
      // Unflipped keeps the low side of the axis: n = -axis, c = position.
      normal[axisIndex] = this.section.flipped ? 1 : -1;
      const constant = this.section.flipped ? -this.section.position : this.section.position;
      this.scene.setSectionPlane(normal, constant);
    }
    this.scene.render();
    this.toolbar?.syncSection();
    this.viewTab?.syncSection();
    this.emitViewChanged();
  }

  updateTheme(): void {
    const styles = getComputedStyle(this.container);
    const bg =
      styles.getPropertyValue('--vscode-editor-background') ||
      styles.getPropertyValue('--ifc-viewport-background');
    if (this.scene.setBackgroundCss(bg)) {
      this.scene.render();
    }
  }

  // -- camera -------------------------------------------------------------
  fitToModel(): CameraPose {
    const pose = this.controls.fitToModel();
    this.scene.render();
    this.emitViewChanged();
    return pose;
  }

  fitToElement(expressID: number): CameraPose | null {
    const pose = this.controls.fitToElement(expressID);
    this.scene.render();
    if (pose) this.emitViewChanged();
    return pose;
  }

  fitToSelection(): CameraPose | null {
    if (this.selection === null) return null;
    return this.fitTo([this.selection]);
  }

  fitTo(expressIDs: readonly number[]): CameraPose | null {
    let bounds: ModelBounds | null = null;
    for (const id of this.expandSubtrees(expressIDs)) {
      const b = this.scene.getElementBounds(id);
      if (!b) continue;
      if (!bounds) {
        bounds = { min: { ...b.min }, max: { ...b.max } };
      } else {
        bounds.min.x = Math.min(bounds.min.x, b.min.x);
        bounds.min.y = Math.min(bounds.min.y, b.min.y);
        bounds.min.z = Math.min(bounds.min.z, b.min.z);
        bounds.max.x = Math.max(bounds.max.x, b.max.x);
        bounds.max.y = Math.max(bounds.max.y, b.max.y);
        bounds.max.z = Math.max(bounds.max.z, b.max.z);
      }
    }
    if (!bounds) return null;
    const pose = this.controls.fitToBounds(bounds);
    this.scene.render();
    if (pose) this.emitViewChanged();
    return pose;
  }

  setStandardView(view: StandardView): CameraPose {
    const pose = this.controls.standardView(view);
    this.scene.render();
    this.emitViewChanged();
    return pose;
  }

  getProjection(): ProjectionMode {
    return this.controls.getProjection();
  }

  setProjection(mode: ProjectionMode): void {
    if (mode === this.controls.getProjection()) return;
    this.controls.setProjection(mode);
    this.scene.render();
    this.viewTab?.syncProjection();
    this.emitViewChanged();
  }

  pickAt(clientX: number, clientY: number): PickResult | null {
    return this.controls.pickAt(clientX, clientY);
  }

  getCamera(): CameraPose {
    return this.controls.getPose();
  }

  getViewport(): { width: number; height: number; aspect: number } {
    return this.scene.getViewport();
  }

  getResolutionScale(): number {
    return this.scene.getResolutionScale();
  }

  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number } {
    return this.scene.getRendererInfo();
  }

  setCamera(pose: CameraPose): void {
    this.controls.setPose(pose);
    this.scene.render();
    this.emitViewChanged();
  }

  // -- view state ---------------------------------------------------------
  getViewState(): ViewerViewState {
    return {
      camera: this.getCamera(),
      projection: this.getProjection(),
      treeVisible: this.treeVisible,
      propertiesVisible: this.propsVisible,
      shelfVisible: this.shelfVisible,
      sidebarTab: this.sidebar?.getActive() ?? undefined,
      section: {
        enabled: this.section.enabled,
        axis: this.section.axis,
        position: this.section.position,
        flipped: this.section.flipped,
      },
      typeFilter: this.getTypeFilter(),
      storeyFilter: this.getStoreyFilter(),
    };
  }

  /** Restore a snapshot (tolerates partial/older state objects). */
  applyViewState(state: Partial<ViewerViewState>): void {
    if (typeof state.treeVisible === 'boolean') this.setTreeVisible(state.treeVisible);
    if (typeof state.propertiesVisible === 'boolean') {
      this.setPropertiesVisible(state.propertiesVisible);
    }
    if (typeof state.shelfVisible === 'boolean') this.setShelfVisible(state.shelfVisible);
    if (typeof state.sidebarTab === 'string' && this.sidebar?.hasTab(state.sidebarTab)) {
      this.sidebar.select(state.sidebarTab);
    }
    if (state.projection === 'perspective' || state.projection === 'orthographic') {
      this.setProjection(state.projection);
    }
    if (state.camera?.position && state.camera.target) this.setCamera(state.camera);
    const section = state.section;
    if (section && (section.axis === 'x' || section.axis === 'y' || section.axis === 'z')) {
      this.section.axis = section.axis;
      if (typeof section.position === 'number') {
        this.section.position = section.position;
        this.sectionPositioned = true;
      }
      this.section.flipped = section.flipped === true;
      this.section.enabled = section.enabled === true;
      this.applySection();
    }
    if (state.typeFilter !== undefined) this.typeFilter = state.typeFilter;
    if (state.storeyFilter !== undefined) this.storeyFilter = state.storeyFilter;
    if (state.typeFilter !== undefined || state.storeyFilter !== undefined) this.applyFilters();
  }

  resize(width: number, height: number): void {
    this.scene.resize(width, height);
    this.scene.render();
  }

  render(): void {
    this.scene.render();
    this.perfHud.onRender();
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    if (this.currentModelID !== null) {
      this.engine?.dispose(this.currentModelID);
      this.currentModelID = null;
    }
    this.engine?.terminate();
    this.engine = null;
    this.initialized = null;
    this.propertiesPanel?.dispose();
    this.viewTab?.dispose();
    this.statsPanel?.dispose();
    this.sidebar?.dispose();
    this.treePanel?.dispose();
    this.toolbar?.dispose();
    this.legend?.dispose();
    this.commandSearch?.dispose();
    this.contextMenu?.dispose();
    this.gizmo?.dispose();
    this.statusBar?.dispose();
    this.perfHud.dispose();
    this.loadingOverlay.dispose();
    this.errorCard.dispose();
    this.controls.dispose();
    this.scene.dispose();
    this.container.classList.remove(TREE_HIDDEN_CLASS, PROPS_HIDDEN_CLASS, SHELF_HIDDEN_CLASS);
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  return new ViewerImpl(container, options);
}
