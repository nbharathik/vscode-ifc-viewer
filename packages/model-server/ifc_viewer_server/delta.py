"""Resolve a transaction's operations to the products they touched.

Property edits, the common case, never ask for geometry. Placement and
representation edits do. Everything is keyed by STEP id and GlobalId.
"""
import ifcopenshell
import ifcopenshell.util.element as element_util

# Shared bookkeeping entities that nearly everything references; walking
# through them would mark the whole model as changed.
SKIP_TYPES = (
    "IfcOwnerHistory",
    "IfcPersonAndOrganization",
    "IfcPerson",
    "IfcOrganization",
    "IfcApplication",
    "IfcActorRole",
    "IfcTelecomAddress",
    "IfcPostalAddress",
    "IfcProject",
    "IfcUnitAssignment",
    "IfcGeometricRepresentationContext",
    "IfcGeometricRepresentationSubContext",
)
MAX_VISITED = 20000
MAX_DEPTH = 10

_subtype_cache = {}


def _is_subtype(schema, type_name, ancestor):
    key = (schema, type_name, ancestor)
    cached = _subtype_cache.get(key)
    if cached is not None:
        return cached
    result = False
    try:
        decl = ifcopenshell.schema_by_name(schema).declaration_by_name(type_name)
        while decl is not None:
            if decl.name() == ancestor:
                result = True
                break
            decl = decl.supertype()
    except Exception:
        result = False
    _subtype_cache[key] = result
    return result


class Change:
    __slots__ = ("id", "properties", "placement", "representation", "relationships", "created")

    def __init__(self, entity_id):
        self.id = entity_id
        self.properties = False
        # Moving an element (placement) and reshaping it (representation) are
        # told apart: a move can reuse the shape it already had.
        self.placement = False
        self.representation = False
        self.relationships = False
        self.created = False

    @property
    def geometry(self):
        return self.placement or self.representation

    @property
    def placement_only(self):
        return self.placement and not self.representation and not self.created


def _exists(model, entity_id):
    try:
        return model.by_id(entity_id)
    except RuntimeError:
        return None


def _entity_refs(entity):
    """Entities referenced directly by an entity's attributes (flattened)."""
    for i in range(len(entity)):
        value = entity[i]
        if isinstance(value, ifcopenshell.entity_instance):
            if not hasattr(value, "wrappedValue"):
                yield entity.attribute_name(i), value
        elif isinstance(value, tuple):
            for item in value:
                if isinstance(item, ifcopenshell.entity_instance) and not hasattr(item, "wrappedValue"):
                    yield entity.attribute_name(i), item


