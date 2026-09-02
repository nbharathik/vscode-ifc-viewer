// Compact icon toolbar, docked top-left beside the spatial tree (it slides
// toward the viewport edge when the tree is hidden, leaving room for the
// tree's show button). Permanent buttons are icon-only; less frequent actions
// live in small flyouts, at most one open at a time. The panel toggles are
// not here: each panel embeds its own collapse control in its header.
// Plain DOM; theme via CSS variables; monochrome inline SVG icons.
import type { LazyCategory } from '../engine/types.js';
import type { FilterOptions, SectionState } from '../viewer.js';
import type { ProjectionMode, SectionAxis } from '../scene/scene.js';
import type { StandardView } from '../scene/controls.js';
import { ensurePanelStyles } from './styles.js';

const SVG_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true">';
const SVG_CLOSE = '</svg>';
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.2"';

/** Fit: four corner brackets around a dot. */
const FIT_ICON =
  SVG_OPEN +
  `<path d="M2 5.2V2h3.2M10.8 2H14v3.2M14 10.8V14h-3.2M5.2 14H2v-3.2" ${STROKE} stroke-linecap="round"/>` +
  '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
  SVG_CLOSE;

/** Views: axonometric cube. */
const VIEWS_ICON =
  SVG_OPEN +
  `<path d="M8 1.8 14 4.9v6.2L8 14.2 2 11.1V4.9L8 1.8Z" ${STROKE} stroke-linejoin="round"/>` +
  `<path d="M2 4.9 8 8l6-3.1M8 8v6.2" ${STROKE} stroke-linejoin="round"/>` +
  SVG_CLOSE;

/** Visibility: eye. */
const VISIBILITY_ICON =
  SVG_OPEN +
  `<path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" ${STROKE}/>` +
  `<circle cx="8" cy="8" r="1.9" ${STROKE}/>` +
  SVG_CLOSE;

/** Section: box cut by a dashed plane. */
const SECTION_ICON =
  SVG_OPEN +
  `<path d="M3 5.4h10v7.2H3Z" ${STROKE}/>` +
  '<path d="M1.4 5.4h13.2" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 1.8"/>' +
  `<path d="M5.4 2.8h5.2v2.6" ${STROKE} opacity="0.55"/>` +
  SVG_CLOSE;

/** Filter: funnel. */
const FILTER_ICON =
  SVG_OPEN +
  `<path d="M2 3h12L9.6 8.4v4.4L6.4 14V8.4L2 3Z" ${STROKE} stroke-linejoin="round"/>` +
  SVG_CLOSE;

/** Everything the toolbar drives; implemented by the viewer. The panel
 * toggles are not here: they live in the panel headers and edge buttons. */
export interface ToolbarSource {
  fitToModel(): unknown;
  fitToSelection(): unknown;
  setStandardView(view: StandardView): unknown;
  getProjection(): ProjectionMode;
  setProjection(mode: ProjectionMode): void;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  onModelLoaded(listener: () => void): () => void;
  hideSelected(): void;
  isolateSelected(): void;
  showAll(): void;
  setCategoryVisible(category: LazyCategory, visible: boolean): void;
  isCategoryVisible(category: LazyCategory): boolean;
  getSectionState(): SectionState;
  setSectionEnabled(enabled: boolean): void;
  setSectionAxis(axis: SectionAxis): void;
  setSectionPosition(position: number): void;
  setSectionFlipped(flipped: boolean): void;
  resetSection(): void;
  getFilterOptions(): FilterOptions;
  getTypeFilter(): string[] | null;
  setTypeFilter(types: string[] | null): void;
  getStoreyFilter(): number[] | null;
  setStoreyFilter(storeys: number[] | null): void;
  resetFilters(): void;
}

interface FlyoutEntry {
  button: HTMLButtonElement;
  wrap: HTMLElement;
  menu: HTMLElement;
}

const STANDARD_VIEWS: { view: StandardView; label: string }[] = [
  { view: 'iso', label: 'Isometric' },
  { view: 'top', label: 'Top' },
  { view: 'front', label: 'Front' },
  { view: 'right', label: 'Right' },
  { view: 'left', label: 'Left' },
  { view: 'back', label: 'Back' },
  { view: 'bottom', label: 'Bottom' },
];

export class Toolbar {
  readonly root: HTMLElement;
  private readonly doc: Document;
  private readonly flyouts = new Map<string, FlyoutEntry>();
  private openFlyout: string | null = null;

