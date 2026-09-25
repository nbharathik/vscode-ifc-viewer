// Agent bridge: while a workspace folder is connected, the viewer keeps
// .ifc-skills/viewer/state.json current and applies JSON commands an agent
// drops into inbox/, answering each in outbox/<id>.json. Nothing is written
// until the user connects. Commands never write IFC files, run code or use
// the network; ids are IFC GlobalIds only.
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BRIDGE_DIR,
  PROTOCOL_VERSION,
  buildState,
  isInside,
  isSafeId,
  resolveModelPath,
  toPosix,
  validateCommand,
} from './bridgeProtocol.js';
import type { InboxCommand, PanelSnapshot } from './bridgeProtocol.js';
import type { IfcEditorProvider, PanelChange, ViewerPanel } from './ifcEditorProvider.js';
import type { AgentStatus, BridgeAck } from './protocol.js';
import type { ExtensionSettings } from './settings.js';

const CONNECTED_KEY = 'ifcViewer.agentBridge.connectedFolders';
const CREATED_ROOT_KEY = 'ifcViewer.agentBridge.createdRootFolders';
const GITIGNORE = '*\n';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write JSON through a temp file and a rename, so readers never see a partial
 * file. Windows refuses the rename while a reader holds the target open, so
 * that case is retried briefly.
 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const retry = ['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(err) ?? '');
      if (!retry || attempt >= 6) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await delay(15 * (attempt + 1));
    }
  }
}

async function writeIfMissing(file: string, text: string): Promise<void> {
  if (!(await exists(file))) await fs.writeFile(file, text, 'utf8');
}

/**
 * Delete a file, retrying briefly while Windows (antivirus, indexer) holds
 * it open. Resolves false when it is still there.
 */
async function removeFile(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(file, { force: true });
      return true;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(err) ?? '')) return false;
      await delay(50 * (attempt + 1));
    }
  }
  return false;
}

