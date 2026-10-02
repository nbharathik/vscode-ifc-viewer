"""JSON-RPC message framing over byte streams (LSP style Content-Length headers)."""
import json


def read_message(stream):
    """Return the next decoded message, or None when the stream is closed."""
    length = None
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is None:
                continue
            break
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value.strip())
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def encode_message(message):
    body = json.dumps(message, separators=(",", ":"), default=str).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def write_message(stream, message):
    stream.write(encode_message(message))
    stream.flush()
