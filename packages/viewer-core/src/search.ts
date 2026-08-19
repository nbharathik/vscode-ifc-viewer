// Model search index: built once per load from the spatial tree, queried by
// the tree search box and the type/storey filters. Pure data, no DOM and no
// engine calls, so queries never touch IFC data after the one-time walk.
import type { SpatialNode } from './engine/types.js';

export interface SearchEntry {
  expressID: number;
  name: string | null;
  type: string;
  globalId: string | null;
  /** Nearest IfcBuildingStorey ancestor (or self), when any. */
  storeyID: number | null;
  /** expressIDs from the root down to the parent of this node. */
  ancestors: number[];
  /** Lowercased haystack: name, type, expressID and GlobalId. */
  text: string;
}

export interface StoreyInfo {
  expressID: number;
  name: string | null;
}

export interface SearchIndex {
  entries: SearchEntry[];
  byID: Map<number, SearchEntry>;
  /** Storeys in document order, for the storey filter. */
  storeys: StoreyInfo[];
}

const STOREY_TYPE = 'IfcBuildingStorey';

/** Walk the spatial tree once and flatten it into a searchable index. */
export function buildSearchIndex(tree: SpatialNode): SearchIndex {
  const entries: SearchEntry[] = [];
  const byID = new Map<number, SearchEntry>();
  const storeys: StoreyInfo[] = [];

  const walk = (node: SpatialNode, ancestors: number[], storeyID: number | null): void => {
    const ownStorey = node.type === STOREY_TYPE ? node.expressID : storeyID;
    if (node.type === STOREY_TYPE) {
      storeys.push({ expressID: node.expressID, name: node.name ?? null });
    }
    const globalId = node.globalId ?? null;
    const entry: SearchEntry = {
      expressID: node.expressID,
      name: node.name ?? null,
      type: node.type,
      globalId,
      storeyID: ownStorey,
      ancestors,
      text: `${node.name ?? ''}\n${node.type}\n${node.expressID}\n${globalId ?? ''}`.toLowerCase(),
    };
    entries.push(entry);
    byID.set(node.expressID, entry);
    const childAncestors = [...ancestors, node.expressID];
    for (const child of node.children) walk(child, childAncestors, ownStorey);
  };

  walk(tree, [], null);
  return { entries, byID, storeys };
}

/** Case-insensitive substring match over name, type, expressID and GlobalId. */
export function queryIndex(index: SearchIndex, query: string): SearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return index.entries.filter((entry) => entry.text.includes(needle));
}

export interface FilterSelection {
  /** IFC type names to keep, or null when the type group is inactive. */
  types: ReadonlySet<string> | null;
  /** Storey expressIDs to keep, or null when the storey group is inactive. */
  storeys: ReadonlySet<number> | null;
}

/**
 * Element expressIDs passing the active filters, or null when no group is
 * active. Groups combine with AND; values within a group combine with OR.
 */
export function filterElementIDs(index: SearchIndex, selection: FilterSelection): Set<number> | null {
  const { types, storeys } = selection;
  if (!types && !storeys) return null;
  const out = new Set<number>();
  for (const entry of index.entries) {
    if (types && !types.has(entry.type)) continue;
    if (storeys && (entry.storeyID === null || !storeys.has(entry.storeyID))) continue;
    out.add(entry.expressID);
  }
  return out;
}
