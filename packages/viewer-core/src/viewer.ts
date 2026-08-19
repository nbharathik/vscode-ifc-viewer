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
import { PerfHud } from './panels/perfHud.js';
import { LoadingOverlay, ErrorCard } from './panels/overlays.js';
import { CancelledError } from './engine/types.js';
import { buildSearchIndex, filterElementIDs } from './search.js';
import type { SearchIndex } from './search.js';
import type { CameraPose, ProjectionMode, SceneInfo, SectionAxis } from './scene/scene.js';
import type { PickResult, StandardView } from './scene/controls.js';
import type {
  AsyncIfcEngine,
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
export type { CameraPose, ProjectionMode, SceneInfo, SectionAxis } from './scene/scene.js';
export type { StandardView } from './scene/controls.js';
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
  propertiesVisible: boolean;
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
  /** Visibility. */
  hideSelected(): void;
  isolateSelected(): void;
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

function defaultSection(): SectionState {
  return { enabled: false, axis: 'y', position: 0, flipped: false, range: null };
}

class ViewerImpl implements Viewer {
  private engine: AsyncIfcEngine | null = null;
  private readonly scene: SceneController;
  private readonly controls: ViewerControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly propertiesPanel: PropertiesPanel | null;
  private readonly treePanel: TreePanel | null;
  private readonly toolbar: Toolbar | null;
  private readonly statsPanel: StatsPanel | null;
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
  private searchIndex: SearchIndex | null = null;
  private readonly loadedCategories = new Set<LazyCategory>();
  private readonly selectionListeners = new Set<(expressID: number | null) => void>();
  private readonly modelLoadedListeners = new Set<() => void>();
  private readonly viewChangedListeners = new Set<() => void>();

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
      onEscape: () => this.clearSelection(),
      onHide: () => this.hideSelected(),
      onIsolate: () => this.isolateSelected(),
      onShowAll: () => this.showAll(),
      onTogglePerfHud: () => this.togglePerfHud(),
      onInteractionEnd: () => this.emitViewChanged(),
    });

    const mountPanels = options.panels ?? true;
    this.propertiesPanel = mountPanels ? new PropertiesPanel(this.container, this) : null;
    this.treePanel = mountPanels ? new TreePanel(this.container, this) : null;
    this.toolbar = mountPanels ? new Toolbar(this.container, this) : null;
    this.statsPanel = mountPanels ? new StatsPanel(this.container, this) : null;
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
    this.searchIndex = null;
    this.stats = null;
    // Per-model view tooling resets with the model it applied to.
    this.section = defaultSection();
    this.sectionPositioned = false;
    this.scene.clearSectionPlane();
    this.typeFilter = null;
    this.storeyFilter = null;
    this.scene.setFilter(null);
    this.toolbar?.syncSection();
    this.toolbar?.syncFilters();

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

  async getProperties(expressID: number): Promise<ItemProperties | null> {
    if (this.currentModelID === null || !this.engine) return null;
    try {
      return await this.engine.getItemProperties(this.currentModelID, expressID);
    } catch {
      return null;
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

  // -- visibility ---------------------------------------------------------
  /** expressIDs in the subtree rooted at `expressID` that have geometry. */
  private subtreeElementIds(expressID: number): number[] {
    const node = this.findNode(expressID);
    if (!node) return this.scene.hasElement(expressID) ? [expressID] : [];
    const ids: number[] = [];
    const walk = (n: SpatialNode): void => {
      if (this.scene.hasElement(n.expressID)) ids.push(n.expressID);
      n.children.forEach(walk);
    };
    walk(node);
    return ids;
  }

  private findNode(expressID: number): SpatialNode | null {
    const walk = (n: SpatialNode): SpatialNode | null => {
      if (n.expressID === expressID) return n;
      for (const child of n.children) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return this.cachedTree ? walk(this.cachedTree) : null;
  }

  hideSelected(): void {
    if (this.selection === null) return;
    this.scene.setHidden(this.subtreeElementIds(this.selection), true);
    this.scene.render();
  }

  isolateSelected(): void {
    if (this.selection === null) return;
    this.scene.isolate(this.subtreeElementIds(this.selection));
    this.scene.render();
  }

  /** Clears manual hide/isolate state; active filters are left untouched. */
  showAll(): void {
    this.scene.showAll();
    this.scene.render();
  }

  setSubtreeVisible(expressID: number, visible: boolean): void {
    this.scene.setHidden(this.subtreeElementIds(expressID), !visible);
    this.scene.render();
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
    this.toolbar?.syncFilters();
    this.emitViewChanged();
  }

  showStatistics(): void {
    this.statsPanel?.toggle();
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
    const ids = this.subtreeElementIds(this.selection);
    let bounds: ModelBounds | null = null;
    for (const id of ids) {
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
    this.toolbar?.syncProjection();
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
    this.treePanel?.dispose();
    this.toolbar?.dispose();
    this.statsPanel?.dispose();
    this.perfHud.dispose();
    this.loadingOverlay.dispose();
    this.errorCard.dispose();
    this.controls.dispose();
    this.scene.dispose();
    this.container.classList.remove(TREE_HIDDEN_CLASS, PROPS_HIDDEN_CLASS);
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  return new ViewerImpl(container, options);
}
