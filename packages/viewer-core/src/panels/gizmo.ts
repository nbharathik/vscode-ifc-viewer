// Orientation gizmo: six axis discs that follow the camera. Clicking one snaps
// to the matching standard view. Axes are labelled in IFC terms (X east, Y
// north, Z up); the viewer's scene is Y-up, so IFC Z is scene Y and IFC Y is
// scene -Z. Plain DOM and SVG, no extra WebGL.
import type { StandardView } from '../scene/controls.js';
import { ensurePanelStyles } from './styles.js';

/** What the gizmo reads from the camera: its right, up and backward world axes. */
export interface GizmoSource {
  getCameraBasis(): { right: [number, number, number]; up: [number, number, number]; back: [number, number, number] } | null;
  setStandardView(view: StandardView): unknown;
}

interface AxisDef {
  /** Scene-space unit vector. */
  dir: [number, number, number];
  label: string;
  view: StandardView;
  /** Positive axes get a letter, negative ones a plain disc. */
  positive: boolean;
  color: string;
  title: string;
}

const AXES: AxisDef[] = [
  { dir: [1, 0, 0], label: 'X', view: 'right', positive: true, color: '#e5534b', title: 'Right view (+X)' },
  { dir: [-1, 0, 0], label: '', view: 'left', positive: false, color: '#e5534b', title: 'Left view (-X)' },
  { dir: [0, 0, -1], label: 'Y', view: 'back', positive: true, color: '#57ab5a', title: 'Back view (+Y)' },
  { dir: [0, 0, 1], label: '', view: 'front', positive: false, color: '#57ab5a', title: 'Front view (-Y)' },
  { dir: [0, 1, 0], label: 'Z', view: 'top', positive: true, color: '#539bf5', title: 'Top view (+Z)' },
  { dir: [0, -1, 0], label: '', view: 'bottom', positive: false, color: '#539bf5', title: 'Bottom view (-Z)' },
];

const SIZE = 84;
const RADIUS = 28;

export class Gizmo {
  readonly root: HTMLElement;
  private readonly lines: SVGLineElement[] = [];
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(
    container: HTMLElement,
    private readonly source: GizmoSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);
    this.root = doc.createElement('div');
    this.root.className = 'ifc-gizmo';
    this.root.setAttribute('data-testid', 'gizmo');
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'View orientation');

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('aria-hidden', 'true');
    this.root.appendChild(svg);

    for (const axis of AXES) {
      if (axis.positive) {
        const line = doc.createElementNS(svgNs, 'line');
        line.setAttribute('stroke', axis.color);
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);
        this.lines.push(line);
      }
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = axis.positive ? 'ifc-gizmo__axis' : 'ifc-gizmo__axis ifc-gizmo__axis--neg';
      btn.setAttribute('data-testid', `gizmo-${axis.view}`);
      btn.title = axis.title;
      btn.setAttribute('aria-label', axis.title);
      btn.textContent = axis.label;
      btn.style.setProperty('--axis', axis.color);
      btn.addEventListener('click', () => this.source.setStandardView(axis.view));
      this.root.appendChild(btn);
      this.buttons.push(btn);
    }
    container.appendChild(this.root);
    this.update();
  }

  /** Re-aim the discs at the camera's current orientation. */
  update(): void {
    const basis = this.source.getCameraBasis();
    if (!basis) return;
    const c = SIZE / 2;
    let lineIndex = 0;
    AXES.forEach((axis, i) => {
      const [x, y, z] = axis.dir;
      const sx = x * basis.right[0] + y * basis.right[1] + z * basis.right[2];
      const sy = x * basis.up[0] + y * basis.up[1] + z * basis.up[2];
      const depth = x * basis.back[0] + y * basis.back[1] + z * basis.back[2];
      const px = c + sx * RADIUS;
      const py = c - sy * RADIUS;
      const btn = this.buttons[i];
      btn.style.left = `${px}px`;
      btn.style.top = `${py}px`;
      // Axes pointing at the camera draw on top and fully opaque.
      btn.style.zIndex = String(Math.round((depth + 1) * 10));
      btn.style.opacity = String(0.55 + 0.45 * ((depth + 1) / 2));
      if (axis.positive) {
        const line = this.lines[lineIndex++];
        line.setAttribute('x1', String(c));
        line.setAttribute('y1', String(c));
        line.setAttribute('x2', String(px));
        line.setAttribute('y2', String(py));
      }
    });
  }

  dispose(): void {
    this.root.remove();
  }
}
