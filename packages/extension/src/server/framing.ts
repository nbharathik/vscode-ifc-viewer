// JSON-RPC framing for the model server: Content-Length headers, UTF-8 JSON
// bodies. Pure (no vscode, no child_process) so it is unit-tested directly.

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Accumulates stream chunks and yields each complete message. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('model server sent a frame without Content-Length');
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break;
      messages.push(JSON.parse(this.buffer.subarray(start, start + length).toString('utf8')));
      this.buffer = this.buffer.subarray(start + length);
    }
    return messages;
  }
}
