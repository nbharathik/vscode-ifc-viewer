"""Read side: spatial tree, properties and GlobalId lookups, shaped like the viewer's types."""
import ifcopenshell
import ifcopenshell.util.element as element_util


def _scalar(value):
    """(value, unit) for a displayable attribute value, or (None, False) when it is a reference."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value, True
    if isinstance(value, ifcopenshell.entity_instance) and hasattr(value, "wrappedValue"):
        return value.wrappedValue, True
    return None, False


def _unit_of(value):
    if isinstance(value, ifcopenshell.entity_instance) and hasattr(value, "wrappedValue"):
        return value.is_a()
    return None


def _json_value(value):
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    return value


def is_product_or_project(entity):
    return entity.is_a("IfcProduct") or entity.is_a("IfcProject")


def global_id_of(entity):
    try:
        gid = entity.GlobalId
    except AttributeError:
        return None
    return gid or None


def name_of(entity):
    try:
        return entity.Name
    except AttributeError:
        return None


def build_tree(model):
    projects = model.by_type("IfcProject")
    if not projects:
        raise ValueError("No IfcProject found in model")
    visited = set()

    def build(obj):
        visited.add(obj.id())
        children_entities = []
        for rel in getattr(obj, "IsDecomposedBy", None) or []:
            children_entities.extend(rel.RelatedObjects or [])
        for rel in getattr(obj, "ContainsElements", None) or []:
            children_entities.extend(rel.RelatedElements or [])
        children = []
        for child in children_entities:
            if child.id() in visited:
                continue
            children.append(build(child))
        return {
            "expressID": obj.id(),
            "type": obj.is_a(),
            "name": name_of(obj),
            "globalId": global_id_of(obj),
            "children": children,
        }

    return build(projects[0])


def _attributes(entity):
    rows = []
    for i in range(len(entity)):
        raw = entity[i]
        value, ok = _scalar(raw)
        if not ok:
            continue
        rows.append(
            {"name": entity.attribute_name(i), "value": _json_value(value), "unit": _unit_of(raw)}
        )
    return rows


def _quantity_row(quantity):
    value = None
    unit = None
    for attr in ("LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"):
        if hasattr(quantity, attr) and getattr(quantity, attr) is not None:
            value = getattr(quantity, attr)
            unit = attr[: -len("Value")]
            break
    return {"name": quantity.Name, "value": _json_value(value), "unit": unit}


def _property_row(prop):
    name = prop.Name
    if prop.is_a("IfcPropertySingleValue"):
        nominal = prop.NominalValue
        value = _json_value(nominal.wrappedValue) if nominal is not None else None
        return {"name": name, "value": value, "unit": _unit_of(nominal)}
    if prop.is_a("IfcPropertyEnumeratedValue"):
        values = [v.wrappedValue for v in (prop.EnumerationValues or [])]
        return {"name": name, "value": ", ".join(str(v) for v in values) if values else None, "unit": None}
    if prop.is_a("IfcPropertyListValue"):
        values = [v.wrappedValue for v in (prop.ListValues or [])]
        return {"name": name, "value": ", ".join(str(v) for v in values) if values else None, "unit": None}
    if prop.is_a("IfcPropertyBoundedValue"):
        parts = []
        for label in ("LowerBoundValue", "UpperBoundValue"):
            bound = getattr(prop, label, None)
            parts.append("" if bound is None else str(bound.wrappedValue))
        return {"name": name, "value": " .. ".join(parts), "unit": None}
    if prop.is_a("IfcComplexProperty"):
        return {"name": name, "value": f"{len(prop.HasProperties or [])} properties", "unit": None}
    return {"name": name, "value": None, "unit": None}


def _pset_entry(model, pset_id):
    pset = model.by_id(pset_id)
    name = getattr(pset, "Name", None) or "Unnamed"
    if pset.is_a("IfcElementQuantity"):
        rows = [_quantity_row(q) for q in (pset.Quantities or []) if q.Name]
        return {"expressID": pset_id, "name": name, "kind": "qto", "properties": rows}
    if hasattr(pset, "HasProperties"):
        rows = [_property_row(p) for p in (pset.HasProperties or []) if p.Name]
        return {"expressID": pset_id, "name": name, "kind": "pset", "properties": rows}
    return None


def item_properties(model, express_id):
    entity = model.by_id(express_id)
    psets = []
    if entity.is_a("IfcObjectDefinition"):
        for name, data in element_util.get_psets(entity).items():
            pset_id = data.get("id") if isinstance(data, dict) else None
            if pset_id is None:
                continue
            entry = _pset_entry(model, pset_id)
            if entry:
                psets.append(entry)
    return {
        "expressID": express_id,
        "type": entity.is_a(),
        "attributes": _attributes(entity),
        "psets": psets,
    }


def resolve_global_ids(model, global_ids):
    found = []
    missing = []
    seen = set()
    for gid in global_ids:
        if gid in seen:
            continue
        seen.add(gid)
        try:
            entity = model.by_guid(gid)
        except RuntimeError:
            missing.append(gid)
            continue
        if not is_product_or_project(entity):
            missing.append(gid)
            continue
        found.append({"globalId": gid, "expressID": entity.id(), "ifcClass": entity.is_a()})
    return {"found": found, "missing": missing}


def global_id_for(model, express_id):
    try:
        entity = model.by_id(express_id)
    except RuntimeError:
        return None
    return global_id_of(entity) if is_product_or_project(entity) else None
