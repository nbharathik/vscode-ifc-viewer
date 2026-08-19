// Right-overlay properties panel (plain DOM). Shows the selected element's direct
// attributes and all psets/qtos with values, and an empty state otherwise.
// Subscribes to the selection source so it updates automatically. A local
// search box filters the rendered rows; it never issues engine requests.
import type { ItemProperties, IfcProperty, IfcPropertySet } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

const SEARCH_DEBOUNCE_MS = 100;

export interface PropertiesSource {
  getProperties(expressID: number): Promise<ItemProperties | null>;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  /** Panel visibility, driven by the header collapse and edge show buttons. */
  arePropertiesVisible(): boolean;
  setPropertiesVisible(visible: boolean): void;
}

/** Header collapse chevron (points into the edge the panel leaves through). */
const COLLAPSE_RIGHT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.5 10.7 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Edge button glyph: panel frame with the properties column filled. */
const RAIL_PROPS_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M10.2 3.6h3.2v8.8h-3.2Z" fill="currentColor"/>' +
  '</svg>';

function formatValue(value: IfcProperty['value']): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: '—', isNull: true };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  if (typeof value === 'number') return { text: String(value), isNull: false };
  if (value === '') return { text: '(empty)', isNull: true };
  return { text: String(value), isNull: false };
}

