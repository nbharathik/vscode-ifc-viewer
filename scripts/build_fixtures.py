#!/usr/bin/env python
"""Deterministic IFC fixture generator for vscode-ifc-viewer.

Generates (dev/CI-time only; the resulting .ifc files are committed):

  small.ifc  2 storeys, ~15 elements: walls, a window + its opening, slabs,
             a space, psets/qtos and a material. The canonical happy-path model.
  house.ifc  a pitched-roof house with colored materials, door, windows and a
             chimney. The model used for README screenshots.
  edge.ifc   unicode element names, an element with NO ObjectPlacement, and a
             property set carrying a null-valued property. Exercises the
             adapter's missing/edge handling.
  big.ifc    >= 50k entities, written gzipped (big.ifc.gz), produced via `--big`;
             skipped otherwise.

Determinism: GlobalIds come from a counter (not random uuids), OwnerHistory and
the STEP header use fixed timestamps, and entities are created in a fixed order.
Re-running produces byte-identical output. Geometry is hand-built from
IfcExtrudedAreaSolid so web-ifc always has a tessellable Body representation.

Usage:
  python scripts/build_fixtures.py            # small.ifc + edge.ifc
  python scripts/build_fixtures.py --big      # also big.ifc.gz
"""
from __future__ import annotations

import argparse
import gzip
import itertools
import os
import sys

import ifcopenshell
import ifcopenshell.guid

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.normpath(os.path.join(HERE, "..", "fixtures"))

FIXED_TIMESTAMP = 0  # epoch; keeps OwnerHistory deterministic
HEADER_TIME = "2024-01-01T00:00:00"


