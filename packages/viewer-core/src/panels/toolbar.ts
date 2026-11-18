// Tool shelf: a short row of icon buttons for the actions used all the time
// (search, fit, hide, isolate, section). Everything else lives in the sidebar's
// View tab and the command search. It sits beside the spatial tree, slides toward
// the viewport edge when the tree is hidden, and hides entirely on T.
// Plain DOM; theme via CSS variables; monochrome inline SVG icons.
import type { SectionState } from '../viewer.js';
import { ensurePanelStyles } from './styles.js';

const SVG_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true">';
const SVG_CLOSE = '</svg>';
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.2"';

/** Command search: magnifier. */
const SEARCH_ICON =
  SVG_OPEN +
  `<circle cx="6.8" cy="6.8" r="4.2" ${STROKE}/>` +
  `<path d="m10 10 4.2 4.2" ${STROKE} stroke-linecap="round"/>` +
  SVG_CLOSE;

/** Fit: four corner brackets around a dot. */
const FIT_ICON =
  SVG_OPEN +
  `<path d="M2 5.2V2h3.2M10.8 2H14v3.2M14 10.8V14h-3.2M5.2 14H2v-3.2" ${STROKE} stroke-linecap="round"/>` +
  '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
  SVG_CLOSE;

/** Hide: eye with a slash. */
const HIDE_ICON =
  SVG_OPEN +
  `<path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" ${STROKE}/>` +
  `<circle cx="8" cy="8" r="1.9" ${STROKE}/>` +
  `<path d="m2.5 13.5 11-11" ${STROKE} stroke-linecap="round"/>` +
  SVG_CLOSE;

/** Isolate: one solid square among dashed ones. */
const ISOLATE_ICON =
  SVG_OPEN +
  `<rect x="2" y="2" width="12" height="12" rx="1.5" ${STROKE} stroke-dasharray="2 1.8" opacity="0.6"/>` +
  '<rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" fill="currentColor"/>' +
  SVG_CLOSE;

/** Section: box cut by a dashed plane. */
const SECTION_ICON =
  SVG_OPEN +
  `<path d="M3 5.4h10v7.2H3Z" ${STROKE}/>` +
  '<path d="M1.4 5.4h13.2" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 1.8"/>' +
  `<path d="M5.4 2.8h5.2v2.6" ${STROKE} opacity="0.55"/>` +
  SVG_CLOSE;

/** What the shelf drives; implemented by the viewer. */
export interface ToolbarSource {
  fitToModel(): unknown;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  hideSelected(): void;
  isolateSelected(): void;
  getSectionState(): SectionState;
  setSectionEnabled(enabled: boolean): void;
  /** Opens the command search (F3); absent when the host has none. */
  toggleCommandSearch?(): void;
}

/** A host-supplied toolbar button. */
export interface ToolbarButtonSpec {
  id: string;
  label: string;
  /** Trusted inline SVG markup, drawn with currentColor. */
  icon: string;
  onClick: () => void;
}

export interface ToolbarButtonHandle {
  setLabel(label: string): void;
  setActive(active: boolean): void;
  setDisabled(disabled: boolean): void;
  remove(): void;
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly doc: Document;
  private hideBtn!: HTMLButtonElement;
  private isolateBtn!: HTMLButtonElement;
  private sectionBtn!: HTMLButtonElement;
  private readonly unsubSelection: () => void;

  constructor(
    container: HTMLElement,
    private readonly source: ToolbarSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-tools';
    this.root.setAttribute('data-testid', 'toolbar');
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Tools');

    if (this.source.toggleCommandSearch) {
      this.add('btn-search', 'Search commands (F3)', SEARCH_ICON, () => this.source.toggleCommandSearch?.());
    }
    this.add('btn-fit', 'Fit model (F)', FIT_ICON, () => this.source.fitToModel());
    this.hideBtn = this.add('shelf-hide', 'Hide selected (H)', HIDE_ICON, () => this.source.hideSelected());
    this.isolateBtn = this.add('shelf-isolate', 'Isolate selected (I)', ISOLATE_ICON, () => this.source.isolateSelected());
    this.sectionBtn = this.add('shelf-section', 'Section plane', SECTION_ICON, () =>
      this.source.setSectionEnabled(!this.source.getSectionState().enabled),
    );

    container.appendChild(this.root);
    this.syncSelection();
    this.syncSection();
    this.unsubSelection = this.source.onSelectionChange(() => this.syncSelection());
  }

  private add(testId: string, label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ifc-tools__toggle';
    btn.setAttribute('data-testid', testId);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon;
    btn.addEventListener('click', onClick);
    this.root.appendChild(btn);
    return btn;
  }

  /** Append a host-supplied icon button after the built-in tools. */
  addButton(spec: ToolbarButtonSpec): ToolbarButtonHandle {
    const btn = this.add(spec.id, spec.label, spec.icon, spec.onClick);
    return {
      setLabel: (label) => {
        btn.title = label;
        btn.setAttribute('aria-label', label);
      },
      setActive: (active) => btn.setAttribute('data-active', String(active)),
      setDisabled: (disabled) => {
        btn.disabled = disabled;
      },
      remove: () => btn.remove(),
    };
  }

  /** Enable or disable the selection-dependent tools. */
  syncSelection(): void {
    const none = this.source.getSelection() === null;
    this.hideBtn.disabled = none;
    this.isolateBtn.disabled = none;
  }

  syncSection(): void {
    this.sectionBtn.setAttribute('data-active', String(this.source.getSectionState().enabled));
    this.sectionBtn.setAttribute('aria-pressed', String(this.source.getSectionState().enabled));
  }

  dispose(): void {
    this.unsubSelection();
    this.root.remove();
  }
}
