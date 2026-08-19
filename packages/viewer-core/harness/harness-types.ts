// Shared type for the test hooks the harness exposes on `window.__viewer`.
// Playwright specs drive the viewer exclusively through this surface so the
// browser/Node split stays clean.
import type {
  ModelStats,
  SpatialNode,
  ItemProperties,
  LazyCategory,
} from '../src/engine/types.js';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  zoom?: number;
}

export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type ProjectionMode = 'perspective' | 'orthographic';
export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  position: number;
  flipped: boolean;
  range: { min: number; max: number } | null;
}

export interface FilterOptions {
  types: { type: string; count: number }[];
  storeys: { expressID: number; name: string | null }[];
}

export interface ViewerViewState {
  camera: CameraPose;
  projection: ProjectionMode;
  treeVisible: boolean;
  propertiesVisible: boolean;
  section: { enabled: boolean; axis: SectionAxis; position: number; flipped: boolean };
  typeFilter: string[] | null;
  storeyFilter: number[] | null;
}

export interface HarnessHooks {
  /** Load a committed fixture by base name (e.g. "small", "edge"). */
  loadFixture(name: string): Promise<void>;
  getStats(): ModelStats | null;
  setCamera(pose: CameraPose): void;
  getCamera(): CameraPose;
  getViewport(): { width: number; height: number; aspect: number };
  fitToModel(): CameraPose;
  fitToElement(expressID: number): CameraPose | null;
  /** Frame the current selection (subtree bounds); null without a selection. */
  fitToSelection(): CameraPose | null;
  /** Deterministic standard camera poses. */
  setStandardView(view: StandardView): CameraPose;
  getProjection(): ProjectionMode;
  setProjection(mode: ProjectionMode): void;
  pickAt(clientX: number, clientY: number): { expressID: number; point: [number, number, number] } | null;
  /** Structural assertions for deterministic visual tests. */
  getSceneInfo(): {
    meshCount: number;
    triangleCount: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
    visibleTriangleCount: number;
  };
  getSpatialTree(): SpatialNode | null;
  getSelection(): number | null;
  select(expressID: number | null): void;
  clearSelection(): void;
  hideSelected(): void;
  isolateSelected(): void;
  showAll(): void;
  isSubtreeVisible(expressID: number): boolean;
  toggleSubtreeVisible(expressID: number): void;
  setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void>;
  isCategoryVisible(category: LazyCategory): boolean;
  showStatistics(): void;
  /** Independent side-panel visibility. */
  setTreeVisible(visible: boolean): void;
  isTreeVisible(): boolean;
  setPropertiesVisible(visible: boolean): void;
  arePropertiesVisible(): boolean;
  /** Both panels at once (1.1.0-compatible convenience). */
  setPanelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  togglePanels(): void;
  /** Section plane. */
  getSectionState(): SectionState;
  setSectionEnabled(enabled: boolean): void;
  setSectionAxis(axis: SectionAxis): void;
  setSectionPosition(position: number): void;
  setSectionFlipped(flipped: boolean): void;
  resetSection(): void;
  /** Type/storey filters. */
  getFilterOptions(): FilterOptions;
  getTypeFilter(): string[] | null;
  setTypeFilter(types: string[] | null): void;
  getStoreyFilter(): number[] | null;
  setStoreyFilter(storeys: number[] | null): void;
  resetFilters(): void;
  /** View-state snapshot/restore (webview persistence path). */
  getViewState(): ViewerViewState;
  applyViewState(state: Partial<ViewerViewState>): void;
  /** Apply an emulated VS Code theme (harness only) and recolor the viewer. */
  setTheme(kind: 'light' | 'dark'): void;
  /** Ordered list of load-progress phases from the most recent load. */
  getProgressLog(): string[];
  /** Live GPU resource counts (leak detection). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number };
  /** Tear down the viewer (free GPU + DOM). */
  dispose(): void;
  getProperties(expressID: number): Promise<ItemProperties | null>;
  /** True once the most recent load has fully rendered a frame. */
  isReady(): boolean;
  /** Render one frame (perf measurements). */
  render(): void;
  /** Toggle or set the performance HUD. */
  setPerfHud(visible: boolean): void;
  /** Load timeline of the most recent load (download/parse/geometry/upload). */
  getLoadTimeline(): {
    downloadMs?: number;
    parseMs?: number;
    geometryMs?: number;
    uploadMs?: number;
    fileBytes?: number;
    firstGeometryMs?: number;
    totalMs?: number;
  } | null;
  /** Cancel the in-flight load, if any. */
  cancelLoad(): void;
  /** Drawing-buffer scale; 1 outside interaction. */
  getResolutionScale(): number;
}

declare global {
  interface Window {
    __viewer?: HarnessHooks;
    __harnessError?: string;
  }
}

export {};
