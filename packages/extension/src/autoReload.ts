// Auto-reload: when an open .ifc changes on disk (an agent or another tool
// rewrote it), wait for the writer to finish, then reload the viewer while
// keeping the camera, selection and agent highlights. Mode "whenConnected"
// (the default) limits this to folders connected to an agent.
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { IfcEditorProvider, ViewerPanel } from './ifcEditorProvider.js';
import type { ExtensionSettings } from './settings.js';

/** Stat rounds before giving up on a file that keeps changing. */
const MAX_STABILITY_ROUNDS = 40;

interface Watch {
  panel: ViewerPanel;
  watcher: vscode.FileSystemWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped on every change; an older pending reload sees it and stands down. */
  generation: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class AutoReloader implements vscode.Disposable {
  private readonly watches = new Map<string, Watch>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly provider: IfcEditorProvider,
    private readonly settings: () => ExtensionSettings,
    private readonly isConnected: (uri: vscode.Uri) => boolean,
  ) {
    this.subscription = provider.onDidChangePanel(({ panel, change }) => {
      if (change === 'opened') this.watch(panel);
      else if (change === 'closed') this.unwatch(panel);
    });
    for (const panel of provider.allPanels()) this.watch(panel);
  }

  private watch(panel: ViewerPanel): void {
    if (panel.uri.scheme !== 'file') return;
    const existing = this.watches.get(panel.key);
    if (existing?.panel === panel) return;
    // A reopened tab can arrive before the old one closes; the new panel wins.
    if (existing) this.release(panel.key, existing);
    const dir = vscode.Uri.file(path.dirname(panel.uri.fsPath));
    // File names are not glob-safe ("Tower[A].ifc"), so watch the folder's
    // IFC files and match the exact path.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, '*.[iI][fF][cC]'),
      false,
      false,
      true,
    );
    const entry: Watch = { panel, watcher, timer: null, generation: 0 };
    const onEvent = (uri: vscode.Uri) => {
      if (samePath(uri.fsPath, panel.uri.fsPath)) this.schedule(panel, entry);
    };
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    this.watches.set(panel.key, entry);
  }

  private unwatch(panel: ViewerPanel): void {
    const entry = this.watches.get(panel.key);
    if (entry?.panel === panel) this.release(panel.key, entry);
  }

  private release(key: string, entry: Watch): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.dispose();
    this.watches.delete(key);
  }

  private enabledFor(panel: ViewerPanel): boolean {
    const mode = this.settings().autoReload.mode;
    if (mode === 'off') return false;
    return mode === 'always' || this.isConnected(panel.uri);
  }

  private schedule(panel: ViewerPanel, entry: Watch): void {
    if (!this.enabledFor(panel)) return;
    const generation = ++entry.generation;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.reloadWhenStable(panel, entry, generation);
    }, this.settings().autoReload.debounceMs);
  }

  /** Reload once two stats `stabilityCheckMs` apart agree on size and mtime. */
  private async reloadWhenStable(panel: ViewerPanel, entry: Watch, generation: number): Promise<void> {
    const { stabilityCheckMs, keepView } = this.settings().autoReload;
    const stat = () => vscode.workspace.fs.stat(panel.uri).then(
      (s) => ({ size: s.size, mtime: s.mtime }),
      () => null,
    );
    let previous = await stat();
    let current = previous;
    for (let round = 0; round < MAX_STABILITY_ROUNDS; round++) {
      await delay(stabilityCheckMs);
      if (panel.disposed || entry.generation !== generation) return;
      current = await stat();
      if (previous && current && previous.size === current.size && previous.mtime === current.mtime) break;
      previous = current;
    }
    if (!current || panel.disposed || entry.generation !== generation) return;
    // The watcher can fire without a content change (touch, metadata).
    if (panel.fileMtimeMs !== null && current.mtime === panel.fileMtimeMs) return;

    const timeoutMs = this.settings().agentBridge.commandTimeoutSeconds * 1000;
    try {
      await this.provider.reload(panel, keepView, timeoutMs);
      vscode.window.setStatusBarMessage(`$(sync) Reloaded ${panel.fileName}`, 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`IFC Viewer: could not reload ${panel.fileName}: ${message}`);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    for (const entry of this.watches.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.dispose();
    }
    this.watches.clear();
  }
}
