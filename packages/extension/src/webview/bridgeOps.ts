// Applies agent bridge commands to the viewer and describes the selection.
// Depends only on the slice of the Viewer API it uses, so unit tests can
// drive it with a fake viewer.
import type { GlobalIdResolution, LazyCategory, Viewer } from '@vscode-ifc-viewer/core';
import type { BridgeAck, BridgeCommand, SelectionInfo } from '../protocol.js';

export type BridgeViewer = Pick<
  Viewer,
  | 'resolveGlobalIds'
  | 'select'
  | 'clearSelection'
  | 'getSelection'
  | 'setHighlight'
  | 'clearHighlight'
  | 'getHighlights'
  | 'isolate'
  | 'isIsolated'
  | 'showAll'
  | 'fitTo'
  | 'setCategoryVisible'
  | 'isCategoryVisible'
>;

export interface BridgeOptions {
  /** Show hidden spaces/openings when a command targets them. */
  revealHiddenCategories: boolean;
}

/** Group name used when a highlight command has no label. */
export const DEFAULT_HIGHLIGHT_LABEL = 'agent';

const LAZY_CLASSES: Record<string, LazyCategory> = {
  IfcSpace: 'IfcSpace',
  IfcOpeningElement: 'IfcOpeningElement',
};

/** Distinct ids in request order. */
function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

async function revealCategories(
  viewer: BridgeViewer,
  found: GlobalIdResolution['found'],
): Promise<void> {
  const categories = new Set<LazyCategory>();
  for (const { ifcClass } of found) {
    const category = LAZY_CLASSES[ifcClass];
    if (category && !viewer.isCategoryVisible(category)) categories.add(category);
  }
  for (const category of categories) await viewer.setCategoryVisible(category, true);
}

export async function applyBridgeCommand(
  viewer: BridgeViewer,
  command: BridgeCommand,
  options: BridgeOptions,
): Promise<BridgeAck> {
  const ids = distinct(command.globalIds ?? []);
  const base: BridgeAck = { id: command.id, ok: true, requested: ids.length, applied: 0, missing: [] };
  try {
    if (command.op === 'clear') {
      return { ...base, applied: clear(viewer, command) };
    }

    const { found, missing } = await viewer.resolveGlobalIds(ids);
    const expressIDs = found.map((f) => f.expressID);
    if (options.revealHiddenCategories && command.op !== 'fit') {
      await revealCategories(viewer, found);
    }

    switch (command.op) {
      case 'select': {
        // The viewer has a single selection; the first resolved id wins.
        if (expressIDs.length > 0) viewer.select(expressIDs[0]);
        return { ...base, applied: expressIDs.length > 0 ? 1 : 0, missing };
      }
      case 'highlight': {
        const label = command.label?.trim() || DEFAULT_HIGHLIGHT_LABEL;
        // A group is exactly the ids given; none found removes a stale group.
        if (expressIDs.length === 0) viewer.clearHighlight(label);
        else viewer.setHighlight(label, expressIDs, command.color);
        return { ...base, applied: expressIDs.length, missing };
      }
      case 'isolate': {
        viewer.isolate(expressIDs);
        return { ...base, applied: expressIDs.length, missing };
      }
      case 'fit': {
        const pose = viewer.fitTo(expressIDs);
        return { ...base, applied: pose ? expressIDs.length : 0, missing };
      }
    }
    return { ...base, ok: false, error: `Unknown op "${String(command.op)}".` };
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Returns how many things were cleared (groups, isolate, selection). A label
 * names one group, so without `what` it clears just that group.
 */
function clear(viewer: BridgeViewer, command: BridgeCommand): number {
  const label = command.label?.trim() || undefined;
  const what = command.what ?? (label ? 'highlight' : 'all');
  let cleared = 0;
  if (what === 'highlight' || what === 'all') {
    const before = viewer.getHighlights().length;
    viewer.clearHighlight(what === 'highlight' ? label : undefined);
    cleared += before - viewer.getHighlights().length;
  }
  if (what === 'isolate' || what === 'all') {
    if (viewer.isIsolated()) cleared++;
    viewer.showAll();
  }
  if (what === 'selection' || what === 'all') {
    if (viewer.getSelection() !== null) cleared++;
    viewer.clearSelection();
  }
  return cleared;
}

export type SelectionViewer = Pick<Viewer, 'globalIdOf' | 'getSearchIndex' | 'getProperties'>;

/** GlobalId, class and name of an element, or null when it has no GlobalId. */
export async function describeElement(
  viewer: SelectionViewer,
  expressID: number,
): Promise<SelectionInfo | null> {
  const globalId = await viewer.globalIdOf(expressID);
  if (!globalId) return null;
  const entry = viewer.getSearchIndex()?.byID.get(expressID);
  if (entry) return { globalId, ifcClass: entry.type, name: entry.name };
  const props = await viewer.getProperties(expressID);
  const name = props?.attributes.find((a) => a.name === 'Name')?.value;
  return {
    globalId,
    ifcClass: props?.type ?? 'IfcProduct',
    name: typeof name === 'string' ? name : null,
  };
}