class Builder:
    """Small helper around ifcopenshell.file for deterministic IFC4 authoring."""

    def __init__(self, schema: str = "IFC4") -> None:
        self.model = ifcopenshell.file(schema=schema)
        self._guid_counter = itertools.count(1)
        self.owner = self._make_owner_history()
        self.origin = self.point((0.0, 0.0, 0.0))
        self.dir_z = self.model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
        self.dir_x = self.model.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
        self.world_axes = self.axis2placement3d((0.0, 0.0, 0.0))
        self._setup_units_and_contexts()

    # -- primitives ---------------------------------------------------------
    def guid(self) -> str:
        return ifcopenshell.guid.compress("%032x" % next(self._guid_counter))

    def point(self, xyz):
        return self.model.create_entity("IfcCartesianPoint", Coordinates=tuple(float(c) for c in xyz))

    def axis2placement3d(self, location, axis=None, ref_direction=None):
        m = self.model
        return m.create_entity(
            "IfcAxis2Placement3D",
            Location=self.point(location),
            Axis=m.create_entity("IfcDirection", DirectionRatios=tuple(axis)) if axis else None,
            RefDirection=(
                m.create_entity("IfcDirection", DirectionRatios=tuple(ref_direction))
                if ref_direction
                else None
            ),
        )

    def local_placement(self, location, rel_to=None, axis=None, ref_direction=None):
        return self.model.create_entity(
            "IfcLocalPlacement",
            PlacementRelTo=rel_to,
            RelativePlacement=self.axis2placement3d(location, axis, ref_direction),
        )

    def style_shape(self, shape, rgb, transparency=0.0, name=None):
        """Attach a surface color (and optional transparency) to a box_shape."""
        m = self.model
        item = shape.Representations[0].Items[0]
        colour = m.create_entity(
            "IfcColourRgb", Name=None, Red=float(rgb[0]), Green=float(rgb[1]), Blue=float(rgb[2])
        )
        shading = m.create_entity(
            "IfcSurfaceStyleShading", SurfaceColour=colour, Transparency=float(transparency)
        )
        style = m.create_entity("IfcSurfaceStyle", Name=name, Side="BOTH", Styles=[shading])
        m.create_entity("IfcStyledItem", Item=item, Styles=[style], Name=None)

    def _make_owner_history(self):
        person = self.model.create_entity("IfcPerson", Identification="fixture", FamilyName="Generator")
        org = self.model.create_entity("IfcOrganization", Name="vscode-ifc-viewer")
        p_and_o = self.model.create_entity(
            "IfcPersonAndOrganization", ThePerson=person, TheOrganization=org
        )
        app = self.model.create_entity(
            "IfcApplication",
            ApplicationDeveloper=org,
            Version="0.1.0",
            ApplicationFullName="build_fixtures",
            ApplicationIdentifier="build_fixtures",
        )
        return self.model.create_entity(
            "IfcOwnerHistory",
            OwningUser=p_and_o,
            OwningApplication=app,
            ChangeAction="ADDED",
            CreationDate=FIXED_TIMESTAMP,
        )

    def _setup_units_and_contexts(self) -> None:
        m = self.model
        units = [
            m.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
            m.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
            m.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
            m.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN"),
        ]
        self.unit_assignment = m.create_entity("IfcUnitAssignment", Units=units)
        self.model_context = m.create_entity(
            "IfcGeometricRepresentationContext",
            ContextType="Model",
            CoordinateSpaceDimension=3,
            Precision=1e-5,
            WorldCoordinateSystem=self.world_axes,
            TrueNorth=None,
        )
        self.body_context = m.create_entity(
            "IfcGeometricRepresentationSubContext",
            ContextIdentifier="Body",
            ContextType="Model",
            ParentContext=self.model_context,
            TargetView="MODEL_VIEW",
        )

    # -- geometry -----------------------------------------------------------
    def box_shape(self, xdim: float, ydim: float, depth: float):
        """A ProductDefinitionShape with a single extruded rectangular Body."""
        m = self.model
        profile = m.create_entity(
            "IfcRectangleProfileDef",
            ProfileType="AREA",
            ProfileName=None,
            Position=m.create_entity(
                "IfcAxis2Placement2D",
                Location=m.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0)),
                RefDirection=None,
            ),
            XDim=float(xdim),
            YDim=float(ydim),
        )
        solid = m.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=profile,
            Position=self.axis2placement3d((0.0, 0.0, 0.0)),
            ExtrudedDirection=self.dir_z,
            Depth=float(depth),
        )
        shape_rep = m.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=self.body_context,
            RepresentationIdentifier="Body",
            RepresentationType="SweptSolid",
            Items=[solid],
        )
        return m.create_entity("IfcProductDefinitionShape", Representations=[shape_rep])

    # -- spatial / relations ------------------------------------------------
    def spatial(self, ifc_class: str, name, placement=None, **kwargs):
        return self.model.create_entity(
            ifc_class,
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            Name=name,
            ObjectPlacement=placement,
            **kwargs,
        )

    def element(self, ifc_class: str, name, placement, shape, **kwargs):
        return self.model.create_entity(
            ifc_class,
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            Name=name,
            ObjectPlacement=placement,
            Representation=shape,
            **kwargs,
        )

    def aggregate(self, parent, children) -> None:
        self.model.create_entity(
            "IfcRelAggregates",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatingObject=parent,
            RelatedObjects=list(children),
        )

    def contain(self, structure, elements) -> None:
        self.model.create_entity(
            "IfcRelContainedInSpatialStructure",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatingStructure=structure,
            RelatedElements=list(elements),
        )

    def add_pset(self, product, name: str, props: dict) -> None:
        m = self.model
        single_values = []
        for key, val in props.items():
            nominal = None
            if isinstance(val, bool):
                nominal = m.create_entity("IfcBoolean", wrappedValue=val)
            elif isinstance(val, (int, float)):
                nominal = m.create_entity("IfcReal", wrappedValue=float(val))
            elif isinstance(val, str):
                nominal = m.create_entity("IfcLabel", wrappedValue=val)
            # val is None -> property with no NominalValue (the "empty"/null case)
            single_values.append(
                m.create_entity(
                    "IfcPropertySingleValue", Name=key, NominalValue=nominal, Unit=None
                )
            )
        pset = m.create_entity(
            "IfcPropertySet",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            Name=name,
            HasProperties=single_values,
        )
        m.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatedObjects=[product],
            RelatingPropertyDefinition=pset,
        )

    def add_qto(self, product, name: str, quantities: dict) -> None:
        m = self.model
        qlist = []
        for key, val in quantities.items():
            qlist.append(
                m.create_entity("IfcQuantityVolume", Name=key, VolumeValue=float(val))
            )
        qto = m.create_entity(
            "IfcElementQuantity",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            Name=name,
            Quantities=qlist,
        )
        m.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatedObjects=[product],
            RelatingPropertyDefinition=qto,
        )

    def assign_material(self, products, material_name: str) -> None:
        m = self.model
        material = m.create_entity("IfcMaterial", Name=material_name)
        m.create_entity(
            "IfcRelAssociatesMaterial",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatedObjects=list(products),
            RelatingMaterial=material,
        )

    def void_and_fill(self, wall, opening, window) -> None:
        m = self.model
        m.create_entity(
            "IfcRelVoidsElement",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatingBuildingElement=wall,
            RelatedOpeningElement=opening,
        )
        m.create_entity(
            "IfcRelFillsElement",
            GlobalId=self.guid(),
            OwnerHistory=self.owner,
            RelatingOpeningElement=opening,
            RelatedBuildingElement=window,
        )

    # -- output -------------------------------------------------------------
    def finalize_header(self, filename: str) -> None:
        h = self.model.header
        h.file_description.description = ("ViewDefinition [CoordinationView]",)
        h.file_description.implementation_level = "2;1"
        h.file_name.name = filename
        h.file_name.time_stamp = HEADER_TIME
        h.file_name.author = ("vscode-ifc-viewer",)
        h.file_name.organization = ("vscode-ifc-viewer",)
        h.file_name.preprocessor_version = "build_fixtures"
        h.file_name.originating_system = "build_fixtures"
        h.file_name.authorization = "none"


