// Compact view-options menu, docked top right beside the properties panel: a
// single layers icon that opens a vertical menu with the category toggles
// (Spaces, Openings) and Show all. Keeps the viewport center clean. Plain
// DOM; theme via CSS variables.
import type { LazyCategory } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

// Monochrome stacked-layers icon (inherits currentColor).
const LAYERS_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 1.6 14.6 5 8 8.4 1.4 5 8 1.6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="m2.7 7.9-1.3.7L8 12l6.6-3.4-1.3-.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="m2.7 10.9-1.3.7L8 15l6.6-3.4-1.3-.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '</svg>';

export interface ToolbarSource {
  setCategoryVisible(category: LazyCategory, visible: boolean): void;
  isCategoryVisible(category: LazyCategory): boolean;
  showAll(): void;
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private open = false;

  constructor(
    container: HTMLElement,
    private readonly source: ToolbarSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-tools';
    this.root.setAttribute('data-testid', 'toolbar');

    this.toggle = doc.createElement('button');
    this.toggle.className = 'ifc-tools__toggle';
    this.toggle.setAttribute('data-testid', 'toolbar-toggle');
    this.toggle.title = 'View options';
    this.toggle.setAttribute('aria-label', 'View options');
    this.toggle.setAttribute('aria-haspopup', 'true');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.innerHTML = LAYERS_ICON;
    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    this.root.appendChild(this.toggle);

    this.menu = doc.createElement('div');
    this.menu.className = 'ifc-tools__menu';
    this.menu.setAttribute('role', 'menu');
    this.menu.appendChild(this.categoryButton(doc, 'IfcSpace', 'Spaces', 'btn-spaces'));
    this.menu.appendChild(
      this.categoryButton(doc, 'IfcOpeningElement', 'Openings', 'btn-openings'),
    );

    const showAll = doc.createElement('button');
    showAll.setAttribute('data-testid', 'btn-showall');
    showAll.textContent = 'Show all';
    showAll.addEventListener('click', () => this.source.showAll());
    this.menu.appendChild(showAll);

    this.root.appendChild(this.menu);
    container.appendChild(this.root);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('ifc-tools--open', open);
    this.toggle.setAttribute('aria-expanded', String(open));
  }

  private categoryButton(
    doc: Document,
    category: LazyCategory,
    label: string,
    testId: string,
  ): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.setAttribute('data-testid', testId);
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(this.source.isCategoryVisible(category)));
    btn.addEventListener('click', () => {
      const next = !this.source.isCategoryVisible(category);
      this.source.setCategoryVisible(category, next);
      btn.setAttribute('aria-pressed', String(this.source.isCategoryVisible(category)));
    });
    return btn;
  }

  dispose(): void {
    this.root.remove();
  }
}
