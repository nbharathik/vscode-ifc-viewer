// Camera interaction: OrbitControls wiring, fit-to-model / fit-to-element framing,
// GPU picking, key bindings (F = fit) and resize handling. Renders on change
// (no continuous RAF) so headless snapshots stay deterministic.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { SceneController, CameraPose } from './scene.js';

export interface PickResult {
  expressID: number;
  point: [number, number, number];
}

export interface ControlHandlers {
  /** Single click on the viewport: pick result, or null when nothing was hit. */
  onPick?: (pick: PickResult | null) => void;
  /** Escape pressed. */
  onEscape?: () => void;
  /** H: hide selection. */
  onHide?: () => void;
  /** I: isolate selection. */
  onIsolate?: () => void;
  /** A: show all. */
  onShowAll?: () => void;
  /** P: toggle the performance HUD. */
  onTogglePerfHud?: () => void;
}

/** Compute a camera pose that frames a sphere (center, radius) along `dir`. */
function framePose(
  center: THREE.Vector3,
  radius: number,
  dir: THREE.Vector3,
  fovDeg: number,
  margin = 1.15,
): CameraPose {
  const fov = (fovDeg * Math.PI) / 180;
  const distance = (Math.max(radius, 0.5) / Math.sin(fov / 2)) * margin;
  const position = center.clone().add(dir.clone().normalize().multiplyScalar(distance));
  return {
    position: [position.x, position.y, position.z],
    target: [center.x, center.y, center.z],
  };
}

/** Clicks that travelled further than this since pointerdown are drags. */
const CLICK_MOVE_TOLERANCE_PX = 5;

export class ViewerControls {
  private readonly orbit: OrbitControls;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly doc: Document;
  private readonly keyHandler: (e: KeyboardEvent) => void;
  private readonly dblHandler: (e: MouseEvent) => void;
  private readonly clickHandler: (e: MouseEvent) => void;
  private readonly pointerDownHandler: (e: PointerEvent) => void;
  private interacting = false;
  private downX = 0;
  private downY = 0;

  constructor(
    private readonly scene: SceneController,
    private readonly container: HTMLElement,
    private readonly requestRender: () => void,
    private readonly handlers: ControlHandlers = {},
  ) {
    const dom = scene.renderer.domElement;
    this.doc = container.ownerDocument;

    this.orbit = new OrbitControls(scene.camera, dom);
    this.orbit.enableDamping = false; // deterministic: settle immediately
    this.orbit.addEventListener('start', () => {
      this.interacting = true;
    });
    this.orbit.addEventListener('change', () => {
      this.requestRender();
      this.adaptResolution();
    });
    this.orbit.addEventListener('end', () => {
      this.interacting = false;
      if (this.scene.getResolutionScale() !== 1) {
        this.scene.setResolutionScale(1);
        this.requestRender();
      }
    });

    this.pointerDownHandler = (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
    };
    dom.addEventListener('pointerdown', this.pointerDownHandler);

    this.clickHandler = (e) => this.onClick(e);
    dom.addEventListener('click', this.clickHandler);

    this.dblHandler = (e) => this.onDoubleClick(e);
    dom.addEventListener('dblclick', this.dblHandler);

    this.keyHandler = (e) => this.onKey(e);
    this.doc.addEventListener('keydown', this.keyHandler);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(container);
    }
  }

  /** Apply a pose, keeping OrbitControls' target in sync. */
  setPose(pose: CameraPose): void {
    this.scene.camera.position.set(...pose.position);
    this.orbit.target.set(...pose.target);
    this.scene.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
  }

  getPose(): CameraPose {
    const p = this.scene.camera.position;
    const t = this.orbit.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  fitToModel(): CameraPose {
    const b = this.scene.getBounds();
    const center = new THREE.Vector3(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
    );
    const radius =
      new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z).length() * 0.5;
    const pose = framePose(center, radius, new THREE.Vector3(1, 0.8, 1), this.scene.camera.fov);
    this.applyNearFar(radius);
    this.setPose(pose);
    return pose;
  }

  /** Frame a single element by expressID; keeps the current viewing direction. */
  fitToElement(expressID: number): CameraPose | null {
    const bounds = this.scene.getElementBounds(expressID);
    if (!bounds) return null;
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    );
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    const current = this.scene.camera.position.clone().sub(this.orbit.target);
    const dir = current.lengthSq() > 1e-6 ? current : new THREE.Vector3(1, 0.8, 1);
    const pose = framePose(center, radius, dir, this.scene.camera.fov, 1.3);
    this.applyNearFar(radius);
    this.setPose(pose);
    return pose;
  }

  pickAt(clientX: number, clientY: number): PickResult | null {
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    return this.scene.pick(clientX - rect.left, clientY - rect.top);
  }

  private applyNearFar(radius: number): void {
    const cam = this.scene.camera;
    cam.near = Math.max(radius / 1000, 0.001);
    cam.far = Math.max(radius * 1000, 100);
    cam.updateProjectionMatrix();
  }

  /**
   * While dragging, trade resolution for frame rate when renders are slow.
   * Fast scenes never degrade; the end handler restores full resolution.
   */
  private adaptResolution(): void {
    if (!this.interacting) return;
    const lastMs = this.scene.getRenderTiming().lastMs;
    const scale = this.scene.getResolutionScale();
    if (lastMs > 45 && scale > 0.45) this.scene.setResolutionScale(0.45);
    else if (lastMs > 20 && scale > 0.6) this.scene.setResolutionScale(0.6);
  }

  /** True when the pointer travelled since pointerdown, i.e. an orbit/pan. */
  private wasDrag(e: MouseEvent): boolean {
    return (
      Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_MOVE_TOLERANCE_PX
    );
  }

  private onClick(e: MouseEvent): void {
    // Releasing an orbit/pan drag fires a click on the same element; only a
    // stationary click is a selection.
    if (this.wasDrag(e)) return;
    this.handlers.onPick?.(this.pickAt(e.clientX, e.clientY));
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.wasDrag(e)) return;
    const pick = this.pickAt(e.clientX, e.clientY);
    if (pick) this.fitToElement(pick.expressID);
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'f':
      case 'F':
        this.fitToModel();
        break;
      case 'h':
      case 'H':
        this.handlers.onHide?.();
        break;
      case 'i':
      case 'I':
        this.handlers.onIsolate?.();
        break;
      case 'a':
      case 'A':
        this.handlers.onShowAll?.();
        break;
      case 'p':
      case 'P':
        this.handlers.onTogglePerfHud?.();
        break;
      case 'Escape':
        this.handlers.onEscape?.();
        break;
    }
  }

  private onResize(): void {
    const rect = this.container.getBoundingClientRect();
    this.scene.resize(rect.width, rect.height);
    this.requestRender();
  }

  dispose(): void {
    this.orbit.dispose();
    const dom = this.scene.renderer.domElement;
    dom.removeEventListener('pointerdown', this.pointerDownHandler);
    dom.removeEventListener('click', this.clickHandler);
    dom.removeEventListener('dblclick', this.dblHandler);
    this.doc.removeEventListener('keydown', this.keyHandler);
    this.resizeObserver?.disconnect();
  }
}
