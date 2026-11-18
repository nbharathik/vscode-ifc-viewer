// What an agent is told after an edit: which elements changed, in a compact
// form. Pure, so it is unit-tested without VS Code.
import type { Delta, GeometryPatch } from '../protocol.js';

const LISTED_ELEMENTS = 50;

export interface ChangeSummary {
  changed: boolean;
  txn?: number;
  elements?: unknown[];
  removed?: number[];
  treeChanged?: boolean;
  tessellationFailed?: number[];
}

export function summarizeChange(delta: Delta | null, patch: GeometryPatch | null): ChangeSummary {
  if (!delta) return { changed: false };
  return {
    changed: true,
    txn: delta.txn,
    elements: delta.changed.slice(0, LISTED_ELEMENTS).map((c) => ({
      globalId: c.globalId,
      ifcClass: c.ifcClass,
      id: c.id,
      created: c.created || undefined,
      properties: c.properties || undefined,
      geometry: c.geometry || undefined,
    })),
    removed: delta.removed.length ? delta.removed : undefined,
    treeChanged: delta.treeDirty || undefined,
    tessellationFailed: patch?.failed.length ? patch.failed : undefined,
  };
}
