// CustomReadonlyEditorProvider for *.ifc: hands the webview a URI to stream
// the file from (bytes fallback for virtual file systems), so model bytes
// never pass through the extension host. Strict CSP; assets from dist/ only.
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost, LoadedStats, ViewerCommand } from './protocol.js';

export const IFC_EDITOR_VIEW_TYPE = 'vscodeIfcViewer.editor';

interface IfcDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export class IfcEditorProvider implements vscode.CustomReadonlyEditorProvider<IfcDocument> {
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onLoaded: (stats: LoadedStats) => void,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    onLoaded: (stats: LoadedStats) => void,
  ): { provider: IfcEditorProvider; disposable: vscode.Disposable } {
    const provider = new IfcEditorProvider(context, onLoaded);
    const disposable = vscode.window.registerCustomEditorProvider(
      IFC_EDITOR_VIEW_TYPE,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return { provider, disposable };
  }

  openCustomDocument(uri: vscode.Uri): IfcDocument {
    return { uri, dispose: () => undefined };
  }

  /** Forward a command to the currently active IFC webview, if any. */
  postCommandToActive(command: ViewerCommand): void {
    for (const panel of this.panels) {
      if (panel.active) {
        void panel.webview.postMessage({ type: 'command', command } satisfies HostToWebview);
        return;
      }
    }
  }

  async resolveCustomEditor(
    document: IfcDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    this.panels.add(webviewPanel);
    webviewPanel.onDidDispose(() => this.panels.delete(webviewPanel));

    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    // The document's directory is a resource root so the webview can stream
    // the model file directly (the URL load path).
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, documentDir],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, distUri);

    webviewPanel.webview.onDidReceiveMessage((message: WebviewToHost) => {
      if (message.type === 'ready') {
        void this.sendFileUrl(document, webviewPanel);
      } else if (message.type === 'loadUrlFailed') {
        void this.sendFileBytes(document, webviewPanel);
      } else if (message.type === 'loaded') {
        this.onLoaded(message.stats);
      } else if (message.type === 'error') {
        void vscode.window.showErrorMessage(`IFC Viewer: ${message.message}`);
      }
    });

    // Keep the viewport background in sync with the active color theme.
    const themeSub = vscode.window.onDidChangeActiveColorTheme((theme) => {
      void webviewPanel.webview.postMessage({
        type: 'theme',
        kind: theme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark',
      } satisfies HostToWebview);
    });
    webviewPanel.onDidDispose(() => themeSub.dispose());
  }

  /** Preferred path: send a fetchable URI; the webview streams the bytes. */
  private async sendFileUrl(
    document: IfcDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const fileName = document.uri.path.split('/').pop() ?? 'model.ifc';
    let size: number | undefined;
    try {
      size = (await vscode.workspace.fs.stat(document.uri)).size;
    } catch {
      size = undefined;
    }
    const src = webviewPanel.webview.asWebviewUri(document.uri).toString();
    const message: HostToWebview = { type: 'load', src, fileName, size };
    void webviewPanel.webview.postMessage(message);
  }

  /** Fallback path: read bytes host-side (virtual FS, unfetchable schemes). */
  private async sendFileBytes(
    document: IfcDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    // Copy into a standalone ArrayBuffer; VS Code's postMessage structured-clones
    // rather than transfers, but the binary is preserved intact.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const fileName = document.uri.path.split('/').pop() ?? 'model.ifc';
    const message: HostToWebview = { type: 'load', buffer, fileName };
    void webviewPanel.webview.postMessage(message);
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