export class AgentBridge implements vscode.Disposable {
  private readonly connections = new Map<string, FolderConnection>();
  /** Folders the user disconnected this session ("always" does not reconnect them). */
  private readonly sessionDisconnected = new Set<string>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private enabled: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly provider: IfcEditorProvider,
    private readonly settings: () => ExtensionSettings,
  ) {
    this.enabled = settings().agentBridge.enabled;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'vscodeIfcViewer.disconnectAgent';
    this.disposables.push(
      this.statusItem,
      provider.onDidChangePanel(({ panel, change }) => this.onPanelChange(panel, change)),
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const folder of e.removed) void this.stopConnection(folder, 'close');
      }),
    );
  }

  folderOf(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  isConnected(folder: vscode.WorkspaceFolder): boolean {
    return this.connections.has(folder.uri.toString());
  }

  isConnectedUri(uri: vscode.Uri): boolean {
    const folder = this.folderOf(uri);
    return folder ? this.isConnected(folder) : false;
  }

  connectedFolders(): vscode.WorkspaceFolder[] {
    return [...this.connections.values()].map((c) => c.folder);
  }

  statusFor(uri: vscode.Uri): AgentStatus {
    if (!this.settings().agentBridge.enabled) return { available: false, connected: false };
    const folder = this.folderOf(uri);
    if (!folder) {
      return {
        available: true,
        connected: false,
        blockedReason: 'this file is not inside an open workspace folder.',
      };
    }
    if (folder.uri.scheme !== 'file') {
      return {
        available: true,
        connected: false,
        folderName: folder.name,
        blockedReason: 'only local folders are supported.',
      };
    }
    return { available: true, connected: this.isConnected(folder), folderName: folder.name };
  }

  /** Resume the folders connected in an earlier session ("remember"). */
  async restore(): Promise<void> {
    const s = this.settings().agentBridge;
    if (!s.enabled || s.autoConnect !== 'remember') return;
    const remembered = this.context.workspaceState.get<string[]>(CONNECTED_KEY, []);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (remembered.includes(folder.uri.toString())) await this.startConnection(folder);
    }
  }

  async connect(folder: vscode.WorkspaceFolder): Promise<void> {
    if (!this.settings().agentBridge.enabled) {
      throw new Error('Agent connections are turned off (setting ifcViewer.agentBridge.enabled).');
    }
    if (folder.uri.scheme !== 'file') throw new Error('Only local folders can connect to an agent.');
    this.sessionDisconnected.delete(folder.uri.toString());
    await this.remember(folder, true);
    await this.startConnection(folder);
  }

  async disconnect(folder: vscode.WorkspaceFolder): Promise<void> {
    this.sessionDisconnected.add(folder.uri.toString());
    await this.remember(folder, false);
    const remove = this.settings().agentBridge.removeFolderOnDisconnect;
    await this.stopConnection(folder, remove ? 'remove' : 'close');
  }

  async toggleFor(uri: vscode.Uri): Promise<void> {
    const folder = this.folderOf(uri);
    if (!folder) return;
    try {
      if (this.isConnected(folder)) await this.disconnect(folder);
      else await this.connect(folder);
    } catch (err) {
      void vscode.window.showErrorMessage(`IFC Viewer: ${errorText(err)}`);
    }
  }

  /** React to a settings change: enable/disable, new intervals, new labels. */
  async applySettings(): Promise<void> {
    const enabled = this.settings().agentBridge.enabled;
    if (!enabled && this.enabled) {
      // Suspend without forgetting, so turning the setting back on resumes.
      for (const connection of [...this.connections.values()]) {
        await this.stopConnection(connection.folder, 'close');
      }
    } else if (enabled && !this.enabled) {
      await this.restore();
    }
    this.enabled = enabled;
    for (const connection of this.connections.values()) connection.restartTimers();
    this.provider.refreshPanels();
    this.updateStatusItem();
  }

  /** Mark every connection closed (extension deactivating). */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((c) => this.stopConnection(c.folder, 'close')),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // -- internals ------------------------------------------------------------

  private async remember(folder: vscode.WorkspaceFolder, connected: boolean): Promise<void> {
    const key = folder.uri.toString();
    const list = new Set(this.context.workspaceState.get<string[]>(CONNECTED_KEY, []));
    if (connected) list.add(key);
    else list.delete(key);
    await this.context.workspaceState.update(CONNECTED_KEY, [...list]);
  }

  private async startConnection(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.connections.has(key)) return;
    const connection = new FolderConnection(folder, this.provider, this.settings, {
      id: this.context.extension.id,
      version: String(this.context.extension.packageJSON.version ?? '0.0.0'),
      uriScheme: vscode.env.uriScheme,
    });
    this.connections.set(key, connection);
    try {
      const createdRoot = await connection.start();
      if (createdRoot) {
        const created = new Set(this.context.workspaceState.get<string[]>(CREATED_ROOT_KEY, []));
        created.add(key);
        await this.context.workspaceState.update(CREATED_ROOT_KEY, [...created]);
      }
    } catch (err) {
      this.connections.delete(key);
      await connection.stop('close').catch(() => undefined);
      throw err;
    } finally {
      this.provider.refreshPanels();
      this.updateStatusItem();
    }
  }

  private async stopConnection(folder: vscode.WorkspaceFolder, mode: 'close' | 'remove'): Promise<void> {
    const key = folder.uri.toString();
    const connection = this.connections.get(key);
    this.connections.delete(key);
    if (connection) {
      const created = this.context.workspaceState.get<string[]>(CREATED_ROOT_KEY, []);
      await connection.stop(mode, created.includes(key)).catch(() => undefined);
      if (mode === 'remove') {
        await this.context.workspaceState.update(
          CREATED_ROOT_KEY,
          created.filter((k) => k !== key),
        );
      }
    }
    this.provider.refreshPanels();
    this.updateStatusItem();
  }

  private onPanelChange(panel: ViewerPanel, change: PanelChange): void {
    const folder = this.folderOf(panel.uri);
    if (!folder) return;
    const connection = this.connections.get(folder.uri.toString());
    if (connection) {
      connection.onPanelChange(panel, change);
      return;
    }
    const s = this.settings().agentBridge;
    if (
      change === 'opened' &&
      s.enabled &&
      s.autoConnect === 'always' &&
      folder.uri.scheme === 'file' &&
      !this.sessionDisconnected.has(folder.uri.toString())
    ) {
      void this.connect(folder).catch((err) =>
        vscode.window.showErrorMessage(`IFC Viewer: ${errorText(err)}`),
      );
    }
  }

  private updateStatusItem(): void {
    const folders = this.connectedFolders();
    if (folders.length === 0) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = '$(plug) Agent';
    this.statusItem.tooltip =
      `IFC Viewer is connected to an agent in: ${folders.map((f) => f.name).join(', ')}. ` +
      'Click to disconnect.';
    this.statusItem.show();
  }
}

