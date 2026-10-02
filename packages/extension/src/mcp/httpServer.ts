// Loopback HTTP transport for the MCP handler: POST JSON-RPC, bearer token,
// host and origin checks (so a web page cannot reach it), size limit. Plain
// Node, no vscode import.
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpHandler } from './handler.js';

export interface RunningMcpServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Only loopback names are accepted as Host, which blocks DNS rebinding. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function startMcpHttp(handler: McpHandler): Promise<RunningMcpServer> {
  const token = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const port = (server.address() as { port: number }).port;
      const reply = (status: number, body?: unknown): void => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      };
      // A browser always sends Origin; the shim and agents do not.
      if (req.headers.origin !== undefined || !hostAllowed(req.headers.host, port)) return reply(403, { error: 'forbidden' });
      if (!tokenMatches(req.headers.authorization, token)) return reply(401, { error: 'unauthorized' });
      if (req.method !== 'POST') return reply(405, { error: 'POST only' });

      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reply(413, { error: 'too large' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY_BYTES) return;
        let message: unknown;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const items = Array.isArray(message) ? message : [message];
        void Promise.all(items.map((m) => handler.handle(m))).then((responses) => {
          const answers = responses.filter((r) => r !== null);
          if (answers.length === 0) return reply(202);
          reply(200, Array.isArray(message) ? answers : answers[0]);
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
