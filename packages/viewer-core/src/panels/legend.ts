// Highlight legend (plain DOM): one row per highlight group with its colour,
// label, count and a clear button. Docked bottom-left beside the spatial
// tree; shown only while groups exist and the legend is enabled.
import type { HighlightInfo } from '../scene/highlights.js';
import { ensurePanelStyles } from './styles.js';

const CLEAR_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '</svg>';

export interface LegendSource {
  getHighlights(): HighlightInfo[];
  onHighlightsChange(listener: () => void): () => void;
  clearHighlight(label?: string): void;
}

export class HighlightLegend {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private enabled = true;
  private readonly unsubscribe: () => void;

  constructor(
    container: HTMLElement,
    private readonly source: LegendSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-legend';
    this.root.setAttribute('data-testid', 'highlight-legend');

    const header = doc.createElement('div');
    header.className = 'ifc-legend__header';
    const title = doc.createElement('span');
    title.textContent = 'Highlights';
    const clearAll = doc.createElement('button');
    clearAll.className = 'ifc-legend__clear-all';
    clearAll.textContent = 'Clear all';
    clearAll.setAttribute('data-testid', 'legend-clear-all');
    clearAll.addEventListener('click', () => this.source.clearHighlight());
    header.append(title, clearAll);

    this.list = doc.createElement('div');
    this.list.className = 'ifc-legend__list';
    this.root.append(header, this.list);
    container.appendChild(this.root);

    this.unsubscribe = this.source.onHighlightsChange(() => this.render());
    this.render();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.render();
  }

  private render(): void {
    const doc = this.root.ownerDocument;
    const groups = this.source.getHighlights();
    this.root.classList.toggle('ifc-legend--visible', this.enabled && groups.length > 0);
    this.list.replaceChildren();
    for (const group of groups) {
      const row = doc.createElement('div');
      row.className = 'ifc-legend__row';
      row.setAttribute('data-label', group.label);

      const swatch = doc.createElement('span');
      swatch.className = 'ifc-legend__swatch';
      swatch.style.background = group.color;
      const label = doc.createElement('span');
      label.className = 'ifc-legend__label';
      label.textContent = group.label;
      label.title = group.label;
      const count = doc.createElement('span');
      count.className = 'ifc-legend__count';
      count.textContent = String(group.count);
      const clear = doc.createElement('button');
      clear.className = 'ifc-legend__clear';
      clear.title = `Clear "${group.label}"`;
      clear.setAttribute('aria-label', `Clear ${group.label}`);
      clear.innerHTML = CLEAR_ICON;
      clear.addEventListener('click', () => this.source.clearHighlight(group.label));

      row.append(swatch, label, count, clear);
      this.list.appendChild(row);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }
}