export class PropertiesPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private collapseBtn!: HTMLButtonElement;
  private railBtn!: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  /** Guards against out-of-order async property responses. */
  private renderSeq = 0;
  private searchTimer: number | null = null;
  private hasContent = false;

  constructor(
    container: HTMLElement,
    private readonly source: PropertiesSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-panel ifc-panel--right';
    this.root.setAttribute('data-testid', 'properties-panel');

    // Header: title on the left, the collapse control right-aligned beside it.
    const header = doc.createElement('div');
    header.className = 'ifc-panel__header';
    const title = doc.createElement('span');
    title.textContent = 'Properties';
    this.collapseBtn = doc.createElement('button');
    this.collapseBtn.className = 'ifc-panel__collapse';
    this.collapseBtn.setAttribute('data-testid', 'btn-props-collapse');
    this.collapseBtn.title = 'Hide properties';
    this.collapseBtn.setAttribute('aria-label', 'Hide properties');
    this.collapseBtn.innerHTML = COLLAPSE_RIGHT_ICON;
    this.collapseBtn.addEventListener('click', () => {
      this.source.setPropertiesVisible(false);
      this.railBtn.focus();
    });
    header.append(title, this.collapseBtn);
    this.root.appendChild(header);

    // Edge button shown while the panel is hidden (via the container class).
    this.railBtn = doc.createElement('button');
    this.railBtn.className = 'ifc-panel-rail ifc-panel-rail--right';
    this.railBtn.setAttribute('data-testid', 'btn-props-show');
    this.railBtn.title = 'Show properties';
    this.railBtn.setAttribute('aria-label', 'Show properties');
    this.railBtn.innerHTML = RAIL_PROPS_ICON;
    this.railBtn.addEventListener('click', () => {
      this.source.setPropertiesVisible(true);
      this.collapseBtn.focus();
    });
    container.appendChild(this.railBtn);

    // Local search over the rendered rows; persists across selections.
    const search = doc.createElement('div');
    search.className = 'ifc-panel__search';
    this.searchInput = doc.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = 'Filter properties';
    this.searchInput.setAttribute('data-testid', 'props-search');
    this.searchInput.setAttribute('aria-label', 'Filter properties');
    this.searchInput.addEventListener('input', () => this.scheduleFilter());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchInput.value) {
        this.searchInput.value = '';
        this.applyFilter();
        e.stopPropagation();
      }
    });
    const clear = doc.createElement('button');
    clear.className = 'ifc-search-clear';
    clear.setAttribute('data-testid', 'props-search-clear');
    clear.title = 'Clear filter';
    clear.setAttribute('aria-label', 'Clear filter');
    clear.textContent = '×';
    clear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.applyFilter();
    });
    search.append(this.searchInput, clear);
    this.root.appendChild(search);

    this.body = doc.createElement('div');
    this.body.className = 'ifc-panel__body';
    this.root.appendChild(this.body);

    container.appendChild(this.root);

    void this.render(this.source.getSelection());
    this.unsubscribe = this.source.onSelectionChange((id) => void this.render(id));
  }

  private scheduleFilter(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.applyFilter();
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Hide rows whose name and value both miss the query. A matching section
   * title keeps its whole section. DOM-only; no property refetch.
   */
  private applyFilter(): void {
    const doc = this.root.ownerDocument;
    const query = this.searchInput.value.trim().toLowerCase();
    this.body.querySelector('[data-testid="props-search-empty"]')?.remove();
    let anyVisible = false;
    for (const section of this.body.querySelectorAll<HTMLElement>('.ifc-section')) {
      const title = section.querySelector('.ifc-section__title')?.textContent ?? '';
      const titleHit = query !== '' && title.toLowerCase().includes(query);
      let visibleRows = 0;
      for (const row of section.querySelectorAll<HTMLElement>('tr')) {
        const hit =
          query === '' || titleHit || (row.textContent ?? '').toLowerCase().includes(query);
        row.style.display = hit ? '' : 'none';
        if (hit) visibleRows++;
      }
      const keepSection = query === '' || titleHit || visibleRows > 0;
      section.style.display = keepSection ? '' : 'none';
      if (keepSection) anyVisible = true;
    }
    if (query !== '' && !anyVisible && this.hasContent) {
      const empty = doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.setAttribute('data-testid', 'props-search-empty');
      empty.textContent = 'No matching properties.';
      this.body.appendChild(empty);
    }
  }

  private async render(expressID: number | null): Promise<void> {
    const seq = ++this.renderSeq;
    const doc = this.root.ownerDocument;

    if (expressID === null) {
      this.body.replaceChildren();
      this.hasContent = false;
      const empty = doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.setAttribute('data-testid', 'properties-empty');
      empty.textContent = 'No element selected. Click an element in the 3D view.';
      this.body.appendChild(empty);
      return;
    }

    let props: ItemProperties | null;
    try {
      props = await this.source.getProperties(expressID);
    } catch {
      props = null;
    }
    if (seq !== this.renderSeq) return; // a newer selection superseded this one

    this.body.replaceChildren();
    if (!props) {
      this.hasContent = false;
      const empty = doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.textContent = 'Properties unavailable.';
      this.body.appendChild(empty);
      return;
    }

    this.body.appendChild(this.renderAttributes(props));
    for (const pset of props.psets) {
      this.body.appendChild(this.renderPset(pset));
    }
    this.hasContent = true;
    // Keep the active filter applied to the freshly rendered rows.
    if (this.searchInput.value.trim() !== '') this.applyFilter();
  }

  private renderAttributes(props: ItemProperties): HTMLElement {
    const doc = this.root.ownerDocument;
    const section = doc.createElement('div');
    section.className = 'ifc-section';

    const title = doc.createElement('div');
    title.className = 'ifc-section__title';
    const type = doc.createElement('span');
    type.setAttribute('data-testid', 'prop-type');
    type.textContent = props.type;
    title.appendChild(type);
    section.appendChild(title);

    section.appendChild(this.renderTable(props.attributes, 'attr'));
    return section;
  }

  private renderPset(pset: IfcPropertySet): HTMLElement {
    const doc = this.root.ownerDocument;
    const section = doc.createElement('div');
    section.className = 'ifc-section';
    section.setAttribute('data-pset', pset.name);

    const title = doc.createElement('div');
    title.className = 'ifc-section__title';
    const name = doc.createElement('span');
    name.textContent = pset.name;
    const badge = doc.createElement('span');
    badge.className = 'ifc-badge';
    badge.textContent = pset.kind;
    title.append(name, badge);
    section.appendChild(title);

    if (pset.properties.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.setAttribute('data-testid', `pset-empty-${pset.name}`);
      empty.textContent = 'No properties.';
      section.appendChild(empty);
    } else {
      section.appendChild(this.renderTable(pset.properties, `pset:${pset.name}`));
    }
    return section;
  }

  private renderTable(rows: IfcProperty[], scope: string): HTMLElement {
    const doc = this.root.ownerDocument;
    const table = doc.createElement('table');
    table.className = 'ifc-table';
    for (const row of rows) {
      const tr = doc.createElement('tr');
      const key = doc.createElement('td');
      key.className = 'ifc-key';
      key.textContent = row.name;
      const val = doc.createElement('td');
      val.className = 'ifc-val';
      val.setAttribute('data-prop', `${scope}.${row.name}`);
      const { text, isNull } = formatValue(row.value);
      val.textContent = text;
      if (isNull) val.classList.add('ifc-null');
      tr.append(key, val);
      table.appendChild(tr);
    }
    return table;
  }

  dispose(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.unsubscribe();
    this.railBtn.remove();
    this.root.remove();
  }
}
