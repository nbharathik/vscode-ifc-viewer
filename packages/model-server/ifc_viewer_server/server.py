"""JSON-RPC dispatcher: one process, many documents, one request at a time."""
import os
import sys
import traceback

import ifcopenshell

from . import PROTOCOL_VERSION, __version__
from .document import Document
from .framing import read_message, write_message
from .geometry import GeometryIds
from .ops import OpError
from .system import lower_priority, resident_mb

ERR_INVALID = -32602
ERR_METHOD = -32601
ERR_INTERNAL = -32603
ERR_DOC = -32001


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Server:
    def __init__(self):
        self.documents = {}
        self.geometry_ids = GeometryIds()

    def doc(self, params):
        key = params.get("doc")
        document = self.documents.get(key)
        if document is None:
            raise RpcError(ERR_DOC, f"document {key!r} is not open")
        return document

    # -- methods -----------------------------------------------------------
    def m_ping(self, params):
        return {
            "protocol": PROTOCOL_VERSION,
            "server": __version__,
            "ifcopenshell": ifcopenshell.version,
            "python": sys.version.split()[0],
            "pid": os.getpid(),
            "memoryMb": resident_mb(),
        }

    def m_open(self, params):
        key, path = params.get("doc"), params.get("path")
        if not key or not path:
            raise RpcError(ERR_INVALID, '"doc" and "path" are required')
        previous = self.documents.pop(key, None)
        if previous is not None:
            previous.release()
        self.documents[key] = Document(
            key, path, self.geometry_ids, params.get("savePath"), bool(params.get("dirty", False))
        )
        return {**self.documents[key].info(), "memoryMb": resident_mb()}

    def m_close(self, params):
        document = self.documents.pop(params.get("doc"), None)
        if document is not None:
            document.release()
        return {"closed": True}

    def m_info(self, params):
        return self.doc(params).info()

    def m_status(self, params):
        return {**self.doc(params).status(), "memoryMb": resident_mb()}

    def m_tree(self, params):
        return self.doc(params).tree()

    def m_properties(self, params):
        return self.doc(params).properties(params["id"])

    def m_resolveGlobalIds(self, params):
        return self.doc(params).resolve_global_ids(params.get("ids", []))

    def m_globalIdOf(self, params):
        return {"globalId": self.doc(params).global_id_of(params["id"])}

    def m_geometry(self, params):
        return self.doc(params).geometry(params.get("ids", []))

    def m_edit(self, params):
        return self.doc(params).edit(params.get("ops"))

    def m_query(self, params):
        return self.doc(params).query(
            params.get("code", ""), params.get("name", "<script>"), bool(params.get("persistent", False))
        )

    def m_undo(self, params):
        return self.doc(params).undo()

    def m_redo(self, params):
        return self.doc(params).redo()

    def m_save(self, params):
        return self.doc(params).save(params.get("path"))

    def m_discard(self, params):
        return self.doc(params).discard()

    # -- dispatch ----------------------------------------------------------
    def handle(self, message):
        method = message.get("method")
        handler = getattr(self, f"m_{method}", None) if isinstance(method, str) else None
        if handler is None:
            raise RpcError(ERR_METHOD, f"unknown method {method!r}")
        params = message.get("params") or {}
        try:
            return handler(params)
        except RpcError:
            raise
        except OpError as err:
            raise RpcError(ERR_INVALID, str(err))
        except KeyError as err:
            raise RpcError(ERR_INVALID, f"missing parameter {err}")
        except Exception as err:
            sys.stderr.write(traceback.format_exc())
            raise RpcError(ERR_INTERNAL, f"{type(err).__name__}: {err}")

    def serve(self, stdin, stdout):
        while True:
            message = read_message(stdin)
            if message is None:
                return
            request_id = message.get("id")
            try:
                result = self.handle(message)
                reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
            except RpcError as err:
                reply = {"jsonrpc": "2.0", "id": request_id, "error": {"code": err.code, "message": str(err)}}
            if request_id is not None:
                write_message(stdout, reply)


def main():
    # Keep the protocol channel clean: scripts and libraries that print must
    # not corrupt the framing, so stdout is redirected to stderr and the real
    # stdout is held privately.
    # The viewer is the foreground job; loading a model here must never slow its first paint.
    lower_priority()
    protocol_out = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    Server().serve(sys.stdin.buffer, protocol_out)