  private fitSelectionBtn!: HTMLButtonElement;
  private projectionBtn!: HTMLButtonElement;
  private hideBtn!: HTMLButtonElement;
  private isolateBtn!: HTMLButtonElement;
  private spacesBtn!: HTMLButtonElement;
  private openingsBtn!: HTMLButtonElement;
  private sectionToggleBtn!: HTMLButtonElement;
  private sectionEnableBtn!: HTMLButtonElement;
  private sectionAxisBtns!: Record<SectionAxis, HTMLButtonElement>;
  private sectionSlider!: HTMLInputElement;
  private sectionFlipBtn!: HTMLButtonElement;
  private filterToggleBtn!: HTMLButtonElement;
  private typeList!: HTMLElement;
  private storeyList!: HTMLElement;

  private readonly unsubSelection: () => void;
  private readonly unsubLoaded: () => void;
  private readonly outsideHandler: (e: PointerEvent) => void;
  private readonly escapeHandler: (e: KeyboardEvent) => void;

  constructor(
    container: HTMLElement,
    private readonly source: ToolbarSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-tools';
    this.root.setAttribute('data-testid', 'toolbar');

    this.buildFitButton();
    this.buildViewsFlyout();
    this.buildVisibilityFlyout();
    this.buildSectionFlyout();
    this.buildFilterFlyout();

    container.appendChild(this.root);

    this.syncSelection();
    this.syncSection();
    this.syncFilters();
    this.syncProjection();
    this.refreshModelControls();

    this.unsubSelection = this.source.onSelectionChange(() => this.syncSelection());
    this.unsubLoaded = this.source.onModelLoaded(() => this.refreshModelControls());

    // Click outside or Escape closes the open flyout.
    this.outsideHandler = (e) => {
      if (this.openFlyout && e.target instanceof Node && !this.root.contains(e.target)) {
        this.closeFlyouts();
      }
    };
    this.doc.addEventListener('pointerdown', this.outsideHandler);
    this.escapeHandler = (e) => {
      if (e.key === 'Escape' && this.openFlyout) {
        const entry = this.flyouts.get(this.openFlyout);
        this.closeFlyouts();
        entry?.button.focus();
        e.stopPropagation();
      }
    };
    this.root.addEventListener('keydown', this.escapeHandler);
  }

  // -- construction helpers ------------------------------------------------

