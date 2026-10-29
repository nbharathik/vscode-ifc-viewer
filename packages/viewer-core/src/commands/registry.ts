// One list of everything the viewer can do. The toolbar, the keyboard, the
// command search and host integrations all read it, so a shortcut, a label and
// an enabled state are defined in exactly one place.

export interface Action {
  /** Stable id, grouped with dots: "view.fit", "visibility.hide". */
  id: string;
  label: string;
  /** Heading shown in the command search ("View", "Visibility", ...). */
  group: string;
  /** Shortcut as shown and matched: "F", "Shift+/", "Ctrl+K", "F3", "Escape". */
  shortcut?: string;
  /** Extra shortcuts that run the action without being shown. */
  alsoBoundTo?: string[];
  /** Absent means always enabled. */
  enabled?: () => boolean;
  /** Whether the action is a toggle that is currently on; drives pressed states. */
  checked?: () => boolean;
  run: () => void;
}

interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

function parseShortcut(spec: string): ParsedShortcut {
  const parts = spec.split('+');
  const key = (parts.pop() ?? '').toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key, ctrl: mods.has('ctrl') || mods.has('cmd'), alt: mods.has('alt'), shift: mods.has('shift') };
}

/** Does this keyboard event trigger the shortcut? Single characters ignore Shift (the character already reflects it); named keys such as F3 must match it. */
export function matchesShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, spec: string): boolean {
  const want = parseShortcut(spec);
  if (e.key.toLowerCase() !== want.key) return false;
  if ((e.ctrlKey || e.metaKey) !== want.ctrl) return false;
  if (e.altKey !== want.alt) return false;
  return want.key.length === 1 ? true : e.shiftKey === want.shift;
}

export class ActionRegistry {
  private readonly actions = new Map<string, Action>();
  private readonly listeners = new Set<() => void>();

  /** Add an action (replacing one with the same id); returns a function that removes it. */
  register(action: Action): () => void {
    this.actions.set(action.id, action);
    this.emit();
    return () => {
      if (this.actions.get(action.id) === action) {
        this.actions.delete(action.id);
        this.emit();
      }
    };
  }

  get(id: string): Action | undefined {
    return this.actions.get(id);
  }

  list(): Action[] {
    return [...this.actions.values()];
  }

  isEnabled(action: Action): boolean {
    return action.enabled ? action.enabled() : true;
  }

  /** Run an action by id; false when it is unknown or currently disabled. */
  run(id: string): boolean {
    const action = this.actions.get(id);
    if (!action || !this.isEnabled(action)) return false;
    action.run();
    return true;
  }

  /** The enabled action a key press triggers, if any. */
  forKey(e: KeyboardEvent): Action | undefined {
    for (const action of this.actions.values()) {
      const specs = [action.shortcut, ...(action.alsoBoundTo ?? [])];
      if (specs.some((spec) => spec && matchesShortcut(e, spec))) return action;
    }
    return undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Rank actions for a typed query. Every word must appear in "group label"
 * (case-insensitive); matches at the start of the label or of a word rank first.
 * An empty query lists everything in registration order.
 */
export function searchActions(actions: readonly Action[], query: string): Action[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...actions];
  const scored: { action: Action; score: number; order: number }[] = [];
  actions.forEach((action, order) => {
    const label = action.label.toLowerCase();
    const haystack = `${action.group.toLowerCase()} ${label}`;
    let score = 0;
    for (const word of words) {
      const at = haystack.indexOf(word);
      if (at < 0) return;
      const labelAt = label.indexOf(word);
      if (labelAt === 0) score += 3;
      else if (labelAt > 0 && label[labelAt - 1] === ' ') score += 2;
      else score += 1;
    }
    scored.push({ action, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.action);
}
