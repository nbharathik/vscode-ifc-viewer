// Owns the one Python model server for the extension: finds a Python with
// IfcOpenShell, starts the process on demand, and tells sessions when it dies.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ModelServer } from './modelServer.js';
import type { ServerInfo } from './modelServer.js';
import { candidates, discoverPython } from './pythonDiscovery.js';
import type { Discovery, PythonInfo, Probe } from './pythonDiscovery.js';
import type { ExtensionSettings } from '../settings.js';

export type ServerState =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'ready'; python: PythonInfo; info: ServerInfo }
  | { state: 'unavailable'; reason: string; discovery: Discovery | null };

/** Path of the Python inside the extension-managed environment. */
export function managedPythonPath(storage: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(storage, 'venv', 'Scripts', 'python.exe')
    : path.join(storage, 'venv', 'bin', 'python');
}

function runProbe(command: string, args: string[]): Promise<Probe> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, 20_000);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

export class ServerManager implements vscode.Disposable {
  private server: ModelServer | null = null;
  private starting: Promise<ModelServer | null> | null = null;
  private current: ServerState = { state: 'idle' };
  private readonly stateEmitter = new vscode.EventEmitter<ServerState>();
  /** Fires on every state change, including the server dying. */
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly exitEmitter = new vscode.EventEmitter<void>();
  /** Fires when a running server exits without being asked to. */
  readonly onDidExit = this.exitEmitter.event;
  private stopping = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: () => ExtensionSettings,
    private readonly output: vscode.OutputChannel,
  ) {}

  get state(): ServerState {
    return this.current;
  }

  get storagePath(): string {
    return this.context.globalStorageUri.fsPath;
  }

  private setState(state: ServerState): void {
    this.current = state;
    this.stateEmitter.fire(state);
  }

  /** The directory holding the ifc_viewer_server package. */
  private async serverDir(): Promise<string> {
    const packaged = path.join(this.context.extensionPath, 'dist', 'server');
    if (await exists(path.join(packaged, 'ifc_viewer_server'))) return packaged;
    return path.resolve(this.context.extensionPath, '..', 'model-server');
  }

  async discover(): Promise<Discovery> {
    const managed = managedPythonPath(this.storagePath);
    const list = candidates({
      setting: this.settings().engine.python,
      managedPython: (await exists(managed)) ? managed : null,
      platform: process.platform,
    });
    return discoverPython(list, runProbe);
  }

  /** Start (once) and return the server, or null when IfcOpenShell is not available. */
  ensure(): Promise<ModelServer | null> {
    if (this.server?.running) return Promise.resolve(this.server);
    this.starting ??= this.startNow().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startNow(): Promise<ModelServer | null> {
    this.setState({ state: 'starting' });
    const discovery = await this.discover();
    if (!discovery.ok) {
      this.output.appendLine(`model server unavailable: ${discovery.message} Tried: ${discovery.tried.join('; ')}`);
      this.setState({ state: 'unavailable', reason: discovery.message, discovery });
      return null;
    }
    const server = new ModelServer({
      python: discovery.python,
      serverDir: await this.serverDir(),
      log: (line) => this.output.appendLine(`[server] ${line}`),
    });
    try {
      const info = await server.start();
      server.onDidExit((code) => {
        if (this.server === server) this.server = null;
        if (this.stopping) return;
        this.output.appendLine(`model server exited (code ${code})`);
        this.setState({ state: 'unavailable', reason: 'The model server stopped unexpectedly.', discovery: null });
        this.exitEmitter.fire();
      });
      this.server = server;
      this.output.appendLine(
        `model server ready: Python ${info.python}, IfcOpenShell ${info.ifcopenshell} (${discovery.python.source})`,
      );
      this.setState({ state: 'ready', python: discovery.python, info });
      return server;
    } catch (err) {
      const reason = `The model server could not start: ${err instanceof Error ? err.message : String(err)}`;
      this.output.appendLine(reason);
      await server.dispose().catch(() => undefined);
      this.setState({ state: 'unavailable', reason, discovery: null });
      return null;
    }
  }

  /**
   * Kill the running server (a script that never ends) and wait for it to be
   * gone. The next ensure() starts a fresh one, and the exit event lets every
   * session recover.
   */
  async kill(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await server.kill();
  }

  /** Forget a failed discovery so the next ensure() looks again (after a setup or setting change). */
  async restart(): Promise<void> {
    this.stopping = true;
    try {
      await this.server?.dispose();
    } finally {
      this.stopping = false;
    }
    this.server = null;
    this.starting = null;
    this.setState({ state: 'idle' });
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await this.server?.dispose();
    this.server = null;
    this.stateEmitter.dispose();
    this.exitEmitter.dispose();
  }
}
