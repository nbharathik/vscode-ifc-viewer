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
import type { CameraPose, SceneInfo } from './scene/scene.js';
import type { PickResult } from './scene/controls.js';
import type {
  AsyncIfcEngine,
  ItemProperties,
  LazyCategory,
  LoadProgress,
  LoadSource,
  LoadedModel,
  ModelStats,
  SpatialNode,
} from './engine/types.js';

export * from './engine/types.js';
export type { CameraPose, SceneInfo } from './scene/scene.js';

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
  getProperties(expressID: number): Promise<ItemProperties | null>;
  /** Select an element: highlight + notify subscribers. null clears. */
  select(expressID: number | null): void;
  clearSelection(): void;
  getSelection(): number | null;
  /** Subscribe to selection changes; returns an unsubscribe function. */
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  /** Subscribe to model-loaded events; returns an unsubscribe function. */
  onModelLoaded(listener: () => void): () => void;
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
  /** Toggle the statistics overlay ("Show Statistics" command). */
  showStatistics(): void;
  /** Toggle the performance HUD (also bound to P). */
  togglePerfHud(): void;
  /** Re-read VS Code theme CSS variables and recolor the viewport. */
  updateTheme(): void;
  fitToModel(): CameraPose;
  fitToElement(expressID: number): CameraPose | null;
  pickAt(clientX: number, clientY: number): PickResult | null;
  getCamera(): CameraPose;
  getViewport(): { width: number; height: number; aspect: number };
  /** Drawing-buffer scale; below 1 only transiently during slow interaction. */
  getResolutionScale(): number;
  /** Live GPU resource counts (for leak detection). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number };
  setCamera(pose: CameraPose): void;
  resize(width: number, height: number): void;
  render(): void;
  isReady(): boolean;
  dispose(): void;
}

/** Minimum ms between renders while mesh batches stream in. */
const PROGRESSIVE_RENDER_INTERVAL = 150;

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
  private cachedTree: SpatialNode | null = null;
  private readonly loadedCategories = new Set<LazyCategory>();
  private readonly selectionListeners = new Set<(expressID: number | null) => void>();
  private readonly modelLoadedListeners = new Set<() => void>();

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
    this.stats = null;

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

  private emitSelection(): void {
    for (const listener of this.selectionListeners) listener(this.selection);
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

  showStatistics(): void {
    this.statsPanel?.toggle();
  }

  togglePerfHud(): void {
    this.perfHud.toggle();
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

  fitToModel(): CameraPose {
    const pose = this.controls.fitToModel();
    this.scene.render();
    return pose;
  }

  fitToElement(expressID: number): CameraPose | null {
    const pose = this.controls.fitToElement(expressID);
    this.scene.render();
    return pose;
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
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  return new ViewerImpl(container, options);
}
