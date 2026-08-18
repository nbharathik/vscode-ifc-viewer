// Left-overlay spatial tree (plain DOM). Renders Project -> Site -> Building ->
// Storey -> elements with lazy expansion. Clicking a node selects it (3D
// highlight + properties); a 3D selection reveals and highlights the node.
// A per-node eye toggle controls subtree visibility.
import type { SpatialNode } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

// Monochrome eye icons (inherit currentColor) for the visibility toggle.
const EYE_SHOWN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const EYE_HIDDEN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/><line x1="2.6" y1="2.6" x2="13.4" y2="13.4" stroke="currentColor" stroke-width="1.3"/></svg>';

function setEyeState(el: HTMLElement, visible: boolean): void {
  el.innerHTML = visible ? EYE_SHOWN : EYE_HIDDEN;
  el.title = visible ? 'Hide' : 'Show';
  el.setAttribute('aria-label', visible ? 'Hide' : 'Show');
}

export interface TreeSource {
  getSpatialTree(): SpatialNode | null;
  select(expressID: number | null): void;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  onModelLoaded(listener: () => void): () => void;
  /** Visibility hooks used by the eye toggle. */
  isSubtreeVisible?(expressID: number): boolean;
  toggleSubtreeVisible?(expressID: number): void;
}

interface NodeEntry {
  node: SpatialNode;
  row: HTMLElement;
  childrenWrap: HTMLElement;
  toggle: HTMLElement;
  built: boolean;
  expanded: boolean;
}

const AUTO_EXPAND_DEPTH = 3; // Project, Site, Building expanded; storeys collapsed

