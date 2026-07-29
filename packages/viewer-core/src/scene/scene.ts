// Scene controller: renderer, camera, lights, and the ModelBatcher. Picking
// is a GPU ID pass. No web-ifc here; it consumes framework-agnostic IfcMesh.
import * as THREE from 'three';

import { ModelBatcher } from './batcher.js';
import type { IfcMesh, ModelBounds } from '../engine/types.js';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface SceneInfo {
  meshCount: number;
  triangleCount: number;
  visibleTriangleCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface SceneColors {
  background: number;
}

export interface ScenePick {
  expressID: number;
  point: [number, number, number];
}

const DEFAULT_COLORS: SceneColors = { background: 0x1e1e1e };

export class SceneController {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private batcher: ModelBatcher;
  private colors: SceneColors;
  private readonly pickTarget: THREE.WebGLRenderTarget;
  private lastRenderMs = 0;
  private renderTimestamps: number[] = [];
  /** CSS-pixel viewport size; the drawing buffer is this times the scale. */
  private baseWidth = 1;
  private baseHeight = 1;
  /** Drawing-buffer scale in (0, 1]; lowered during interaction on slow scenes. */
  private resolutionScale = 1;

  constructor(canvas: HTMLCanvasElement, colors: SceneColors = DEFAULT_COLORS) {
    this.colors = colors;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1); // pinned for deterministic snapshots

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(colors.background);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.camera.position.set(10, 10, 10);
    this.camera.lookAt(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
    hemi.position.set(0, 1, 0);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(5, 10, 7.5);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-6, 4, -5);
    this.scene.add(dir2);

    this.batcher = new ModelBatcher();
    this.scene.add(this.batcher.group);

    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);
  }

  /** Feed a batch of engine meshes into the GPU batcher. */
  addMeshes(meshes: IfcMesh[]): void {
    this.batcher.ingest(meshes);
  }

  // -- visibility ---------------------------------------------------------
  setHidden(expressIDs: Iterable<number>, hidden: boolean): void {
    this.batcher.setHidden(expressIDs, hidden);
  }

  /** Hide everything except the given expressIDs. */
  isolate(expressIDs: Iterable<number>): void {
    this.batcher.isolate(expressIDs);
  }

  showAll(): void {
    this.batcher.showAll();
  }

  setCategoryVisible(type: string, visible: boolean): void {
    this.batcher.setCategoryVisible(type, visible);
  }

  getCategoryVisible(type: string): boolean {
    return this.batcher.getCategoryVisible(type);
  }

  isElementVisible(expressID: number): boolean {
    return this.batcher.isElementVisible(expressID);
  }

  hasMeshesOfType(type: string): boolean {
    return this.batcher.hasType(type);
  }

  /** True when the element contributed geometry to the scene. */
  hasElement(expressID: number): boolean {
    return this.batcher.hasElement(expressID);
  }

  /** World-space (origin-shifted) AABB of one element. */
  getElementBounds(expressID: number): ModelBounds | null {
    return this.batcher.elementBounds(expressID);
  }

  /** Apply the highlight state to one element. */
  highlight(expressID: number): void {
    this.batcher.highlight(expressID);
  }

  clearHighlight(): void {
    this.batcher.clearHighlight();
  }

  allExpressIDs(): number[] {
    return this.batcher.allExpressIDs();
  }

  getBounds(): ModelBounds {
    return this.batcher.getBounds();
  }

  getViewport(): { width: number; height: number; aspect: number } {
    const size = this.renderer.getSize(new THREE.Vector2());
    return { width: size.x, height: size.y, aspect: this.camera.aspect };
  }

  /** Live GPU resource counts (for leak detection and the perf HUD). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number } {
    const info = this.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      calls: info.render.calls,
      triangles: info.render.triangles,
    };
  }

  /** Timing of the most recent render pass and renders in the last second. */
  getRenderTiming(): { lastMs: number; rendersLastSecond: number } {
    const cutoff = performance.now() - 1000;
    this.renderTimestamps = this.renderTimestamps.filter((t) => t > cutoff);
    return { lastMs: this.lastRenderMs, rendersLastSecond: this.renderTimestamps.length };
  }

  /**
   * GPU ID pick at canvas CSS coordinates: renders a 1x1 element-index pass
   * under the cursor and reads it back. Hidden elements are not pickable. The
   * point is the ray hit on the element's AABB.
   */
  pick(canvasX: number, canvasY: number): ScenePick | null {
    const size = this.renderer.getSize(new THREE.Vector2());
    const w = size.x;
    const h = size.y;
    if (w < 1 || h < 1) return null;
    // CSS px -> drawing-buffer px (differs while the resolution is scaled).
    canvasX *= this.resolutionScale;
    canvasY *= this.resolutionScale;

    const prevBackground = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    const prevTarget = this.renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();

    this.camera.setViewOffset(w, h, Math.floor(canvasX), Math.floor(canvasY), 1, 1);
    this.scene.background = null;
    this.scene.overrideMaterial = this.batcher.pickMaterial;
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);

    const buf = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, buf);

    this.camera.clearViewOffset();
    this.scene.background = prevBackground;
    this.scene.overrideMaterial = prevOverride;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);

    const id = buf[0] * 65536 + buf[1] * 256 + buf[2];
    if (id === 0) return null;
    const expressID = this.batcher.expressIDForIndex(id - 1);
    if (expressID === null) return null;

    const ndc = new THREE.Vector2((canvasX / w) * 2 - 1, -(canvasY / h) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const point =
      this.batcher.rayElementPoint(raycaster.ray.origin, raycaster.ray.direction, expressID) ??
      ([0, 0, 0] as [number, number, number]);
    return { expressID, point };
  }

  resize(width: number, height: number): void {
    this.baseWidth = Math.max(1, Math.floor(width));
    this.baseHeight = Math.max(1, Math.floor(height));
    this.applySize();
  }

  private applySize(): void {
    const w = Math.max(1, Math.floor(this.baseWidth * this.resolutionScale));
    const h = Math.max(1, Math.floor(this.baseHeight * this.resolutionScale));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.baseWidth / this.baseHeight;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Scale the drawing buffer without changing the CSS size: fewer pixels to
   * shade while the canvas stretches to fill the viewport. Used to keep
   * orbiting fluid on heavy scenes; 1 restores full resolution.
   */
  setResolutionScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.25, scale));
    if (clamped === this.resolutionScale) return;
    this.resolutionScale = clamped;
    this.applySize();
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  /** Streaming mode skips transparent sorting while mesh batches pour in. */
  setStreamingMode(on: boolean): void {
    this.renderer.sortObjects = !on;
  }

  render(): void {
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.lastRenderMs = performance.now() - t0;
    this.renderTimestamps.push(t0);
    if (this.renderTimestamps.length > 240) this.renderTimestamps.shift();
  }

  getSceneInfo(): SceneInfo {
    const b = this.batcher.getBounds();
    return {
      meshCount: this.batcher.meshCount,
      triangleCount: this.batcher.triangleCount,
      visibleTriangleCount: this.batcher.visibleTriangleCount(),
      bounds: {
        min: [b.min.x, b.min.y, b.min.z],
        max: [b.max.x, b.max.y, b.max.z],
      },
    };
  }

  setBackground(color: number): void {
    this.colors = { ...this.colors, background: color };
    (this.scene.background as THREE.Color).set(color);
  }

  /** Set the viewport background from any CSS color string (theme-driven). */
  setBackgroundCss(css: string): boolean {
    const trimmed = css.trim();
    if (!trimmed) return false;
    try {
      const color = new THREE.Color(trimmed);
      (this.scene.background as THREE.Color).copy(color);
      this.colors = { ...this.colors, background: color.getHex() };
      return true;
    } catch {
      return false;
    }
  }

  clearModel(): void {
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.batcher = new ModelBatcher();
    this.scene.add(this.batcher.group);
  }

  dispose(): void {
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.pickTarget.dispose();
    this.renderer.dispose();
  }
}
