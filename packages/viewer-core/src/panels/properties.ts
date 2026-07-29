// Right-overlay properties panel (plain DOM). Shows the selected element's direct
// attributes and all psets/qtos with values, and an empty state otherwise.
// Subscribes to the selection source so it updates automatically.
import type { ItemProperties, IfcProperty, IfcPropertySet } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

export interface PropertiesSource {
  getProperties(expressID: number): Promise<ItemProperties | null>;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
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
  private readonly unsubscribe: () => void;
  /** Guards against out-of-order async property responses. */
  private renderSeq = 0;

  constructor(
    container: HTMLElement,
    private readonly source: PropertiesSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-panel ifc-panel--right';
    this.root.setAttribute('data-testid', 'properties-panel');

    const header = doc.createElement('div');
    header.className = 'ifc-panel__header';
    header.textContent = 'Properties';
    this.root.appendChild(header);

    this.body = doc.createElement('div');
    this.body.className = 'ifc-panel__body';
    this.root.appendChild(this.body);

    container.appendChild(this.root);

    void this.render(this.source.getSelection());
    this.unsubscribe = this.source.onSelectionChange((id) => void this.render(id));
  }

  private async render(expressID: number | null): Promise<void> {
    const seq = ++this.renderSeq;
    const doc = this.root.ownerDocument;

    if (expressID === null) {
      this.body.replaceChildren();
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
    this.unsubscribe();
    this.root.remove();
  }
}
