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
  /** True while an editing session is up; value cells then accept edits. */
  canEdit?(): boolean;
  /** True when editing is available but not started yet (on-demand sessions). */
  canEnableEditing?(): boolean;
  /** Start the idle editing session; cells become editable once it is ready. */
  enableEditing?(): void;
  editAttribute?(expressID: number, name: string, value: string | null): Promise<void>;
  editProperty?(expressID: number, edit: PropertyEdit): Promise<void>;
  /** Add an empty property set to an element. */
  addPset?(expressID: number, name: string): Promise<void>;
  /** Remove one property from a set the element owns. */
  removeProperty?(expressID: number, edit: { pset: string; psetId: number; name: string }): Promise<void>;
  /** Re-render when the model was edited or the session changed. */
  onModelChanged?(listener: () => void): () => void;
}

export interface PropertyEdit {
  pset: string;
  psetId: number;
  kind: 'pset' | 'qto';
  name: string;
  value: string | number | boolean | null;
  /** Set when a property is being created: "text", "number" or "boolean". */
  valueType?: NewValueKind;
}

/** What the "Add property" row can create. */
export type NewValueKind = 'text' | 'number' | 'boolean';

/** A new property's text as a typed value; undefined when it does not fit the kind. */
export function parseNewValue(text: string, kind: NewValueKind): string | number | boolean | undefined {
  if (kind === 'boolean') {
    const t = text.trim().toLowerCase();
    return t === 'true' || t === 'yes' ? true : t === 'false' || t === 'no' ? false : undefined;
  }
  if (kind === 'number') {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return text;
}

/** A unit symbol ("m", "mm", "kg") as opposed to an IFC type name ("IFCLABEL") or a quantity kind ("Length"). */
export function isUnitSymbol(unit: string | null | undefined): unit is string {
  return typeof unit === 'string' && /^[a-zµ°²³/%·^0-9-]{1,10}$/.test(unit);
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

    // The sidebar owns the panel chrome (header, collapse, edge button); this is its Item tab.
    this.root = doc.createElement('div');
    this.root.className = 'ifc-tab';
    this.root.setAttribute('data-testid', 'properties-panel');

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
    // Rows are hidden-safe: render now so a selection made before the tab is opened is ready.
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
    if (this.source.canEdit?.() && this.source.addPset) {
      this.body.appendChild(this.renderAddPset(props.expressID));
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
    if (this.source.canEdit?.() && pset.kind === 'pset') section.appendChild(this.renderAddProperty(pset, ownerId));
    return section;
  }

  /** Report an edit that failed, in the panel, for a few seconds. */
  private notice(message: string): void {
    const doc = this.root.ownerDocument;
    this.body.querySelector('.ifc-notice')?.remove();
    const el = doc.createElement('div');
    el.className = 'ifc-notice';
    el.setAttribute('role', 'alert');
    el.setAttribute('data-testid', 'props-notice');
    el.textContent = message;
    this.body.prepend(el);
    window.setTimeout(() => el.remove(), 6000);
  }

  private run(action: Promise<void> | undefined): void {
    void (action ?? Promise.reject(new Error('Editing is not available.'))).catch((err: unknown) =>
      this.notice(err instanceof Error ? err.message : String(err)),
    );
  }

  /** "+ Add property" under a set: a small form (name, type, value) that opens in place. */
  private renderAddProperty(pset: IfcPropertySet, ownerId: number): HTMLElement {
    const doc = this.root.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'ifc-add';
    const open = doc.createElement('button');
    open.className = 'ifc-add__open';
    open.setAttribute('data-testid', `add-property-${pset.name}`);
    open.textContent = '+ Add property';
    wrap.appendChild(open);

    open.addEventListener('click', () => {
      open.hidden = true;
      this.editing = true;
      const form = doc.createElement('form');
      form.className = 'ifc-add__form';
      const name = doc.createElement('input');
      name.placeholder = 'Name';
      name.setAttribute('data-testid', 'add-property-name');
      name.setAttribute('aria-label', 'Property name');
      const kind = doc.createElement('select');
      kind.setAttribute('data-testid', 'add-property-type');
      kind.setAttribute('aria-label', 'Value type');
      for (const [value, label] of [['text', 'Text'], ['number', 'Number'], ['boolean', 'Yes/No']] as const) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = label;
        kind.appendChild(option);
      }
      const value = doc.createElement('input');
      value.placeholder = 'Value';
      value.setAttribute('data-testid', 'add-property-value');
      value.setAttribute('aria-label', 'Value');
      kind.addEventListener('change', () => {
        value.placeholder = kind.value === 'boolean' ? 'true or false' : kind.value === 'number' ? '0' : 'Value';
      });
      const add = doc.createElement('button');
      add.type = 'submit';
      add.textContent = 'Add';
      add.setAttribute('data-testid', 'add-property-submit');
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      const close = (): void => {
        form.remove();
        open.hidden = false;
        this.editing = false;
      };
      cancel.addEventListener('click', close);
      form.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const trimmed = name.value.trim();
        const typed = parseNewValue(value.value, kind.value as NewValueKind);
        if (!trimmed) {
          name.classList.add('ifc-edit-invalid');
          return;
        }
        if (typed === undefined) {
          value.classList.add('ifc-edit-invalid');
          value.title = kind.value === 'boolean' ? 'Enter true or false' : 'Enter a number';
          return;
        }
        close();
        this.run(
          this.source.editProperty?.(ownerId, {
            pset: pset.name,
            psetId: pset.expressID,
            kind: pset.kind,
            name: trimmed,
            value: typed,
            valueType: kind.value as NewValueKind,
          }),
        );
      });
      form.append(name, kind, value, add, cancel);
      wrap.appendChild(form);
      name.focus();
    });
    return wrap;
  }

  /** "+ Add property set" at the end of the panel. */
  private renderAddPset(ownerId: number): HTMLElement {
    const doc = this.root.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'ifc-add ifc-add--pset';
    const open = doc.createElement('button');
    open.className = 'ifc-add__open';
    open.setAttribute('data-testid', 'add-pset');
    open.textContent = '+ Add property set';
    wrap.appendChild(open);
    open.addEventListener('click', () => {
      open.hidden = true;
      this.editing = true;
      const form = doc.createElement('form');
      form.className = 'ifc-add__form';
      const name = doc.createElement('input');
      name.placeholder = 'Pset_Custom';
      name.setAttribute('data-testid', 'add-pset-name');
      name.setAttribute('aria-label', 'Property set name');
      const add = doc.createElement('button');
      add.type = 'submit';
      add.textContent = 'Add';
      add.setAttribute('data-testid', 'add-pset-submit');
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      const close = (): void => {
        form.remove();
        open.hidden = false;
        this.editing = false;
      };
      cancel.addEventListener('click', close);
      form.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const trimmed = name.value.trim();
        if (!trimmed) {
          name.classList.add('ifc-edit-invalid');
          return;
        }
        close();
        this.run(this.source.addPset?.(ownerId, trimmed));
      });
      form.append(name, add, cancel);
      wrap.appendChild(form);
      name.focus();
    });
    return wrap;
  }

  /** Can this row be edited? Never GlobalId; only plain scalars. */
  private isEditable(row: IfcProperty, target: EditTarget): boolean {
    return Boolean(this.source.canEdit?.()) && this.wouldBeEditable(row, target);
  }

  /** The row's own rules for editing, independent of whether a session is up. */
  private wouldBeEditable(row: IfcProperty, target: EditTarget): boolean {
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
      this.fillValue(val, row);
      if (this.isEditable(row, target)) {
        val.classList.add('ifc-val--editable');
        val.title = 'Double-click to edit';
        val.addEventListener('dblclick', () => this.beginEdit(val, row, target, ownerId));
      } else if (this.source.canEnableEditing?.() && this.wouldBeEditable(row, target)) {
        // On-demand session: the first double-click starts IfcOpenShell, and
        // the panel re-renders with editable cells when it is ready.
        val.classList.add('ifc-val--enable');
        val.title = 'Double-click to enable editing (starts IfcOpenShell)';
        val.addEventListener('dblclick', () => this.source.enableEditing?.());
      }
      tr.append(key, val);
      // A property of a set can be removed; attributes and read-only rows cannot.
      if (target.kind === 'pset' && this.source.canEdit?.() && this.source.removeProperty && target.pset.kind === 'pset') {
        const actions = doc.createElement('td');
        actions.className = 'ifc-row-actions';
        const remove = doc.createElement('button');
        remove.className = 'ifc-row-remove';
        remove.title = `Remove ${row.name}`;
        remove.setAttribute('aria-label', `Remove ${row.name}`);
        remove.setAttribute('data-testid', `remove-${target.pset.name}.${row.name}`);
        remove.textContent = '×';
        remove.addEventListener('click', () =>
          this.run(
            this.source.removeProperty?.(ownerId, {
              pset: target.pset.name,
              psetId: target.pset.expressID,
              name: row.name,
            }),
          ),
        );
        actions.appendChild(remove);
        tr.appendChild(actions);
      }
      table.appendChild(tr);
    }
    return table;
  }

  /** A value cell's text, with the unit symbol after it when the property has one. */
  private fillValue(cell: HTMLElement, row: IfcProperty): void {
    const { text, isNull } = formatValue(row.value);
    cell.textContent = text;
    cell.classList.toggle('ifc-null', isNull);
    if (!isNull && isUnitSymbol(row.unit) && typeof row.value === 'number') {
      const unit = cell.ownerDocument.createElement('span');
      unit.className = 'ifc-unit';
      unit.textContent = ` ${row.unit}`;
      cell.appendChild(unit);
    }
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
      this.fillValue(cell, row);
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
          const message = err instanceof Error ? err.message : String(err);
          cell.title = message;
          restore();
          cell.classList.add('ifc-edit-failed');
          // The server explains why (a value that does not fit the type, an
          // enumeration), and that deserves more than a tooltip.
          this.notice(message);
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
    this.root.remove();
  }
}