  private iconButton(testId: string, label: string, icon: string): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.className = 'ifc-tools__toggle';
    btn.setAttribute('data-testid', testId);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon;
    return btn;
  }

  private menuButton(testId: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.setAttribute('data-testid', testId);
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private menuLabel(text: string): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = 'ifc-menu__label';
    el.textContent = text;
    return el;
  }

  private menuSeparator(): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = 'ifc-menu__sep';
    return el;
  }

  private setPressed(btn: HTMLButtonElement, pressed: boolean): void {
    btn.setAttribute('aria-pressed', String(pressed));
  }

  /** Wrap an icon button with a flyout menu and register it with the manager. */
  private addFlyout(id: string, label: string, icon: string): HTMLElement {
    const wrap = this.doc.createElement('div');
    wrap.className = 'ifc-tool';
    const button = this.iconButton(id, label, icon);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => this.toggleFlyout(id));
    const menu = this.doc.createElement('div');
    menu.className = 'ifc-tools__menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-testid', `${id}-menu`);
    wrap.append(button, menu);
    this.root.appendChild(wrap);
    this.flyouts.set(id, { button, wrap, menu });
    return menu;
  }

  private toggleFlyout(id: string): void {
    const next = this.openFlyout === id ? null : id;
    this.closeFlyouts();
    if (!next) return;
    const entry = this.flyouts.get(next);
    if (!entry) return;
    this.openFlyout = next;
    entry.wrap.classList.add('ifc-tool--open');
    entry.button.setAttribute('aria-expanded', 'true');
    const first = entry.menu.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)',
    );
    first?.focus();
  }

  private closeFlyouts(): void {
    if (!this.openFlyout) return;
    const entry = this.flyouts.get(this.openFlyout);
    entry?.wrap.classList.remove('ifc-tool--open');
    entry?.button.setAttribute('aria-expanded', 'false');
    this.openFlyout = null;
  }

  // -- controls ------------------------------------------------------------

  private buildFitButton(): void {
    const fit = this.iconButton('btn-fit', 'Fit model', FIT_ICON);
    fit.addEventListener('click', () => {
      this.closeFlyouts();
      this.source.fitToModel();
    });
    this.root.appendChild(fit);
  }

  private buildViewsFlyout(): void {
    const menu = this.addFlyout('btn-views', 'Views', VIEWS_ICON);

    this.fitSelectionBtn = this.menuButton('btn-fit-selection', 'Fit selection', () => {
      this.source.fitToSelection();
      this.closeFlyouts();
    });
    menu.appendChild(this.fitSelectionBtn);
    menu.appendChild(this.menuSeparator());

    for (const { view, label } of STANDARD_VIEWS) {
      menu.appendChild(
        this.menuButton(`view-${view}`, label, () => {
          this.source.setStandardView(view);
          this.closeFlyouts();
        }),
      );
    }

    menu.appendChild(this.menuSeparator());
    this.projectionBtn = this.menuButton('btn-projection', 'Orthographic', () => {
      const next = this.source.getProjection() === 'orthographic' ? 'perspective' : 'orthographic';
      this.source.setProjection(next);
    });
    menu.appendChild(this.projectionBtn);
    menu.appendChild(
      this.menuButton('view-reset', 'Reset view', () => {
        this.source.fitToModel();
        this.closeFlyouts();
      }),
    );
  }

  private buildVisibilityFlyout(): void {
    const menu = this.addFlyout('btn-visibility', 'Visibility', VISIBILITY_ICON);

    this.hideBtn = this.menuButton('btn-hide-selected', 'Hide selected', () =>
      this.source.hideSelected(),
    );
    this.isolateBtn = this.menuButton('btn-isolate-selected', 'Isolate selected', () =>
      this.source.isolateSelected(),
    );
    const showAll = this.menuButton('btn-showall', 'Show all', () => this.source.showAll());
    menu.append(this.hideBtn, this.isolateBtn, showAll, this.menuSeparator());

    this.spacesBtn = this.categoryButton('IfcSpace', 'Spaces', 'btn-spaces');
    this.openingsBtn = this.categoryButton('IfcOpeningElement', 'Openings', 'btn-openings');
    menu.append(this.spacesBtn, this.openingsBtn);
  }

  private categoryButton(
    category: LazyCategory,
    label: string,
    testId: string,
  ): HTMLButtonElement {
    const btn = this.menuButton(testId, label, () => {
      const next = !this.source.isCategoryVisible(category);
      this.source.setCategoryVisible(category, next);
      this.setPressed(btn, this.source.isCategoryVisible(category));
    });
    this.setPressed(btn, this.source.isCategoryVisible(category));
    return btn;
  }

  private buildSectionFlyout(): void {
    const menu = this.addFlyout('btn-section', 'Section plane', SECTION_ICON);
    this.sectionToggleBtn = this.flyouts.get('btn-section')!.button;

    this.sectionEnableBtn = this.menuButton('section-enable', 'Section plane', () => {
      this.source.setSectionEnabled(!this.source.getSectionState().enabled);
    });
    menu.appendChild(this.sectionEnableBtn);

    menu.appendChild(this.menuLabel('Axis'));
    const axisRow = this.doc.createElement('div');
    axisRow.className = 'ifc-menu__row';
    this.sectionAxisBtns = {} as Record<SectionAxis, HTMLButtonElement>;
    for (const axis of ['x', 'y', 'z'] as const) {
      const btn = this.menuButton(`section-axis-${axis}`, axis.toUpperCase(), () =>
        this.source.setSectionAxis(axis),
      );
      this.sectionAxisBtns[axis] = btn;
      axisRow.appendChild(btn);
    }
    menu.appendChild(axisRow);

    menu.appendChild(this.menuLabel('Position'));
    this.sectionSlider = this.doc.createElement('input');
    this.sectionSlider.type = 'range';
    this.sectionSlider.className = 'ifc-menu__slider';
    this.sectionSlider.setAttribute('data-testid', 'section-slider');
    this.sectionSlider.setAttribute('aria-label', 'Section position');
    this.sectionSlider.addEventListener('input', () => {
      this.source.setSectionPosition(Number(this.sectionSlider.value));
    });
    menu.appendChild(this.sectionSlider);

    this.sectionFlipBtn = this.menuButton('section-flip', 'Flip side', () => {
      this.source.setSectionFlipped(!this.source.getSectionState().flipped);
    });
    menu.appendChild(this.sectionFlipBtn);
    menu.appendChild(
      this.menuButton('section-reset', 'Reset section', () => this.source.resetSection()),
    );
  }

  private buildFilterFlyout(): void {
    const menu = this.addFlyout('btn-filter', 'Filters', FILTER_ICON);
    this.filterToggleBtn = this.flyouts.get('btn-filter')!.button;

    menu.appendChild(this.menuLabel('Types'));
    this.typeList = this.doc.createElement('div');
    this.typeList.className = 'ifc-menu__list';
    this.typeList.setAttribute('data-testid', 'filter-types');
    menu.appendChild(this.typeList);

    menu.appendChild(this.menuLabel('Storeys'));
    this.storeyList = this.doc.createElement('div');
    this.storeyList.className = 'ifc-menu__list';
    this.storeyList.setAttribute('data-testid', 'filter-storeys');
    menu.appendChild(this.storeyList);

    menu.appendChild(this.menuSeparator());
    menu.appendChild(
      this.menuButton('btn-reset-filters', 'Reset filters', () => this.source.resetFilters()),
    );
  }

  /** Toggle one value inside a filter group; an empty group deactivates it. */
  private toggleFilterValue<T>(current: T[] | null, value: T): T[] | null {
    const set = new Set(current ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return set.size === 0 ? null : [...set];
  }

  // -- state sync ----------------------------------------------------------

  /** Enable/disable the selection-dependent actions. */
  syncSelection(): void {
    const none = this.source.getSelection() === null;
    this.fitSelectionBtn.disabled = none;
    this.hideBtn.disabled = none;
    this.isolateBtn.disabled = none;
  }

  syncProjection(): void {
    this.setPressed(this.projectionBtn, this.source.getProjection() === 'orthographic');
  }

  syncSection(): void {
    const state = this.source.getSectionState();
    this.sectionToggleBtn.setAttribute('data-active', String(state.enabled));
    this.setPressed(this.sectionEnableBtn, state.enabled);
    for (const axis of ['x', 'y', 'z'] as const) {
      this.setPressed(this.sectionAxisBtns[axis], state.axis === axis);
      this.sectionAxisBtns[axis].disabled = !state.enabled;
    }
    const range = state.range;
    this.sectionSlider.disabled = !state.enabled || !range;
    this.sectionFlipBtn.disabled = !state.enabled;
    this.setPressed(this.sectionFlipBtn, state.flipped);
    if (range) {
      const min = String(range.min);
      const max = String(range.max);
      const step = String((range.max - range.min) / 200 || 1);
      if (this.sectionSlider.min !== min) this.sectionSlider.min = min;
      if (this.sectionSlider.max !== max) this.sectionSlider.max = max;
      if (this.sectionSlider.step !== step) this.sectionSlider.step = step;
      this.sectionSlider.value = String(state.position);
    }
  }

  syncFilters(): void {
    const typeFilter = new Set(this.source.getTypeFilter() ?? []);
    for (const btn of this.typeList.querySelectorAll('button')) {
      this.setPressed(btn, typeFilter.has(btn.getAttribute('data-type') ?? ''));
    }
    const storeyFilter = new Set(this.source.getStoreyFilter() ?? []);
    for (const btn of this.storeyList.querySelectorAll('button')) {
      this.setPressed(btn, storeyFilter.has(Number(btn.getAttribute('data-storey'))));
    }
    const active = typeFilter.size > 0 || storeyFilter.size > 0;
    this.filterToggleBtn.setAttribute('data-active', String(active));
  }

  /** Rebuild the model-dependent controls (filter lists, slider range). */
  refreshModelControls(): void {
    const options = this.source.getFilterOptions();

    this.typeList.replaceChildren();
    if (options.types.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'ifc-menu__empty';
      empty.textContent = 'No model loaded.';
      this.typeList.appendChild(empty);
    }
    for (const { type, count } of options.types) {
      const btn = this.menuButton(`filter-type-${type}`, `${type} (${count})`, () => {
        this.source.setTypeFilter(this.toggleFilterValue(this.source.getTypeFilter(), type));
      });
      btn.setAttribute('data-type', type);
      this.typeList.appendChild(btn);
    }

    this.storeyList.replaceChildren();
    if (options.storeys.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'ifc-menu__empty';
      empty.textContent = 'No storeys.';
      this.storeyList.appendChild(empty);
    }
    for (const storey of options.storeys) {
      const label = storey.name ?? `Storey ${storey.expressID}`;
      const btn = this.menuButton(`filter-storey-${storey.expressID}`, label, () => {
        this.source.setStoreyFilter(
          this.toggleFilterValue(this.source.getStoreyFilter(), storey.expressID),
        );
      });
      btn.setAttribute('data-storey', String(storey.expressID));
      this.storeyList.appendChild(btn);
    }

    // Category visibility resets with each load; re-read it into the buttons.
    this.setPressed(this.spacesBtn, this.source.isCategoryVisible('IfcSpace'));
    this.setPressed(this.openingsBtn, this.source.isCategoryVisible('IfcOpeningElement'));

    this.syncFilters();
    this.syncSection();
    this.syncSelection();
  }

  dispose(): void {
    this.unsubSelection();
    this.unsubLoaded();
    this.doc.removeEventListener('pointerdown', this.outsideHandler);
    this.root.remove();
  }
}
