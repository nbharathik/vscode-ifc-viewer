// Right sidebar: one panel with tabs (Item, View, Model, plus whatever the host
// adds, such as Agent and Engine). It replaces the old fixed properties panel and
// is shown or hidden as a whole (N), with an edge button as the way back.
// Plain DOM; theme via CSS variables.
import { ensurePanelStyles } from './styles.js';

const COLLAPSE_RIGHT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.5 10.7 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Edge button glyph: panel frame with the sidebar column filled. */
const RAIL_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M10.2 3.6h3.2v8.8h-3.2Z" fill="currentColor"/>' +
  '</svg>';

export interface SidebarSource {
  arePropertiesVisible(): boolean;
  setPropertiesVisible(visible: boolean): void;
}

export interface SidebarTabSpec {
  id: string;
  label: string;
  /** Position in the tab strip; lower comes first. Defaults to after the built-in tabs. */
  order?: number;
}

export interface SidebarTabHandle {
  /** Content area of the tab; the owner fills it. */
  readonly body: HTMLElement;
  /** Small text next to the label (a count, "!"); null clears it. */
  setBadge(text: string | null): void;
  /** Bring the tab to the front, showing the sidebar if it is hidden. */
  show(): void;
  remove(): void;
}

interface TabEntry {
  spec: SidebarTabSpec;
  order: number;
  button: HTMLButtonElement;
  badge: HTMLElement;
  body: HTMLElement;
}

export class Sidebar {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly bodies: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly railBtn: HTMLButtonElement;
  private readonly tabs = new Map<string, TabEntry>();
  private active: string | null = null;
  private readonly listeners = new Set<(id: string | null) => void>();
  private nextOrder = 100;
  /** Emitted when the tab strip or active tab changes (for view-state persistence). */
  private readonly showListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly container: HTMLElement,
    private readonly source: SidebarSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-panel ifc-panel--right ifc-sidebar';
    this.root.setAttribute('data-testid', 'sidebar');

    const header = doc.createElement('div');
    header.className = 'ifc-panel__header';
    this.title = doc.createElement('span');
    this.title.setAttribute('data-testid', 'sidebar-title');
    this.collapseBtn = doc.createElement('button');
    this.collapseBtn.className = 'ifc-panel__collapse';
    this.collapseBtn.setAttribute('data-testid', 'btn-props-collapse');
    this.collapseBtn.title = 'Hide sidebar (N)';
    this.collapseBtn.setAttribute('aria-label', 'Hide sidebar');
    this.collapseBtn.innerHTML = COLLAPSE_RIGHT_ICON;
    this.collapseBtn.addEventListener('click', () => {
      this.source.setPropertiesVisible(false);
      this.railBtn.focus();
    });
    header.append(this.title, this.collapseBtn);

    this.strip = doc.createElement('div');
    this.strip.className = 'ifc-sidebar__tabs';
    this.strip.setAttribute('role', 'tablist');
    this.strip.setAttribute('aria-label', 'Sidebar');
    this.strip.addEventListener('keydown', (e) => this.onStripKey(e));

    this.bodies = doc.createElement('div');
    this.bodies.className = 'ifc-sidebar__bodies';

    this.root.append(header, this.strip, this.bodies);

    // Edge button shown while the sidebar is hidden (via the container class).
    this.railBtn = doc.createElement('button');
    this.railBtn.className = 'ifc-panel-rail ifc-panel-rail--right';
    this.railBtn.setAttribute('data-testid', 'btn-props-show');
    this.railBtn.title = 'Show sidebar (N)';
    this.railBtn.setAttribute('aria-label', 'Show sidebar');
    this.railBtn.innerHTML = RAIL_ICON;
    this.railBtn.addEventListener('click', () => {
      this.source.setPropertiesVisible(true);
      this.collapseBtn.focus();
    });
    container.append(this.railBtn, this.root);
  }

  /** Add a tab; the first one added becomes active. */
  addTab(spec: SidebarTabSpec): SidebarTabHandle {
    const doc = this.container.ownerDocument;
    const existing = this.tabs.get(spec.id);
    if (existing) this.removeTab(spec.id);

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ifc-sidebar__tab';
    button.id = `ifc-tab-${spec.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('data-testid', `sidebar-tab-${spec.id}`);
    button.setAttribute('aria-controls', `ifc-tabpanel-${spec.id}`);
    button.tabIndex = -1;
    const label = doc.createElement('span');
    label.textContent = spec.label;
    const badge = doc.createElement('span');
    badge.className = 'ifc-sidebar__badge';
    badge.hidden = true;
    button.append(label, badge);
    button.addEventListener('click', () => this.select(spec.id));

    const body = doc.createElement('div');
    body.className = 'ifc-sidebar__body';
    body.id = `ifc-tabpanel-${spec.id}`;
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', button.id);
    body.setAttribute('data-testid', `sidebar-body-${spec.id}`);
    body.hidden = true;

    const entry: TabEntry = { spec, order: spec.order ?? this.nextOrder++, button, badge, body };
    this.tabs.set(spec.id, entry);
    this.layout();
    if (this.active === null) this.select(spec.id);
    else this.syncSelected();

    return {
      body,
      setBadge: (text) => {
        badge.textContent = text ?? '';
        badge.hidden = text === null || text === '';
      },
      show: () => {
        this.source.setPropertiesVisible(true);
        this.select(spec.id);
      },
      remove: () => this.removeTab(spec.id),
    };
  }

  /** Fires after a tab has been shown (its first time and every time after). */
  onTabShown(id: string, listener: () => void): () => void {
    let set = this.showListeners.get(id);
    if (!set) this.showListeners.set(id, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Make a tab the active one without touching sidebar visibility. */
  select(id: string): void {
    if (!this.tabs.has(id) || id === this.active) return;
    this.active = id;
    this.syncSelected();
    for (const l of this.showListeners.get(id) ?? []) l();
    for (const l of this.listeners) l(id);
  }

  getActive(): string | null {
    return this.active;
  }

  hasTab(id: string): boolean {
    return this.tabs.has(id);
  }

  onActiveChange(listener: (id: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private removeTab(id: string): void {
    const entry = this.tabs.get(id);
    if (!entry) return;
    entry.button.remove();
    entry.body.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      this.active = null;
      const first = this.sorted()[0];
      if (first) this.select(first.spec.id);
      else this.syncSelected();
    }
  }

  private sorted(): TabEntry[] {
    return [...this.tabs.values()].sort((a, b) => a.order - b.order);
  }

  private layout(): void {
    const entries = this.sorted();
    this.strip.replaceChildren(...entries.map((e) => e.button));
    this.bodies.replaceChildren(...entries.map((e) => e.body));
  }

  private syncSelected(): void {
    for (const entry of this.tabs.values()) {
      const on = entry.spec.id === this.active;
      entry.button.setAttribute('aria-selected', String(on));
      entry.button.tabIndex = on ? 0 : -1;
      entry.body.hidden = !on;
      if (on) this.title.textContent = entry.spec.label;
    }
    if (this.active === null) this.title.textContent = '';
  }

  private onStripKey(e: KeyboardEvent): void {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const edge = e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null;
    if (step === 0 && edge === null) return;
    const entries = this.sorted();
    if (entries.length === 0) return;
    const at = entries.findIndex((en) => en.spec.id === this.active);
    const next =
      edge !== null
        ? entries.at(edge)!
        : entries[(at + step + entries.length) % entries.length]!;
    e.preventDefault();
    this.select(next.spec.id);
    next.button.focus();
  }

  dispose(): void {
    this.railBtn.remove();
    this.root.remove();
  }
}
