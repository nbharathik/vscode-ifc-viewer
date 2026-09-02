// Scene controller: renderer, camera, lights, and the ModelBatcher. Picking
// is a GPU ID pass. No web-ifc here; it consumes framework-agnostic IfcMesh.
import * as THREE from 'three';

import { ModelBatcher } from './batcher.js';
import type { IfcMesh, ModelBounds } from '../engine/types.js';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  /** Orthographic zoom factor; omitted or 1 for perspective poses. */
  zoom?: number;
}

export type ProjectionMode = 'perspective' | 'orthographic';

export type SectionAxis = 'x' | 'y' | 'z';

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

/** Smallest useful near plane, in the model's world units. */
const MIN_NEAR = 0.001;
/** Do not let an interior view's near plane grow beyond this value. */
const MAX_INTERIOR_NEAR = 0.1;
/** Extra room around the model sphere so geometry never touches a clip plane. */
const CLIP_PADDING = 1.05;

export class SceneController {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  /** Perspective camera; also the source of pose state when switching modes. */
  readonly perspectiveCamera: THREE.PerspectiveCamera;
  /** Orthographic sibling; frustum derived from orthoHalfHeight and aspect. */
  readonly orthographicCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private batcher: ModelBatcher;
  private colors: SceneColors;
  private readonly pickTarget: THREE.WebGLRenderTarget;
  /** Single shared section plane; null while sectioning is disabled. */
  private sectionPlane: THREE.Plane | null = null;
  private lastRenderMs = 0;
  private renderTimestamps: number[] = [];
  /** CSS-pixel viewport size; the drawing buffer is this times the scale. */
  private baseWidth = 1;
  private baseHeight = 1;
  /** World-space half height of the orthographic frustum at zoom 1. */
  private orthoHalfHeight = 10;
  /** Orbit focus used to choose a navigation-scale near plane inside a model. */
  private readonly cameraTarget = new THREE.Vector3();
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

