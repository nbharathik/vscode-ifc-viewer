"""Tessellate a few products and pack them as a patch the viewer can ingest.

Only changed products come through here; the first paint is web-ifc's job.
Arrays are base64 so the patch travels inside a JSON-RPC message.

Tessellating is the expensive part (seconds for a heavy element), and a move
does not change an element's shape. So every tessellated product is cached, and
a placement-only edit just re-derives the matrix: new = new_placement *
inverse(old_placement) * old_matrix. Moving the same element again, or undoing
a move, costs microseconds.
"""
import base64
import math
import os
from collections import OrderedDict

import numpy as np

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement as placement_util
import ifcopenshell.util.unit as unit_util

# Patch geometry ids live above anything a file's STEP ids can reach, so they
# never collide with the ids web-ifc streamed at load.
GEOMETRY_ID_BASE = 0x80000000

# Tessellated products kept for cheap moves. Heavy elements are the ones worth
# keeping, and a few hundred covers any realistic editing session.
CACHE_LIMIT = 256

# IFC is Z-up. The viewer's scene follows web-ifc, which is Y-up: x stays,
# y = IFC z, z = -IFC y. Patch matrices carry this conversion so geometry from
# IfcOpenShell lands exactly where web-ifc drew the same element.
IFC_TO_VIEWER = np.array(
    [[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, -1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
)


def column_major(matrix):
    return [float(x) for x in np.asarray(matrix, dtype=np.float64).flatten(order="F")]


def as_matrix(flat_column_major):
    return np.array(flat_column_major, dtype=np.float64).reshape((4, 4), order="F")


def viewer_matrix(flat_column_major):
    """A shape's column-major placement in IFC axes, converted to the viewer's axes."""
    return column_major(IFC_TO_VIEWER @ as_matrix(flat_column_major))


def _b64(array):
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def _settings():
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", False)
    settings.set("weld-vertices", False)
    return settings


def _color(material):
    """RGBA of an IfcOpenShell style, or opaque white (the viewer then picks its own)."""
    if material is None:
        return [1.0, 1.0, 1.0, 1.0]
    diffuse = getattr(material, "diffuse", None)
    if diffuse is None:
        return [1.0, 1.0, 1.0, 1.0]

    def comp(name):
        value = getattr(diffuse, name)
        return float(value() if callable(value) else value)

    transparency = getattr(material, "transparency", float("nan"))
    transparency = transparency() if callable(transparency) else transparency
    alpha = 1.0 if transparency is None or math.isnan(transparency) else 1.0 - float(transparency)
    return [comp("r"), comp("g"), comp("b"), alpha]


def _flat_normals(verts, faces):
    tri = verts[faces]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    length = np.linalg.norm(n, axis=1, keepdims=True)
    length[length == 0] = 1.0
    n = n / length
    normals = np.zeros_like(verts)
    for k in range(3):
        normals[faces[:, k]] = n
    return normals


class GeometryIds:
    """Hands out patch geometry ids that never repeat within a server run."""

    def __init__(self):
        self._next = 0

    def take(self):
        value = GEOMETRY_ID_BASE + self._next
        self._next += 1
        return value


class _Part:
    """One drawable piece of a product: a shape and its colour, placed by a matrix (IFC axes, metres)."""

    __slots__ = ("key", "payload", "matrix", "color", "ifc_type", "gid")

    def __init__(self, key, payload, matrix, color, ifc_type):
        self.key = key
        self.payload = payload
        self.matrix = matrix
        self.color = color
        self.ifc_type = ifc_type
        # Assigned when the part is first sent and then kept: moving the element
        # again reuses the id, so the viewer draws the shape as one more
        # instance of geometry it already holds instead of a second full copy.
        self.gid = None


class _Entry:
    """What is cached for a product: its world placement and its parts."""

    __slots__ = ("world", "parts")

    def __init__(self, world, parts):
        self.world = world
        self.parts = parts


class _Out:
    """Builds one patch: shares a geometry between placements that use the same shape."""

    def __init__(self, ids):
        self._ids = ids
        self._sent = set()
        self.geometries = []
        self.placements = []
        self.failed = []

    def add(self, product_id, part, matrix_ifc):
        if part.gid is None:
            part.gid = self._ids.take()
        gid = part.gid
        # Each patch carries a geometry's data once, however many placements use it.
        if gid not in self._sent:
            self._sent.add(gid)
            self.geometries.append({"id": gid, **part.payload})
        self.placements.append(
            {
                "id": product_id,
                "geometryId": gid,
                "matrix": viewer_matrix(column_major(matrix_ifc)),
                "color": part.color,
                "ifcType": part.ifc_type,
            }
        )

    def result(self):
        return {"geometries": self.geometries, "placements": self.placements, "failed": self.failed}


class PatchBuilder:
    """Patches for one document, with the shape cache that makes moves cheap."""

    def __init__(self, ids, threads=None):
        self._ids = ids
        self._threads = threads or max(1, min(4, os.cpu_count() or 1))
        self._cache = OrderedDict()
        self._scale = None
        self.stats = {"tessellated": 0, "moved": 0}

    # -- helpers ---------------------------------------------------------------
    def _unit_scale(self, model):
        if self._scale is None:
            try:
                self._scale = float(unit_util.calculate_unit_scale(model))
            except Exception:
                self._scale = 1.0
        return self._scale

    def _world(self, product, model):
        """The product's world placement in metres, or None when it has none."""
        placement = getattr(product, "ObjectPlacement", None)
        if placement is None:
            return None
        try:
            world = np.array(placement_util.get_local_placement(placement), dtype=np.float64)
        except Exception:
            return None
        world[:3, 3] *= self._unit_scale(model)
        return world

    def _remember(self, product_id, entry):
        self._cache[product_id] = entry
        self._cache.move_to_end(product_id)
        while len(self._cache) > CACHE_LIMIT:
            self._cache.popitem(last=False)

    def forget(self, product_ids):
        for product_id in product_ids:
            self._cache.pop(product_id, None)

    # -- patches -----------------------------------------------------------------
    def build(self, model, entities, placement_only=frozenset()):
        """Tessellate `entities` into a MeshBatch-shaped dict.

        Products whose only change is their placement, and that were tessellated
        before, are not tessellated again: their matrix is re-derived.
        """
        out = _Out(self._ids)
        full = []
        for entity in entities:
            if entity is None or not getattr(entity, "Representation", None):
                continue
            entry = self._cache.get(entity.id())
            if entity.id() in placement_only and entry is not None and entry.world is not None:
                world = self._world(entity, model)
                if world is not None:
                    self._move(out, model, entity, entry, world)
                    continue
            full.append(entity)
        if full:
            self._tessellate(model, full, out)
        return out.result()

    def _move(self, out, model, entity, entry, world):
        try:
            change = world @ np.linalg.inv(entry.world)
        except np.linalg.LinAlgError:
            self._cache.pop(entity.id(), None)
            self._tessellate(model, [entity], out)
            return
        for part in entry.parts:
            part.matrix = change @ part.matrix
            out.add(entity.id(), part, part.matrix)
        entry.world = world
        self._cache.move_to_end(entity.id())
        self.stats["moved"] += 1

    def _tessellate(self, model, entities, out):
        iterator = ifcopenshell.geom.iterator(_settings(), model, self._threads, include=entities)
        # A product can yield several shapes (one per representation), so its
        # parts are gathered across shapes before they are cached.
        gathered = {}
        # Products drawn from the same shape in this run (mapped items) share one
        # geometry id, so their data crosses once. Ids are never shared between
        # runs: a later edit may have reshaped what an old key pointed to.
        shared = {}
        if iterator.initialize():
            while True:
                shape = iterator.get()
                product = model.by_id(shape.id)
                parts = self._parts(product, shape)
                for part in parts:
                    part.gid = shared.setdefault(part.key, self._ids.take())
                    out.add(product.id(), part, part.matrix)
                gathered.setdefault(product.id(), (product, []))[1].extend(parts)
                if not iterator.next():
                    break
        for product_id, (product, parts) in gathered.items():
            self._remember(product_id, _Entry(self._world(product, model), parts))
        self.stats["tessellated"] += len(gathered)
        for entity in entities:
            if entity.id() not in gathered:
                out.failed.append(entity.id())

    @staticmethod
    def _parts(product, shape):
        geom = shape.geometry
        verts_all = np.array(geom.verts, dtype=np.float64).reshape(-1, 3)
        faces_all = np.array(geom.faces, dtype=np.int64).reshape(-1, 3)
        if not len(verts_all) or not len(faces_all):
            return []
        normals_all = np.array(geom.normals, dtype=np.float64).reshape(-1, 3)
        if normals_all.shape != verts_all.shape:
            normals_all = _flat_normals(verts_all, faces_all)
        material_ids = np.array(geom.material_ids, dtype=np.int64)
        if material_ids.shape[0] != faces_all.shape[0]:
            material_ids = np.zeros(faces_all.shape[0], dtype=np.int64)
        matrix = as_matrix(shape.transformation.matrix)
        materials = geom.materials
        parts = []
        for material_index in np.unique(material_ids):
            mask = material_ids == material_index
            faces = faces_all[mask]
            used, inverse = np.unique(faces.reshape(-1), return_inverse=True)
            verts = verts_all[used]
            payload = {
                "positions": _b64(verts.astype(np.float32)),
                "normals": _b64(normals_all[used].astype(np.float32)),
                "indices": _b64(inverse.astype(np.uint32)),
                "vertexCount": int(len(verts)),
                "indexCount": int(len(inverse)),
                "bounds": [float(x) for x in (*verts.min(axis=0), *verts.max(axis=0))],
            }
            material = materials[int(material_index)] if 0 <= material_index < len(materials) else None
            parts.append(
                _Part((geom.id, int(material_index)), payload, matrix.copy(), _color(material), product.is_a())
            )
        return parts
