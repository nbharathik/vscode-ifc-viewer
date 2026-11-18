// Typed postMessage protocol shared between the extension host and the webview.
// Pure types only - NO `vscode`, NO `three`/`web-ifc` - so it can be bundled into
// the webview safely.

// -- editing session wire types -----------------------------------------------
// Mirrors viewer-core's engine/session.ts. They are structural copies on
// purpose (this file must stay free of imports); the webview passes these
// values straight into viewer-core, so its typecheck fails if they drift.

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
  positions: string;
  normals: string;
  indices: string;
  vertexCount: number;
  indexCount: number;
  bounds: number[];
}

export interface PatchPlacement {
  id: number;
  geometryId: number;
  matrix: number[];
  color: number[];
  ifcType: string;
}

/** Geometry for the changed products, ready to ingest as meshes. */
export interface GeometryPatch {
  geometries: PatchGeometry[];
  placements: PatchPlacement[];
  failed: number[];
}

export type DeltaSource = 'user' | 'agent' | 'undo' | 'redo' | 'revert';

export interface SessionState {
  /** `idle`: not started yet, it starts on first use (large files, or the on-demand setting). */
  state: 'off' | 'idle' | 'starting' | 'ready' | 'unavailable';
  engine: 'ifcopenshell' | 'web-ifc';
  canQuery: boolean;
  canEdit: boolean;
  detail?: string;
}

export const READ_ONLY_SESSION: SessionState = {
  state: 'off',
  engine: 'web-ifc',
  canQuery: false,
  canEdit: false,
};

/** Requests the webview may make of the model session (forwarded to the Python server). */
export type RpcMethod =
  | 'properties'
  | 'tree'
  | 'resolveGlobalIds'
  | 'globalIdOf'
  | 'edit'
  | 'undo'
  | 'redo';

export type ThemeKind = 'light' | 'dark';
export type ViewerCommand =
  | 'resetView'
  | 'showStatistics'
  | 'toggleTree'
  | 'toggleProperties';

/** Operations an agent can apply to an open model. Ids are IFC GlobalIds. */
export type BridgeOp = 'select' | 'highlight' | 'isolate' | 'fit' | 'clear';
export type ClearTarget = 'highlight' | 'isolate' | 'selection' | 'all';

export interface BridgeCommand {
  id: string;
  op: BridgeOp;
  globalIds?: string[];
  /** Highlight group name (highlight, clear). */
  label?: string;
  /** '#rgb', '#rrggbb' or a CSS colour name (highlight). */
  color?: string;
  /** What `clear` removes; defaults to 'all'. */
  what?: ClearTarget;
}

/** Result of one bridge command, written to the agent's outbox. */
export interface BridgeAck {
  id: string;
  ok: boolean;
  /** Distinct GlobalIds in the command. */
  requested: number;
  /** How many took effect (resolved ids; 1 for select; groups/states for clear). */
  applied: number;
  /** GlobalIds with no matching element in the model. */
  missing: string[];
  error?: string;
}

export interface SelectionInfo {
  globalId: string;
  ifcClass: string;
  name: string | null;
}

export interface HighlightSummary {
  label: string;
  color: string;
  count: number;
}

/** Agent connection as shown on the viewer's toolbar button. */
export interface AgentStatus {
  /** False hides the button (ifcViewer.agentBridge.enabled is off). */
  available: boolean;
  connected: boolean;
  /** Why this file cannot connect (for example: not inside a workspace folder). */
  blockedReason?: string;
  /** Workspace folder the connection belongs to. */
  folderName?: string;
}

/** Settings the webview applies locally. */
export interface WebviewConfig {
  showLegend: boolean;
  /** Show hidden spaces/openings when an agent command targets them. */
  revealHiddenCategories: boolean;
  /** Highlight elements an agent changed through the live model. */
  highlightAgentEdits: boolean;
}

/** Messages sent host -> webview. */
export type HostToWebview =
  /**
   * Preferred load path: the webview (worker) streams the file itself from a
   * webview URI, so bytes never pass through the extension host. `buffer` is
   * the fallback when the URI cannot be fetched (virtual file systems).
   * `reload` keeps the camera, selection and agent highlights.
   */
  | {
      type: 'load';
      fileName: string;
      src?: string;
      size?: number;
      buffer?: ArrayBuffer;
      reload?: boolean;
    }
  | { type: 'command'; command: ViewerCommand }
  | { type: 'theme'; kind: ThemeKind }
  | ({ type: 'bridge' } & BridgeCommand)
  | { type: 'agentStatus'; status: AgentStatus }
  | { type: 'config'; config: WebviewConfig }
  | { type: 'getSelection'; requestId: number }
  /** State of the editing session (the Python model server) for this document. */
  | { type: 'session'; session: SessionState }
  | { type: 'rpcResult'; id: number; result: unknown }
  | { type: 'rpcError'; id: number; message: string }
  /** An edit, undo or redo happened: retire/replace geometry and refresh panels. */
  | { type: 'delta'; source: DeltaSource; delta: Delta; patch: GeometryPatch | null };

export interface LoadedStats {
  fileName: string;
  meshCount: number;
  triangleCount: number;
  totalEntities: number;
  parseMs: number;
  geometryMs: number;
  downloadMs?: number;
  uploadMs?: number;
  fileBytes?: number;
}

/** Messages sent webview -> host. */
export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'progress';
      phase: string;
      entities: number;
      totalEntities: number;
      meshes: number;
      bytesLoaded?: number;
      bytesTotal?: number;
    }
  | { type: 'loaded'; stats: LoadedStats }
  /** The URL load path failed; the host should resend with bytes. */
  | { type: 'loadUrlFailed'; message: string }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }
  /** Sent only while connected to an agent. */
  | { type: 'selection'; selection: SelectionInfo | null }
  | ({ type: 'bridgeAck' } & BridgeAck)
  /** Highlight groups and isolate state, sent only while connected. */
  | { type: 'viewerState'; highlights: HighlightSummary[]; isolated: boolean }
  /** The toolbar's agent button was clicked. */
  | { type: 'agentToggle' }
  | { type: 'selectionResult'; requestId: number; selection: SelectionInfo | null }
  | { type: 'rpc'; id: number; method: RpcMethod; params: Record<string, unknown> }
  /** The toolbar's engine indicator was clicked. */
  | { type: 'engineAction' }
  /** The user asked to enable editing: start the idle IfcOpenShell session. */
  | { type: 'startSession' }
  /** A sidebar button asked the host to run one of the viewer's own commands. */
  | { type: 'command'; command: WebviewCommand };

/** Commands the webview may trigger; the host runs only these. */
export const WEBVIEW_COMMANDS = [
  'addAgentInstructions',
  'addAgentTools',
  'setupIfcOpenShell',
  'selectEngine',
  'showLog',
] as const;
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];
