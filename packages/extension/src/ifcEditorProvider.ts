// Custom editor for *.ifc. The webview streams the file from a URI (bytes
// fallback for virtual file systems), so model bytes never pass through the
// extension host, and web-ifc draws it. When the Python model server is
// available each document also gets a DocumentSession: IfcOpenShell holds the
// model as ground truth, serves properties, tree and ids, applies edits and
// saves. Strict CSP; assets from dist/ only. Panels are keyed by document URI
// so agent commands reach the right model.
import * as vscode from 'vscode';
import type { DocumentSession } from './server/documentSession.js';
import { READ_ONLY_SESSION } from './protocol.js';
import type {
  AgentStatus,
  BridgeAck,
  BridgeCommand,
  EditOp,
  HighlightSummary,
  HostToWebview,
  LoadedStats,
  SelectionInfo,
  ViewerCommand,
  WebviewConfig,
  WebviewToHost,
} from './protocol.js';

export const IFC_EDITOR_VIEW_TYPE = 'vscodeIfcViewer.editor';

export interface IfcDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
  /** The editing session, or null when IfcOpenShell is off or unavailable. */
  readonly session: DocumentSession | null;
  /** What the webview loads: the file, or a hot-exit backup of it. */
  readonly loadUri: vscode.Uri;
}

export type PanelChange = 'opened' | 'closed' | 'loaded' | 'focus' | 'selection' | 'state';

/** What the provider needs from the agent bridge; set once in activate(). */
export interface ProviderHooks {
  agentStatus(uri: vscode.Uri): AgentStatus;
  webviewConfig(): WebviewConfig;
  toggleAgent(uri: vscode.Uri): void;
  /** The toolbar's engine indicator was clicked. */
  engineAction(uri: vscode.Uri): void;
}

/** Creates the editing session for a document (null when the engine setting is web-ifc). */
export interface SessionHost {
  create(uri: vscode.Uri, backup: vscode.Uri | undefined): DocumentSession | null;
  /** The document closed; forget its session. */
  release(session: DocumentSession): void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** One open viewer tab and what the host knows about it. */
export class ViewerPanel {
  loaded = false;
  loading = false;
  loadedAtMs: number | null = null;
  fileMtimeMs: number | null = null;
  selection: SelectionInfo | null = null;
  highlights: HighlightSummary[] = [];
  isolated = false;
  disposed = false;
  /** Why the last load failed; cleared when the next load starts. */
  loadError: string | null = null;
  /** The load in flight keeps the view (reload); reused by the bytes fallback. */
  reloadInFlight = false;
  private waiters: Waiter[] = [];
  private readonly acks = new Map<string, (ack: BridgeAck) => void>();
  private readonly selectionRequests = new Map<number, (s: SelectionInfo | null) => void>();
  private nextRequestId = 1;

  constructor(
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    readonly document: IfcDocument,
  ) {}

  get session(): DocumentSession | null {
    return this.document.session;
  }

  get key(): string {
    return this.uri.toString();
  }

  get fileName(): string {
    return this.uri.path.split('/').pop() ?? 'model.ifc';
  }

  get active(): boolean {
    return !this.disposed && this.panel.active;
  }

  post(message: HostToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  /** Resolves once the current (or next) load finishes; rejects on a load error. */
  whenLoaded(timeoutMs: number): Promise<void> {
    if (this.loaded && !this.loading) return Promise.resolve();
    // A failed load sends nothing more; fail now with its reason.
    if (!this.loading && this.loadError) return Promise.reject(new Error(this.loadError));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${this.fileName} to load.`));
      }, timeoutMs);
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.push(waiter);
    });
  }

  settleLoad(error?: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (error) w.reject(error);
      else w.resolve();
    }
  }

  sendBridgeCommand(command: BridgeCommand, timeoutMs: number): Promise<BridgeAck> {
    const requested = new Set(command.globalIds ?? []).size;
    return new Promise<BridgeAck>((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(command.id);
        resolve({
          id: command.id,
          ok: false,
          requested,
          applied: 0,
          missing: [],
          error: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the viewer.`,
        });
      }, timeoutMs);
      this.acks.set(command.id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      this.post({ type: 'bridge', ...command });
    });
  }

  resolveAck(ack: BridgeAck): void {
    const resolve = this.acks.get(ack.id);
    this.acks.delete(ack.id);
    resolve?.(ack);
  }

  requestSelection(timeoutMs: number): Promise<SelectionInfo | null> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.selectionRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.selectionRequests.set(requestId, (selection) => {
        clearTimeout(timer);
        resolve(selection);
      });
      this.post({ type: 'getSelection', requestId });
    });
  }

  resolveSelectionRequest(requestId: number, selection: SelectionInfo | null): void {
    const resolve = this.selectionRequests.get(requestId);
    this.selectionRequests.delete(requestId);
    resolve?.(selection);
  }

  /** Fail everything still waiting on this panel (it closed). */
  dispose(): void {
    this.disposed = true;
    this.settleLoad(new Error(`${this.fileName} was closed.`));
    for (const [id, resolve] of this.acks) {
      resolve({ id, ok: false, requested: 0, applied: 0, missing: [], error: 'The viewer was closed.' });
    }
    this.acks.clear();
    for (const resolve of this.selectionRequests.values()) resolve(null);
    this.selectionRequests.clear();
  }
}

