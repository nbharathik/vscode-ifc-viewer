// Status bar along the bottom edge: what is selected, how much is on screen,
// and any items the host adds (engine state, agent connection, unsaved edits).
// Plain DOM; read-only apart from items that have a click handler.
import { ensurePanelStyles } from './styles.js';

/** Class and name of the selection, resolved by the viewer. */
export interface StatusSelection {
  ifcClass: string;
  name: string | null;
}

export interface StatusSource {
  getSelection(): number | null;
  describeSelection(expressID: number): Promise<StatusSelection | null>;
  getTriangleCounts(): { visible: number; total: number } | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  onModelLoaded(listener: () => void): () => void;
  onVisibilityChange(listener: () => void): () => void;
  onViewChanged(listener: () => void): () => void;
  onModelEdited(listener: () => void): () => void;
}

/** A host-supplied status bar entry. */
export interface StatusItemSpec {
  id: string;
  /** Text shown in the bar; keep it short. */
  text: string;
  /** Longer description shown as a tooltip and read by screen readers. */
  title?: string;
  /** Trusted inline SVG markup drawn with currentColor, shown before the text. */
  icon?: string;
  /** Which end of the bar the item sits at. Defaults to the right. */
  align?: 'left' | 'right';
  /** Makes the item a button. */
  onClick?: () => void;
}

export interface StatusItemHandle {
  setText(text: string): void;
  setTitle(title: string): void;
  setActive(active: boolean): void;
  setDisabled(disabled: boolean): void;
  setHidden(hidden: boolean): void;
  remove(): void;
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export class StatusBar {
  readonly root: HTMLElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly trianglesEl: HTMLElement;
  private selectionSeq = 0;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly source: StatusSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-status';
    this.root.setAttribute('data-testid', 'status-bar');
    this.root.setAttribute('role', 'status');

    this.left = doc.createElement('div');
    this.left.className = 'ifc-status__side';
    this.right = doc.createElement('div');
    this.right.className = 'ifc-status__side ifc-status__side--right';

    this.selectionEl = doc.createElement('span');
    this.selectionEl.className = 'ifc-status__item';
    this.selectionEl.setAttribute('data-testid', 'status-selection');
    this.trianglesEl = doc.createElement('span');
    this.trianglesEl.className = 'ifc-status__item';
    this.trianglesEl.setAttribute('data-testid', 'status-triangles');
    this.left.appendChild(this.selectionEl);
    this.right.appendChild(this.trianglesEl);

    this.root.append(this.left, this.right);
    container.appendChild(this.root);
    container.classList.add('ifc-has-status');

    let pending = false;
    const refreshCounts = (): void => {
      if (pending) return;
      pending = true;
      const run = (): void => {
        pending = false;
        this.renderTriangles();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else run();
    };
    this.unsubs.push(
      source.onSelectionChange(() => void this.renderSelection()),
      source.onModelLoaded(() => {
        void this.renderSelection();
        refreshCounts();
      }),
      source.onVisibilityChange(refreshCounts),
      source.onViewChanged(refreshCounts),
      source.onModelEdited(refreshCounts),
    );
    void this.renderSelection();
    this.renderTriangles();
  }

  /** Add a host item; returns a handle to update or remove it. */
  addItem(spec: StatusItemSpec): StatusItemHandle {
    const doc = this.container.ownerDocument;
    const el = doc.createElement(spec.onClick ? 'button' : 'span');
    el.className = 'ifc-status__item';
    el.setAttribute('data-testid', `status-${spec.id}`);
    if (spec.onClick) {
      (el as HTMLButtonElement).type = 'button';
      el.classList.add('ifc-status__item--button');
      el.addEventListener('click', spec.onClick);
    }
    const icon = doc.createElement('span');
    icon.className = 'ifc-status__icon';
    if (spec.icon) icon.innerHTML = spec.icon;
    else icon.hidden = true;
    const text = doc.createElement('span');
    text.textContent = spec.text;
    el.append(icon, text);
    const setTitle = (title: string): void => {
      el.title = title;
      el.setAttribute('aria-label', title ? `${text.textContent ?? ''}: ${title}` : (text.textContent ?? ''));
    };
    setTitle(spec.title ?? '');
    (spec.align === 'left' ? this.left : this.right).appendChild(el);
    return {
      setText: (value) => {
        text.textContent = value;
        setTitle(el.title);
      },
      setTitle,
      setActive: (active) => el.setAttribute('data-active', String(active)),
      setDisabled: (disabled) => {
        if (el instanceof HTMLButtonElement) el.disabled = disabled;
        el.setAttribute('aria-disabled', String(disabled));
      },
      setHidden: (hidden) => {
        el.hidden = hidden;
      },
      remove: () => el.remove(),
    };
  }

  private async renderSelection(): Promise<void> {
    const seq = ++this.selectionSeq;
    const id = this.source.getSelection();
    if (id === null) {
      this.selectionEl.textContent = 'Nothing selected';
      this.selectionEl.removeAttribute('title');
      return;
    }
    this.selectionEl.textContent = `#${id}`;
    const info = await this.source.describeSelection(id).catch(() => null);
    if (seq !== this.selectionSeq || !info) return;
    const label = info.name ? `${info.ifcClass}  ${info.name}` : info.ifcClass;
    this.selectionEl.textContent = label;
    this.selectionEl.title = `${label} (#${id})`;
  }

  private renderTriangles(): void {
    const counts = this.source.getTriangleCounts();
    if (!counts || counts.total === 0) {
      this.trianglesEl.textContent = '';
      return;
    }
    this.trianglesEl.textContent =
      counts.visible === counts.total
        ? `${formatCount(counts.total)} triangles`
        : `${formatCount(counts.visible)} of ${formatCount(counts.total)} triangles`;
    this.trianglesEl.title = `${counts.visible.toLocaleString('en-US')} of ${counts.total.toLocaleString('en-US')} triangles visible`;
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.container.classList.remove('ifc-has-status');
    this.root.remove();
  }
}
