// Minimal Model Context Protocol server logic: JSON-RPC 2.0 requests in,
// responses out, tools only. Pure (no vscode, no network), so the protocol
// behaviour is unit-tested; transport lives in httpServer.ts.

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export class McpHandler {
  constructor(
    private readonly info: ServerInfo,
    private readonly tools: readonly ToolDef[],
  ) {}

  /** Null for notifications (no id): nothing goes back. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } };
    }
    const request = message as JsonRpcMessage;
    const id = request.id ?? null;
    const isNotification = request.id === undefined;
    const ok = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string): JsonRpcResponse | null =>
      isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } };

    switch (request.method) {
      case 'initialize': {
        const wanted = request.params?.protocolVersion;
        const protocolVersion = (SUPPORTED_PROTOCOLS as readonly unknown[]).includes(wanted)
          ? (wanted as string)
          : SUPPORTED_PROTOCOLS[0];
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          instructions: this.info.instructions,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case 'tools/call': {
        const name = request.params?.name;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool ${JSON.stringify(name)}.`);
        const args = request.params?.arguments;
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
          return fail(-32602, 'Tool arguments must be an object.');
        }
        try {
          return ok(await tool.run((args as Record<string, unknown> | undefined) ?? {}));
        } catch (err) {
          // Tool failures are results the agent can read, not protocol errors.
          return ok(textResult(err instanceof Error ? err.message : String(err), true));
        }
      }
      default:
        if (typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
        return fail(-32601, `Method not found: ${String(request.method)}`);
    }
  }
}
