"""One open model: the IfcOpenShell file, its undo history, and save."""
import contextlib
import gc
import io
import os
import time
import traceback

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as element_util

from . import model_data
from .delta import build_delta
from .geometry import GeometryIds, PatchBuilder
from .ops import OpError, apply_ops


class Document:
    def __init__(self, key, path, geometry_ids, save_path=None, dirty=False):
        self.key = key
        # `path` is what gets loaded (the file, or a hot-exit backup of it);
        # `save_path` is where Save writes and what Discard reloads.
        self.path = path
        self.save_path = save_path or path
        self._start_dirty = dirty
        self._geometry_ids = geometry_ids
        self.model = None
        self.mtime_ms = None
        self.load_seconds = 0.0
        self._next_txn = 1
        # Revision markers: each edit pushes a unique number, undo pops, redo
        # pushes it back. dirty means the top marker is not the saved one.
        self._undo = []
        self._redo = []
        self._saved_marker = 0
        self._repl_names = None
        self._patches = None
        self.reload()

    # -- lifecycle ---------------------------------------------------------
    def reload(self):
        started = time.perf_counter()
        # Drop the previous model, its shape cache and script variables first, so
        # a reload never holds two models in memory at once.
        self.model = None
        self._repl_names = None
        self._patches = None
        gc.collect()
        self.model = ifcopenshell.open(self.path)
        self._patches = PatchBuilder(self._geometry_ids)
        self.load_seconds = round(time.perf_counter() - started, 3)
        self.mtime_ms = int(os.stat(self.path).st_mtime * 1000)
        self._undo.clear()
        self._redo.clear()
        # A document restored from a backup starts out with unsaved changes.
        self._saved_marker = -1 if self._start_dirty else 0

    def info(self):
        counts = {}
        for entity in self.model.by_type("IfcProduct"):
            counts[entity.is_a()] = counts.get(entity.is_a(), 0) + 1
        return {
            "schema": self.model.schema,
            "products": sum(counts.values()),
            "countsByType": counts,
            "mtimeMs": self.mtime_ms,
            "loadSeconds": self.load_seconds,
        }

    def status(self):
        return {
            "dirty": self.dirty,
            "canUndo": bool(self._undo),
            "canRedo": bool(self._redo),
            "mtimeMs": self.mtime_ms,
        }

    @property
    def dirty(self):
        top = self._undo[-1] if self._undo else 0
        return top != self._saved_marker

    # -- reads -------------------------------------------------------------
    def tree(self):
        return model_data.build_tree(self.model)

    def properties(self, express_id):
        return model_data.item_properties(self.model, express_id)

    def resolve_global_ids(self, ids):
        return model_data.resolve_global_ids(self.model, ids)

    def global_id_of(self, express_id):
        return model_data.global_id_for(self.model, express_id)

    def geometry(self, ids, placement_only=frozenset()):
        entities = []
        for express_id in ids:
            try:
                entities.append(self.model.by_id(express_id))
            except RuntimeError:
                continue
        return self._patches.build(self.model, entities, frozenset(placement_only))

    def release(self):
        """Free the model and everything derived from it (the document is closing)."""
        self.model = None
        self._repl_names = None
        self._patches = None
        gc.collect()

    # -- edits -------------------------------------------------------------
    def _transaction(self, work):
        """Run `work` in a transaction; return (delta, patch) or (None, None) when nothing changed."""
        model = self.model
        model.begin_transaction()
        try:
            result = work()
        except BaseException:
            model.discard_transaction()
            raise
        if not getattr(model.transaction, "operations", None):
            model.discard_transaction()
            return None, None, result
        model.end_transaction()
        operations = model.history[-1].operations
        marker = self._next_txn
        self._next_txn += 1
        self._undo.append(marker)
        self._redo.clear()
        delta = build_delta(model, operations, marker)
        return delta, self._patch_for(delta), result

    def _patch_for(self, delta):
        self._patches.forget(delta["removed"])
        ids = [c["id"] for c in delta["changed"] if c["geometry"]]
        if not ids:
            return None
        return self.geometry(ids, {c["id"] for c in delta["changed"] if c["placementOnly"]})

    def edit(self, ops):
        delta, patch, _ = self._transaction(lambda: apply_ops(self.model, ops))
        return {"delta": delta, "patch": patch}

    def _namespace(self, persistent):
        """Names a script sees. A persistent namespace keeps variables between calls (the REPL)."""
        base = {
            "model": self.model,
            "ifcopenshell": ifcopenshell,
            "api": ifcopenshell.api,
            "element_util": element_util,
            "IFC_PATH": self.path,
        }
        if not persistent:
            return base
        if self._repl_names is None:
            self._repl_names = {}
        # Re-bind the model every call: Discard and Revert replace it.
        self._repl_names.update(base)
        return self._repl_names

    def query(self, code, name="<script>", persistent=False):
        """Run a script against the live model. Its edits become one transaction.

        With `persistent`, variables survive between calls and a lone expression
        echoes its value, as in an interactive prompt.
        """
        output = io.StringIO()
        namespace = self._namespace(persistent)
        error = None

        def run():
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                if persistent:
                    try:
                        compiled = compile(code, name, "single")
                    except SyntaxError:
                        compiled = compile(code, name, "exec")
                else:
                    compiled = compile(code, name, "exec")
                exec(compiled, namespace)

        try:
            delta, patch, _ = self._transaction(run)
        except OpError as err:
            delta, patch, error = None, None, str(err)
        except BaseException:
            delta, patch, error = None, None, traceback.format_exc()
        return {"output": output.getvalue(), "error": error, "delta": delta, "patch": patch}

    def undo(self):
        if not self._undo:
            return {"delta": None, "patch": None}
        operations = self.model.history[-1].operations
        self.model.undo()
        marker = self._undo.pop()
        self._redo.append(marker)
        delta = build_delta(self.model, operations, marker)
        return {"delta": delta, "patch": self._patch_for(delta)}

    def redo(self):
        if not self._redo:
            return {"delta": None, "patch": None}
        operations = self.model.future[-1].operations
        self.model.redo()
        marker = self._redo.pop()
        self._undo.append(marker)
        delta = build_delta(self.model, operations, marker)
        return {"delta": delta, "patch": self._patch_for(delta)}

    # -- save --------------------------------------------------------------
    def save(self, path=None):
        """Write atomically: a temp file in the same folder, then os.replace."""
        target = os.path.abspath(path or self.save_path)
        folder = os.path.dirname(target)
        temp = os.path.join(folder, f".{os.path.basename(target)}.{os.getpid()}.tmp")
        try:
            self.model.write(temp)
            os.replace(temp, target)
        finally:
            if os.path.exists(temp):
                os.remove(temp)
        mtime = int(os.stat(target).st_mtime * 1000)
        # Only a write to the document's own file counts as saving it; a backup
        # or a copy elsewhere leaves the document dirty.
        if target == os.path.abspath(self.save_path):
            self.mtime_ms = mtime
            self._saved_marker = self._undo[-1] if self._undo else 0
            self._start_dirty = False
        return {"path": target, "mtimeMs": mtime}

    def discard(self):
        self.path = self.save_path
        self._start_dirty = False
        self.reload()
        return self.info()
