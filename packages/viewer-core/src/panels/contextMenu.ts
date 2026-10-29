// Right-click menu over the viewport. Its entries are registry actions, so
// labels, shortcuts and enabled states stay in one place. Plain DOM; keyboard
// operable (arrows, Enter, Escape).
import type { ActionRegistry } from '../commands/registry.js';
import { ensurePanelStyles } from './styles.js';

/** An action id, or '-' for a separator. */
export type MenuEntry = string;

export class ContextMenu {
  readonly root: HTMLElement;
  private opened = false;
  private returnFocus: HTMLElement | null = null;
  private readonly outside: (e: PointerEvent) => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly registry: ActionRegistry,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);
    this.root = doc.createElement('div');
    this.root.className = 'ifc-ctx';
    this.root.setAttribute('role', 'menu');
    this.root.setAttribute('aria-label', 'Viewport actions');
    this.root.setAttribute('data-testid', 'context-menu');
    this.root.hidden = true;
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    container.appendChild(this.root);

    this.outside = (e) => {
      if (this.opened && e.target instanceof Node && !this.root.contains(e.target)) this.close(false);
    };
    doc.addEventListener('pointerdown', this.outside, true);
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Show the menu at a viewport position (client coordinates). */
  open(clientX: number, clientY: number, entries: readonly MenuEntry[]): void {
    const doc = this.container.ownerDocument;
    this.root.replaceChildren();
    let pendingSeparator = false;
    let count = 0;
    for (const entry of entries) {
      if (entry === '-') {
        pendingSeparator = count > 0;
        continue;
      }
      const action = this.registry.get(entry);
      if (!action) continue;
      if (pendingSeparator) {
        const sep = doc.createElement('div');
        sep.className = 'ifc-menu__sep';
        sep.setAttribute('role', 'separator');
        this.root.appendChild(sep);
        pendingSeparator = false;
      }
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'ifc-ctx__item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-testid', `ctx-${action.id}`);
      item.disabled = !this.registry.isEnabled(action);
      const label = doc.createElement('span');
      label.textContent = action.label;
      item.appendChild(label);
      if (action.shortcut) {
        const key = doc.createElement('kbd');
        key.className = 'ifc-cmd__key';
        key.textContent = action.shortcut;
        item.appendChild(key);
      }
      item.addEventListener('click', () => {
        this.close(true);
        action.run();
      });
      this.root.appendChild(item);
      count++;
    }
    if (count === 0) return;

    this.returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    this.opened = true;
    this.root.hidden = false;

    // Place at the pointer, then pull back inside the viewport if it overflows.
    const bounds = this.container.getBoundingClientRect();
    this.root.style.left = '0px';
    this.root.style.top = '0px';
    const menu = this.root.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - bounds.left, bounds.width - menu.width - 4));
    const top = Math.max(4, Math.min(clientY - bounds.top, bounds.height - menu.height - 4));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.focusables()[0]?.focus();
  }

  close(restoreFocus: boolean): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    if (restoreFocus) this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private focusables(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  }

  private onKey(e: KeyboardEvent): void {
    const items = this.focusables();
    const at = items.indexOf(this.container.ownerDocument.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[(at + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[(at - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
        break;
      default:
        // The viewport shortcuts stay out of the menu's way.
        e.stopPropagation();
    }
  }

  dispose(): void {
    this.container.ownerDocument.removeEventListener('pointerdown', this.outside, true);
    this.root.remove();
  }
}