/** One connected workspace folder: its files, watcher, heartbeat and queue. */
class FolderConnection {
  private readonly folderPath: string;
  private readonly root: string;
  private readonly dir: string;
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly statePath: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateWrite = 0;
  private writing: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  /** Inbox files already answered whose deletion failed; never run twice. */
  private readonly answered = new Set<string>();
  private stopped = false;
  /** The start in progress; stop() waits for it so nothing outlives a stop. */
  private starting: Promise<boolean> | null = null;
  /** Panel used when a command names no model and none is focused. */
  private lastActive: string | null = null;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly provider: IfcEditorProvider,
    private readonly settings: () => ExtensionSettings,
    private readonly viewerInfo: { id: string; version: string; uriScheme: string },
  ) {
    this.folderPath = folder.uri.fsPath;
    this.root = path.join(this.folderPath, BRIDGE_DIR[0]);
    this.dir = path.join(this.root, BRIDGE_DIR[1]);
    this.inbox = path.join(this.dir, 'inbox');
    this.outbox = path.join(this.dir, 'outbox');
    this.statePath = path.join(this.dir, 'state.json');
  }

  /** Create the folders and start listening. Returns true when .ifc-skills/ was created here. */
  start(): Promise<boolean> {
    this.starting = this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const rootExisted = await exists(this.root);
    await fs.mkdir(this.inbox, { recursive: true });
    await fs.mkdir(this.outbox, { recursive: true });
    await writeIfMissing(path.join(this.dir, '.gitignore'), GITIGNORE);
    // Only a .ifc-skills/ folder we created gets a catch-all .gitignore; one
    // made by the skill pack may hold files its owner wants committed.
    if (!rootExisted) await writeIfMissing(path.join(this.root, '.gitignore'), GITIGNORE);
    // Stopped while the folders were being created: stop() cleans up after us.
    if (this.stopped) return !rootExisted;

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, `${BRIDGE_DIR.join('/')}/inbox/*.json`),
      false,
      false,
      true,
    );
    this.watcher.onDidCreate((uri) => this.enqueue(path.basename(uri.fsPath)));
    this.watcher.onDidChange((uri) => this.enqueue(path.basename(uri.fsPath)));
    this.restartTimers();
    await this.writeState();
    await this.scanInbox();
    return !rootExisted;
  }

  async stop(mode: 'close' | 'remove', createdRoot = false): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => undefined);
    this.watcher?.dispose();
    this.watcher = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.heartbeat = null;
    this.stateTimer = null;
    await this.writing.catch(() => undefined);
    if (mode === 'close') {
      await this.writeStateNow(false).catch(() => undefined);
      return;
    }
    await fs.rm(this.dir, { recursive: true, force: true });
    if (createdRoot) {
      // Remove only what connecting added: our .gitignore, then the folder if empty.
      const ignore = path.join(this.root, '.gitignore');
      const text = await fs.readFile(ignore, 'utf8').catch(() => null);
      if (text === GITIGNORE) await fs.rm(ignore, { force: true });
      await fs.rmdir(this.root).catch(() => undefined);
    }
  }

  restartTimers(): void {
    if (this.stopped) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const seconds = this.settings().agentBridge.heartbeatSeconds;
    this.heartbeat = setInterval(() => void this.onHeartbeat().catch(() => undefined), seconds * 1000);
  }

  onPanelChange(panel: ViewerPanel, change: PanelChange): void {
    if (panel.active) this.lastActive = panel.key;
    if (change === 'closed' && this.lastActive === panel.key) this.lastActive = null;
    this.scheduleState();
  }

  // -- state.json -------------------------------------------------------------

  /** Throttled: the first change writes at once, later ones at most once per interval. */
  scheduleState(): void {
    if (this.stopped || this.stateTimer) return;
    const interval = this.settings().agentBridge.selectionDebounceMs;
    const wait = Math.max(0, this.lastStateWrite + interval - Date.now());
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.writeState();
    }, wait);
  }

  private writeState(): Promise<void> {
    this.lastStateWrite = Date.now();
    this.writing = this.writing.then(() => this.writeStateNow(true)).catch(() => undefined);
    return this.writing;
  }

  private async writeStateNow(open: boolean): Promise<void> {
    const state = buildState(this.viewerInfo, this.snapshots(), {
      open,
      nowMs: Date.now(),
      heartbeatSeconds: this.settings().agentBridge.heartbeatSeconds,
    });
    await writeJsonAtomic(this.statePath, state);
  }

  private panelsHere(): ViewerPanel[] {
    return this.provider.allPanels().filter((p) => {
      if (p.uri.scheme !== 'file') return false;
      return vscode.workspace.getWorkspaceFolder(p.uri)?.uri.toString() === this.folder.uri.toString();
    });
  }

  private snapshots(): PanelSnapshot[] {
    return this.panelsHere().map((p) => ({
      path: toPosix(path.relative(this.folderPath, p.uri.fsPath)),
      active: p.active,
      fileMtimeMs: p.fileMtimeMs,
      loadedAtMs: p.loaded ? p.loadedAtMs : null,
      selection: p.selection,
      highlights: p.highlights,
      isolated: p.isolated,
    }));
  }

  private async onHeartbeat(): Promise<void> {
    await this.writeState();
    await this.scanInbox();
    await this.pruneOutbox();
  }

  // -- inbox --------------------------------------------------------------------

  /** Also a fallback for missed watcher events; runs on every heartbeat. */
  private async scanInbox(): Promise<void> {
    const names = await fs.readdir(this.inbox).catch(() => [] as string[]);
    for (const name of names.sort()) this.enqueue(name);
  }

  private enqueue(name: string): void {
    if (this.stopped || !name.endsWith('.json') || this.queued.has(name)) return;
    if (this.answered.has(name)) {
      // Answered before, but the delete failed: only retry the delete.
      void removeFile(path.join(this.inbox, name)).then((gone) => {
        if (gone) this.answered.delete(name);
      });
      return;
    }
    this.queued.add(name);
    this.queue = this.queue
      .then(() => this.processInboxFile(name))
      .catch(() => undefined)
      .finally(() => this.queued.delete(name));
  }

  private async processInboxFile(name: string): Promise<void> {
    if (this.stopped) return;
    const file = path.join(this.inbox, name);
    const stem = name.slice(0, -'.json'.length);
    const fallbackId = isSafeId(stem) ? stem : `invalid-${Date.now()}`;

    // A writer that skips the temp-file step can leave a partial file for a
    // moment; retry the parse briefly before rejecting it.
    let parsed: unknown;
    let parseError: string | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return;
        throw err;
      }
      try {
        // Windows PowerShell writes UTF-8 with a byte order mark.
        parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        parseError = null;
        break;
      } catch (err) {
        parseError = errorText(err);
        await delay(100);
      }
    }

    let ack: BridgeAck;
    let model: string | undefined;
    if (parseError !== null) {
      ack = invalidAck(fallbackId, `Invalid JSON: ${parseError}`);
    } else {
      const s = this.settings().agentBridge;
      const validation = validateCommand(parsed, {
        nowMs: Date.now(),
        maxAgeMs: s.maxCommandAgeSeconds * 1000,
        maxIds: s.maxIdsPerCommand,
      });
      if (!validation.ok) {
        ack = invalidAck(validation.id ?? fallbackId, validation.error);
      } else {
        const result = await this.execute(validation.command);
        ack = result.ack;
        model = result.model;
      }
    }
    if (this.stopped) return;
    await writeJsonAtomic(path.join(this.outbox, `${ack.id}.json`), {
      protocol: PROTOCOL_VERSION,
      ...ack,
      ...(model ? { model } : {}),
      completedAt: new Date().toISOString(),
    });
    if (!(await removeFile(file))) this.answered.add(name);
    this.scheduleState();
  }

  /** The panel a command without "model" applies to. */
  private defaultPanel(): ViewerPanel | undefined {
    const here = this.panelsHere();
    return (
      here.find((p) => p.active) ??
      here.find((p) => p.key === this.lastActive) ??
      (here.length === 1 ? here[0] : undefined)
    );
  }

  private async execute(command: InboxCommand): Promise<{ ack: BridgeAck; model?: string }> {
    const s = this.settings();
    const timeoutMs = s.agentBridge.commandTimeoutSeconds * 1000;
    const requested = new Set(command.globalIds ?? []).size;
    const fail = (error: string, model?: string) => ({
      ack: { id: command.id, ok: false, requested, applied: 0, missing: [], error },
      model,
    });

    let uri: vscode.Uri;
    let panel: ViewerPanel | undefined;
    if (command.model !== undefined) {
      const resolved = resolveModelPath(this.folderPath, command.model);
      if (!resolved.ok) return fail(resolved.error);
      // Resolve links too: a symlink must not lead outside the folder.
      let real: string;
      try {
        real = await fs.realpath(resolved.absolute);
      } catch {
        return fail(`"${command.model}" does not exist.`, resolved.relative);
      }
      const realFolder = await fs.realpath(this.folderPath).catch(() => this.folderPath);
      if (!isInside(realFolder, real)) return fail(`"${command.model}" is outside the workspace folder.`);
      uri = vscode.Uri.file(resolved.absolute);
      panel = this.provider.panelFor(uri);
    } else {
      panel = this.defaultPanel();
      if (!panel) return fail('No model is open in this folder; name one with "model".');
      uri = panel.uri;
    }
    const model = toPosix(path.relative(this.folderPath, uri.fsPath));

    try {
      if (command.op === 'open') {
        await this.provider.open(uri, timeoutMs);
        return { ack: { id: command.id, ok: true, requested: 0, applied: 1, missing: [] }, model };
      }
      if (command.op === 'reload') {
        if (!panel) return fail(`${model} is not open in the viewer.`, model);
        await this.provider.reload(panel, s.autoReload.keepView, timeoutMs);
        return { ack: { id: command.id, ok: true, requested: 0, applied: 1, missing: [] }, model };
      }
      // Viewer ops open the model first when needed, so one command is enough.
      if (!panel) panel = await this.provider.open(uri, timeoutMs);
      else await panel.whenLoaded(timeoutMs);
      const ack = await panel.sendBridgeCommand(
        {
          id: command.id,
          op: command.op,
          globalIds: command.globalIds,
          label: command.label,
          color: command.color,
          what: command.what,
        },
        timeoutMs,
      );
      return { ack, model };
    } catch (err) {
      return fail(errorText(err), model);
    }
  }

  private async pruneOutbox(): Promise<void> {
    const maxAgeMs = this.settings().agentBridge.outboxRetentionMinutes * 60_000;
    const names = await fs.readdir(this.outbox).catch(() => [] as string[]);
    const now = Date.now();
    for (const name of names) {
      const file = path.join(this.outbox, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > maxAgeMs) await removeFile(file);
    }
  }
}

function invalidAck(id: string, error: string): BridgeAck {
  return { id, ok: false, requested: 0, applied: 0, missing: [], error };
}
