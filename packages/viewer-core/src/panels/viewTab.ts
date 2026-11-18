// View tab of the sidebar: camera, visibility, section plane and filters in one
// scrolling column, every control always in reach (no flyouts). The same actions
// are in the command search and on the tool shelf; this tab adds the controls
// that need room (section slider, filter lists). Plain DOM.
import type { LazyCategory } from '../engine/types.js';
import type { FilterOptions, SectionState } from '../viewer.js';
import type { ProjectionMode, SectionAxis } from '../scene/scene.js';
import type { StandardView } from '../scene/controls.js';
import { ensurePanelStyles } from './styles.js';

/** Everything the View tab drives; implemented by the viewer. */
export interface ViewSource {
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

const STANDARD_VIEWS: { view: StandardView; label: string }[] = [
  { view: 'iso', label: 'Isometric' },
  { view: 'top', label: 'Top' },
  { view: 'front', label: 'Front' },
  { view: 'right', label: 'Right' },
  { view: 'left', label: 'Left' },
  { view: 'back', label: 'Back' },
  { view: 'bottom', label: 'Bottom' },
];

export class ViewTab {
  readonly root: HTMLElement;
  private readonly doc: Document;

  private fitSelectionBtn!: HTMLButtonElement;
  private projectionBtn!: HTMLButtonElement;
  private hideBtn!: HTMLButtonElement;
  private isolateBtn!: HTMLButtonElement;
  private spacesBtn!: HTMLButtonElement;
  private openingsBtn!: HTMLButtonElement;
  private sectionEnableBtn!: HTMLButtonElement;
  private sectionAxisBtns!: Record<SectionAxis, HTMLButtonElement>;
  private sectionSlider!: HTMLInputElement;
  private sectionFlipBtn!: HTMLButtonElement;
  private sectionResetBtn!: HTMLButtonElement;
  private filterBadge!: HTMLElement;
  private typeList!: HTMLElement;
  private storeyList!: HTMLElement;

  private readonly unsubSelection: () => void;
  private readonly unsubLoaded: () => void;

  constructor(
    container: HTMLElement,
    private readonly source: ViewSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-tab ifc-viewtab';
    this.root.setAttribute('data-testid', 'view-tab');
    const scroll = this.doc.createElement('div');
    scroll.className = 'ifc-panel__body';
    this.root.appendChild(scroll);

    scroll.append(this.buildCamera(), this.buildVisibility(), this.buildSection(), this.buildFilters());
    container.appendChild(this.root);

    this.syncSelection();
    this.syncSection();
    this.syncProjection();
    this.refreshModelControls();

    this.unsubSelection = this.source.onSelectionChange(() => this.syncSelection());
    this.unsubLoaded = this.source.onModelLoaded(() => this.refreshModelControls());
  }

  // -- construction helpers ------------------------------------------------

  private group(title: string): { el: HTMLElement; body: HTMLElement; heading: HTMLElement } {
    const el = this.doc.createElement('section');
    el.className = 'ifc-viewtab__group';
    const heading = this.doc.createElement('div');
    heading.className = 'ifc-menu__label';
    heading.textContent = title;
    const body = this.doc.createElement('div');
    body.className = 'ifc-viewtab__body';
    el.append(heading, body);
    return { el, body, heading };
  }

  private button(testId: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-testid', testId);
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private row(...children: HTMLElement[]): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = 'ifc-menu__row';
    el.append(...children);
    return el;
  }

  private setPressed(btn: HTMLButtonElement, pressed: boolean): void {
    btn.setAttribute('aria-pressed', String(pressed));
  }

  // -- sections ------------------------------------------------------------

  private buildCamera(): HTMLElement {
    const { el, body } = this.group('Camera');
    this.fitSelectionBtn = this.button('btn-fit-selection', 'Fit selection', () => this.source.fitToSelection());
    body.append(this.row(this.button('view-reset', 'Fit model', () => this.source.fitToModel()), this.fitSelectionBtn));

    const grid = this.doc.createElement('div');
    grid.className = 'ifc-viewtab__grid';
    for (const { view, label } of STANDARD_VIEWS) {
      grid.appendChild(this.button(`view-${view}`, label, () => this.source.setStandardView(view)));
    }
    body.appendChild(grid);

    this.projectionBtn = this.button('btn-projection', 'Orthographic', () => {
      const next = this.source.getProjection() === 'orthographic' ? 'perspective' : 'orthographic';
      this.source.setProjection(next);
    });
    body.appendChild(this.projectionBtn);
    return el;
  }

  private buildVisibility(): HTMLElement {
    const { el, body } = this.group('Visibility');
    this.hideBtn = this.button('btn-hide-selected', 'Hide selected', () => this.source.hideSelected());
    this.isolateBtn = this.button('btn-isolate-selected', 'Isolate selected', () => this.source.isolateSelected());
    const showAll = this.button('btn-showall', 'Show all', () => this.source.showAll());
    body.append(this.row(this.hideBtn, this.isolateBtn), showAll);
    this.spacesBtn = this.categoryButton('IfcSpace', 'Spaces', 'btn-spaces');
    this.openingsBtn = this.categoryButton('IfcOpeningElement', 'Openings', 'btn-openings');
    body.appendChild(this.row(this.spacesBtn, this.openingsBtn));
    return el;
  }

