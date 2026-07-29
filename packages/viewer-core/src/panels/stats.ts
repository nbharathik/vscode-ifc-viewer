// Statistics overlay (plain DOM), toggled by the "Show Statistics" command.
// Shows parse/geometry timings, totals, and entity counts by IFC class.
import type { ModelStats } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

export interface StatsSource {
  getStats(): ModelStats | null;
}

export class StatsPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private visible = false;

  constructor(
    container: HTMLElement,
    private readonly source: StatsSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-stats';
    this.root.setAttribute('data-testid', 'stats-panel');

    const header = doc.createElement('div');
    header.className = 'ifc-stats__header';
    const title = doc.createElement('span');
    title.textContent = 'Statistics';
    const close = doc.createElement('span');
    close.className = 'ifc-stats__close';
    close.textContent = '✕';
    close.setAttribute('data-testid', 'stats-close');
    close.addEventListener('click', () => this.hide());
    header.append(title, close);
    this.root.appendChild(header);

    this.body = doc.createElement('div');
    this.body.className = 'ifc-stats__body';
    this.root.appendChild(this.body);

    container.appendChild(this.root);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.render();
    this.visible = true;
    this.root.classList.add('ifc-stats--visible');
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('ifc-stats--visible');
  }

  isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const doc = this.root.ownerDocument;
    this.body.replaceChildren();
    const stats = this.source.getStats();
    if (!stats) {
      const empty = doc.createElement('div');
      empty.className = 'ifc-empty';
      empty.textContent = 'No model loaded.';
      this.body.appendChild(empty);
      return;
    }

    const summary = doc.createElement('table');
    summary.className = 'ifc-table';
    const rows: Array<[string, string]> = [
      ['Entities', String(stats.totalEntities)],
      ['Meshes', String(stats.meshCount)],
      ['Triangles', String(stats.triangleCount)],
      ['Parse', `${stats.parseMs.toFixed(1)} ms`],
      ['Geometry', `${stats.geometryMs.toFixed(1)} ms`],
    ];
    if (stats.fileBytes !== undefined) {
      rows.unshift(['File', `${(stats.fileBytes / 1e6).toFixed(1)} MB`]);
    }
    if (stats.downloadMs !== undefined) {
      rows.push(['Download', `${stats.downloadMs.toFixed(1)} ms`]);
    }
    if (stats.uploadMs !== undefined) {
      rows.push(['Upload', `${stats.uploadMs.toFixed(1)} ms`]);
    }
    for (const [k, v] of rows) {
      const tr = doc.createElement('tr');
      const key = doc.createElement('td');
      key.className = 'ifc-key';
      key.textContent = k;
      const val = doc.createElement('td');
      val.className = 'ifc-val';
      val.setAttribute('data-stat', k);
      val.textContent = v;
      tr.append(key, val);
      summary.appendChild(tr);
    }
    this.body.appendChild(summary);

    const byTypeTitle = doc.createElement('div');
    byTypeTitle.className = 'ifc-section__title';
    byTypeTitle.textContent = 'By class';
    this.body.appendChild(byTypeTitle);

    const byType = doc.createElement('table');
    byType.className = 'ifc-table';
    const entries = Object.entries(stats.countsByType)
      .filter(([name]) => name.startsWith('Ifc'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    for (const [name, count] of entries) {
      const tr = doc.createElement('tr');
      const key = doc.createElement('td');
      key.className = 'ifc-key';
      key.textContent = name;
      const val = doc.createElement('td');
      val.className = 'ifc-val';
      val.textContent = String(count);
      tr.append(key, val);
      byType.appendChild(tr);
    }
    this.body.appendChild(byType);
  }

  dispose(): void {
    this.root.remove();
  }
}
