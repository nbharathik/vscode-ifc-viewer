"""Tessellate a few products and pack them as a patch the viewer can ingest.

Only changed products come through here; the first paint is web-ifc's job.
Arrays are base64 so the patch travels inside a JSON-RPC message.
"""
import base64
import math
import os

import numpy as np

import ifcopenshell
import ifcopenshell.geom

# Patch geometry ids live above anything a file's STEP ids can reach, so they
# never collide with the ids web-ifc streamed at load.
GEOMETRY_ID_BASE = 0x80000000


# IFC is Z-up. The viewer's scene follows web-ifc, which is Y-up: x stays,
# y = IFC z, z = -IFC y. Patch matrices carry this conversion so geometry from
# IfcOpenShell lands exactly where web-ifc drew the same element.
IFC_TO_VIEWER = np.array(
    [[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, -1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
)


def viewer_matrix(flat_column_major):
    """The 16-number column-major placement of a shape, converted to the viewer's axes."""
    m = np.array(flat_column_major, dtype=np.float64).reshape((4, 4), order="F")
    return [float(x) for x in (IFC_TO_VIEWER @ m).flatten(order="F")]


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


def build_patch(model, entities, ids, threads=None):
    """Tessellate `entities` (products) into a MeshBatch-shaped dict.

    Returns {"geometries": [...], "placements": [...], "failed": [step ids]}.
    """
    geometries = []
    placements = []
    failed = []
    entities = [e for e in entities if e is not None and getattr(e, "Representation", None)]
    if not entities:
        return {"geometries": geometries, "placements": placements, "failed": failed}

    threads = threads or max(1, min(4, os.cpu_count() or 1))
    iterator = ifcopenshell.geom.iterator(_settings(), model, threads, include=entities)
    seen = {}  # (representation geometry id, material index) -> patch geometry id
    produced = set()
    if iterator.initialize():
        while True:
            shape = iterator.get()
            product = model.by_id(shape.id)
            geom = shape.geometry
            produced.add(shape.id)
            verts_all = np.array(geom.verts, dtype=np.float64).reshape(-1, 3)
            faces_all = np.array(geom.faces, dtype=np.int64).reshape(-1, 3)
            if len(verts_all) and len(faces_all):
                normals_all = np.array(geom.normals, dtype=np.float64).reshape(-1, 3)
                if normals_all.shape != verts_all.shape:
                    normals_all = _flat_normals(verts_all, faces_all)
                material_ids = np.array(geom.material_ids, dtype=np.int64)
                if material_ids.shape[0] != faces_all.shape[0]:
                    material_ids = np.zeros(faces_all.shape[0], dtype=np.int64)
                matrix = viewer_matrix(shape.transformation.matrix)
                for material_index in np.unique(material_ids):
                    key = (geom.id, int(material_index))
                    mask = material_ids == material_index
                    faces = faces_all[mask]
                    used, inverse = np.unique(faces.reshape(-1), return_inverse=True)
                    verts = verts_all[used]
                    gid = seen.get(key)
                    if gid is None:
                        gid = ids.take()
                        seen[key] = gid
                        geometries.append(
                            {
                                "id": gid,
                                "positions": _b64(verts.astype(np.float32)),
                                "normals": _b64(normals_all[used].astype(np.float32)),
                                "indices": _b64(inverse.astype(np.uint32)),
                                "vertexCount": int(len(verts)),
                                "indexCount": int(len(inverse)),
                                "bounds": [float(x) for x in (*verts.min(axis=0), *verts.max(axis=0))],
                            }
                        )
                    materials = geom.materials
                    material = materials[int(material_index)] if 0 <= material_index < len(materials) else None
                    placements.append(
                        {
                            "id": product.id(),
                            "geometryId": gid,
                            "matrix": matrix,
                            "color": _color(material),
                            "ifcType": product.is_a(),
                        }
                    )
            if not iterator.next():
                break
    for entity in entities:
        if entity.id() not in produced:
            failed.append(entity.id())
    return {"geometries": geometries, "placements": placements, "failed": failed}
