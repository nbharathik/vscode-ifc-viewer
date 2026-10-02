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
  CLIENT_FILE,
  GUIDE_FILE,
  INSTRUCTION_BLOCK,
  INSTRUCTION_TARGETS,
  upsertInstructionBlock,
  PROTOCOL_VERSION,
  buildState,
  isInside,
  isSafeId,
  renderAgentGuide,
  resolveModelPath,
  toPosix,
  validateCommand,
} from './bridgeProtocol.js';
import type { InboxCommand, PanelSnapshot } from './bridgeProtocol.js';
import { McpHandler } from './mcp/handler.js';
import { startMcpHttp } from './mcp/httpServer.js';
import type { RunningMcpServer } from './mcp/httpServer.js';
import { SHIM_SOURCE } from './mcp/shim.js';
import { buildTools } from './agentTools.js';
import type { ResolvedTarget, ToolHost } from './agentTools.js';
import type { EngineController } from './engine.js';
import type { IfcEditorProvider, PanelChange, ViewerPanel } from './ifcEditorProvider.js';
import type { AgentStatus, BridgeAck } from './protocol.js';
import type { ExtensionSettings } from './settings.js';

const SERVER_FILE = 'server.json';
const SHIM_FILE = 'mcp-shim.mjs';

const CONNECTED_KEY = 'ifcViewer.agentBridge.connectedFolders';
const CREATED_ROOT_KEY = 'ifcViewer.agentBridge.createdRootFolders';
const GUIDE_ANNOUNCED_KEY = 'ifcViewer.agentBridge.guideAnnounced';
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

