// Data-side contract between the viewer and an editing session (the Python
// model server in the extension). Pure types, no imports: the extension host
// and the webview both depend on this file.
import type { GlobalIdResolution, ItemProperties, SpatialNode } from './types.js';

/** Typed edit operations; the same vocabulary the agent uses. */
export type EditOp =
  | { op: 'setAttribute'; id?: number; globalId?: string; name: string; value: string | number | boolean | null }
  | {
      op: 'setProperty';
      id?: number;
      globalId?: string;
      pset?: string;
      psetId?: number;
      name: string;
      value: string | number | boolean | null;
      kind?: 'pset' | 'qto';
      /** Type for a new property: "text", "number", "boolean", or an IFC type such as IfcLengthMeasure. */
      valueType?: string;
    }
  | { op: 'addPset'; id?: number; globalId?: string; pset: string; kind?: 'pset' | 'qto' }
  | { op: 'removeProperty'; id?: number; globalId?: string; pset?: string; psetId?: number; name: string }
  | { op: 'removePset'; id?: number; globalId?: string; psetId: number }
  | { op: 'deleteProduct'; id?: number; globalId?: string }
  | { op: 'setPlacement'; id?: number; globalId?: string; location?: number[]; matrix?: number[] }
  | { op: 'assignContainer'; id?: number; globalId?: string; containerId: number }
  | { op: 'assignType'; id?: number; globalId?: string; typeId: number }
  | { op: 'createProduct'; ifcClass: string; name?: string; containerId?: number; location?: number[] };

export interface DeltaChange {
  id: number;
  globalId: string | null;
  ifcClass: string;
  properties: boolean;
  geometry: boolean;
  /** Only the placement changed: the element's shape is the same. */
  placementOnly?: boolean;
  relationships: boolean;
  created: boolean;
}

/** What one transaction (or its undo/redo) touched. */
export interface Delta {
  txn: number;
  changed: DeltaChange[];
  removed: number[];
  treeDirty: boolean;
}

export interface PatchGeometry {
  id: number;
  /** base64 of little-endian float32 xyz triples. */
  positions: string;
  /** base64 of little-endian float32 xyz triples. */
  normals: string;
  /** base64 of little-endian uint32 triangle indices. */
  indices: string;
  vertexCount: number;
  indexCount: number;
  /** minX, minY, minZ, maxX, maxY, maxZ in local space. */
  bounds: number[];
}

export interface PatchPlacement {
  /** STEP id of the product. */
  id: number;
  geometryId: number;
  /** 4x4 column-major placement. */
  matrix: number[];
  /** r, g, b, a in 0..1. */
  color: number[];
  ifcType: string;
}

/** Geometry for the changed products, ready to ingest as meshes. */
export interface GeometryPatch {
  geometries: PatchGeometry[];
  placements: PatchPlacement[];
  /** Products the server could not tessellate. */
  failed: number[];
}

export type DeltaSource = 'user' | 'agent' | 'undo' | 'redo' | 'revert';

export interface SessionState {
  /** `idle`: not started yet, it starts on first use (large files, or the on-demand setting). */
  state: 'off' | 'idle' | 'starting' | 'ready' | 'unavailable';
  /** Which engine feeds the data panels and edits. */
  engine: 'ifcopenshell' | 'web-ifc';
  canQuery: boolean;
  canEdit: boolean;
  /** Why the session is not available, or what it is doing. */
  detail?: string;
}

export const READ_ONLY_SESSION: SessionState = {
  state: 'off',
  engine: 'web-ifc',
  canQuery: false,
  canEdit: false,
};

/** Data side of a model: properties, tree, ids and edits. */
export interface ModelSession {
  /** Ask the host to start an idle session (on-demand mode). No-op otherwise. */
  start?(): void;
  getProperties(expressID: number): Promise<ItemProperties>;
  getTree(): Promise<SpatialNode>;
  resolveGlobalIds(globalIds: readonly string[]): Promise<GlobalIdResolution>;
  globalIdOf(expressID: number): Promise<string | null>;
  edit(ops: EditOp[]): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}
