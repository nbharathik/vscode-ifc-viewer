// One open document's editing session: the model held by the Python server,
// its dirty state, and the stream of deltas the viewer applies. The session
// also keeps a journal of everything applied since the file was last saved, so
// a crashed or killed server can be restarted and the unsaved work replayed.
import * as vscode from 'vscode';
import type { ModelServer } from './modelServer.js';
import type { ServerManager } from './serverManager.js';
import { READ_ONLY_SESSION } from '../protocol.js';
import type { Delta, DeltaSource, EditOp, GeometryPatch, SessionState } from '../protocol.js';

export interface EditResult {
  delta: Delta | null;
  patch: GeometryPatch | null;
}

export interface QueryResult extends EditResult {
  output: string;
  error: string | null;
}

export interface SessionStatus {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  mtimeMs: number | null;
  memoryMb?: number | null;
}

export interface DeltaEvent {
  source: DeltaSource;
  delta: Delta;
  patch: GeometryPatch | null;
}

export interface EditEvent {
  label: string;
}

export interface RecoveryEvent {
  /** Journal entries replayed (0 when the journal was incomplete). */
  restored: number;
  /** False when the journal overflowed and unsaved work could not be restored. */
  complete: boolean;
}

export interface SessionOptions {
  /** Whether scripts (`query`) may run. */
  allowScripts: () => boolean;
  /** `onOpen` starts once the model has appeared; `onDemand` waits for first use. */
  startMode: 'onOpen' | 'onDemand';
  /** A script running longer than this is stopped and the server restarted. */
  scriptTimeoutMs: () => number;
  /** Diagnostics for the output channel. */
  log: (line: string) => void;
}