/** Write a file only when its content differs, so a connect does not touch it needlessly. */
async function writeIfChanged(file: string, text: string): Promise<void> {
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current !== text) await fs.writeFile(file, text, 'utf8');
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
    private readonly engine: EngineController,
    private readonly output: vscode.OutputChannel,
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

  /**
   * Tell the user, once per workspace, how to point their agent at the guide
   * written on connect. Not awaited by callers: it waits for a button click.
   */
  async announceGuide(folder: vscode.WorkspaceFolder): Promise<void> {
    const guide = this.guidePath(folder);
    if (!guide || this.context.workspaceState.get<boolean>(GUIDE_ANNOUNCED_KEY, false)) return;
    await this.context.workspaceState.update(GUIDE_ANNOUNCED_KEY, true);
    const add = 'Add to instructions';
    const copy = 'Copy line';
    const open = 'Open guide';
    const pick = await vscode.window.showInformationMessage(
      'Connected. Any agent can now query and edit the live model with python .ifc-skills/viewer/ifc_live.py. ' +
        'To make your agent find it, add the viewer line to its instructions file.',
      add,
      copy,
      open,
    );
    if (pick === add) await this.addInstructions(folder);
    else if (pick === copy) await vscode.env.clipboard.writeText(INSTRUCTION_BLOCK);
    else if (pick === open) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(guide));
  }

  /** Let the user pick an instruction file (AGENTS.md, Copilot, CLAUDE.md) and add the viewer block to it. */
  async addInstructions(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        ...INSTRUCTION_TARGETS.map((t) => ({ label: t.label, description: t.detail, file: t.file })),
        { label: '$(clippy) Copy to clipboard', description: 'paste it into any instructions file yourself', file: '' },
      ],
      { placeHolder: 'Which agent instructions file should get the IFC Viewer lines?' },
    );
    if (!picked) return undefined;
    if (!picked.file) {
      await vscode.env.clipboard.writeText(INSTRUCTION_BLOCK);
      void vscode.window.showInformationMessage('Copied the IFC Viewer instructions.');
      return undefined;
    }
    const target = path.join(folder.uri.fsPath, ...picked.file.split('/'));
    const existing = await fs.readFile(target, 'utf8').catch(() => '');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, upsertInstructionBlock(existing), 'utf8');
    void vscode.window.showInformationMessage(`Added the IFC Viewer lines to ${picked.file}.`, 'Open').then((open) => {
      if (open) void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
    });
    return target;
  }

  async toggleFor(uri: vscode.Uri): Promise<void> {
    const folder = this.folderOf(uri);
    if (!folder) return;
    try {
      if (this.isConnected(folder)) {
        await this.disconnect(folder);
      } else {
        await this.connect(folder);
        void this.announceGuide(folder);
      }
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

  /** The bundled agent guide with this viewer's version, or null when it cannot be read. */
  private async loadGuide(version: string): Promise<string | null> {
    try {
      const file = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agent-guide.md').fsPath;
      return renderAgentGuide(await fs.readFile(file, 'utf8'), version);
    } catch {
      return null;
    }
  }

  /** The bundled Python client, or null when it cannot be read. */
  private async loadClient(): Promise<string | null> {
    try {
      const file = vscode.Uri.joinPath(this.context.extensionUri, 'media', CLIENT_FILE).fsPath;
      return await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  /** Path of the guide a connected folder holds (null when it is not connected). */
  guidePath(folder: vscode.WorkspaceFolder): string | null {
    return this.connections.has(folder.uri.toString())
      ? path.join(folder.uri.fsPath, ...BRIDGE_DIR, GUIDE_FILE)
      : null;
  }

  private async startConnection(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.connections.has(key)) return;
    const version = String(this.context.extension.packageJSON.version ?? '0.0.0');
    const connection = new FolderConnection(
      folder,
      this.provider,
      this.settings,
      { id: this.context.extension.id, version, uriScheme: vscode.env.uriScheme },
      { guide: await this.loadGuide(version), client: await this.loadClient() },
      this.engine,
      this.output,
    );
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
  /** The agent tool server (MCP over loopback HTTP), while this folder is connected. */
  private tools: RunningMcpServer | null = null;
  private toolCounter = 0;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly provider: IfcEditorProvider,
    private readonly settings: () => ExtensionSettings,
    private readonly viewerInfo: { id: string; version: string; uriScheme: string },
    private readonly assets: { guide: string | null; client: string | null },
    private readonly engine: EngineController,
    private readonly output: vscode.OutputChannel,
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
    if (this.assets.guide !== null) await writeIfChanged(path.join(this.dir, GUIDE_FILE), this.assets.guide);
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
    await this.startTools();
    await this.writeState();
    await this.scanInbox();
    return !rootExisted;
  }

  // -- agent tools (MCP) --------------------------------------------------------

  private toolHost(): ToolHost {
    return {
      runViewerOp: (fields) => this.runViewerOp(fields),
      resolveTarget: (model) => this.resolveTarget(model),
      ensurePanel: async (target) => {
        const timeoutMs = this.settings().agentBridge.commandTimeoutSeconds * 1000;
        if (target.panel) {
          await target.panel.whenLoaded(timeoutMs);
          return target.panel;
        }
        return this.provider.open(target.uri, timeoutMs);
      },
      state: () => this.currentState(true),
      scriptsAllowed: () => this.engine.scriptsAllowed(),
    };
  }

  /** Start the tool server and publish how to reach it. Failure leaves the file bridge working. */
  private async startTools(): Promise<void> {
    if (!this.settings().agentBridge.mcpTools || this.tools || this.stopped) return;
    try {
      const handler = new McpHandler(
        {
          name: 'ifc-viewer',
          version: this.viewerInfo.version,
          instructions:
            'Tools for the IFC model the user has open in their editor. Answer questions from the model with query, ' +
            'never from memory. Show results with highlight and select. Edits are applied to the live model, ' +
            'highlighted for the user, and only reach the file when the user saves. Read .ifc-skills/viewer/SKILL.md for details.',
        },
        buildTools(this.toolHost()),
      );
      this.tools = await startMcpHttp(handler);
      if (this.stopped) {
        await this.stopTools();
        return;
      }
      await writeIfChanged(path.join(this.dir, SHIM_FILE), SHIM_SOURCE);
      if (this.assets.client !== null) await writeIfChanged(path.join(this.dir, CLIENT_FILE), this.assets.client);
      await writeJsonAtomic(path.join(this.dir, SERVER_FILE), {
        protocol: PROTOCOL_VERSION,
        url: `http://127.0.0.1:${this.tools.port}/mcp`,
        token: this.tools.token,
        pid: process.pid,
        version: this.viewerInfo.version,
      });
    } catch (err) {
      this.output.appendLine(`agent tool server could not start: ${errorText(err)}`);
      await this.stopTools();
    }
  }

  private async stopTools(): Promise<void> {
    const tools = this.tools;
    this.tools = null;
    await removeFile(path.join(this.dir, SERVER_FILE));
    await tools?.close().catch(() => undefined);
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
    await this.stopTools();
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

  private currentState(open: boolean) {
    return buildState(this.viewerInfo, this.snapshots(), {
      open,
      nowMs: Date.now(),
      heartbeatSeconds: this.settings().agentBridge.heartbeatSeconds,
    });
  }

  private async writeStateNow(open: boolean): Promise<void> {
    await writeJsonAtomic(this.statePath, this.currentState(open));
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
      engine: p.session?.state.engine ?? 'web-ifc',
      editable: p.session?.state.canEdit ?? false,
      dirty: p.session?.dirty ?? false,
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

  /** The model a command or tool names (or the default one), checked to stay inside the folder. */
  private async resolveTarget(modelPath: string | undefined): Promise<ResolvedTarget> {
    if (modelPath !== undefined) {
      const resolved = resolveModelPath(this.folderPath, modelPath);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      // Resolve links too: a symlink must not lead outside the folder.
      let real: string;
      try {
        real = await fs.realpath(resolved.absolute);
      } catch {
        return { ok: false, error: `"${modelPath}" does not exist.`, model: resolved.relative };
      }
      const realFolder = await fs.realpath(this.folderPath).catch(() => this.folderPath);
      if (!isInside(realFolder, real)) return { ok: false, error: `"${modelPath}" is outside the workspace folder.` };
      const uri = vscode.Uri.file(resolved.absolute);
      return { ok: true, uri, panel: this.provider.panelFor(uri), model: toPosix(path.relative(this.folderPath, uri.fsPath)) };
    }
    const panel = this.defaultPanel();
    if (!panel) return { ok: false, error: 'No model is open in this folder; name one with "model".' };
    return { ok: true, uri: panel.uri, panel, model: toPosix(path.relative(this.folderPath, panel.uri.fsPath)) };
  }

  /** A viewer op from an agent tool: validated exactly like an inbox command. */
  private async runViewerOp(fields: Record<string, unknown>): Promise<{ ack: BridgeAck; model?: string }> {
    const s = this.settings().agentBridge;
    const id = `tool-${Date.now().toString(36)}-${this.toolCounter++}`;
    const validation = validateCommand(
      { protocol: PROTOCOL_VERSION, id, createdAt: Date.now(), ...fields },
      { nowMs: Date.now(), maxAgeMs: s.maxCommandAgeSeconds * 1000, maxIds: s.maxIdsPerCommand },
    );
    if (!validation.ok) return { ack: invalidAck(id, validation.error) };
    return this.execute(validation.command);
  }

  private async execute(command: InboxCommand): Promise<{ ack: BridgeAck; model?: string }> {
    const s = this.settings();
    const timeoutMs = s.agentBridge.commandTimeoutSeconds * 1000;
    const requested = new Set(command.globalIds ?? []).size;
    const fail = (error: string, model?: string) => ({
      ack: { id: command.id, ok: false, requested, applied: 0, missing: [], error },
      model,
    });

    const target = await this.resolveTarget(command.model);
    if (!target.ok) return fail(target.error, target.model);
    const { uri, model } = target;
    let panel = target.panel;

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
