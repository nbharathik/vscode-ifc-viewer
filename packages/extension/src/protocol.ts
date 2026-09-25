// Typed postMessage protocol shared between the extension host and the webview.
// Pure types only - NO `vscode`, NO `three`/`web-ifc` - so it can be bundled into
// the webview safely.

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
  | { type: 'getSelection'; requestId: number };

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
  | { type: 'selectionResult'; requestId: number; selection: SelectionInfo | null };