class Resolver:
    def __init__(self, model):
        self.model = model
        self.schema = model.schema
        self.changes = {}
        self.removed = set()
        self.tree_dirty = False

    def _mark(
        self, entity, *, properties=False, placement=False, representation=False, relationships=False, created=False
    ):
        change = self.changes.get(entity.id())
        if change is None:
            change = self.changes[entity.id()] = Change(entity.id())
        change.properties = change.properties or properties
        change.placement = change.placement or placement
        change.representation = change.representation or representation
        change.relationships = change.relationships or relationships
        change.created = change.created or created

    def _mark_products(self, entities, **kinds):
        for entity in entities:
            if entity.is_a("IfcTypeObject"):
                for occurrence in element_util.get_types(entity) or []:
                    self._mark(occurrence, **kinds)
                self._mark(entity, **kinds)
            elif entity.is_a("IfcProduct") or entity.is_a("IfcProject"):
                self._mark(entity, **kinds)

    def _from_relationship(self, rel, via):
        """Products on the other side of a relationship that changed."""
        if rel.is_a("IfcRelVoidsElement"):
            self._mark_products([rel.RelatingBuildingElement], representation=True)
            return
        if rel.is_a("IfcRelFillsElement"):
            self._mark_products([rel.RelatedBuildingElement], representation=True)
            return
        if rel.is_a("IfcRelAggregates") or rel.is_a("IfcRelContainedInSpatialStructure") or rel.is_a("IfcRelNests"):
            self.tree_dirty = True
            members = []
            for _name, ref in _entity_refs(rel):
                members.append(ref)
            self._mark_products(members, relationships=True)
            return
        members = [ref for _name, ref in _entity_refs(rel) if ref.id() != via.id()]
        self._mark_products(members, properties=True)

    def touch(self, entity, channel):
        """Mark what an edit of `entity` means for the products above it."""
        if entity.is_a("IfcProduct") or entity.is_a("IfcProject"):
            self._mark(entity, **{channel: True})
            return
        seen = {entity.id()}
        frontier = [(entity, channel, 0)]
        while frontier and len(seen) < MAX_VISITED:
            current, chan, depth = frontier.pop()
            if depth > MAX_DEPTH:
                continue
            if current.is_a("IfcRelationship"):
                self._from_relationship(current, current)
                continue
            for parent in self.model.get_inverse(current):
                if parent.id() in seen or parent.is_a() in SKIP_TYPES:
                    continue
                seen.add(parent.id())
                if parent.is_a("IfcRelationship"):
                    self._from_relationship(parent, current)
                    continue
                if parent.is_a("IfcProduct") or parent.is_a("IfcProject"):
                    attr_names = [name for name, ref in _entity_refs(parent) if ref.id() == current.id()]
                    if "ObjectPlacement" in attr_names:
                        self._mark(parent, placement=True)
                    elif "Representation" in attr_names:
                        self._mark(parent, representation=True)
                    else:
                        self._mark(parent, **{chan: True})
                    continue
                if parent.is_a("IfcTypeObject"):
                    self._mark_products([parent], **{chan: True})
                    continue
                frontier.append((parent, chan, depth + 1))

    def resolve(self, operations):
        for op in operations:
            action = op.get("action")
            if action == "create":
                value = op.get("value") or {}
                entity = _exists(self.model, value.get("id"))
                if entity is None:
                    if _is_subtype(self.schema, value.get("type", ""), "IfcProduct"):
                        self.removed.add(value.get("id"))
                    continue
                if entity.is_a("IfcProduct"):
                    self._mark(
                        entity, properties=True, placement=True, representation=True, relationships=True, created=True
                    )
                    self.tree_dirty = True
                else:
                    self.touch(entity, "properties")
            elif action == "delete":
                value = op.get("value") or {}
                type_name = value.get("type", "")
                if _is_subtype(self.schema, type_name, "IfcProduct"):
                    entity = _exists(self.model, value.get("id"))
                    if entity is None:
                        self.removed.add(value.get("id"))
                    else:
                        # An undo brought the product back with its old id.
                        self._mark(
                            entity,
                            properties=True,
                            placement=True,
                            representation=True,
                            relationships=True,
                            created=True,
                        )
                    self.tree_dirty = True
                elif _is_subtype(self.schema, type_name, "IfcRelationship"):
                    self.tree_dirty = self.tree_dirty or any(
                        _is_subtype(self.schema, type_name, rel)
                        for rel in ("IfcRelAggregates", "IfcRelContainedInSpatialStructure", "IfcRelNests")
                    )
            elif action == "edit":
                entity = _exists(self.model, op.get("id"))
                if entity is None:
                    continue
                attr = ""
                try:
                    attr = entity.attribute_name(op["index"])
                except Exception:
                    pass
                if attr == "ObjectPlacement":
                    self.touch(entity, "placement")
                elif attr == "Representation":
                    self.touch(entity, "representation")
                elif entity.is_a("IfcObjectPlacement") or attr == "PlacementRelTo":
                    self.touch(entity, "placement")
                else:
                    self.touch(entity, "properties")
        # A product that was removed is not also a change.
        for entity_id in list(self.changes):
            if entity_id in self.removed or _exists(self.model, entity_id) is None:
                self.changes.pop(entity_id, None)
        return self


def build_delta(model, operations, txn_number):
    """Return the Delta dict for a transaction's operations."""
    resolver = Resolver(model).resolve(operations)
    changed = []
    for change in resolver.changes.values():
        entity = model.by_id(change.id)
        changed.append(
            {
                "id": change.id,
                "globalId": getattr(entity, "GlobalId", None),
                "ifcClass": entity.is_a(),
                "properties": change.properties,
                "geometry": change.geometry,
                "placementOnly": change.placement_only,
                "relationships": change.relationships,
                "created": change.created,
            }
        )
    changed.sort(key=lambda c: c["id"])
    return {
        "txn": txn_number,
        "changed": changed,
        "removed": sorted(i for i in resolver.removed if i is not None),
        "treeDirty": resolver.tree_dirty,
    }
