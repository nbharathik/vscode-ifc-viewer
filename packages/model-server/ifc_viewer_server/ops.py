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


def _owned_pset(model, entity, pset_name, pset_id):
    """The property set this element owns with that name or id, or None.

    A set that comes from the type is shared: editing it would change every
    occurrence, so only sets the element itself owns count.
    """
    existing_id = _find_pset(entity, pset_name, pset_id)
    if existing_id is None:
        return None
    owned_ids = {
        rel.RelatingPropertyDefinition.id()
        for rel in (getattr(entity, "IsDefinedBy", None) or [])
        if rel.is_a("IfcRelDefinesByProperties")
    }
    return model.by_id(existing_id) if existing_id in owned_ids else None


_QUANTITY_VALUE = {
    "IfcQuantityLength": "LengthValue",
    "IfcQuantityArea": "AreaValue",
    "IfcQuantityVolume": "VolumeValue",
    "IfcQuantityCount": "CountValue",
    "IfcQuantityWeight": "WeightValue",
    "IfcQuantityTime": "TimeValue",
}


def _kind_of(ifc_type):
    """How a value of this IFC type is written: bool, int, float or str."""
    if ifc_type in ("IfcBoolean", "IfcLogical"):
        return "bool"
    if ifc_type == "IfcInteger":
        return "int"
    if ifc_type in ("IfcReal", "IfcNumber") or ifc_type.endswith("Measure") or ifc_type.startswith(
        ("IfcPositive", "IfcNonNegative", "IfcNormalised", "IfcRatio")
    ):
        return "float"
    return "str"


def _coerce(ifc_type, value):
    """`value` as a plain Python value that fits `ifc_type`, or an OpError saying why not."""
    kind = _kind_of(ifc_type)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in ("true", "false"):
            return value.strip().lower() == "true"
        raise OpError(f"{ifc_type} takes true or false")
    if kind in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise OpError(f"{ifc_type} takes a number")
        try:
            number = float(value)
        except ValueError:
            raise OpError(f"{ifc_type} takes a number, not {value!r}") from None
        if number != number or number in (float("inf"), float("-inf")):
            raise OpError(f"{ifc_type} takes a finite number")
        if kind == "int":
            if number != int(number):
                raise OpError(f"{ifc_type} takes a whole number")
            return int(number)
        return number
    if value is None or isinstance(value, (str, int, float, bool)):
        return None if value is None else str(value)
    raise OpError(f"{ifc_type} takes text")


def _wrap(model, ifc_type, value):
    """An IFC value of type `ifc_type` holding `value` (None leaves the property valueless)."""
    if value is None:
        return None
    try:
        return model.create_entity(ifc_type, _coerce(ifc_type, value))
    except OpError:
        raise
    except Exception as err:
        raise OpError(f"{value!r} is not a valid {ifc_type}: {err}") from None


# What the editor's Text, Number and Yes/No choices create.
_NEW_TYPES = {"text": "IfcLabel", "number": "IfcReal", "boolean": "IfcBoolean"}


def _new_type(op, value):
    declared = op.get("valueType")
    if isinstance(declared, str) and declared:
        return _NEW_TYPES.get(declared.lower(), declared)
    if isinstance(value, bool):
        return "IfcBoolean"
    if isinstance(value, (int, float)):
        return "IfcReal"
    return "IfcLabel"


def _set_existing_property(model, prop, value):
    if prop.is_a("IfcPropertySingleValue"):
        current = prop.NominalValue
        ifc_type = current.is_a() if current is not None else _new_type({}, value)
        ifcopenshell.api.run(
            "attribute.edit_attributes", model, product=prop, attributes={"NominalValue": _wrap(model, ifc_type, value)}
        )
    elif prop.is_a("IfcPropertyEnumeratedValue"):
        allowed = []
        reference = prop.EnumerationReference
        if reference is not None:
            allowed = [v.wrappedValue for v in (reference.EnumerationValues or [])]
        if value is not None and allowed and value not in allowed:
            raise OpError(f"{prop.Name} must be one of: {', '.join(str(a) for a in allowed)}")
        ifc_type = (prop.EnumerationValues[0].is_a() if prop.EnumerationValues else "IfcLabel")
        values = [] if value is None else [_wrap(model, ifc_type, value)]
        ifcopenshell.api.run("attribute.edit_attributes", model, product=prop, attributes={"EnumerationValues": values})
    elif prop.is_a("IfcPhysicalSimpleQuantity"):
        attr = _QUANTITY_VALUE.get(prop.is_a())
        if attr is None:
            raise OpError(f"{prop.Name} cannot be edited here")
        ifcopenshell.api.run(
            "attribute.edit_attributes", model, product=prop, attributes={attr: _coerce("IfcReal", value)}
        )
    else:
        raise OpError(f"{prop.Name} ({prop.is_a()}) cannot be edited here")


def _find_property(pset, name):
    members = list(getattr(pset, "HasProperties", None) or getattr(pset, "Quantities", None) or [])
    return next((p for p in members if p.Name == name), None)


def set_property(model, op):
    entity = _by_global_id_or_id(model, op)
    pset_name = op.get("pset")
    prop = op.get("name")
    if not isinstance(prop, str) or not prop:
        raise OpError('"name" is required')
    pset_id = op.get("psetId")
    if pset_id is None and not isinstance(pset_name, str):
        raise OpError('"pset" or "psetId" is required')
    value = op.get("value")
    own = _owned_pset(model, entity, pset_name, pset_id)
    if own is None:
        name = pset_name or model.by_id(pset_id).Name
        is_qto = op.get("kind") == "qto" or (isinstance(name, str) and name.startswith("Qto_"))
        adder = "pset.add_qto" if is_qto else "pset.add_pset"
        own = ifcopenshell.api.run(adder, model, product=entity, name=name)
    existing = _find_property(own, prop)
    if existing is not None:
        _set_existing_property(model, existing, value)
        return
    if own.is_a("IfcElementQuantity"):
        ifcopenshell.api.run("pset.edit_qto", model, qto=own, properties={prop: _coerce("IfcReal", value)})
        return
    created = model.create_entity("IfcPropertySingleValue", Name=prop, NominalValue=_wrap(model, _new_type(op, value), value))
    ifcopenshell.api.run(
        "attribute.edit_attributes", model, product=own, attributes={"HasProperties": [*(own.HasProperties or []), created]}
    )


def add_pset(model, op):
    entity = _by_global_id_or_id(model, op)
    name = op.get("pset")
    if not isinstance(name, str) or not name.strip():
        raise OpError('"pset" is required')
    if _owned_pset(model, entity, name, None) is not None:
        raise OpError(f"{name} already exists on this element")
    is_qto = op.get("kind") == "qto" or name.startswith("Qto_")
    ifcopenshell.api.run("pset.add_qto" if is_qto else "pset.add_pset", model, product=entity, name=name)


def remove_property(model, op):
    entity = _by_global_id_or_id(model, op)
    name = op.get("name")
    if not isinstance(name, str) or not name:
        raise OpError('"name" is required')
    own = _owned_pset(model, entity, op.get("pset"), op.get("psetId"))
    if own is None:
        raise OpError("that property set belongs to the element's type; change it on the type instead")
    if _find_property(own, name) is None:
        raise OpError(f"{own.Name} has no property {name}")
    editor, arg = ("pset.edit_qto", "qto") if own.is_a("IfcElementQuantity") else ("pset.edit_pset", "pset")
    ifcopenshell.api.run(editor, model, **{arg: own, "properties": {name: None}})


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
    "addPset": add_pset,
    "removeProperty": remove_property,
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
