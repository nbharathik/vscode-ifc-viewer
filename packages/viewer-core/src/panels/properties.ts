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
  /** True while an editing session is up; value cells then accept edits. */
  canEdit?(): boolean;
  editAttribute?(expressID: number, name: string, value: string | null): Promise<void>;
  editProperty?(expressID: number, edit: PropertyEdit): Promise<void>;
  /** Re-render when the model was edited or the session changed. */
  onModelChanged?(listener: () => void): () => void;
}

export interface PropertyEdit {
  pset: string;
  psetId: number;
  kind: 'pset' | 'qto';
  name: string;
  value: string | number | boolean | null;
}

/** Where a table's rows live, so an edit knows what to change. */
type EditTarget = { kind: 'attr' } | { kind: 'pset'; pset: IfcPropertySet };

/** Parse typed text back into the value's original type; undefined when it does not fit. */
export function parseEdited(
  text: string,
  original: IfcProperty['value'],
): string | number | boolean | null | undefined {
  if (typeof original === 'boolean') {
    const t = text.trim().toLowerCase();
    return t === 'true' ? true : t === 'false' ? false : undefined;
  }
  if (typeof original === 'number') {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return text === '' && original === null ? null : text;
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
  private currentId: number | null = null;
  private readonly unsubscribeModel: (() => void) | undefined;

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
    this.unsubscribeModel = this.source.onModelChanged?.(() => {
      if (this.currentId !== null && !this.editing) void this.render(this.currentId);
    });
  }

  /** True while a value cell is open for typing; re-rendering then would discard it. */
  private editing = false;

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
    this.currentId = expressID;
    this.editing = false;

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
      this.body.appendChild(this.renderPset(pset, props.expressID));
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

    section.appendChild(this.renderTable(props.attributes, 'attr', { kind: 'attr' }, props.expressID));
    return section;
  }

  private renderPset(pset: IfcPropertySet, ownerId: number): HTMLElement {
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
      section.appendChild(this.renderTable(pset.properties, `pset:${pset.name}`, { kind: 'pset', pset }, ownerId));
    }
    return section;
  }

  /** Can this row be edited? Never GlobalId; only plain scalars. */
  private isEditable(row: IfcProperty, target: EditTarget): boolean {
    if (!this.source.canEdit?.()) return false;
    if (target.kind === 'attr') {
      return row.name !== 'GlobalId' && (typeof row.value === 'string' || row.value === null);
    }
    return row.value === null || ['string', 'number', 'boolean'].includes(typeof row.value);
  }

  private renderTable(rows: IfcProperty[], scope: string, target: EditTarget, ownerId: number): HTMLElement {
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
      if (this.isEditable(row, target)) {
        val.classList.add('ifc-val--editable');
        val.title = 'Double-click to edit';
        val.addEventListener('dblclick', () => this.beginEdit(val, row, target, ownerId));
      }
      tr.append(key, val);
      table.appendChild(tr);
    }
    return table;
  }

  /** Swap a value cell for an input; Enter commits, Escape or blur cancels. */
  private beginEdit(cell: HTMLElement, row: IfcProperty, target: EditTarget, ownerId: number): void {
    if (this.editing) return;
    this.editing = true;
    const doc = this.root.ownerDocument;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'ifc-edit-input';
    input.setAttribute('data-testid', 'prop-edit-input');
    input.value = row.value === null || row.value === undefined ? '' : String(row.value);
    cell.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const restore = (): void => {
      if (finished) return;
      finished = true;
      this.editing = false;
      const { text, isNull } = formatValue(row.value);
      cell.textContent = text;
      cell.classList.toggle('ifc-null', isNull);
    };
    const commit = (): void => {
      if (finished) return;
      const parsed = parseEdited(input.value, row.value);
      if (parsed === undefined) {
        input.classList.add('ifc-edit-invalid');
        input.title = typeof row.value === 'boolean' ? 'Enter true or false' : 'Enter a number';
        return;
      }
      if (parsed === row.value) {
        restore();
        return;
      }
      finished = true;
      input.disabled = true;
      const done =
        target.kind === 'attr'
          ? this.source.editAttribute?.(ownerId, row.name, parsed as string | null)
          : this.source.editProperty?.(ownerId, {
              pset: target.pset.name,
              psetId: target.pset.expressID,
              kind: target.pset.kind,
              name: row.name,
              value: parsed,
            });
      void (done ?? Promise.reject(new Error('Editing is not available.')))
        .then(() => {
          this.editing = false;
          // The model-edited event re-renders; this covers a no-op edit.
          if (this.currentId === ownerId) void this.render(ownerId);
        })
        .catch((err: unknown) => {
          finished = false;
          this.editing = false;
          cell.title = err instanceof Error ? err.message : String(err);
          restore();
          cell.classList.add('ifc-edit-failed');
        });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        restore();
      }
    });
    input.addEventListener('blur', () => restore());
  }

  dispose(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.unsubscribe();
    this.unsubscribeModel?.();
    this.railBtn.remove();
    this.root.remove();
  }
}