def write_ifc(model, path: str) -> None:
    """Write STEP text with LF line endings on every platform (determinism)."""
    text = model.to_string().replace("\r\n", "\n").replace("\r", "\n")
    with open(path, "wb") as fh:
        fh.write(text.encode("utf-8"))


def build_project(b: Builder, project_name: str):
    """Project -> Site -> Building -> 2 Storeys, returns the two storeys."""
    # IfcProject is an IfcContext, not an IfcProduct: no ObjectPlacement.
    project = b.model.create_entity(
        "IfcProject",
        GlobalId=b.guid(),
        OwnerHistory=b.owner,
        Name=project_name,
        RepresentationContexts=[b.model_context],
        UnitsInContext=b.unit_assignment,
    )
    site = b.spatial("IfcSite", "Site", placement=b.local_placement((0.0, 0.0, 0.0)))
    building = b.spatial("IfcBuilding", "Building", placement=b.local_placement((0.0, 0.0, 0.0), site.ObjectPlacement))
    storey0 = b.spatial(
        "IfcBuildingStorey", "Ground Floor",
        placement=b.local_placement((0.0, 0.0, 0.0), building.ObjectPlacement), Elevation=0.0,
    )
    storey1 = b.spatial(
        "IfcBuildingStorey", "Level 1",
        placement=b.local_placement((0.0, 0.0, 3.0), building.ObjectPlacement), Elevation=3.0,
    )
    b.aggregate(project, [site])
    b.aggregate(site, [building])
    b.aggregate(building, [storey0, storey1])
    return storey0, storey1


def four_walls(b: Builder, storey, prefix: str, count: int = 4):
    """Up to four walls forming a 5m x 4m room on the given storey placement."""
    sp = storey.ObjectPlacement
    walls = []
    layout = [
        ("South", (0.0, 0.0, 0.0), 5.0, 0.2),
        ("North", (0.0, 4.0, 0.0), 5.0, 0.2),
        ("West", (0.0, 0.0, 0.0), 0.2, 4.0),
        ("East", (5.0, 0.0, 0.0), 0.2, 4.0),
    ]
    for name, loc, xdim, ydim in layout[:count]:
        wall = b.element(
            "IfcWall", f"{prefix} Wall {name}",
            b.local_placement(loc, sp), b.box_shape(xdim, ydim, 3.0),
        )
        walls.append(wall)
    return walls


