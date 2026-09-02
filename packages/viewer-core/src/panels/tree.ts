// Left-overlay spatial tree (plain DOM). Renders Project -> Site -> Building ->
// Storey -> elements with lazy expansion. Clicking a node selects it (3D
// highlight + properties); a 3D selection reveals and highlights the node.
// A per-node eye toggle controls subtree visibility. A debounced search box
// filters the tree through the model search index (no engine calls).
import type { SpatialNode } from '../engine/types.js';
import type { SearchIndex } from '../search.js';
import { queryIndex } from '../search.js';
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

/** Header collapse chevron (points into the edge the panel leaves through). */
const COLLAPSE_LEFT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Edge button glyph: panel frame with the tree column filled. */
const RAIL_TREE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M2.6 3.6h3.2v8.8H2.6Z" fill="currentColor"/>' +
  '</svg>';

export interface TreeSource {
  getSpatialTree(): SpatialNode | null;
  getSearchIndex(): SearchIndex | null;
  select(expressID: number | null): void;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  onModelLoaded(listener: () => void): () => void;
  /** Panel visibility, driven by the header collapse and edge show buttons. */
  isTreeVisible(): boolean;
  setTreeVisible(visible: boolean): void;
  /** Visibility hooks used by the eye toggle. */
  isSubtreeVisible?(expressID: number): boolean;
  toggleSubtreeVisible?(expressID: number): void;
}

interface NodeEntry {
  node: SpatialNode;
  wrap: HTMLElement;
  row: HTMLElement;
  childrenWrap: HTMLElement;
  toggle: HTMLElement;
  built: boolean;
  expanded: boolean;
}

const AUTO_EXPAND_DEPTH = 3; // Project, Site, Building expanded; storeys collapsed
const SEARCH_DEBOUNCE_MS = 120;
/** Cap on rows revealed per search, so huge result sets stay responsive. */
const SEARCH_REVEAL_CAP = 200;

