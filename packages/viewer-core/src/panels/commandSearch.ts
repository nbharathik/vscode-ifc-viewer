// Command search: type to find any viewer action and run it with Enter. Opens
// on F3 or Ctrl+K and closes on Escape or a click outside. Plain DOM.
import { searchActions } from '../commands/registry.js';
import type { Action, ActionRegistry } from '../commands/registry.js';
import { ensurePanelStyles } from './styles.js';

export class CommandSearch {
  readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private results: Action[] = [];
  private active = 0;
  private opened = false;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly registry: ActionRegistry,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-cmd';
    this.root.setAttribute('data-testid', 'command-search');
    this.root.hidden = true;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });

    const box = doc.createElement('div');
    box.className = 'ifc-cmd__box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Command search');

    this.input = doc.createElement('input');
    this.input.type = 'text';
    this.input.className = 'ifc-cmd__input';
    this.input.placeholder = 'Search commands';
    this.input.setAttribute('data-testid', 'command-search-input');
    this.input.setAttribute('aria-label', 'Search commands');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', 'ifc-cmd-list');
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.list = doc.createElement('div');
    this.list.className = 'ifc-cmd__list';
    this.list.id = 'ifc-cmd-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('data-testid', 'command-search-list');

    box.append(this.input, this.list);
    this.root.appendChild(box);
    container.appendChild(this.root);
  }

  isOpen(): boolean {
    return this.opened;
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const doc = this.container.ownerDocument;
    this.returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    this.root.hidden = false;
    this.input.value = '';
    this.refresh();
    this.input.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private refresh(): void {
    this.results = searchActions(this.registry.list(), this.input.value);
    // Start on the first action that can run, so Enter does something useful.
    const first = this.results.findIndex((a) => this.registry.isEnabled(a));
    this.active = first < 0 ? 0 : first;
    this.render();
  }

  private render(): void {
    const doc = this.container.ownerDocument;
    this.list.replaceChildren();
    if (this.results.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'ifc-cmd__empty';
      empty.textContent = 'No matching commands';
      this.list.appendChild(empty);
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.results.forEach((action, index) => {
      const enabled = this.registry.isEnabled(action);
      const row = doc.createElement('div');
      row.id = `ifc-cmd-${index}`;
      row.className = 'ifc-cmd__item';
      row.setAttribute('role', 'option');
      row.setAttribute('data-testid', 'command-item');
      row.setAttribute('data-action', action.id);
      row.setAttribute('aria-selected', String(index === this.active));
      row.setAttribute('aria-disabled', String(!enabled));
      if (action.checked) row.setAttribute('data-checked', String(action.checked()));
      const group = doc.createElement('span');
      group.className = 'ifc-cmd__group';
      group.textContent = action.group;
      const label = doc.createElement('span');
      label.className = 'ifc-cmd__label';
      label.textContent = action.label;
      row.append(group, label);
      if (action.shortcut) {
        const key = doc.createElement('kbd');
        key.className = 'ifc-cmd__key';
        key.textContent = action.shortcut;
        row.appendChild(key);
      }
      row.addEventListener('pointerdown', (e) => e.preventDefault());
      row.addEventListener('click', () => this.runAt(index));
      this.list.appendChild(row);
    });
    this.input.setAttribute('aria-activedescendant', `ifc-cmd-${this.active}`);
    this.list.children[this.active]?.scrollIntoView?.({ block: 'nearest' });
  }

  private move(step: number): void {
    if (this.results.length === 0) return;
    this.active = (this.active + step + this.results.length) % this.results.length;
    this.render();
  }

  private runAt(index: number): void {
    const action = this.results[index];
    if (!action || !this.registry.isEnabled(action)) return;
    // Close first so an action that opens something takes the focus.
    this.close();
    action.run();
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        this.runAt(this.active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      case 'F3':
        e.preventDefault();
        this.close();
        break;
      default:
        // Keep typed characters here: the viewport must not see them.
        e.stopPropagation();
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