def build_small(path: str) -> None:
    b = Builder()
    storey0, storey1 = build_project(b, "Small Sample Project")

    g_walls = four_walls(b, storey0, "GF")
    g_slab = b.element(
        "IfcSlab", "GF Slab",
        b.local_placement((0.0, 0.0, -0.2), storey0.ObjectPlacement), b.box_shape(5.0, 4.0, 0.2),
    )
    g_space = b.element(
        "IfcSpace", "GF Room",
        b.local_placement((0.2, 0.2, 0.0), storey0.ObjectPlacement), b.box_shape(4.6, 3.6, 2.8),
        CompositionType="ELEMENT",
    )

    # Window + its opening, voiding the south wall on the ground floor.
    opening = b.element(
        "IfcOpeningElement", "Window Opening",
        b.local_placement((1.5, 0.0, 1.0), storey0.ObjectPlacement), b.box_shape(1.2, 0.2, 1.2),
    )
    window = b.element(
        "IfcWindow", "South Window",
        b.local_placement((1.5, 0.0, 1.0), storey0.ObjectPlacement), b.box_shape(1.2, 0.05, 1.2),
        OverallHeight=1.2, OverallWidth=1.2,
    )
    b.void_and_fill(g_walls[0], opening, window)

    l1_walls = four_walls(b, storey1, "L1", count=2)
    l1_slab = b.element(
        "IfcSlab", "L1 Slab",
        b.local_placement((0.0, 0.0, -0.2), storey1.ObjectPlacement), b.box_shape(5.0, 4.0, 0.2),
    )

    b.aggregate(storey0, [g_space])
    b.contain(storey0, g_walls + [g_slab, window])
    b.contain(storey1, l1_walls + [l1_slab])

    # Psets / qtos / material on the canonical south wall.
    south = g_walls[0]
    b.add_pset(south, "Pset_WallCommon", {
        "Reference": "WAL-01",
        "IsExternal": True,
        "LoadBearing": False,
        "FireRating": "REI60",
        "ThermalTransmittance": 0.24,
    })
    b.add_qto(south, "Qto_WallBaseQuantities", {"NetVolume": 3.0})
    b.assign_material(g_walls + l1_walls, "Concrete")
    b.add_pset(g_slab, "Pset_SlabCommon", {"IsExternal": False, "LoadBearing": True})

    b.finalize_header(os.path.basename(path))
    write_ifc(b.model, path)


HOUSE_COLORS = {
    "slab": (0.60, 0.58, 0.55),
    "wall": (0.87, 0.82, 0.72),
    "roof": (0.63, 0.32, 0.24),
    "door": (0.42, 0.28, 0.16),
    "window": (0.55, 0.74, 0.88),
    "chimney": (0.47, 0.43, 0.41),
}


