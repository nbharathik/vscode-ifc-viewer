// Typed postMessage protocol shared between the extension host and the webview.
// Pure types only - NO `vscode`, NO `three`/`web-ifc` - so it can be bundled into
// the webview safely.

export type ThemeKind = 'light' | 'dark';
export type ViewerCommand =
  | 'resetView'
  | 'showStatistics'
  | 'toggleTree'
  | 'toggleProperties';

/** Messages sent host -> webview. */
export type HostToWebview =
  /**
   * Preferred load path: the webview (worker) streams the file itself from a
   * webview URI, so bytes never pass through the extension host. `buffer` is
   * the fallback when the URI cannot be fetched (virtual file systems).
   */
  | { type: 'load'; fileName: string; src?: string; size?: number; buffer?: ArrayBuffer }
  | { type: 'command'; command: ViewerCommand }
  | { type: 'theme'; kind: ThemeKind };

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
  | { type: 'log'; message: string };
