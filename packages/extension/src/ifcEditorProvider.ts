// CustomReadonlyEditorProvider for *.ifc: hands the webview a URI to stream
// the file from (bytes fallback for virtual file systems), so model bytes
// never pass through the extension host. Strict CSP; assets from dist/ only.
// Panels are keyed by document URI so agent commands reach the right model.
import * as vscode from 'vscode';
import type {
  AgentStatus,
  BridgeAck,
  BridgeCommand,
  HighlightSummary,
  HostToWebview,
  LoadedStats,
  SelectionInfo,
  ViewerCommand,
  WebviewConfig,
  WebviewToHost,
} from './protocol.js';

export const IFC_EDITOR_VIEW_TYPE = 'vscodeIfcViewer.editor';

interface IfcDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export type PanelChange = 'opened' | 'closed' | 'loaded' | 'focus' | 'selection' | 'state';

/** What the provider needs from the agent bridge; set once in activate(). */
export interface ProviderHooks {
  agentStatus(uri: vscode.Uri): AgentStatus;
  webviewConfig(): WebviewConfig;
  toggleAgent(uri: vscode.Uri): void;
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
  ) {}

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

export class IfcEditorProvider implements vscode.CustomReadonlyEditorProvider<IfcDocument> {
  private readonly panels = new Map<string, ViewerPanel>();
  private readonly changeEmitter = new vscode.EventEmitter<{ panel: ViewerPanel; change: PanelChange }>();
  /** Fires when a panel opens, closes, loads, gains focus or reports new state. */
  readonly onDidChangePanel = this.changeEmitter.event;
  private hooks: ProviderHooks | null = null;

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
    );
    return { provider, disposable };
  }

  setHooks(hooks: ProviderHooks): void {
    this.hooks = hooks;
  }

  openCustomDocument(uri: vscode.Uri): IfcDocument {
    return { uri, dispose: () => undefined };
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

  /** Load the file again; `keepView` keeps camera, selection and agent highlights. */
  async reload(panel: ViewerPanel, keepView: boolean, timeoutMs: number): Promise<void> {
    panel.reloadInFlight = keepView;
    // Mark the load first so whenLoaded waits for this one, not the last.
    panel.loading = true;
    panel.loadError = null;
    const loaded = panel.whenLoaded(timeoutMs);
    await this.sendFileUrl(panel);
    await loaded;
  }

  async resolveCustomEditor(document: IfcDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const panel = new ViewerPanel(document.uri, webviewPanel);
    this.panels.set(panel.key, panel);
    webviewPanel.onDidDispose(() => {
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
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, documentDir],
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
      return stat.size;
    } catch {
      return undefined;
    }
  }

  /** Preferred path: send a fetchable URI; the webview streams the bytes. */
  private async sendFileUrl(panel: ViewerPanel): Promise<void> {
    const size = await this.statMtime(panel);
    const src = panel.panel.webview.asWebviewUri(panel.uri).toString();
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
    const bytes = await vscode.workspace.fs.readFile(panel.uri);
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

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