def build_house(path: str) -> None:
    """A small pitched-roof house with colored materials: the README model."""
    b = Builder()
    project = b.model.create_entity(
        "IfcProject",
        GlobalId=b.guid(),
        OwnerHistory=b.owner,
        Name="Basic House",
        RepresentationContexts=[b.model_context],
        UnitsInContext=b.unit_assignment,
    )
    site = b.spatial("IfcSite", "Site", placement=b.local_placement((0.0, 0.0, 0.0)))
    building = b.spatial(
        "IfcBuilding", "House", placement=b.local_placement((0.0, 0.0, 0.0), site.ObjectPlacement)
    )
    ground = b.spatial(
        "IfcBuildingStorey", "Ground Floor",
        placement=b.local_placement((0.0, 0.0, 0.0), building.ObjectPlacement), Elevation=0.0,
    )
    roof_level = b.spatial(
        "IfcBuildingStorey", "Roof",
        placement=b.local_placement((0.0, 0.0, 3.0), building.ObjectPlacement), Elevation=3.0,
    )
    b.aggregate(project, [site])
    b.aggregate(site, [building])
    b.aggregate(building, [ground, roof_level])
    gp = ground.ObjectPlacement
    rp = roof_level.ObjectPlacement

    def boxed(ifc_class, name, center, size, color, transparency=0.0, rel=gp, axis=None, ref=None, **kw):
        shape = b.box_shape(size[0], size[1], size[2])
        b.style_shape(shape, HOUSE_COLORS[color], transparency, name=color)
        return b.element(
            ifc_class, name,
            b.local_placement(center, rel, axis=axis, ref_direction=ref), shape, **kw,
        )

    slab = boxed("IfcSlab", "Floor Slab", (4.0, 3.0, -0.3), (8.6, 6.6, 0.3), "slab", PredefinedType="FLOOR")

    walls = [
        boxed("IfcWall", "Front Wall", (4.0, 0.15, 0.0), (8.0, 0.3, 3.0), "wall"),
        boxed("IfcWall", "Back Wall", (4.0, 5.85, 0.0), (8.0, 0.3, 3.0), "wall"),
        boxed("IfcWall", "West Wall", (0.15, 3.0, 0.0), (0.3, 5.4, 3.0), "wall"),
        boxed("IfcWall", "East Wall", (7.85, 3.0, 0.0), (0.3, 5.4, 3.0), "wall"),
    ]
    front, back, west, east = walls

    def opening(name, center, size):
        return b.element(
            "IfcOpeningElement", name, b.local_placement(center, gp), b.box_shape(*size)
        )

    door_opening = opening("Door Opening", (4.0, 0.15, 0.0), (1.0, 0.5, 2.15))
    door = boxed("IfcDoor", "Front Door", (4.0, 0.15, 0.0), (1.0, 0.12, 2.15), "door",
                 OverallHeight=2.15, OverallWidth=1.0)
    b.void_and_fill(front, door_opening, door)

    windows = []
    window_layout = [
        ("Front Window West", front, (1.9, 0.15, 0.9), (1.5, 0.5, 1.2), (1.5, 0.1, 1.2)),
        ("Front Window East", front, (6.1, 0.15, 0.9), (1.5, 0.5, 1.2), (1.5, 0.1, 1.2)),
        ("Back Window West", back, (2.2, 5.85, 0.9), (1.5, 0.5, 1.2), (1.5, 0.1, 1.2)),
        ("Back Window East", back, (5.8, 5.85, 0.9), (1.5, 0.5, 1.2), (1.5, 0.1, 1.2)),
        ("West Window", west, (0.15, 3.0, 0.9), (0.5, 1.5, 1.2), (0.1, 1.5, 1.2)),
    ]
    for name, wall, center, hole, glass in window_layout:
        hole_el = opening(f"{name} Opening", center, hole)
        win = boxed("IfcWindow", name, center, glass, "window", transparency=0.5,
                    OverallHeight=glass[2], OverallWidth=max(glass[0], glass[1]))
        b.void_and_fill(wall, hole_el, win)
        windows.append(win)

    # Pitched roof: two slabs rotated about X (slope 1:2, eaves at z=3.0).
    s, c = 1.0 / 5.0 ** 0.5, 2.0 / 5.0 ** 0.5
    slope_len = (3.4 ** 2 + 1.7 ** 2) ** 0.5
    roof_south = boxed(
        "IfcSlab", "Roof South", (4.0, 1.3, 0.85), (9.0, slope_len, 0.12), "roof",
        rel=rp, axis=(0.0, -s, c), ref=(1.0, 0.0, 0.0), PredefinedType="ROOF",
    )
    roof_north = boxed(
        "IfcSlab", "Roof North", (4.0, 4.7, 0.85), (9.0, slope_len, 0.12), "roof",
        rel=rp, axis=(0.0, s, c), ref=(1.0, 0.0, 0.0), PredefinedType="ROOF",
    )
    chimney = boxed(
        "IfcBuildingElementProxy", "Chimney", (6.0, 4.2, 0.4), (0.6, 0.6, 1.8), "chimney", rel=rp
    )

    space = b.element(
        "IfcSpace", "Living Room",
        b.local_placement((4.0, 3.0, 0.0), gp), b.box_shape(7.4, 5.4, 3.0),
        CompositionType="ELEMENT",
    )

    b.aggregate(ground, [space])
    b.contain(ground, walls + [slab, door] + windows)
    b.contain(roof_level, [roof_south, roof_north, chimney])

    for wall_el, name in zip(walls, ("Front", "Back", "West", "East")):
        b.add_pset(wall_el, "Pset_WallCommon", {
            "IsExternal": True, "LoadBearing": True, "FireRating": "REI30", "Reference": f"WAL-{name}",
        })
        b.add_qto(wall_el, "Qto_WallBaseQuantities", {"Height": 3.0, "Width": 0.3})
    b.add_pset(door, "Pset_DoorCommon", {"IsExternal": True, "FireRating": "EI30"})
    for win in windows:
        b.add_pset(win, "Pset_WindowCommon", {"IsExternal": True, "SecurityRating": "Standard"})
    b.add_qto(slab, "Qto_SlabBaseQuantities", {"Width": 8.6, "Length": 6.6, "Depth": 0.3})
    b.assign_material(walls, "Brick")
    b.assign_material([slab], "Concrete")
    b.assign_material([roof_south, roof_north], "Clay Tile")
    b.assign_material([door], "Timber")
    b.assign_material(windows, "Glass")

    b.finalize_header("house.ifc")
    write_ifc(b.model, path)


