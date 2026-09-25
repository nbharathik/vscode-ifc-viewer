// Named colour groups ("highlight sets") over many elements. Pure
// bookkeeping: each group owns a palette slot (1..255, 0 = none), and every
// element resolves to the slot of the newest group containing it. The batcher
// writes that slot into its per-element state texture.
import { Color } from 'three';

export interface HighlightInfo {
  label: string;
  /** Normalized '#rrggbb'. */
  color: string;
  /** Number of items the caller asked to highlight. */
  count: number;
}

/** Slots available in the palette texture (slot 0 means "no group"). */
export const MAX_HIGHLIGHT_SETS = 255;

/** Used in order when a group has no colour; none resembles the selection orange. */
export const DEFAULT_HIGHLIGHT_COLORS = [
  '#e53935',
  '#1e88e5',
  '#43a047',
  '#8e24aa',
  '#00acc1',
  '#fdd835',
  '#d81b60',
  '#7cb342',
];

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#rgb', '#rrggbb' or a CSS colour name to '#rrggbb'; null when invalid. */
export function normalizeColor(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (HEX_COLOR.test(value)) {
    return value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
  }
  const named = (Color.NAMES as Record<string, number>)[value];
  return named === undefined ? null : `#${named.toString(16).padStart(6, '0')}`;
}

interface HighlightEntry {
  label: string;
  color: string;
  count: number;
  slot: number;
  ids: Set<number>;
}

export class HighlightSets {
  /** Oldest first; the last entry wins where groups overlap. */
  private readonly order: HighlightEntry[] = [];
  /** expressID -> slot of the newest group containing it. */
  private readonly resolved = new Map<number, number>();

  get size(): number {
    return this.order.length;
  }

  /**
   * Create or replace a group; it becomes the newest. Returns its slot and the
   * expressIDs whose resolved slot may have changed.
   */
  set(
    label: string,
    ids: Iterable<number>,
    color: string,
    count: number,
  ): { slot: number; changed: number[] } {
    const index = this.order.findIndex((e) => e.label === label);
    const previous = index >= 0 ? this.order.splice(index, 1)[0] : null;
    const slot = previous?.slot ?? this.freeSlot();
    const entry: HighlightEntry = { label, color, count, slot, ids: new Set(ids) };
    this.order.push(entry);
    const changed = new Set(entry.ids);
    if (previous) for (const id of previous.ids) changed.add(id);
    this.resolve(changed);
    return { slot, changed: [...changed] };
  }

  /** Remove one group, or all when no label is given. Returns changed expressIDs. */
  clear(label?: string): number[] {
    if (label === undefined) {
      const changed = [...this.resolved.keys()];
      this.order.length = 0;
      this.resolved.clear();
      return changed;
    }
    const index = this.order.findIndex((e) => e.label === label);
    if (index < 0) return [];
    const [removed] = this.order.splice(index, 1);
    this.resolve(removed.ids);
    return [...removed.ids];
  }

  slotOf(expressID: number): number {
    return this.resolved.get(expressID) ?? 0;
  }

  /** Groups oldest first. */
  list(): HighlightInfo[] {
    return this.order.map(({ label, color, count }) => ({ label, color, count }));
  }

  /** First default colour no current group uses (cycles when all are taken). */
  nextDefaultColor(): string {
    const used = new Set(this.order.map((e) => e.color));
    return (
      DEFAULT_HIGHLIGHT_COLORS.find((c) => !used.has(c)) ??
      DEFAULT_HIGHLIGHT_COLORS[this.order.length % DEFAULT_HIGHLIGHT_COLORS.length]
    );
  }

  private freeSlot(): number {
    const used = new Set(this.order.map((e) => e.slot));
    for (let slot = 1; slot <= MAX_HIGHLIGHT_SETS; slot++) {
      if (!used.has(slot)) return slot;
    }
    throw new Error(`Too many highlight groups (at most ${MAX_HIGHLIGHT_SETS}).`);
  }

  private resolve(ids: Iterable<number>): void {
    for (const id of ids) {
      let slot = 0;
      for (let i = this.order.length - 1; i >= 0; i--) {
        if (this.order[i].ids.has(id)) {
          slot = this.order[i].slot;
          break;
        }
      }
      if (slot === 0) this.resolved.delete(id);
      else this.resolved.set(id, slot);
    }
  }
}
