// One open document's editing session: the model held by the Python server,
// its dirty state, and the stream of deltas the viewer applies.
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
}

export interface DeltaEvent {
  source: DeltaSource;
  delta: Delta;
  patch: GeometryPatch | null;
}

export interface EditEvent {
  label: string;
}

export interface SessionOptions {
  /** Whether scripts (`query`) may run. */
  allowScripts: () => boolean;
}

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
  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidDelta = this.deltaEmitter.event;
  /** Fires after each successful edit, so the editor can push an undo entry. */
  readonly onDidEdit = this.editEmitter.event;
  private disposed = false;

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

  /** Open the document in the server. Never throws; failure becomes an unavailable state. */
  async start(): Promise<void> {
    this.setState({ state: 'starting', engine: 'web-ifc', canQuery: false, canEdit: false, detail: 'Starting IfcOpenShell' });
    const server = await this.manager.ensure();
    if (this.disposed) return;
    if (!server) {
      const s = this.manager.state;
      this.setState({
        state: 'unavailable',
        engine: 'web-ifc',
        canQuery: false,
        canEdit: false,
        detail: s.state === 'unavailable' ? s.reason : 'IfcOpenShell is not available.',
      });
      return;
    }
    try {
      this.server = server;
      await server.request('open', { doc: this.key, path: this.loadPath, savePath: this.savePath, dirty: this.fromBackup }, 15 * 60 * 1000);
      this.opened = true;
      await this.refreshStatus();
      this.setState({ state: 'ready', engine: 'ifcopenshell', canQuery: this.options.allowScripts(), canEdit: true });
    } catch (err) {
      this.setState({
        state: 'unavailable',
        engine: 'web-ifc',
        canQuery: false,
        canEdit: false,
        detail: `IfcOpenShell could not open this file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** The server died; the model in memory (and unsaved edits) are gone. */
  markLost(): void {
    if (!this.opened) return;
    this.opened = false;
    this.server = null;
    this._status = { dirty: false, canUndo: false, canRedo: false, mtimeMs: this._status.mtimeMs };
    this.setState({
      state: 'unavailable',
      engine: 'web-ifc',
      canQuery: false,
      canEdit: false,
      detail: 'The model server stopped. Unsaved edits in this session are lost; reopen the file.',
    });
  }

  setScriptsAllowed(allowed: boolean): void {
    if (this._state.state === 'ready') this.setState({ ...this._state, canQuery: allowed });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const server = this.server;
    if (!server || !this.opened) return Promise.reject(new Error('IfcOpenShell is not available for this file.'));
    return server.request<T>(method, { doc: this.key, ...params });
  }

  async refreshStatus(): Promise<SessionStatus> {
    this._status = await this.call<SessionStatus>('status');
    return this._status;
  }

  // -- reads ----------------------------------------------------------------
  read<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(method, params);
  }

  // -- edits ----------------------------------------------------------------
  private publish(source: DeltaSource, result: EditResult): void {
    if (result.delta) this.deltaEmitter.fire({ source, delta: result.delta, patch: result.patch });
  }

  edit(ops: EditOp[], source: DeltaSource = 'user'): Promise<EditResult> {
    return this.enqueue(async () => {
      const result = await this.call<EditResult>('edit', { ops });
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
      const result = await this.call<QueryResult>('query', { code, name, persistent });
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
      await this.refreshStatus();
      this.publish('undo', result);
      return result;
    });
  }

  redo(): Promise<EditResult> {
    return this.enqueue(async () => {
      const result = await this.call<EditResult>('redo');
      await this.refreshStatus();
      this.publish('redo', result);
      return result;
    });
  }

  // -- save / discard -------------------------------------------------------
  save(targetPath?: string): Promise<{ path: string; mtimeMs: number }> {
    return this.enqueue(async () => {
      const result = await this.call<{ path: string; mtimeMs: number }>('save', {
        path: targetPath ?? this.savePath,
      });
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
  }
}

function describeOps(ops: EditOp[]): string {
  if (ops.length === 1) {
    const op = ops[0];
    switch (op.op) {
      case 'setProperty':
        return `Edit ${op.name}`;
      case 'setAttribute':
        return `Edit ${op.name}`;
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