type JournalEntry =
  | { kind: 'edit'; ops: EditOp[] }
  | { kind: 'query'; code: string; name: string; persistent: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** Beyond this the journal stops growing and recovery can only reopen the file. */
const JOURNAL_MAX_ENTRIES = 2000;
const JOURNAL_MAX_CHARS = 2_000_000;
/** More restarts than this within the window means something is broken; stop trying. */
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 5 * 60_000;
/** Requests slower than this are written to the log. */
const SLOW_REQUEST_MS = 150;

export class DocumentSession implements vscode.Disposable {
  private server: ModelServer | null = null;
  private opened = false;
  private _state: SessionState = { ...READ_ONLY_SESSION };
  private _status: SessionStatus = { dirty: false, canUndo: false, canRedo: false, mtimeMs: null };
  /** Serializes requests so an edit and the undo after it never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stateEmitter = new vscode.EventEmitter<SessionState>();
  private readonly deltaEmitter = new vscode.EventEmitter<DeltaEvent>();
  private readonly editEmitter = new vscode.EventEmitter<EditEvent>();
  private readonly recoverEmitter = new vscode.EventEmitter<RecoveryEvent>();
  private readonly warnEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidDelta = this.deltaEmitter.event;
  /** Fires after each successful edit, so the editor can push an undo entry. */
  readonly onDidEdit = this.editEmitter.event;
  /** Fires after the server was restarted and the session restored. */
  readonly onDidRecover = this.recoverEmitter.event;
  /** Something the user should hear about (an element could not be redrawn, a script was stopped). */
  readonly onDidWarn = this.warnEmitter.event;
  private disposed = false;
  private starting: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private recoveries: number[] = [];
  private journal: JournalEntry[] = [];
  private journalChars = 0;
  private journalComplete = true;

  constructor(
    private readonly manager: ServerManager,
    readonly key: string,
    /** The file whose content the server loads (the original, or a hot-exit backup). */
    private readonly loadPath: string,
    /** Where Save writes. */
    private readonly savePath: string,
    private readonly options: SessionOptions,
    private readonly fromBackup = false,
  ) {}

  get state(): SessionState {
    return this._state;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get ready(): boolean {
    return this._state.state === 'ready';
  }

  get dirty(): boolean {
    return this._status.dirty;
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.stateEmitter.fire(state);
  }

  private unavailable(detail: string): void {
    this.setState({ state: 'unavailable', engine: 'web-ifc', canQuery: false, canEdit: false, detail });
  }

  private readyState(): SessionState {
    return { state: 'ready', engine: 'ifcopenshell', canQuery: this.options.allowScripts(), canEdit: true };
  }

  // -- lifecycle ----------------------------------------------------------------

  /**
   * The model is on screen. Starting IfcOpenShell only now keeps its CPU and
   * memory use away from the first paint; on-demand sessions stay idle.
   */
  modelShown(): void {
    if (this._state.state !== 'off') return;
    if (this.options.startMode === 'onOpen') void this.start();
    else this.markIdle('IfcOpenShell starts when you first edit a value or an agent asks for the model.');
  }

  /** Waiting for first use: nothing is running and nothing is held in memory. */
  markIdle(detail: string): void {
    if (this._state.state === 'off') {
      this.setState({ state: 'idle', engine: 'web-ifc', canQuery: false, canEdit: false, detail });
    }
  }

  /** This document can never have a session (too large, for example); say why. */
  disable(detail: string): void {
    this.unavailable(detail);
  }

  /**
   * Open the document in the server. Never throws; failure becomes an
   * unavailable state. Calling it again while it runs, or once ready, is a no-op.
   */
  start(): Promise<void> {
    if (this._state.state === 'ready' || this._state.state === 'unavailable') return Promise.resolve();
    this.starting ??= this.startNow();
    return this.starting;
  }

  private async startNow(): Promise<void> {
    this.setState({ state: 'starting', engine: 'web-ifc', canQuery: false, canEdit: false, detail: 'Starting IfcOpenShell' });
    const server = await this.manager.ensure();
    if (this.disposed) return;
    if (!server) {
      const s = this.manager.state;
      this.unavailable(s.state === 'unavailable' ? s.reason : 'IfcOpenShell is not available.');
      return;
    }
    try {
      await this.open(server);
      await this.refreshStatus();
      this.setState(this.readyState());
    } catch (err) {
      this.unavailable(`IfcOpenShell could not open this file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async open(server: ModelServer): Promise<void> {
    this.server = server;
    await server.request(
      'open',
      { doc: this.key, path: this.loadPath, savePath: this.savePath, dirty: this.fromBackup },
      15 * 60 * 1000,
    );
    this.opened = true;
  }

  /**
   * Free this model's memory while its tab is hidden. Never touches a document
   * with unsaved edits. The session restarts on first use.
   */
  async evict(): Promise<boolean> {
    if (!this.ready || this.dirty || !this.opened || this.recovering) return false;
    await this.enqueue(async () => {
      const server = this.server;
      this.opened = false;
      this.server = null;
      if (server?.running) await server.request('close', { doc: this.key }, 10_000).catch(() => undefined);
    });
    this.starting = null;
    this.journal = [];
    this.journalChars = 0;
    this.journalComplete = true;
    this.setState({
      state: 'idle',
      engine: 'web-ifc',
      canQuery: false,
      canEdit: false,
      detail: 'IfcOpenShell was stopped for this hidden file to free memory. It restarts when you need it.',
    });
    this.options.log(`[session] evicted ${this.key}`);
    return true;
  }

  // -- recovery -----------------------------------------------------------------

  /**
   * The server died or was killed. Start a fresh one, reopen the file and
   * replay everything applied since the last save. Joins a recovery already
   * running, so several callers can ask.
   */
  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    if (!this.opened || this.disposed) return Promise.resolve();
    this.recovering = this.recoverNow().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async recoverNow(): Promise<void> {
    const entries = this.journal.slice();
    const complete = this.journalComplete;
    this.opened = false;
    this.server = null;
    const now = Date.now();
    this.recoveries = this.recoveries.filter((t) => now - t < RECOVERY_WINDOW_MS);
    if (this.recoveries.length >= MAX_RECOVERIES) {
      this.unavailable('The model server keeps stopping, so IfcOpenShell was turned off for this file. Reopen it to try again.');
      return;
    }
    this.recoveries.push(now);
    this.setState({
      state: 'starting',
      engine: 'web-ifc',
      canQuery: false,
      canEdit: false,
      detail: 'Restarting IfcOpenShell and restoring your edits',
    });
    try {
      const server = await this.manager.ensure();
      if (!server || this.disposed) throw new Error('the model server could not be restarted');
      await this.open(server);
      if (complete) for (const entry of entries) await this.replay(server, entry);
      // Direct request: refreshStatus() would wait for this very recovery.
      this._status = await server.request<SessionStatus>('status', { doc: this.key });
      this.setState(this.readyState());
      this.options.log(`[session] recovered ${this.key}: replayed ${complete ? entries.length : 0} entries`);
      this.recoverEmitter.fire({ restored: complete ? entries.length : 0, complete });
    } catch (err) {
      this.opened = false;
      this.server = null;
      this.unavailable(
        `The model server stopped and could not be restored: ${err instanceof Error ? err.message : String(err)}. Unsaved edits are lost; reopen the file.`,
      );
    }
  }

  private async replay(server: ModelServer, entry: JournalEntry): Promise<void> {
    const base = { doc: this.key };
    switch (entry.kind) {
      case 'edit':
        await server.request('edit', { ...base, ops: entry.ops });
        break;
      case 'query':
        await server.request(
          'query',
          { ...base, code: entry.code, name: entry.name, persistent: entry.persistent },
          this.options.scriptTimeoutMs(),
        );
        break;
      case 'undo':
        await server.request('undo', base);
        break;
      case 'redo':
        await server.request('redo', base);
        break;
    }
  }

  private record(entry: JournalEntry): void {
    if (!this.journalComplete) return;
    this.journalChars += entry.kind === 'query' ? entry.code.length : 200;
    if (this.journal.length >= JOURNAL_MAX_ENTRIES || this.journalChars > JOURNAL_MAX_CHARS) {
      this.journalComplete = false;
      this.journal = [];
      return;
    }
    this.journal.push(entry);
  }

  private clearJournal(): void {
    this.journal = [];
    this.journalChars = 0;
    this.journalComplete = true;
  }

  setScriptsAllowed(allowed: boolean): void {
    if (this._state.state === 'ready') this.setState({ ...this._state, canQuery: allowed });
  }

  // -- requests -----------------------------------------------------------------

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    // A recovery in progress finishes first, so a request sent meanwhile waits
    // instead of failing.
    if (this.recovering) await this.recovering;
    const server = this.server;
    if (!server || !this.opened) throw new Error('IfcOpenShell is not available for this file.');
    const started = Date.now();
    try {
      return await server.request<T>(method, { doc: this.key, ...params }, timeoutMs);
    } finally {
      const ms = Date.now() - started;
      if (ms >= SLOW_REQUEST_MS && method !== 'open') this.options.log(`[session] ${method} took ${ms} ms`);
    }
  }

  async refreshStatus(): Promise<SessionStatus> {
    this._status = await this.call<SessionStatus>('status');
    return this._status;
  }

  // -- reads --------------------------------------------------------------------
  read<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(method, params);
  }

  // -- edits --------------------------------------------------------------------
  private publish(source: DeltaSource, result: EditResult): void {
    if (!result.delta) return;
    this.deltaEmitter.fire({ source, delta: result.delta, patch: result.patch });
    const failed = result.patch?.failed ?? [];
    if (failed.length > 0) {
      this.options.log(`[session] could not tessellate ${failed.length} element(s): ${failed.slice(0, 20).join(', ')}`);
      this.warnEmitter.fire(
        `${failed.length} changed element${failed.length === 1 ? '' : 's'} could not be redrawn, so the view still shows the old shape. The model itself is changed.`,
      );
    }
  }

  edit(ops: EditOp[], source: DeltaSource = 'user'): Promise<EditResult> {
    return this.enqueue(async () => {
      const result = await this.call<EditResult>('edit', { ops });
      this.record({ kind: 'edit', ops });
      await this.refreshStatus();
      if (result.delta) {
        this.publish(source, result);
        this.editEmitter.fire({ label: describeOps(ops) });
      }
      return result;
    });
  }

  query(code: string, name: string, persistent = false): Promise<QueryResult> {
    return this.enqueue(async () => {
      if (!this.options.allowScripts()) throw new Error('Scripts are turned off (setting ifcViewer.engine.allowScripts).');
      const limit = this.options.scriptTimeoutMs();
      let result: QueryResult;
      try {
        result = await this.call<QueryResult>('query', { code, name, persistent }, limit);
      } catch (err) {
        if (!isTimeout(err)) throw err;
        // Python cannot interrupt a script from outside, so the only way to stop
        // it is to end the process, then rebuild the session from the journal.
        this.options.log(`[session] script exceeded ${Math.round(limit / 1000)} s; restarting the server`);
        await this.manager.kill();
        await this.recover();
        throw new Error(
          `The script ran longer than ${Math.round(limit / 1000)} s and was stopped. The model was restored to its state before it (setting ifcViewer.engine.scriptTimeoutSeconds).`,
          { cause: err },
        );
      }
      if (persistent || result.delta) this.record({ kind: 'query', code, name, persistent });
      await this.refreshStatus();
      if (result.delta) {
        this.publish('agent', result);
        this.editEmitter.fire({ label: 'Script edit' });
      }
      return result;
    });
  }

  undo(): Promise<EditResult> {
    return this.enqueue(async () => {
      const result = await this.call<EditResult>('undo');
      this.record({ kind: 'undo' });
      await this.refreshStatus();
      this.publish('undo', result);
      return result;
    });
  }

  redo(): Promise<EditResult> {
    return this.enqueue(async () => {
      const result = await this.call<EditResult>('redo');
      this.record({ kind: 'redo' });
      await this.refreshStatus();
      this.publish('redo', result);
      return result;
    });
  }

  // -- save / discard -----------------------------------------------------------
  save(targetPath?: string): Promise<{ path: string; mtimeMs: number }> {
    return this.enqueue(async () => {
      const result = await this.call<{ path: string; mtimeMs: number }>('save', {
        path: targetPath ?? this.savePath,
      });
      // What was saved needs no replaying; a copy elsewhere does not count.
      if (!targetPath || targetPath === this.savePath) this.clearJournal();
      await this.refreshStatus();
      return result;
    });
  }

  /** Write the current state somewhere else (hot-exit backup) without marking the document saved. */
  writeBackup(targetPath: string): Promise<void> {
    return this.enqueue(async () => {
      await this.call('save', { path: targetPath });
    });
  }

  /** Re-read the file from disk, dropping all unsaved edits. */
  discard(): Promise<void> {
    return this.enqueue(async () => {
      await this.call('discard');
      this.clearJournal();
      await this.refreshStatus();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const server = this.server;
    if (server?.running && this.opened) {
      await server.request('close', { doc: this.key }, 10_000).catch(() => undefined);
    }
    this.opened = false;
    this.stateEmitter.dispose();
    this.deltaEmitter.dispose();
    this.editEmitter.dispose();
    this.recoverEmitter.dispose();
    this.warnEmitter.dispose();
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /did not answer/.test(err.message);
}

function describeOps(ops: EditOp[]): string {
  if (ops.length === 1) {
    const op = ops[0];
    switch (op.op) {
      case 'setProperty':
        return `Edit ${op.name}`;
      case 'setAttribute':
        return `Edit ${op.name}`;
      case 'addPset':
        return `Add ${op.pset}`;
      case 'removeProperty':
        return `Remove ${op.name}`;
      case 'deleteProduct':
        return 'Delete element';
      case 'setPlacement':
        return 'Move element';
      default:
        return 'Edit model';
    }
  }
  return `Edit model (${ops.length} changes)`;
}
