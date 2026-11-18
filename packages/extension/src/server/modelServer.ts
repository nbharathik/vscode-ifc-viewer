// The Python model server as a child process: JSON-RPC over stdio. No vscode
// imports, so it can be started from plain Node tests.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { FrameDecoder, encodeFrame } from './framing.js';
import type { PythonCandidate } from './pythonDiscovery.js';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface ServerInfo {
  protocol: number;
  server: string;
  ifcopenshell: string;
  python: string;
  pid: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface ModelServerOptions {
  python: PythonCandidate;
  /** Folder containing the ifc_viewer_server package (the process cwd). */
  serverDir: string;
  /** Receives the server's stderr, line by line. */
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ModelServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly notificationListeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  constructor(private readonly options: ModelServerOptions) {}

  get running(): boolean {
    return this.proc !== null && !this.exited;
  }

  onDidExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Messages the server sends on its own (progress), as opposed to answers. */
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Stop the process now (a runaway script) and resolve once it is gone. */
  kill(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
    });
  }

  /** Spawn the process and confirm it answers `ping`. */
  async start(): Promise<ServerInfo> {
    const { python, serverDir, log } = this.options;
    const proc = spawn(python.command, [...python.args, '-m', 'ifc_viewer_server'], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      if (log) for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) log(line);
    });
    proc.on('error', (err) => this.onExit(null, err));
    proc.on('exit', (code) => this.onExit(code, null));
    return this.request<ServerInfo>('ping', {}, 30_000);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const proc = this.proc;
    if (!proc || this.exited) return Promise.reject(new Error('The model server is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The model server did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      proc.stdin.write(encodeFrame({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Ask the process to finish by closing its input; kill it if it lingers. */
  async dispose(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) return;
    proc.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.options.log?.(`protocol error: ${String(err)}`);
      this.proc?.kill();
      return;
    }
    for (const raw of messages) {
      const message = raw as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (typeof message.id !== 'number') {
        if (typeof message.method === 'string') {
          for (const listener of this.notificationListeners) listener(message.method, message.params ?? {});
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    }
  }

  private onExit(code: number | null, error: Error | null): void {
    if (this.exited) return;
    this.exited = true;
    const reason = error ? error.message : `The model server exited (code ${code}).`;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const listener of this.exitListeners) listener(code);
  }
}
