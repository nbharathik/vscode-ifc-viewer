// Shared type for the test hooks the harness exposes on `window.__viewer`.
// Playwright specs drive the viewer exclusively through this surface so the
// browser/Node split stays clean.
import type { ModelStats, SpatialNode, ItemProperties, LazyCategory } from '../src/engine/types.js';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
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
  /** Spatial tree + properties panel, shown and hidden as one state. */
  setPanelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  togglePanels(): void;
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