    this.perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.perspectiveCamera.position.set(10, 10, 10);
    this.perspectiveCamera.lookAt(0, 0, 0);
    this.orthographicCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 1000);
    this.orthographicCamera.position.copy(this.perspectiveCamera.position);
    this.activeCamera = this.perspectiveCamera;

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

  /** The camera in use (perspective by default). */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.activeCamera;
  }

  getProjection(): ProjectionMode {
    return this.activeCamera === this.perspectiveCamera ? 'perspective' : 'orthographic';
  }

  /** Swap the active camera. Pose math is the caller's job (see controls). */
  setProjection(mode: ProjectionMode): void {
    this.activeCamera =
      mode === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
    this.applySize();
  }

  /** Resize the orthographic frustum (world units, half of the visible height). */
  setOrthoHalfHeight(halfHeight: number): void {
    this.orthoHalfHeight = Math.max(halfHeight, 1e-6);
    this.applySize();
  }

  getOrthoHalfHeight(): number {
    return this.orthoHalfHeight;
  }

  /** Keep both cameras' clip range in sync so projection switches are seamless. */
  setNearFar(near: number, far: number): void {
    if (
      Math.abs(this.activeCamera.near - near) <= Math.max(near * 1e-6, 1e-9) &&
      Math.abs(this.activeCamera.far - far) <= Math.max(far * 1e-6, 1e-9)
    ) {
      return;
    }
    this.perspectiveCamera.near = near;
    this.perspectiveCamera.far = far;
    this.perspectiveCamera.updateProjectionMatrix();
    this.orthographicCamera.near = near;
    this.orthographicCamera.far = far;
    this.orthographicCamera.updateProjectionMatrix();
  }

  /** Keep the latest OrbitControls focus available to the render path. */
  setCameraTarget(target: THREE.Vector3): void {
    this.cameraTarget.copy(target);
  }

  /**
   * Fit the depth range to the current model and camera before drawing.
   *
   * The old radius / 1000 to radius * 1000 range always had a 1,000,000:1
   * ratio. A 24-bit perspective depth buffer then loses millimetres of
   * precision at normal building-view distances, allowing adjacent IFC faces
   * to exchange depth order while orbiting. This range encloses the same model
   * sphere but keeps the near plane as far forward as navigation permits.
   */
  private updateCameraClipRange(): void {
    const bounds = this.batcher.getBounds();
    const sx = bounds.max.x - bounds.min.x;
    const sy = bounds.max.y - bounds.min.y;
    const sz = bounds.max.z - bounds.min.z;
    const radius = Math.hypot(sx, sy, sz) * 0.5;
    if (!(radius > 0) || !Number.isFinite(radius)) return;

    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cy = (bounds.min.y + bounds.max.y) * 0.5;
    const cz = (bounds.min.z + bounds.max.z) * 0.5;
    const camera = this.activeCamera.position;
    let fx = this.cameraTarget.x - camera.x;
    let fy = this.cameraTarget.y - camera.y;
    let fz = this.cameraTarget.z - camera.z;
    const focusDistance = Math.hypot(fx, fy, fz);
    if (focusDistance > 1e-9) {
      fx /= focusDistance;
      fy /= focusDistance;
      fz /= focusDistance;
    } else {
      // Degenerate saved poses are tolerated elsewhere, so retain the
      // camera's current direction if position and target happen to coincide.
      const direction = this.activeCamera.getWorldDirection(new THREE.Vector3());
      fx = direction.x;
      fy = direction.y;
      fz = direction.z;
    }
    const centerDepth =
      (cx - camera.x) * fx + (cy - camera.y) * fy + (cz - camera.z) * fz;

    // Outside the model, the sphere's front edge gives a tight near plane.
    // Inside it, use the current navigation scale and retain close-up access.
    const interiorNear = Math.min(
      MAX_INTERIOR_NEAR,
      Math.max(MIN_NEAR, focusDistance / 1000),
    );
    const paddedRadius = radius * CLIP_PADDING;
    const near = Math.max(interiorNear, centerDepth - paddedRadius);
    const far = Math.max(near + MIN_NEAR, centerDepth + paddedRadius);
    this.setNearFar(near, far);
  }

  // -- section plane -------------------------------------------------------
  /**
   * Enable or move the single section plane. Creating the plane switches on
   * local clipping and attaches it to the model materials once; subsequent
   * calls only mutate the plane, which the renderer uploads as a uniform.
   */
  setSectionPlane(normal: [number, number, number], constant: number): void {
    if (!this.sectionPlane) {
      this.sectionPlane = new THREE.Plane(new THREE.Vector3(...normal), constant);
      this.renderer.localClippingEnabled = true;
      this.batcher.setClippingPlanes([this.sectionPlane]);
    } else {
      this.sectionPlane.normal.set(...normal);
      this.sectionPlane.constant = constant;
    }
  }

  /** Detach the section plane; clipping goes back to costing nothing. */
  clearSectionPlane(): void {
    if (!this.sectionPlane) return;
    this.sectionPlane = null;
    this.renderer.localClippingEnabled = false;
    this.batcher.setClippingPlanes(null);
  }

  hasSectionPlane(): boolean {
    return this.sectionPlane !== null;
  }

  /** Feed a batch of engine meshes into the GPU batcher. */
  addMeshes(meshes: IfcMesh[]): void {
    this.batcher.ingest(meshes);
  }

  /** Apply (or clear) the type/storey filter allowlist. */
  setFilter(ids: Set<number> | null): void {
    this.batcher.setFilter(ids);
  }

  /** Element types present in the scene, for the filter flyout. */
  typesWithCounts(): { type: string; count: number }[] {
    return this.batcher.typesWithCounts();
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
    return { width: size.x, height: size.y, aspect: this.baseWidth / this.baseHeight };
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
    this.updateCameraClipRange();
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
    const aspect = this.baseWidth / this.baseHeight;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    const halfH = this.orthoHalfHeight;
    this.orthographicCamera.left = -halfH * aspect;
    this.orthographicCamera.right = halfH * aspect;
    this.orthographicCamera.top = halfH;
    this.orthographicCamera.bottom = -halfH;
    this.orthographicCamera.updateProjectionMatrix();
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
    this.updateCameraClipRange();
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
    // A live section plane survives the batcher swap (model replacement is
    // driven by the viewer, which resets sectioning before a new load).
    if (this.sectionPlane) this.batcher.setClippingPlanes([this.sectionPlane]);
  }

  dispose(): void {
    this.clearSectionPlane();
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.pickTarget.dispose();
    this.renderer.dispose();
  }
}