def build_edge(path: str) -> None:
    b = Builder()
    storey0, _ = build_project(b, "Edge Café — Ünïcödé 测试 Project")

    # Element with a normal placement and a unicode name.
    wall = b.element(
        "IfcWall", "Wänd_üü_Façade_测试_🧱",
        b.local_placement((0.0, 0.0, 0.0), storey0.ObjectPlacement), b.box_shape(3.0, 0.2, 3.0),
    )
    # Element with NO ObjectPlacement (missing-placement case). It still carries
    # geometry, so web-ifc must place it at the world origin without crashing.
    floating = b.element(
        "IfcSlab", "Floating Slab (no placement)",
        None, b.box_shape(2.0, 2.0, 0.2),
    )
    b.contain(storey0, [wall, floating])

    # An "empty" pset: a single property whose NominalValue is null.
    b.add_pset(wall, "Pset_EmptyValues", {"Note": None})
    # A normal pset alongside, to prove mixed null/non-null rendering.
    b.add_pset(wall, "Pset_WallCommon", {"IsExternal": True})

    b.finalize_header(os.path.basename(path))
    write_ifc(b.model, path)


def build_big(path_gz: str, columns: int = 6000) -> None:
    """Grid of boxes far from the origin. ~12 entities/column => >= 50k entities.

    The far-from-origin coordinates (100000+) exercise the viewer's local-origin
    translation."""
    b = Builder()
    storey0, storey1 = build_project(b, "Big Performance Project")
    storeys = [storey0, storey1]
    material_added = False
    batch = []
    for i in range(columns):
        storey = storeys[i % 2]
        gx = (i % 60) * 1.5 + 100000.0  # far-from-origin coordinates
        gy = (i // 60) * 1.5 + 100000.0
        col = b.element(
            "IfcColumn", f"Col {i}",
            b.local_placement((gx, gy, 0.0), storey.ObjectPlacement), b.box_shape(0.3, 0.3, 3.0),
        )
        batch.append(col)
        if len(batch) >= 500:
            b.contain(storey, batch)
            if not material_added:
                b.assign_material(batch[:1], "Steel")
                material_added = True
            batch = []
    if batch:
        b.contain(storey0, batch)

    total = sum(1 for _ in b.model)
    print(f"big.ifc entities: {total}")
    b.finalize_header("big.ifc")
    text = b.model.to_string().replace("\r\n", "\n").replace("\r", "\n")
    # Deterministic gzip: fixed mtime, no embedded filename.
    with open(path_gz, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz:
            gz.write(text.encode("utf-8"))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Generate IFC fixtures.")
    parser.add_argument("--big", action="store_true", help="also generate big.ifc.gz")
    parser.add_argument("--only-big", action="store_true", help="generate only big.ifc.gz")
    args = parser.parse_args(argv)

    os.makedirs(FIXTURES_DIR, exist_ok=True)

    if not args.only_big:
        small = os.path.join(FIXTURES_DIR, "small.ifc")
        edge = os.path.join(FIXTURES_DIR, "edge.ifc")
        house = os.path.join(FIXTURES_DIR, "house.ifc")
        build_small(small)
        build_edge(edge)
        build_house(house)
        print(f"wrote {small} ({os.path.getsize(small)} bytes)")
        print(f"wrote {edge} ({os.path.getsize(edge)} bytes)")
        print(f"wrote {house} ({os.path.getsize(house)} bytes)")

    if args.big or args.only_big:
        big = os.path.join(FIXTURES_DIR, "big.ifc.gz")
        build_big(big)
        print(f"wrote {big} ({os.path.getsize(big)} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
