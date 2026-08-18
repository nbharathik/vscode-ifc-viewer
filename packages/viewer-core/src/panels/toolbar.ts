// Compact view controls, docked top right beside the properties panel: a
// panels toggle that shows or hides the spatial tree and the properties panel
// together, and a layers icon that opens a vertical menu with the category
// toggles (Spaces, Openings) and Show all. Keeps the viewport center clean.
// Plain DOM; theme via CSS variables.
import type { LazyCategory } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

// Monochrome stacked-layers icon (inherits currentColor).
const LAYERS_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 1.6 14.6 5 8 8.4 1.4 5 8 1.6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="m2.7 7.9-1.3.7L8 12l6.6-3.4-1.3-.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="m2.7 10.9-1.3.7L8 15l6.6-3.4-1.3-.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '</svg>';

// Side-panel icons: solid side columns while the panels are shown, dashed
// outlines while they are hidden, so the button reads at a glance.
const PANELS_FRAME =
  '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>';
const PANELS_SHOWN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  PANELS_FRAME +
  '<path d="M2.6 3.6h2.8v8.8H2.6Z M10.6 3.6h2.8v8.8h-2.8Z" fill="currentColor"/>' +
  '</svg>';
const PANELS_HIDDEN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  PANELS_FRAME +
  '<path d="M5.4 3.6v8.8M10.6 3.6v8.8" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 2" opacity="0.6"/>' +
  '</svg>';

export interface ToolbarSource {
  setCategoryVisible(category: LazyCategory, visible: boolean): void;
  isCategoryVisible(category: LazyCategory): boolean;
  showAll(): void;
  /** Spatial tree and properties panel, shown and hidden as one state. */
  arePanelsVisible(): boolean;
  setPanelsVisible(visible: boolean): void;
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly panelsBtn: HTMLButtonElement;
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

    const buttons = doc.createElement('div');
    buttons.className = 'ifc-tools__buttons';

    // Panels toggle. The label and icon follow the state, so this button is
    // also the way back once both panels are gone.
    this.panelsBtn = doc.createElement('button');
    this.panelsBtn.className = 'ifc-tools__toggle';
    this.panelsBtn.setAttribute('data-testid', 'btn-panels');
    this.panelsBtn.addEventListener('click', () =>
      this.source.setPanelsVisible(!this.source.arePanelsVisible()),
    );
    buttons.appendChild(this.panelsBtn);

    this.toggle = doc.createElement('button');
    this.toggle.className = 'ifc-tools__toggle';
    this.toggle.setAttribute('data-testid', 'toolbar-toggle');
    this.toggle.title = 'View options';
    this.toggle.setAttribute('aria-label', 'View options');
    this.toggle.setAttribute('aria-haspopup', 'true');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.innerHTML = LAYERS_ICON;
    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    buttons.appendChild(this.toggle);

    this.root.appendChild(buttons);

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
    this.syncPanelsState();
  }

  /**
   * Re-read the panel visibility from the source and update the button. The
   * viewer calls this after every change so the button stays correct whether
   * the toggle came from a click or from the API.
   */
  syncPanelsState(): void {
    const visible = this.source.arePanelsVisible();
    const label = visible ? 'Hide panels' : 'Show panels';
    this.panelsBtn.innerHTML = visible ? PANELS_SHOWN_ICON : PANELS_HIDDEN_ICON;
    this.panelsBtn.title = label;
    this.panelsBtn.setAttribute('aria-label', label);
    this.panelsBtn.setAttribute('aria-pressed', String(visible));
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