export class TreePanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  private collapseBtn!: HTMLButtonElement;
  private railBtn!: HTMLButtonElement;
  private readonly doc: Document;
  private readonly entries = new Map<number, NodeEntry>();
  private readonly parents = new Map<number, number>();
  private readonly unsubSelection: () => void;
  private readonly unsubLoaded: () => void;
  private selected: number | null = null;
  private searchTimer: number | null = null;
  /** expressIDs currently marked as shown/matched by the active search. */
  private searchShown: number[] = [];
  private searchMatched: number[] = [];
  private firstMatch: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly source: TreeSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-panel ifc-panel--left';
    this.root.setAttribute('data-testid', 'tree-panel');

    // Header: title on the left, the collapse control right-aligned beside it.
    const header = this.doc.createElement('div');
    header.className = 'ifc-panel__header';
    const title = this.doc.createElement('span');
    title.textContent = 'Spatial Tree';
    this.collapseBtn = this.doc.createElement('button');
    this.collapseBtn.className = 'ifc-panel__collapse';
    this.collapseBtn.setAttribute('data-testid', 'btn-tree-collapse');
    this.collapseBtn.title = 'Hide spatial tree';
    this.collapseBtn.setAttribute('aria-label', 'Hide spatial tree');
    this.collapseBtn.innerHTML = COLLAPSE_LEFT_ICON;
    this.collapseBtn.addEventListener('click', () => {
      this.source.setTreeVisible(false);
      // Keep keyboard users anchored: the way back is the edge button.
      this.railBtn.focus();
    });
    header.append(title, this.collapseBtn);
    this.root.appendChild(header);

    // Edge button shown while the panel is hidden (via the container class).
    this.railBtn = this.doc.createElement('button');
    this.railBtn.className = 'ifc-panel-rail ifc-panel-rail--left';
    this.railBtn.setAttribute('data-testid', 'btn-tree-show');
    this.railBtn.title = 'Show spatial tree';
    this.railBtn.setAttribute('aria-label', 'Show spatial tree');
    this.railBtn.innerHTML = RAIL_TREE_ICON;
    this.railBtn.addEventListener('click', () => {
      this.source.setTreeVisible(true);
      this.collapseBtn.focus();
    });
    container.appendChild(this.railBtn);

    // Search row: debounced index queries, result count, one-key clearing.
    const search = this.doc.createElement('div');
    search.className = 'ifc-panel__search';
    this.searchInput = this.doc.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = 'Search name, type, ID';
    this.searchInput.setAttribute('data-testid', 'tree-search');
    this.searchInput.setAttribute('aria-label', 'Search spatial tree');
    this.searchInput.addEventListener('input', () => this.scheduleSearch());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchInput.value) {
        this.clearSearch();
        e.stopPropagation();
      } else if (e.key === 'Enter' && this.firstMatch !== null) {
        this.source.select(this.firstMatch);
      }
    });
    this.searchCount = this.doc.createElement('span');
    this.searchCount.className = 'ifc-search-count';
    this.searchCount.setAttribute('data-testid', 'tree-search-count');
    const clear = this.doc.createElement('button');
    clear.className = 'ifc-search-clear';
    clear.setAttribute('data-testid', 'tree-search-clear');
    clear.title = 'Clear search';
    clear.setAttribute('aria-label', 'Clear search');
    clear.textContent = '×';
    clear.addEventListener('click', () => this.clearSearch());
    search.append(this.searchInput, this.searchCount, clear);
    this.root.appendChild(search);

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
    this.resetSearchState();

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

    const entry: NodeEntry = { node, wrap, row, childrenWrap, toggle, built: false, expanded: false };
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

  // -- search --------------------------------------------------------------

  private scheduleSearch(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.runSearch(this.searchInput.value);
    }, SEARCH_DEBOUNCE_MS);
  }

  private clearSearch(): void {
    this.searchInput.value = '';
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.runSearch('');
  }

  /** Drop all search marks and leave search mode (expansions are kept). */
  private unmarkSearch(): void {
    for (const id of this.searchShown) {
      this.entries.get(id)?.wrap.classList.remove('ifc-tree-show');
    }
    for (const id of this.searchMatched) {
      this.entries.get(id)?.row.classList.remove('ifc-tree-row--match');
    }
    this.searchShown = [];
    this.searchMatched = [];
    this.firstMatch = null;
    this.body.classList.remove('ifc-tree--searching');
  }

  private resetSearchState(): void {
    this.unmarkSearch();
    this.searchInput.value = '';
    this.searchCount.textContent = '';
  }

  private runSearch(query: string): void {
    this.unmarkSearch();
    const trimmed = query.trim();
    if (!trimmed) {
      this.searchCount.textContent = '';
      return;
    }

    const index = this.source.getSearchIndex();
    const matches = index ? queryIndex(index, trimmed) : [];
    this.firstMatch = matches.length > 0 ? matches[0].expressID : null;
    const revealed = matches.slice(0, SEARCH_REVEAL_CAP);

    const shown = new Set<number>();
    for (const match of revealed) {
      // Ancestors first, so the match's row exists (lazy DOM) and is open.
      for (const ancestor of match.ancestors) {
        this.expand(ancestor);
        shown.add(ancestor);
      }
      shown.add(match.expressID);
      const entry = this.entries.get(match.expressID);
      if (entry) {
        entry.row.classList.add('ifc-tree-row--match');
        this.searchMatched.push(match.expressID);
      }
    }
    for (const id of shown) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.wrap.classList.add('ifc-tree-show');
        this.searchShown.push(id);
      }
    }

    this.body.classList.add('ifc-tree--searching');
    const suffix = matches.length > revealed.length ? `, first ${revealed.length} shown` : '';
    this.searchCount.textContent =
      matches.length === 1 ? '1 match' : `${matches.length} matches${suffix}`;
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
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.unsubSelection();
    this.unsubLoaded();
    this.railBtn.remove();
    this.root.remove();
  }
}
