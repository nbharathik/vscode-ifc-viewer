"""Typed edit operations: one vocabulary shared by the viewer and the agent.

Every op runs inside the caller's transaction and goes through
ifcopenshell.api, which keeps relationships, owner history and GlobalIds
consistent. Raw entity edits are available through the `query` method instead.
"""
import numpy as np

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as element_util


class OpError(ValueError):
    pass


def _entity(model, op, key="id"):
    value = op.get(key)
    if not isinstance(value, int):
        raise OpError(f'"{key}" must be a STEP id (integer)')
    try:
        return model.by_id(value)
    except RuntimeError:
        raise OpError(f"no entity #{value}")


def _by_global_id_or_id(model, op):
    if "globalId" in op:
        try:
            return model.by_guid(op["globalId"])
        except RuntimeError:
            raise OpError(f'no element with GlobalId {op["globalId"]}')
    return _entity(model, op)


def set_attribute(model, op):
    entity = _by_global_id_or_id(model, op)
    name = op.get("name")
    if not isinstance(name, str) or not name:
        raise OpError('"name" is required')
    if name == "GlobalId":
        raise OpError("GlobalId is never changed")
    ifcopenshell.api.run("attribute.edit_attributes", model, product=entity, attributes={name: op.get("value")})


def _find_pset(entity, pset_name, pset_id):
    for name, data in element_util.get_psets(entity).items():
        if pset_id is not None and data.get("id") == pset_id:
            return data["id"]
        if pset_id is None and name == pset_name:
            return data["id"]
    return None


def set_property(model, op):
    entity = _by_global_id_or_id(model, op)
    pset_name = op.get("pset")
    prop = op.get("name")
    if not isinstance(prop, str) or not prop:
        raise OpError('"name" is required')
    pset_id = op.get("psetId")
    if pset_id is None and not isinstance(pset_name, str):
        raise OpError('"pset" or "psetId" is required')
    existing_id = _find_pset(entity, pset_name, pset_id)
    own = None
    if existing_id is not None:
        candidate = model.by_id(existing_id)
        # A set that comes from the type is shared; editing it changes every
        # occurrence, so only edit sets this element owns.
        owned_ids = {
            rel.RelatingPropertyDefinition.id()
            for rel in (getattr(entity, "IsDefinedBy", None) or [])
            if rel.is_a("IfcRelDefinesByProperties")
        }
        if candidate.id() in owned_ids:
            own = candidate
    if own is None:
        name = pset_name or model.by_id(pset_id).Name
        is_qto = op.get("kind") == "qto" or (isinstance(name, str) and name.startswith("Qto_"))
        adder = "pset.add_qto" if is_qto else "pset.add_pset"
        own = ifcopenshell.api.run(adder, model, product=entity, name=name)
    editor = "pset.edit_qto" if own.is_a("IfcElementQuantity") else "pset.edit_pset"
    value = op.get("value")
    arg = "qto" if own.is_a("IfcElementQuantity") else "pset"
    ifcopenshell.api.run(editor, model, **{arg: own, "properties": {prop: value}})


def remove_pset(model, op):
    entity = _by_global_id_or_id(model, op)
    pset = _entity(model, op, "psetId")
    ifcopenshell.api.run("pset.remove_pset", model, product=entity, pset=pset)


def delete_product(model, op):
    entity = _by_global_id_or_id(model, op)
    if not entity.is_a("IfcProduct"):
        raise OpError(f"{entity.is_a()} is not a product")
    ifcopenshell.api.run("root.remove_product", model, product=entity)


def set_placement(model, op):
    entity = _by_global_id_or_id(model, op)
    matrix = op.get("matrix")
    location = op.get("location")
    if matrix is not None:
        array = np.array(matrix, dtype=float)
        if array.size != 16:
            raise OpError('"matrix" must hold 16 numbers (4x4, column-major, metres)')
        array = array.reshape((4, 4), order="F")
    elif location is not None:
        if len(location) != 3:
            raise OpError('"location" must be [x, y, z] in metres')
        array = np.eye(4)
        array[:3, 3] = [float(v) for v in location]
    else:
        raise OpError('"matrix" or "location" is required')
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=array, is_si=True)


def assign_container(model, op):
    entity = _by_global_id_or_id(model, op)
    container = _entity(model, op, "containerId")
    ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=container)


def assign_type(model, op):
    entity = _by_global_id_or_id(model, op)
    type_object = _entity(model, op, "typeId")
    ifcopenshell.api.run("type.assign_type", model, related_objects=[entity], relating_type=type_object)


def create_product(model, op):
    ifc_class = op.get("ifcClass")
    if not isinstance(ifc_class, str) or not ifc_class:
        raise OpError('"ifcClass" is required')
    entity = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class=ifc_class, name=op.get("name")
    )
    if op.get("containerId") is not None:
        container = _entity(model, op, "containerId")
        ifcopenshell.api.run("spatial.assign_container", model, products=[entity], relating_structure=container)
    if op.get("location") is not None:
        array = np.eye(4)
        array[:3, 3] = [float(v) for v in op["location"]]
        ifcopenshell.api.run("geometry.edit_object_placement", model, product=entity, matrix=array, is_si=True)


OPS = {
    "setAttribute": set_attribute,
    "setProperty": set_property,
    "removePset": remove_pset,
    "deleteProduct": delete_product,
    "setPlacement": set_placement,
    "assignContainer": assign_container,
    "assignType": assign_type,
    "createProduct": create_product,
}


def apply_ops(model, ops):
    if not isinstance(ops, list) or not ops:
        raise OpError('"ops" must be a non-empty list')
    for index, op in enumerate(ops):
        kind = op.get("op") if isinstance(op, dict) else None
        handler = OPS.get(kind)
        if handler is None:
            raise OpError(f"op {index}: unknown op {kind!r}; expected one of {', '.join(OPS)}")
        try:
            handler(model, op)
        except OpError as err:
            raise OpError(f"op {index} ({kind}): {err}") from None