export class IfcEditorProvider implements vscode.CustomEditorProvider<IfcDocument> {
  private readonly panels = new Map<string, ViewerPanel>();
  private readonly documents = new Map<string, IfcDocument>();
  private readonly changeEmitter = new vscode.EventEmitter<{ panel: ViewerPanel; change: PanelChange }>();
  /** Fires when a panel opens, closes, loads, gains focus or reports new state. */
  readonly onDidChangePanel = this.changeEmitter.event;
  private readonly editEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IfcDocument>>();
  /** Edits push undo entries here; VS Code owns dirty state, undo and redo. */
  readonly onDidChangeCustomDocument = this.editEmitter.event;
  private hooks: ProviderHooks | null = null;
  private sessionHost: SessionHost | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onLoaded: (stats: LoadedStats, panel: ViewerPanel) => void,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    onLoaded: (stats: LoadedStats, panel: ViewerPanel) => void,
  ): { provider: IfcEditorProvider; disposable: vscode.Disposable } {
    const provider = new IfcEditorProvider(context, onLoaded);
    const disposable = vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(IFC_EDITOR_VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      provider.changeEmitter,
      provider.editEmitter,
    );
    return { provider, disposable };
  }

  setHooks(hooks: ProviderHooks): void {
    this.hooks = hooks;
  }

  setSessionHost(host: SessionHost): void {
    this.sessionHost = host;
  }

  documentFor(uri: vscode.Uri): IfcDocument | undefined {
    return this.documents.get(uri.toString());
  }

  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): IfcDocument {
    const backup = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : undefined;
    const session = this.sessionHost?.create(uri, backup) ?? null;
    const document: IfcDocument = {
      uri,
      session,
      loadUri: backup ?? uri,
      dispose: () => {
        if (this.documents.get(uri.toString()) === document) this.documents.delete(uri.toString());
        if (session) {
          this.sessionHost?.release(session);
          void session.dispose();
        }
      },
    };
    this.documents.set(uri.toString(), document);
    if (session) {
      session.onDidEdit(({ label }) =>
        this.editEmitter.fire({
          document,
          label,
          undo: async () => void (await session.undo()),
          redo: async () => void (await session.redo()),
        }),
      );
      void session.start();
    }
    return document;
  }

  // -- save, revert, backup -------------------------------------------------

  async saveCustomDocument(document: IfcDocument): Promise<void> {
    const session = document.session;
    if (!session?.ready) return;
    const saved = await session.save();
    // Our own write must not look like an outside change to the auto-reloader.
    // Use VS Code's stat, the value the reloader compares against; the server's
    // own mtime can differ in the last millisecond.
    const panel = this.panelFor(document.uri);
    if (panel) {
      panel.fileMtimeMs = await vscode.workspace.fs.stat(document.uri).then(
        (s) => s.mtime,
        () => saved.mtimeMs,
      );
    }
  }

  async saveCustomDocumentAs(document: IfcDocument, destination: vscode.Uri): Promise<void> {
    const session = document.session;
    if (!session?.ready) throw new Error('Saving a copy needs IfcOpenShell, which is not available for this file.');
    if (destination.scheme !== 'file') throw new Error('Only local files can be saved.');
    await session.save(destination.fsPath);
  }

  async revertCustomDocument(document: IfcDocument): Promise<void> {
    const session = document.session;
    if (!session?.ready) return;
    await session.discard();
    const panel = this.panelFor(document.uri);
    if (panel) await this.reloadView(panel, true, 120_000);
  }

  async backupCustomDocument(
    document: IfcDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const session = document.session;
    if (session?.ready) await session.writeBackup(context.destination.fsPath);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // already gone
        }
      },
    };
  }

  panelFor(uri: vscode.Uri): ViewerPanel | undefined {
    const exact = this.panels.get(uri.toString());
    if (exact || process.platform !== 'win32' || uri.scheme !== 'file') return exact;
    // Windows paths are case-insensitive; an agent may spell one differently.
    const wanted = uri.fsPath.toLowerCase();
    return this.allPanels().find((p) => p.uri.scheme === 'file' && p.uri.fsPath.toLowerCase() === wanted);
  }

  allPanels(): ViewerPanel[] {
    return [...this.panels.values()];
  }

  activePanel(): ViewerPanel | undefined {
    return this.allPanels().find((p) => p.active);
  }

  /** Forward a command to the currently active IFC webview, if any. */
  postCommandToActive(command: ViewerCommand): void {
    this.activePanel()?.post({ type: 'command', command });
  }

  /** Re-send the agent status (and settings) to every panel. */
  refreshPanels(): void {
    for (const panel of this.panels.values()) this.sendStatus(panel);
  }

  /** Open (or reveal) a model without stealing focus; resolves once it is loaded. */
  async open(uri: vscode.Uri, timeoutMs: number): Promise<ViewerPanel> {
    await vscode.commands.executeCommand('vscode.openWith', uri, IFC_EDITOR_VIEW_TYPE, {
      preserveFocus: true,
      preview: false,
    });
    const panel = this.panelFor(uri);
    if (!panel) throw new Error(`Could not open ${uri.fsPath} in the IFC viewer.`);
    await panel.whenLoaded(timeoutMs);
    return panel;
  }

  /**
   * Load the file again; `keepView` keeps camera, selection and agent
   * highlights. With an editing session the model is re-read from disk too,
   * which would drop unsaved edits, so that is refused.
   */
  async reload(panel: ViewerPanel, keepView: boolean, timeoutMs: number): Promise<void> {
    const session = panel.session;
    if (session?.ready) {
      if (session.dirty) {
        throw new Error(`${panel.fileName} has unsaved changes. Save or revert them first.`);
      }
      await session.discard();
    }
    await this.reloadView(panel, keepView, timeoutMs);
  }

  private async reloadView(panel: ViewerPanel, keepView: boolean, timeoutMs: number): Promise<void> {
    panel.reloadInFlight = keepView;
    // Mark the load first so whenLoaded waits for this one, not the last.
    panel.loading = true;
    panel.loadError = null;
    const loaded = panel.whenLoaded(timeoutMs);
    await this.sendFileUrl(panel);
    await loaded;
  }

  async resolveCustomEditor(document: IfcDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const panel = new ViewerPanel(document.uri, webviewPanel, document);
    this.panels.set(panel.key, panel);
    const session = document.session;
    const sessionSubs: vscode.Disposable[] = [];
    if (session) {
      sessionSubs.push(
        session.onDidChangeState((state) => {
          panel.post({ type: 'session', session: state });
          this.changeEmitter.fire({ panel, change: 'state' });
        }),
        session.onDidDelta(({ source, delta, patch }) => {
          panel.post({ type: 'delta', source, delta, patch });
          this.changeEmitter.fire({ panel, change: 'state' });
        }),
      );
    }
    webviewPanel.onDidDispose(() => {
      for (const sub of sessionSubs) sub.dispose();
      panel.dispose();
      // A reopened tab for the same file may already have replaced this one.
      if (this.panels.get(panel.key) === panel) this.panels.delete(panel.key);
      this.changeEmitter.fire({ panel, change: 'closed' });
    });
    webviewPanel.onDidChangeViewState(() => this.changeEmitter.fire({ panel, change: 'focus' }));

    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    // The document's directory is a resource root so the webview can stream
    // the model file directly (the URL load path).
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [distUri, documentDir];
    // A hot-exit backup lives elsewhere and is what gets streamed.
    if (document.loadUri.toString() !== document.uri.toString()) {
      roots.push(vscode.Uri.joinPath(document.loadUri, '..'));
    }
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, distUri);

    webviewPanel.webview.onDidReceiveMessage((message: WebviewToHost) =>
      this.onMessage(panel, message),
    );

    // Keep the viewport background in sync with the active color theme.
    const themeSub = vscode.window.onDidChangeActiveColorTheme((theme) => {
      panel.post({
        type: 'theme',
        kind: theme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark',
      });
    });
    webviewPanel.onDidDispose(() => themeSub.dispose());
    this.changeEmitter.fire({ panel, change: 'opened' });
  }

  private onMessage(panel: ViewerPanel, message: WebviewToHost): void {
    switch (message.type) {
      case 'ready':
        this.sendStatus(panel);
        panel.post({ type: 'session', session: panel.session?.state ?? READ_ONLY_SESSION });
        panel.loading = true;
        panel.loadError = null;
        void this.sendFileUrl(panel);
        break;
      case 'loadUrlFailed':
        void this.sendFileBytes(panel);
        break;
      case 'loaded':
        panel.loaded = true;
        panel.loading = false;
        panel.loadedAtMs = Date.now();
        panel.settleLoad();
        this.onLoaded(message.stats, panel);
        this.changeEmitter.fire({ panel, change: 'loaded' });
        panel.reloadInFlight = false;
        break;
      case 'error':
        panel.loading = false;
        panel.loaded = false;
        panel.reloadInFlight = false;
        panel.loadError = message.message;
        panel.settleLoad(new Error(message.message));
        void vscode.window.showErrorMessage(`IFC Viewer: ${message.message}`);
        break;
      case 'selection':
        panel.selection = message.selection;
        this.changeEmitter.fire({ panel, change: 'selection' });
        break;
      case 'viewerState':
        panel.highlights = message.highlights;
        panel.isolated = message.isolated;
        this.changeEmitter.fire({ panel, change: 'state' });
        break;
      case 'bridgeAck': {
        const { type: _type, ...ack } = message;
        panel.resolveAck(ack);
        break;
      }
      case 'agentToggle':
        this.hooks?.toggleAgent(panel.uri);
        break;
      case 'selectionResult':
        panel.resolveSelectionRequest(message.requestId, message.selection);
        break;
      case 'rpc':
        void this.handleRpc(panel, message);
        break;
      case 'engineAction':
        this.hooks?.engineAction(panel.uri);
        break;
    }
  }

  /** Forward a webview data request to the model server. */
  private async handleRpc(panel: ViewerPanel, message: Extract<WebviewToHost, { type: 'rpc' }>): Promise<void> {
    const { id, method, params } = message;
    try {
      const session = panel.session;
      if (!session?.ready) throw new Error('IfcOpenShell is not available for this file.');
      let result: unknown;
      switch (method) {
        case 'properties':
          result = await session.read('properties', { id: requireInt(params.id) });
          break;
        case 'tree':
          result = await session.read('tree');
          break;
        case 'resolveGlobalIds':
          result = await session.read('resolveGlobalIds', { ids: requireStrings(params.ids) });
          break;
        case 'globalIdOf':
          result = (await session.read<{ globalId: string | null }>('globalIdOf', { id: requireInt(params.id) })).globalId;
          break;
        case 'edit': {
          const edit = await session.edit(requireOps(params.ops), 'user');
          result = { txn: edit.delta?.txn ?? null };
          break;
        }
        case 'undo':
          await vscode.commands.executeCommand('undo');
          result = null;
          break;
        case 'redo':
          await vscode.commands.executeCommand('redo');
          result = null;
          break;
        default:
          throw new Error(`Unknown request "${String(method)}".`);
      }
      panel.post({ type: 'rpcResult', id, result });
    } catch (err) {
      panel.post({ type: 'rpcError', id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private sendStatus(panel: ViewerPanel): void {
    if (!this.hooks) return;
    panel.post({ type: 'config', config: this.hooks.webviewConfig() });
    panel.post({ type: 'agentStatus', status: this.hooks.agentStatus(panel.uri) });
  }

  private async statMtime(panel: ViewerPanel): Promise<number | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(panel.uri);
      panel.fileMtimeMs = stat.mtime;
      const loadUri = panel.document.loadUri;
      if (loadUri.toString() === panel.uri.toString()) return stat.size;
      return (await vscode.workspace.fs.stat(loadUri)).size;
    } catch {
      return undefined;
    }
  }

  /** Preferred path: send a fetchable URI; the webview streams the bytes. */
  private async sendFileUrl(panel: ViewerPanel): Promise<void> {
    const size = await this.statMtime(panel);
    const src = panel.panel.webview.asWebviewUri(panel.document.loadUri).toString();
    panel.post({
      type: 'load',
      src,
      fileName: panel.fileName,
      size,
      reload: panel.reloadInFlight,
    });
  }

  /** Fallback path: read bytes host-side (virtual FS, unfetchable schemes). */
  private async sendFileBytes(panel: ViewerPanel): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(panel.document.loadUri);
    // Copy into a standalone ArrayBuffer; VS Code's postMessage structured-clones
    // rather than transfers, but the binary is preserved intact.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    panel.post({ type: 'load', buffer, fileName: panel.fileName, reload: panel.reloadInFlight });
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'ifc-worker.js'));
    const wasmDir = `${webview.asWebviewUri(distUri).toString()}/`;
    // worker-src blob: because webview resources are cross-origin to the
    // webview document; the worker script is fetched and booted from a blob.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource} blob: data:`,
      `worker-src ${webview.cspSource} blob:`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IFC Viewer</title>
    <style nonce="${nonce}">
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
      body { background: var(--vscode-editor-background, #1e1e1e); }
      #app { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__IFC_WASM_DIR__ = ${JSON.stringify(wasmDir)};
      window.__IFC_WORKER_URL__ = ${JSON.stringify(workerUri.toString())};
    </script>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
  }
}

function requireInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Expected an integer id.');
  return value;
}

function requireStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error('Expected an array of strings.');
  return value as string[];
}

function requireOps(value: unknown): EditOp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Expected a non-empty list of edit operations.');
  return value as EditOp[];
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