  private categoryButton(category: LazyCategory, label: string, testId: string): HTMLButtonElement {
    const btn = this.button(testId, label, () => {
      this.source.setCategoryVisible(category, !this.source.isCategoryVisible(category));
      this.setPressed(btn, this.source.isCategoryVisible(category));
    });
    this.setPressed(btn, this.source.isCategoryVisible(category));
    return btn;
  }

  private buildSection(): HTMLElement {
    const { el, body } = this.group('Section plane');
    this.sectionEnableBtn = this.button('section-enable', 'Section plane', () =>
      this.source.setSectionEnabled(!this.source.getSectionState().enabled),
    );
    body.appendChild(this.sectionEnableBtn);

    this.sectionAxisBtns = {} as Record<SectionAxis, HTMLButtonElement>;
    const axisRow: HTMLButtonElement[] = [];
    for (const axis of ['x', 'y', 'z'] as const) {
      const btn = this.button(`section-axis-${axis}`, axis.toUpperCase(), () => this.source.setSectionAxis(axis));
      this.sectionAxisBtns[axis] = btn;
      axisRow.push(btn);
    }
    body.appendChild(this.row(...axisRow));

    this.sectionSlider = this.doc.createElement('input');
    this.sectionSlider.type = 'range';
    this.sectionSlider.className = 'ifc-menu__slider';
    this.sectionSlider.setAttribute('data-testid', 'section-slider');
    this.sectionSlider.setAttribute('aria-label', 'Section position');
    this.sectionSlider.addEventListener('input', () => {
      this.source.setSectionPosition(Number(this.sectionSlider.value));
    });
    body.appendChild(this.sectionSlider);

    this.sectionFlipBtn = this.button('section-flip', 'Flip side', () =>
      this.source.setSectionFlipped(!this.source.getSectionState().flipped),
    );
    this.sectionResetBtn = this.button('section-reset', 'Reset section', () => this.source.resetSection());
    body.appendChild(this.row(this.sectionFlipBtn, this.sectionResetBtn));
    return el;
  }

  private buildFilters(): HTMLElement {
    const { el, body, heading } = this.group('Filters');
    this.filterBadge = this.doc.createElement('span');
    this.filterBadge.className = 'ifc-badge';
    this.filterBadge.setAttribute('data-testid', 'filters-active');
    this.filterBadge.textContent = 'active';
    this.filterBadge.hidden = true;
    heading.appendChild(this.filterBadge);

    const typesLabel = this.doc.createElement('div');
    typesLabel.className = 'ifc-viewtab__sub';
    typesLabel.textContent = 'Types';
    this.typeList = this.doc.createElement('div');
    this.typeList.className = 'ifc-menu__list';
    this.typeList.setAttribute('data-testid', 'filter-types');

    const storeysLabel = this.doc.createElement('div');
    storeysLabel.className = 'ifc-viewtab__sub';
    storeysLabel.textContent = 'Storeys';
    this.storeyList = this.doc.createElement('div');
    this.storeyList.className = 'ifc-menu__list';
    this.storeyList.setAttribute('data-testid', 'filter-storeys');

    body.append(
      typesLabel,
      this.typeList,
      storeysLabel,
      this.storeyList,
      this.button('btn-reset-filters', 'Reset filters', () => this.source.resetFilters()),
    );
    return el;
  }

  /** Toggle one value inside a filter group; an empty group deactivates it. */
  private toggleFilterValue<T>(current: T[] | null, value: T): T[] | null {
    const set = new Set(current ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return set.size === 0 ? null : [...set];
  }

  // -- state sync ----------------------------------------------------------

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
    this.setPressed(this.sectionEnableBtn, state.enabled);
    for (const axis of ['x', 'y', 'z'] as const) {
      this.setPressed(this.sectionAxisBtns[axis], state.axis === axis);
      this.sectionAxisBtns[axis].disabled = !state.enabled;
    }
    const range = state.range;
    this.sectionSlider.disabled = !state.enabled || !range;
    this.sectionFlipBtn.disabled = !state.enabled;
    this.sectionResetBtn.disabled = !state.enabled;
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
    this.filterBadge.hidden = typeFilter.size === 0 && storeyFilter.size === 0;
  }

  /** Rebuild the model-dependent controls (filter lists, slider range). */
  refreshModelControls(): void {
    const options = this.source.getFilterOptions();

    this.typeList.replaceChildren();
    if (options.types.length === 0) {
      this.typeList.appendChild(this.empty('No model loaded.'));
    }
    for (const { type, count } of options.types) {
      const btn = this.button(`filter-type-${type}`, `${type} (${count})`, () => {
        this.source.setTypeFilter(this.toggleFilterValue(this.source.getTypeFilter(), type));
      });
      btn.setAttribute('data-type', type);
      this.typeList.appendChild(btn);
    }

    this.storeyList.replaceChildren();
    if (options.storeys.length === 0) {
      this.storeyList.appendChild(this.empty('No storeys.'));
    }
    for (const storey of options.storeys) {
      const label = storey.name ?? `Storey ${storey.expressID}`;
      const btn = this.button(`filter-storey-${storey.expressID}`, label, () => {
        this.source.setStoreyFilter(this.toggleFilterValue(this.source.getStoreyFilter(), storey.expressID));
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
    this.syncProjection();
  }

  private empty(text: string): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = 'ifc-menu__empty';
    el.textContent = text;
    return el;
  }

  dispose(): void {
    this.unsubSelection();
    this.unsubLoaded();
    this.root.remove();
  }
}