export class TreePanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly doc: Document;
  private readonly entries = new Map<number, NodeEntry>();
  private readonly parents = new Map<number, number>();
  private readonly unsubSelection: () => void;
  private readonly unsubLoaded: () => void;
  private selected: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly source: TreeSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-panel ifc-panel--left';
    this.root.setAttribute('data-testid', 'tree-panel');

    const header = this.doc.createElement('div');
    header.className = 'ifc-panel__header';
    header.textContent = 'Spatial Tree';
    this.root.appendChild(header);

    this.body = this.doc.createElement('div');
    this.body.className = 'ifc-panel__body';
    this.root.appendChild(this.body);

    container.appendChild(this.root);

    this.render();
    this.unsubLoaded = this.source.onModelLoaded(() => this.render());
    this.unsubSelection = this.source.onSelectionChange((id) => this.reveal(id));
  }

  private render(): void {
    this.body.replaceChildren();
    this.entries.clear();
    this.parents.clear();
    this.selected = null;

    const tree = this.source.getSpatialTree();
    if (!tree) {
      const empty = this.doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.setAttribute('data-testid', 'tree-empty');
      empty.textContent = 'No model loaded.';
      this.body.appendChild(empty);
      return;
    }
    this.indexParents(tree, null);
    this.body.appendChild(this.buildNode(tree, 0));
  }

  private indexParents(node: SpatialNode, parent: number | null): void {
    if (parent !== null) this.parents.set(node.expressID, parent);
    for (const child of node.children) this.indexParents(child, node.expressID);
  }

  private buildNode(node: SpatialNode, depth: number): HTMLElement {
    const wrap = this.doc.createElement('div');
    wrap.className = 'ifc-tree-node';
    wrap.setAttribute('data-express-id', String(node.expressID));

    const row = this.doc.createElement('div');
    row.className = 'ifc-tree-row';

    const toggle = this.doc.createElement('span');
    toggle.className = 'ifc-tree-toggle';
    const hasChildren = node.children.length > 0;
    if (!hasChildren) toggle.classList.add('ifc-tree-toggle--leaf');
    toggle.textContent = '▶';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle(node.expressID);
    });
    row.appendChild(toggle);

    const label = this.doc.createElement('span');
    label.className = 'ifc-tree-label';
    const name = this.doc.createElement('span');
    name.textContent = node.name ?? '(unnamed)';
    const type = this.doc.createElement('span');
    type.className = 'ifc-tree-type';
    type.textContent = node.type;
    label.append(name, type);
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      this.source.select(node.expressID);
    });
    row.appendChild(label);

    if (this.source.toggleSubtreeVisible && this.source.isSubtreeVisible) {
      const eye = this.doc.createElement('span');
      eye.className = 'ifc-tree-eye';
      eye.setAttribute('data-testid', `tree-eye-${node.expressID}`);
      setEyeState(eye, this.source.isSubtreeVisible(node.expressID));
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.source.toggleSubtreeVisible!(node.expressID);
        const visible = this.source.isSubtreeVisible!(node.expressID);
        setEyeState(eye, visible);
        wrap.classList.toggle('ifc-tree-node--hidden', !visible);
      });
      row.appendChild(eye);
    }

    wrap.appendChild(row);

    const childrenWrap = this.doc.createElement('div');
    childrenWrap.className = 'ifc-tree-children';
    childrenWrap.style.display = 'none';
    wrap.appendChild(childrenWrap);

    const entry: NodeEntry = { node, row, childrenWrap, toggle, built: false, expanded: false };
    this.entries.set(node.expressID, entry);

    if (hasChildren && depth < AUTO_EXPAND_DEPTH) {
      this.expand(node.expressID);
    }
    return wrap;
  }

  private buildChildren(entry: NodeEntry, depth: number): void {
    if (entry.built) return;
    for (const child of entry.node.children) {
      entry.childrenWrap.appendChild(this.buildNode(child, depth + 1));
    }
    entry.built = true;
  }

  private depthOf(expressID: number): number {
    let depth = 0;
    let cur = expressID;
    while (this.parents.has(cur)) {
      cur = this.parents.get(cur)!;
      depth++;
    }
    return depth;
  }

  expand(expressID: number): void {
    const entry = this.entries.get(expressID);
    if (!entry || entry.node.children.length === 0) return;
    this.buildChildren(entry, this.depthOf(expressID));
    entry.expanded = true;
    entry.childrenWrap.style.display = 'block';
    entry.toggle.textContent = '▼';
  }

  collapse(expressID: number): void {
    const entry = this.entries.get(expressID);
    if (!entry) return;
    entry.expanded = false;
    entry.childrenWrap.style.display = 'none';
    entry.toggle.textContent = '▶';
  }

  private toggle(expressID: number): void {
    const entry = this.entries.get(expressID);
    if (!entry) return;
    if (entry.expanded) this.collapse(expressID);
    else this.expand(expressID);
  }

  /**
   * Scroll the selected row back into view. The viewer calls this when the
   * panel becomes visible again, since a hidden panel loses its scroll offset.
   */
  revealSelection(): void {
    if (this.selected !== null) this.reveal(this.selected);
  }

  /** Expand ancestors and highlight the node for a 3D selection. */
  private reveal(expressID: number | null): void {
    if (this.selected !== null) {
      this.entries.get(this.selected)?.row.classList.remove('ifc-tree-row--selected');
      this.entries.get(this.selected)?.row.removeAttribute('data-selected');
    }
    this.selected = expressID;
    if (expressID === null) return;

    // Expand the path from root to this node so its row exists in the DOM.
    const chain: number[] = [];
    let cur: number | undefined = expressID;
    while (cur !== undefined && this.parents.has(cur)) {
      cur = this.parents.get(cur);
      if (cur !== undefined) chain.unshift(cur);
    }
    for (const ancestor of chain) this.expand(ancestor);

    const entry = this.entries.get(expressID);
    if (entry) {
      entry.row.classList.add('ifc-tree-row--selected');
      entry.row.setAttribute('data-selected', 'true');
      entry.row.scrollIntoView({ block: 'nearest' });
    }
  }

  dispose(): void {
    this.unsubSelection();
    this.unsubLoaded();
    this.root.remove();
  }
}
