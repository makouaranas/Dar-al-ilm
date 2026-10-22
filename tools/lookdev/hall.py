"""Dar al Ilm reading hall, look-development scene (Blender 5.2 as a Python module, Cycles).

Builds the hall procedurally from docs/DESIGN.md (limestone, plaster, ash, walnut, brass,
lapis, mashrabiya), fills the bookcases with physically placed books, lights it with a sky, a
sun and warm practicals, and renders named shots. Text and lattice masks come from the scripts
next to this file (see README.md); they are read from tex/.

    python hall.py --shot entrance,nave --res 1600 --samples 48 [--outdir renders] [--tag _v2]
    python hall.py --check              # collision and support report for every shelf book
    python hall.py --counts counts.json # books per section, for the range plates

Blender axes: x across the hall, y along it (the app's z), z up.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy  # noqa: I001  (bpy must load before bmesh)
import bmesh
from mathutils import Euler, Vector

HERE = Path(__file__).resolve().parent
TEX = HERE / "tex"
rng = random.Random(7)

# --- Layout (metres), close to the app's hall (lib/hallLayout.ts) ---------------------------
HALL_HALF = 6.2          # outer side walls
INNER_HALF = 5.9         # inner face of the side walls
NAVE_HALF = 2.4          # arcade line
LENGTH = 17.1
NAVE_HEIGHT = 6.0
AISLE_HEIGHT = 3.5
PARTITIONS = [7.94, 11.34, 14.74]
BAYS = [  # (side, y_start, y_end, name, plaque texture)
    (-1, 8.06, 11.34, "Programming", "programming"),
    (1, 8.06, 11.34, "Histoire", "histoire"),
    (-1, 11.46, 14.74, "Novels", "novels"),
    (1, 11.46, 14.74, "العربية", "arabic"),
]
DESK = (0.0, 4.6)        # centre
SUN_ELEVATION, SUN_AZIMUTH = 42.0, -25.0  # degrees; azimuth from +x toward +y
COLUMN_YS = [2.65, 5.3, 7.94, 11.34, 14.74]  # arcade columns: entrance zone, then every bay boundary
ENTRANCE_WINDOWS = [2.3, 5.3]  # y centres of the arched side windows in the entrance zone
MEDALLION = (0.0, 3.0)

# --- Scene setup ----------------------------------------------------------------------------


def reset() -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.max_bounces = 10
    scene.cycles.diffuse_bounces = 5
    scene.cycles.glossy_bounces = 4
    scene.cycles.transparent_max_bounces = 16
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.sample_clamp_indirect = 8.0
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.film_transparent = False
    return scene


def link(obj: bpy.types.Object, collection: str = "Hall") -> bpy.types.Object:
    coll = bpy.data.collections.get(collection)
    if coll is None:
        coll = bpy.data.collections.new(collection)
        bpy.context.scene.collection.children.link(coll)
    coll.objects.link(obj)
    return obj


# --- Materials ------------------------------------------------------------------------------


def hex_rgb(value: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    value = value.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (lin[0], lin[1], lin[2], alpha)


class M:
    """Node helpers for one material."""

    def __init__(self, name: str):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nodes = self.nt.nodes
        self.bsdf = self.nodes["Principled BSDF"]
        self.out = self.nodes["Material Output"]

    def node(self, kind: str, **inputs):
        n = self.nodes.new(kind)
        for key, value in inputs.items():
            if key in n.inputs:
                n.inputs[key].default_value = value
            else:
                setattr(n, key, value)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def set(self, **values):
        for key, value in values.items():
            self.bsdf.inputs[key].default_value = value
        return self


def tex_coord(m: M, kind: str = "Object"):
    return m.node("ShaderNodeTexCoord").outputs[kind]


def color_ramp(m: M, stops: list[tuple[float, tuple]]):
    ramp = m.node("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = stops[0]
    els[1].position, els[1].color = stops[-1]
    for pos, col in stops[1:-1]:
        e = els.new(pos)
        e.color = col
    return ramp


def bump(m: M, height_socket, strength=0.15, distance=0.002):
    b = m.node("ShaderNodeBump", Strength=strength, Distance=distance)
    m.link(height_socket, b.inputs["Height"])
    m.link(b.outputs["Normal"], m.bsdf.inputs["Normal"])
    return b


def mat_limestone(name: str, roughness: float, tiles: bool) -> bpy.types.Material:
    m = M(name)
    co = tex_coord(m, "Object")
    big = m.node("ShaderNodeTexNoise", Scale=0.6, Detail=3.0, Roughness=0.5)
    fine = m.node("ShaderNodeTexNoise", Scale=60.0, Detail=6.0, Roughness=0.6)
    m.link(co, big.inputs["Vector"])
    m.link(co, fine.inputs["Vector"])
    ramp = color_ramp(m, [(0.35, hex_rgb("#DDD7CB")), (0.55, hex_rgb("#E7E3DB")), (0.75, hex_rgb("#EEEBE3"))])
    m.link(big.outputs["Fac"], ramp.inputs["Fac"])
    speck = m.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    speck.inputs["Factor"].default_value = 0.08
    m.link(ramp.outputs["Color"], speck.inputs["A"])
    m.link(fine.outputs["Color"], speck.inputs["B"])
    base = speck.outputs["Result"]
    if tiles:
        brick = m.node("ShaderNodeTexBrick", offset=0.5, offset_frequency=2, squash=1.0, squash_frequency=1)
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Mortar Size"].default_value = 0.0018
        brick.inputs["Mortar Smooth"].default_value = 0.3
        brick.inputs["Brick Width"].default_value = 1.2
        brick.inputs["Row Height"].default_value = 0.6
        brick.inputs["Bias"].default_value = 0.0
        brick.inputs["Color1"].default_value = (1, 1, 1, 1)
        brick.inputs["Color2"].default_value = (0.86, 0.85, 0.82, 1)
        brick.inputs["Mortar"].default_value = hex_rgb("#CFC8BA")
        m.link(co, brick.inputs["Vector"])
        tile = m.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
        tile.inputs["Factor"].default_value = 1.0
        m.link(base, tile.inputs["A"])
        m.link(brick.outputs["Color"], tile.inputs["B"])
        base = tile.outputs["Result"]
        bump(m, brick.outputs["Fac"], strength=0.25, distance=0.003)
    else:
        bump(m, fine.outputs["Fac"], strength=0.08)
    m.link(base, m.bsdf.inputs["Base Color"])
    rough = m.node("ShaderNodeMapRange", **{"From Min": 0.0, "From Max": 1.0, "To Min": roughness - 0.08, "To Max": roughness + 0.1})
    m.link(big.outputs["Fac"], rough.inputs["Value"])
    m.link(rough.outputs["Result"], m.bsdf.inputs["Roughness"])
    return m.mat


def mat_plaster() -> bpy.types.Material:
    m = M("Plaster")
    co = tex_coord(m, "Object")
    n = m.node("ShaderNodeTexNoise", Scale=25.0, Detail=8.0, Roughness=0.65)
    m.link(co, n.inputs["Vector"])
    ramp = color_ramp(m, [(0.4, hex_rgb("#E9E5DE")), (0.6, hex_rgb("#F0EDE7"))])
    m.link(n.outputs["Fac"], ramp.inputs["Fac"])
    m.link(ramp.outputs["Color"], m.bsdf.inputs["Base Color"])
    bump(m, n.outputs["Fac"], strength=0.05)
    m.set(Roughness=0.9)
    return m.mat


def mat_wood(name: str, light: str, dark: str, roughness: float, scale: float = 6.0, along: str = "X") -> bpy.types.Material:
    """Straight grain: a stretched wave texture distorted by noise."""
    m = M(name)
    co = tex_coord(m, "Object")
    mapping = m.node("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.08, 1.0, 1.0) if along == "X" else (1.0, 0.08, 1.0) if along == "Y" else (1.0, 1.0, 0.08)
    m.link(co, mapping.inputs["Vector"])
    wave = m.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y" if along == "X" else "X", wave_profile="SIN")
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 6.0
    wave.inputs["Detail"].default_value = 4.0
    wave.inputs["Detail Roughness"].default_value = 0.6
    m.link(mapping.outputs["Vector"], wave.inputs["Vector"])
    fine = m.node("ShaderNodeTexNoise", Scale=180.0, Detail=4.0)
    m.link(mapping.outputs["Vector"], fine.inputs["Vector"])
    ramp = color_ramp(m, [(0.25, hex_rgb(dark)), (0.75, hex_rgb(light))])
    m.link(wave.outputs["Fac"], ramp.inputs["Fac"])
    mix = m.node("ShaderNodeMix", data_type="RGBA", blend_type="OVERLAY")
    mix.inputs["Factor"].default_value = 0.15
    m.link(ramp.outputs["Color"], mix.inputs["A"])
    m.link(fine.outputs["Color"], mix.inputs["B"])
    m.link(mix.outputs["Result"], m.bsdf.inputs["Base Color"])
    bump(m, wave.outputs["Fac"], strength=0.06, distance=0.001)
    m.set(Roughness=roughness)
    m.bsdf.inputs["Coat Weight"].default_value = 0.15
    m.bsdf.inputs["Coat Roughness"].default_value = 0.25
    return m.mat


def mat_brass(name: str, roughness: float) -> bpy.types.Material:
    m = M(name)
    co = tex_coord(m, "Object")
    brushed = m.node("ShaderNodeTexNoise", Scale=400.0, Detail=2.0)
    mapping = m.node("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0, 0.02, 1.0)
    m.link(co, mapping.inputs["Vector"])
    m.link(mapping.outputs["Vector"], brushed.inputs["Vector"])
    rough = m.node("ShaderNodeMapRange", **{"To Min": roughness - 0.06, "To Max": roughness + 0.08})
    m.link(brushed.outputs["Fac"], rough.inputs["Value"])
    m.link(rough.outputs["Result"], m.bsdf.inputs["Roughness"])
    m.set(**{"Base Color": hex_rgb("#C9A066"), "Metallic": 1.0})
    m.bsdf.inputs["Anisotropic"].default_value = 0.4
    return m.mat


def mat_lattice() -> bpy.types.Material:
    """Dark wood, cut by the joined star-lattice mask (tex/lattice.png, one tile per UV unit)."""
    mat = mat_wood("Mashrabiya", "#4A3C2E", "#2E251C", 0.6, scale=10.0, along="Z")
    nt = mat.node_tree
    uv = nt.nodes.new("ShaderNodeTexCoord")
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = bpy.data.images.load(str(TEX / "lattice.png"))
    img.extension = "REPEAT"
    img.interpolation = "Cubic"
    nt.links.new(uv.outputs["UV"], img.inputs["Vector"])
    nt.links.new(img.outputs["Alpha"], nt.nodes["Principled BSDF"].inputs["Alpha"])
    return mat


def mat_simple(name: str, color: str, roughness: float, metallic: float = 0.0, emission: float = 0.0) -> bpy.types.Material:
    m = M(name)
    m.set(**{"Base Color": hex_rgb(color), "Roughness": roughness, "Metallic": metallic})
    if emission:
        m.bsdf.inputs["Emission Color"].default_value = hex_rgb(color)
        m.bsdf.inputs["Emission Strength"].default_value = emission
    return m.mat


def mat_lapis() -> bpy.types.Material:
    m = M("Lapis")
    co = tex_coord(m, "Object")
    n = m.node("ShaderNodeTexNoise", Scale=14.0, Detail=8.0)
    m.link(co, n.inputs["Vector"])
    ramp = color_ramp(m, [(0.3, hex_rgb("#22407F")), (0.6, hex_rgb("#2C4C9C")), (0.85, hex_rgb("#4E6DB8"))])
    m.link(n.outputs["Fac"], ramp.inputs["Fac"])
    flecks = m.node("ShaderNodeTexVoronoi", feature="F1")
    flecks.inputs["Scale"].default_value = 120.0
    m.link(co, flecks.inputs["Vector"])
    thresh = m.node("ShaderNodeMath", operation="LESS_THAN")
    thresh.inputs[1].default_value = 0.06
    m.link(flecks.outputs["Distance"], thresh.inputs[0])
    gold = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(thresh.outputs["Value"], gold.inputs["Factor"])
    m.link(ramp.outputs["Color"], gold.inputs["A"])
    gold.inputs["B"].default_value = hex_rgb("#D8B77A")
    m.link(gold.outputs["Result"], m.bsdf.inputs["Base Color"])
    m.link(thresh.outputs["Value"], m.bsdf.inputs["Metallic"])
    m.set(Roughness=0.22)
    return m.mat


def math_node(m: M, op: str, a, b=None):
    """A Math node; a and b are sockets or numbers."""
    n = m.node("ShaderNodeMath", operation=op)
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            m.link(v, n.inputs[i])
    return n.outputs["Value"]


def obj_attr(m: M, name: str):
    n = m.node("ShaderNodeAttribute", attribute_type="OBJECT", attribute_name=name)
    return n.outputs["Fac"]


def mat_book_cloth() -> bpy.types.Material:
    """Cloth from the object colour, desaturated 15 %, with gilt bands and a title label on the spine.

    Per-book object properties pick the label: lab_cell (atlas cell, -1 for none) and the label's
    extent on the spine as fractions of the generated coordinates (lab_u0..lab_u1 along the height,
    lab_v0..lab_v1 across the thickness).
    """
    m = M("BookCloth")
    info = m.node("ShaderNodeObjectInfo")
    hsv = m.node("ShaderNodeHueSaturation", Saturation=0.85, Value=1.0)
    m.link(info.outputs["Color"], hsv.inputs["Color"])
    co = tex_coord(m, "Generated")
    weave = m.node("ShaderNodeTexNoise", Scale=900.0, Detail=1.0)
    m.link(tex_coord(m, "Object"), weave.inputs["Vector"])
    sep = m.node("ShaderNodeSeparateXYZ")
    m.link(co, sep.inputs["Vector"])
    gx, gy, gz = sep.outputs["X"], sep.outputs["Y"], sep.outputs["Z"]
    spine = math_node(m, "GREATER_THAN", gy, 0.93)

    def between(v, lo, hi):
        return math_node(m, "MULTIPLY", math_node(m, "GREATER_THAN", v, lo), math_node(m, "LESS_THAN", v, hi))

    # Gilt bands near the head and tail of the spine, on about two books in three.
    bands = math_node(m, "MAXIMUM", between(gz, 0.07, 0.085), between(gz, 0.915, 0.93))
    gilt = math_node(m, "MULTIPLY", math_node(m, "MULTIPLY", bands, spine), math_node(m, "GREATER_THAN", info.outputs["Random"], 0.35))

    # Title label from the atlas (8 x 32 cells, text running along the spine from head to tail).
    cell = obj_attr(m, "lab_cell")
    u0, u1, v0, v1 = (obj_attr(m, k) for k in ("lab_u0", "lab_u1", "lab_v0", "lab_v1"))
    lu = math_node(m, "DIVIDE", math_node(m, "SUBTRACT", u1, gz), math_node(m, "SUBTRACT", u1, u0))
    lv = math_node(m, "DIVIDE", math_node(m, "SUBTRACT", math_node(m, "SUBTRACT", 1.0, gx), v0), math_node(m, "SUBTRACT", v1, v0))
    col = math_node(m, "FLOORED_MODULO", cell, 8.0)
    row = math_node(m, "FLOOR", math_node(m, "DIVIDE", cell, 8.0))
    au = math_node(m, "DIVIDE", math_node(m, "ADD", col, lu), 8.0)
    av = math_node(m, "SUBTRACT", 1.0, math_node(m, "DIVIDE", math_node(m, "SUBTRACT", math_node(m, "ADD", row, 1.0), lv), 32.0))
    uv = m.node("ShaderNodeCombineXYZ")
    m.link(au, uv.inputs["X"])
    m.link(av, uv.inputs["Y"])
    img = m.node("ShaderNodeTexImage", extension="EXTEND", interpolation="Cubic")
    img.image = bpy.data.images.load(str(TEX / "spine-atlas.png"))
    m.link(uv.outputs["Vector"], img.inputs["Vector"])
    inside = math_node(m, "MULTIPLY", between(lu, 0.0, 1.0), between(lv, 0.0, 1.0))
    inside = math_node(m, "MULTIPLY", inside, math_node(m, "MULTIPLY", spine, math_node(m, "GREATER_THAN", cell, -0.5)))
    label = math_node(m, "MULTIPLY", inside, img.outputs["Alpha"])
    # Gilt foil on dark cloth, ink print on light cloth.
    lum = m.node("ShaderNodeRGBToBW")
    m.link(hsv.outputs["Color"], lum.inputs["Color"])
    dark = math_node(m, "LESS_THAN", lum.outputs["Val"], 0.2)
    ink = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(dark, ink.inputs["Factor"])
    ink.inputs["A"].default_value = hex_rgb("#1E2230")
    ink.inputs["B"].default_value = hex_rgb("#D8B77A")
    foil = math_node(m, "MAXIMUM", gilt, math_node(m, "MULTIPLY", label, dark))
    mark = math_node(m, "MAXIMUM", gilt, label)

    col_mix = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(mark, col_mix.inputs["Factor"])
    m.link(hsv.outputs["Color"], col_mix.inputs["A"])
    gilt_or_ink = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(gilt, gilt_or_ink.inputs["Factor"])
    m.link(ink.outputs["Result"], gilt_or_ink.inputs["A"])
    gilt_or_ink.inputs["B"].default_value = hex_rgb("#D8B77A")
    m.link(gilt_or_ink.outputs["Result"], col_mix.inputs["B"])
    m.link(col_mix.outputs["Result"], m.bsdf.inputs["Base Color"])
    m.link(math_node(m, "MULTIPLY", foil, 0.85), m.bsdf.inputs["Metallic"])
    rough = m.node("ShaderNodeMix", data_type="FLOAT")
    m.link(foil, rough.inputs["Factor"])
    rough.inputs["A"].default_value = 0.72
    rough.inputs["B"].default_value = 0.32
    m.link(rough.outputs["Result"], m.bsdf.inputs["Roughness"])
    bump(m, weave.outputs["Fac"], strength=0.12, distance=0.0005)
    m.bsdf.inputs["Sheen Weight"].default_value = 0.25
    return m.mat


def mat_pages() -> bpy.types.Material:
    m = M("Pages")
    co = tex_coord(m, "Object")
    mapping = m.node("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0, 1.0, 1.0)
    m.link(co, mapping.inputs["Vector"])
    lines = m.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="X")
    lines.inputs["Scale"].default_value = 900.0
    m.link(mapping.outputs["Vector"], lines.inputs["Vector"])
    ramp = color_ramp(m, [(0.0, hex_rgb("#E3DCCB")), (1.0, hex_rgb("#F2ECDF"))])
    m.link(lines.outputs["Fac"], ramp.inputs["Fac"])
    m.link(ramp.outputs["Color"], m.bsdf.inputs["Base Color"])
    m.set(Roughness=0.85)
    return m.mat


def mat_engraved_brass(texture: Path) -> bpy.types.Material:
    """Brushed brass plate with the name engraved (dark, recessed) from a text mask."""
    m = M(f"Plaque-{texture.stem}")
    image = bpy.data.images.load(str(texture))
    uv = tex_coord(m, "UV")
    img = m.node("ShaderNodeTexImage", extension="CLIP")
    img.image = image
    m.link(uv, img.inputs["Vector"])
    co = tex_coord(m, "Object")
    brushed = m.node("ShaderNodeTexNoise", Scale=500.0, Detail=2.0)
    mapping = m.node("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.02, 1.0, 1.0)
    m.link(co, mapping.inputs["Vector"])
    m.link(mapping.outputs["Vector"], brushed.inputs["Vector"])
    col = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(img.outputs["Alpha"], col.inputs["Factor"])
    col.inputs["A"].default_value = hex_rgb("#C9A066")
    col.inputs["B"].default_value = hex_rgb("#2A2016")
    m.link(col.outputs["Result"], m.bsdf.inputs["Base Color"])
    metal = m.node("ShaderNodeMath", operation="SUBTRACT")
    metal.inputs[0].default_value = 1.0
    m.link(img.outputs["Alpha"], metal.inputs[1])
    m.link(metal.outputs["Value"], m.bsdf.inputs["Metallic"])
    rough = m.node("ShaderNodeMapRange", **{"To Min": 0.26, "To Max": 0.4})
    m.link(brushed.outputs["Fac"], rough.inputs["Value"])
    rough2 = m.node("ShaderNodeMix", data_type="FLOAT")
    m.link(img.outputs["Alpha"], rough2.inputs["Factor"])
    m.link(rough.outputs["Result"], rough2.inputs["A"])
    rough2.inputs["B"].default_value = 0.7
    m.link(rough2.outputs["Result"], m.bsdf.inputs["Roughness"])
    inv = m.node("ShaderNodeMath", operation="MULTIPLY")
    inv.inputs[1].default_value = -1.0
    m.link(img.outputs["Alpha"], inv.inputs[0])
    bump(m, inv.outputs["Value"], strength=0.6, distance=0.0015)
    return m.mat


def mat_shade() -> bpy.types.Material:
    """Pendant shade: brass outside, glowing warm inside; perforated with a star pattern."""
    m = M("PendantShade")
    co = tex_coord(m, "Object")
    vor = m.node("ShaderNodeTexVoronoi", feature="F1", distance="MINKOWSKI")
    vor.inputs["Scale"].default_value = 26.0
    vor.inputs["Exponent"].default_value = 0.7
    m.link(co, vor.inputs["Vector"])
    holes = m.node("ShaderNodeMath", operation="LESS_THAN")
    holes.inputs[1].default_value = 0.18
    m.link(vor.outputs["Distance"], holes.inputs[0])
    solid = m.node("ShaderNodeMath", operation="SUBTRACT")
    solid.inputs[0].default_value = 1.0
    m.link(holes.outputs["Value"], solid.inputs[1])
    m.link(solid.outputs["Value"], m.bsdf.inputs["Alpha"])
    m.set(**{"Base Color": hex_rgb("#C9A066"), "Metallic": 1.0, "Roughness": 0.3})
    return m.mat


# --- Geometry helpers -----------------------------------------------------------------------


def box(name, center, size, mat, bevel=0.006, segments=3, collection="Hall"):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = center
    if mat:
        mesh.materials.append(mat)
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.harden_normals = True
    for poly in mesh.polygons:
        poly.use_smooth = True
    return link(obj, collection)


def cylinder(name, center, radius, depth, mat, vertices=48, bevel=0.004, collection="Hall"):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=vertices, radius1=radius, radius2=radius, depth=depth)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = center
    mesh.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = True
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        mod.harden_normals = True
    return link(obj, collection)


def polygon_prism(name, points, z0, z1, mat, bevel=0.0, collection="Hall"):
    """Extrude a 2D polygon (x, y) from z0 to z1."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, z0)) for x, y in points]
    face = bm.faces.new(verts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in ext["geom"]:
        if isinstance(v, bmesh.types.BMVert):
            v.co.z = z1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return link(obj, collection)


def pointed_arch_points(width, spring, rise, steps=24):
    """Outline of a pointed (two-centred) arch opening, from bottom-left round to bottom-right."""
    half = width / 2
    r = (half**2 + rise**2) / (2 * half)
    cx = -half + r  # the left arc's centre lies right of the opening's centre line
    left = [(-half, 0.0), (-half, spring)]
    for i in range(1, steps):
        ang = math.pi - (i / steps) * math.acos((r - half) / r)
        left.append((cx + r * math.cos(ang), spring + r * math.sin(ang)))
    apex = (0.0, spring + math.sqrt(r**2 - cx**2))
    return left + [apex] + [(-x, y) for x, y in reversed(left)]


def wall_with_opening(name, y, x0, x1, z0, z1, thickness, opening, mat):
    """A wall in the x-z plane at y (thickness toward +y), with an arched opening (outline in x, z)."""
    wall = box(name, ((x0 + x1) / 2, y + thickness / 2, (z0 + z1) / 2), (x1 - x0, thickness, z1 - z0), mat, bevel=0.0)
    cutter = polygon_prism(name + "-cut", list(opening), -1.0, 1.0, mat)
    cutter.rotation_euler = (math.radians(90), 0, 0)
    cutter.location = (0, y + thickness / 2, 0)
    mod = wall.modifiers.new("Opening", "BOOLEAN")
    mod.object = cutter
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    cutter.hide_render = True
    cutter.hide_viewport = True
    return wall


def lattice_mesh(name, outline, tile_w, tile_h, origin):
    """A flat panel (outline in local x, y) with UVs counting tiles from origin."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((x, y, 0)) for x, y in outline])
    uv = bm.loops.layers.uv.new("UVMap")
    for loop in face.loops:
        loop[uv].uv = ((loop.vert.co.x - origin[0]) / tile_w, (loop.vert.co.y - origin[1]) / tile_h)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def lattice_object(name, mesh, depth, mat, center, rotation, collection="Hall"):
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mat)
    solid = obj.modifiers.new("Depth", "SOLIDIFY")
    solid.thickness = depth
    solid.offset = 0.0
    obj.location = center
    obj.rotation_euler = rotation
    return link(obj, collection)


def lattice_panel(name, width, height, tile, bar, depth, mat, center, rotation=(0, 0, 0), collection="Hall"):
    """Mashrabiya: eight-point stars tied to a square grid (the bar width comes from the mask)."""
    nx, ny = max(1, round(width / tile)), max(1, round(height / tile))
    outline = [(-width / 2, -height / 2), (width / 2, -height / 2), (width / 2, height / 2), (-width / 2, height / 2)]
    mesh = lattice_mesh(name, outline, width / nx, height / ny, (-width / 2, -height / 2))
    return lattice_object(name, mesh, depth, mat, center, rotation, collection)


# --- Books ----------------------------------------------------------------------------------

_book_cache: dict[tuple, tuple[bpy.types.Mesh, bpy.types.Mesh]] = {}


def book_meshes(thickness, height, depth, cloth, pages):
    """A hardback: two cover boards joined by a rounded spine (one shell), and a recessed page block.

    Local axes: x across the thickness, y from the fore-edge (-) to the spine (+), z up from 0.
    """
    key = (round(thickness, 3), round(height, 3), round(depth, 3))
    if key in _book_cache:
        return _book_cache[key]
    board = 0.0026
    half = thickness / 2
    bulge = min(0.012, thickness * 0.28)
    shell_pts: list[tuple[float, float]] = []
    # Outer path: left cover back -> front, rounded spine, right cover front -> back.
    shell_pts.append((-half, -depth / 2))
    shell_pts.append((-half, depth / 2 - 0.004))
    arc = 14
    for i in range(1, arc):
        a = math.pi - math.pi * i / arc
        shell_pts.append((half * math.cos(a), depth / 2 - 0.004 + bulge * math.sin(a)))
    shell_pts.append((half, depth / 2 - 0.004))
    shell_pts.append((half, -depth / 2))
    # Inner path back (board thickness), right to left.
    shell_pts.append((half - board, -depth / 2))
    shell_pts.append((half - board, depth / 2 - 0.006))
    for i in range(arc - 1, 0, -1):
        a = math.pi - math.pi * i / arc
        shell_pts.append(((half - board) * math.cos(a), depth / 2 - 0.006 + (bulge - board) * math.sin(a)))
    shell_pts.append((-half + board, depth / 2 - 0.006))
    shell_pts.append((-half + board, -depth / 2))

    def prism(points, z0, z1, name):
        mesh = bpy.data.meshes.new(name)
        bm = bmesh.new()
        verts = [bm.verts.new((x, y, z0)) for x, y in points]
        face = bm.faces.new(verts)
        ext = bmesh.ops.extrude_face_region(bm, geom=[face])
        for v in ext["geom"]:
            if isinstance(v, bmesh.types.BMVert):
                v.co.z = z1
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(mesh)
        bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = True
        return mesh

    shell = prism(shell_pts, 0.0, height, "BookShell")
    shell.materials.append(cloth)
    inset = 0.0035
    block_pts = [(-half + board, -depth / 2 + inset), (half - board, -depth / 2 + inset), (half - board, depth / 2 - 0.006), (-half + board, depth / 2 - 0.006)]
    block = prism(block_pts, inset, height - inset, "BookPages")
    block.materials.append(pages)
    _book_cache[key] = (shell, block)
    return shell, block


PALETTE = ["#7A2E8C", "#2E5E8C", "#3A6E4F", "#8C3A2E", "#B0742E", "#1F3A5F", "#6B3F2A", "#4C5A2A", "#8A6A3A", "#2F2F3A", "#A23B4C", "#3F6A75", "#C4A35A", "#5B3A6E", "#264E3B", "#7F4E2A", "#9A2F2F", "#305080", "#C2B59B", "#E2DACB"]


BOOK_COUNT = [0]
SECTION_COUNTS: dict[str, int] = {}


def add_book(x, y, z, thickness, height, depth, color, cloth, pages, rot_z=0.0, tilt=0.0, collection="Books"):
    if collection == "Books":
        BOOK_COUNT[0] += 1
    shell_mesh, block_mesh = book_meshes(thickness, height, depth, cloth, pages)
    shell = bpy.data.objects.new("Book", shell_mesh)
    block = bpy.data.objects.new("BookPages", block_mesh)
    for obj in (shell, block):
        obj.location = (x, y, z)
        obj.rotation_euler = Euler((0, tilt, rot_z))
        obj.color = (*hex_rgb(color)[:3], 1.0)
        link(obj, collection)
    # Spine label: keep the atlas cell's 8:1 aspect, centred on the spine.
    if rng.random() < 0.82:
        length, across = 0.76 * height, thickness * 0.9
        if length / across > 8:
            half_u, half_v = 4 * across / height, 0.45
        else:
            half_u, half_v = 0.38, (length / 16) / thickness
        shell["lab_cell"] = float(rng.randrange(256))
        shell["lab_u0"], shell["lab_u1"] = 0.5 - half_u, 0.5 + half_u
        shell["lab_v0"], shell["lab_v1"] = 0.5 - half_v, 0.5 + half_v
    else:
        shell["lab_cell"] = -1.0
    return shell, block


# --- The hall -------------------------------------------------------------------------------


def build(scene):
    mats = {
        "floor": mat_limestone("LimestoneFloor", 0.24, tiles=True),
        "stone": mat_limestone("Limestone", 0.65, tiles=False),
        "plaster": mat_plaster(),
        "ash": mat_wood("Ash", "#D2C2A6", "#B9A584", 0.48, scale=5.0, along="X"),
        "ash_v": mat_wood("AshVertical", "#D2C2A6", "#B9A584", 0.48, scale=5.0, along="Z"),
        "walnut": mat_wood("Walnut", "#6A5240", "#4A372A", 0.42, scale=8.0, along="X"),
        "brass": mat_brass("Brass", 0.32),
        "brass_polished": mat_brass("BrassPolished", 0.2),
        "lapis": mat_lapis(),
        "lattice": mat_wood("DarkWood", "#4A3C2E", "#2E251C", 0.6, scale=10.0, along="Z"),
        "screen": mat_lattice(),
        "cloth": mat_book_cloth(),
        "pages": mat_pages(),
        "bulb": mat_simple("Bulb", "#FFD9A0", 0.4, emission=18.0),
        "leather": mat_simple("Leather", "#3C2A22", 0.55),
        "shade": mat_shade(),
        "outside": mat_simple("Outside", "#F4F1EA", 1.0, emission=2.5),
        "ceramic": mat_simple("Ceramic", "#E9E4DA", 0.18),
        "marble": mat_simple("DarkMarble", "#2B2A2A", 0.22),
    }

    # Floor, walls, ceiling --------------------------------------------------------------------
    box("Ground", (0, LENGTH / 2, -0.06), (200, 200, 0.1), mats["stone"], bevel=0)
    box("Floor", (0, LENGTH / 2, -0.05), (HALL_HALF * 2, LENGTH + 0.6, 0.1), mats["floor"], bevel=0)
    for s in (-1, 1):
        side_wall = box(f"SideWall{s}", (s * (INNER_HALF + 0.15), LENGTH / 2, AISLE_HEIGHT / 2), (0.3, LENGTH + 0.6, AISLE_HEIGHT), mats["plaster"], bevel=0)
        for wy in ENTRANCE_WINDOWS:
            side_window(side_wall, s, wy, mats)
        # Each bay's back wall has its own arched lattice window.
        for side, y0, y1, _, _ in BAYS:
            if side == s:
                side_window(side_wall, s, (y0 + y1) / 2, mats, sill=0.85, spring=1.45, rise=0.75)
        # A built-in window seat runs under the windows.
        box(f"Seat{s}", (s * (INNER_HALF - 0.27), 3.8, 0.21), (0.52, 5.4, 0.42), mats["ash"], bevel=0.01)
        box(f"SeatCushion{s}", (s * (INNER_HALF - 0.29), 3.8, 0.46), (0.46, 5.3, 0.08), mats["leather"], bevel=0.025, segments=4)
        box(f"SeatKick{s}", (s * (INNER_HALF - 0.28), 3.8, 0.03), (0.5, 5.38, 0.06), mats["walnut"], bevel=0.003)
        # Aisle ceiling
        # It starts inside the clerestory wall (x = NAVE_HALF): coplanar faces render black in Cycles.
        box(f"AisleCeiling{s}", (s * (NAVE_HALF + INNER_HALF + 0.15) / 2, LENGTH / 2, AISLE_HEIGHT + 0.1), (INNER_HALF + 0.15 - NAVE_HALF, LENGTH + 0.6, 0.2), mats["lattice"], bevel=0)
        # Ash slats under the dark aisle ceiling, running across the aisle.
        slat = bpy.data.meshes.new(f"CeilingSlat{s}")
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * (INNER_HALF - NAVE_HALF - 0.17), v.co.y * 0.045, v.co.z * 0.045))
        bm.to_mesh(slat)
        bm.free()
        slat.materials.append(mats["ash"])
        for i in range(int((LENGTH + 0.1) / 0.1)):
            o = bpy.data.objects.new(f"CeilingSlat{s}", slat)
            o.location = (s * (NAVE_HALF + 0.17 + INNER_HALF) / 2, -0.25 + 0.05 + i * 0.1, AISLE_HEIGHT - 0.0225)
            link(o)
        # Clerestory wall above the arcade, with lattice windows over each bay.
        wall_y0, wall_y1 = -0.3, LENGTH + 0.3
        box(f"ArcadeBeam{s}", (s * NAVE_HALF, LENGTH / 2, AISLE_HEIGHT - 0.12), (0.34, LENGTH + 0.6, 0.36), mats["stone"], bevel=0.01)
        # Solid wall pieces between window openings.
        windows = [(1.2, 3.2), (4.2, 6.2), (8.4, 10.6), (11.8, 14.0), (15.2, 17.1)]
        solid = [(wall_y0, 1.2), (3.2, 4.2), (6.2, 8.4), (10.6, 11.8), (14.0, 15.2)]
        for a, b in solid:
            box(f"Clerestory{s}-{a}", (s * NAVE_HALF, (a + b) / 2, (AISLE_HEIGHT + NAVE_HEIGHT) / 2 + 0.1), (0.3, b - a, NAVE_HEIGHT - AISLE_HEIGHT + 0.2), mats["plaster"], bevel=0)
        for a, b in windows:
            box(f"Sill{s}-{a}", (s * NAVE_HALF, (a + b) / 2, AISLE_HEIGHT + 0.35), (0.3, b - a, 0.7), mats["plaster"], bevel=0)
            box(f"Head{s}-{a}", (s * NAVE_HALF, (a + b) / 2, NAVE_HEIGHT - 0.25), (0.3, b - a, 0.5), mats["plaster"], bevel=0)
            lattice_panel(f"Window{s}-{a}", b - a, NAVE_HEIGHT - AISLE_HEIGHT - 1.2, 0.32, 0.018, 0.04, mats["screen"], (s * NAVE_HALF, (a + b) / 2, (AISLE_HEIGHT + 0.7 + NAVE_HEIGHT - 0.5) / 2), rotation=(math.radians(90), 0, math.radians(90)))
    # Nave ceiling with skylight wells and lattices.
    skylights = [1.6, 5.0, 9.7, 13.1, 16.0]
    ceiling_parts = []
    last = -0.3
    for y in skylights:
        ceiling_parts.append((last, y - 0.8))
        last = y + 0.8
    ceiling_parts.append((last, LENGTH + 0.3))
    for a, b in ceiling_parts:
        box(f"NaveCeiling-{a}", (0, (a + b) / 2, NAVE_HEIGHT + 0.1), (NAVE_HALF * 2 + 0.3, b - a, 0.2), mats["plaster"], bevel=0)
    for y in skylights:
        for s in (-1, 1):
            box(f"SkyRim{s}-{y}", (s * 1.6, y, NAVE_HEIGHT + 0.1), (NAVE_HALF * 2 - 3.2 + 0.3, 1.6, 0.2), mats["plaster"], bevel=0)
        # The well rises 0.8 m; the lattice sits at its mouth.
        for s in (-1, 1):
            box(f"WellSide{s}-{y}", (s * 1.75, y, NAVE_HEIGHT + 0.6), (0.3, 1.6, 1.0), mats["plaster"], bevel=0)
            box(f"WellEnd{s}-{y}", (0, y + s * 0.95, NAVE_HEIGHT + 0.6), (3.8, 0.3, 1.0), mats["plaster"], bevel=0)
        lattice_panel(f"Skylight-{y}", 3.2, 1.6, 0.4, 0.02, 0.06, mats["screen"], (0, y, NAVE_HEIGHT + 0.02))
        # Deep plaster beams frame each skylight well, giving the ceiling rhythm and shadow.
        for s in (-1, 1):
            box(f"Beam{s}-{y}", (0, y + s * 0.92, NAVE_HEIGHT - 0.14), (NAVE_HALF * 2, 0.22, 0.28), mats["plaster"], bevel=0.01)
    for y in (3.3, 7.35, 11.4, 14.55):
        box(f"BeamMid-{y}", (0, y, NAVE_HEIGHT - 0.14), (NAVE_HALF * 2, 0.22, 0.28), mats["plaster"], bevel=0.01)
    for s in (-1, 1):
        box(f"Cornice{s}", (s * (NAVE_HALF - 0.12), LENGTH / 2, NAVE_HEIGHT - 0.1), (0.24, LENGTH + 0.6, 0.2), mats["plaster"], bevel=0.01)
        # Limestone skirting along the arcade piers and the side walls.
        box(f"Skirting{s}", (s * (INNER_HALF - 0.01), LENGTH / 2, 0.08), (0.04, LENGTH, 0.16), mats["stone"], bevel=0.004)
    # Entrance wall with a tall pointed arch; a bright forecourt beyond.
    arch = [(x, z) for x, z in pointed_arch_points(2.2, 2.7, 1.5)]
    wall_with_opening("EntranceWall", -0.3, -HALL_HALF, HALL_HALF, 0, NAVE_HEIGHT + 0.2, 0.3, arch, mats["plaster"])
    box("Forecourt", (0, -3.0, 2.5), (6.0, 0.2, 5.0), mats["outside"], bevel=0)
    # End wall and its niche.
    niche = [(x, z + 0.0) for x, z in pointed_arch_points(2.4, 2.1, 1.6)]
    wall_with_opening("EndWall", LENGTH, -HALL_HALF, HALL_HALF, 0, NAVE_HEIGHT + 0.2, 0.3, niche, mats["plaster"])
    box("NicheBack", (0, LENGTH + 0.55, 2.0), (2.6, 0.1, 4.0), mats["plaster"], bevel=0)
    for s in (-1, 1):
        box(f"NicheSide{s}", (s * 1.25, LENGTH + 0.4, 2.0), (0.1, 0.4, 4.0), mats["plaster"], bevel=0)
    box("NicheTop", (0, LENGTH + 0.4, 3.85), (2.6, 0.4, 0.1), mats["plaster"], bevel=0)
    box("Bench", (0, LENGTH + 0.32, 0.23), (1.9, 0.42, 0.06), mats["walnut"], bevel=0.008)
    box("BenchBase", (0, LENGTH + 0.35, 0.1), (1.7, 0.34, 0.2), mats["stone"], bevel=0.01)
    wash = bpy.data.lights.new("NicheWash", "AREA")
    wash.energy, wash.color, wash.size = 160.0, (1.0, 0.78, 0.55), 1.8
    o = bpy.data.objects.new("NicheWash", wash)
    o.location = (0, LENGTH + 0.2, 3.6)
    o.rotation_euler = (math.radians(-12), 0, 0)
    link(o, "Lights")

    # Partitions between bays, columns, plaques ---------------------------------------------------
    for y in PARTITIONS:
        for s in (-1, 1):
            box(f"Partition{s}-{y}", (s * (NAVE_HALF + INNER_HALF) / 2, y, AISLE_HEIGHT / 2), (INNER_HALF - NAVE_HALF, 0.12, AISLE_HEIGHT), mats["plaster"], bevel=0.01)
    for s in (-1, 1):
        lo, hi = sorted((s * (NAVE_HALF + 0.27), s * (INNER_HALF - 0.05)))
        slat_wall(f"Cladding{s}", lo, hi, PARTITIONS[0] - 0.06, -1, AISLE_HEIGHT - 0.25, mats)
    # Arcade columns on the nave edge, under the arcade beam: one at every bay boundary (where the
    # partitions meet the nave) and two in the entrance zone, so the bay openings stay clear.
    beam_bottom = AISLE_HEIGHT - 0.3
    for s in (-1, 1):
        for y in COLUMN_YS:
            cx = s * NAVE_HALF
            fluted_shaft(f"Shaft{s}-{y}", (cx, y), 0.17, 0.24, beam_bottom - 0.24, mats["stone"])
            box(f"Base{s}-{y}", (cx, y, 0.12), (0.46, 0.46, 0.24), mats["stone"], bevel=0.015)
            box(f"Plinth{s}-{y}", (cx, y, 0.27), (0.4, 0.4, 0.06), mats["stone"], bevel=0.01)
            # Simplified muqarnas capital: three plain steps widening up to the beam.
            for k, size in enumerate((0.4, 0.48, 0.56)):
                box(f"Capital{s}-{y}-{k}", (cx, y, beam_bottom - 0.2 + k * 0.08), (size, size, 0.08), mats["stone"], bevel=0.008)
    for side, y0, y1, name, key in BAYS:
        cy = (y0 + y1) / 2
        # Signage level 1: the section name in cut bronze letters on the arcade beam over the opening.
        section_header(side, cy, key, mats)
        # Bookcases stand against the partitions, facing each other across the bay; level 2 range
        # plates sit at eye level on their end panels facing the nave.
        start = BOOK_COUNT[0]
        bookcase(f"BookcaseFront{name}", side, y0 - 0.05, +1, mats, plate=key)
        bookcase(f"BookcaseBack{name}", side, y1 - 0.07, -1, mats, plate=key)
        SECTION_COUNTS[key] = BOOK_COUNT[0] - start
        # A warm pendant at the bay's opening.
        pendant(f"BayLamp{name}", (side * 3.9, cy, AISLE_HEIGHT - 0.05), 0.9, mats, power=45.0, radius=0.16)
        # A reading table in the bay.
        box(f"Table{name}", (side * 4.0, cy, 0.74), (1.4, 0.7, 0.04), mats["walnut"], bevel=0.006)
        for dx in (-0.6, 0.6):
            for dy in (-0.28, 0.28):
                box(f"TableLeg{name}{dx}{dy}", (side * 4.0 + dx, cy + dy, 0.36), (0.04, 0.04, 0.72), mats["ash_v"], bevel=0.004)
        for dx in (-0.35, 0.35):
            chair(f"Chair{name}{dx}a", side * 4.0 + dx, cy - 0.62 - (0.12 if dx > 0 else 0), (8 if dx > 0 else 0), mats)
            chair(f"Chair{name}{dx}b", side * 4.0 + dx, cy + 0.62, 180 + (-6 if dx < 0 else 0), mats)
        table_lamp(f"Lamp{name}", side * 4.0 + side * 0.45, cy - 0.12, 0.76, mats)

    # The floor's brass inlay lines and the medallion ------------------------------------------------
    for x in (-1.5, 1.5):
        box(f"Inlay{x}", (x, LENGTH / 2 + 0.6, 0.0005), (0.012, LENGTH - 1.4, 0.002), mats["brass_polished"], bevel=0)
    medallion(MEDALLION, mats)

    # Signage level 3: the directory stele by the entrance.
    directory_stele((1.85, 3.75), -10.0, mats)

    # The Entrance Desk ---------------------------------------------------------------------------
    desk(mats)


def side_window(wall, side, yc, mats, width=1.3, sill=0.55, spring=1.9, rise=0.8):
    """Cut a pointed-arch window into a side wall (y-z plane) and fill it with a mashrabiya."""
    outline = [(yc + u, sill + v) for u, v in pointed_arch_points(width, spring, rise)]
    x_wall = side * (INNER_HALF + 0.15)
    rot = (math.radians(90), 0, math.radians(90))  # local x -> world y, local y -> world z, local z -> world x
    cutter = polygon_prism(f"WinCut{side}-{yc}", outline, -0.6, 0.6, mats["plaster"])
    cutter.rotation_euler = rot
    cutter.location = (x_wall, 0, 0)
    cutter.hide_render = cutter.hide_viewport = True
    mod = wall.modifiers.new(f"Win{yc}", "BOOLEAN")
    mod.object, mod.operation, mod.solver = cutter, "DIFFERENCE", "EXACT"
    # The lattice sits in the outer third of the reveal, clipped to the arch.
    height = spring + rise
    tile = width / 5
    local = [(u - yc, v - sill) for u, v in outline]
    mesh = lattice_mesh(f"WinScreen{side}-{yc}", local, tile, tile, (-width / 2, 0.0))
    lattice_object(f"WinScreen{side}-{yc}", mesh, 0.035, mats["screen"], (x_wall + side * 0.06, yc, sill), rot)
    box(f"WinSill{side}-{yc}", (side * (INNER_HALF + 0.02), yc, sill - 0.02), (0.34, width + 0.12, 0.04), mats["stone"], bevel=0.006)


def fluted_shaft(name, center, radius, z0, z1, mat, flutes=32, depth=0.006):
    """A limestone column shaft with concave flutes."""
    pts = []
    per = 8
    for k in range(flutes * per):
        a = 2 * math.pi * k / (flutes * per)
        t = (k % per) / per
        r = radius - depth * math.sin(math.pi * t)
        pts.append((center[0] + r * math.cos(a), center[1] + r * math.sin(a)))
    obj = polygon_prism(name, pts, z0, z1, mat)
    for poly in obj.data.polygons:
        poly.use_smooth = abs(poly.normal.z) < 0.5
    return obj


def slat_wall(name, x0, x1, y_face, facing, height, mats, pitch=0.055):
    """Vertical ash slats over a dark backing, on a partition face (front toward facing * y)."""
    width = x1 - x0
    box(name + "Backing", ((x0 + x1) / 2, y_face + facing * 0.004, height / 2 + 0.08), (width, 0.008, height), mats["lattice"], bevel=0)
    slat = bpy.data.meshes.new(name + "Slat")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * 0.032, v.co.y * 0.026, v.co.z * height))
    bm.to_mesh(slat)
    bm.free()
    slat.materials.append(mats["ash_v"])
    count = int(width / pitch)
    for i in range(count):
        o = bpy.data.objects.new(name + "Slat", slat)
        o.location = (x0 + pitch / 2 + i * pitch, y_face + facing * 0.021, height / 2 + 0.08)
        bev = o.modifiers.new("Bevel", "BEVEL")
        bev.width, bev.segments = 0.003, 2
        link(o)


def chair(name, x, y, angle_deg, mats):
    """A slim ash chair with a leather seat; local +y faces the table."""
    root = bpy.data.objects.new(name, None)
    root.location = (x, y, 0)
    root.rotation_euler = (0, 0, math.radians(angle_deg))
    link(root)
    parts = [
        ((0, 0, 0.45), (0.44, 0.42, 0.035), "ash", 0.005),
        ((0, 0.01, 0.48), (0.4, 0.36, 0.035), "leather", 0.014),
        ((0, -0.2, 0.78), (0.42, 0.025, 0.12), "ash", 0.008),
    ]
    for dx in (-0.19, 0.19):
        for dy in (-0.18, 0.18):
            parts.append(((dx, dy, 0.215), (0.03, 0.03, 0.43), "walnut", 0.004))
        parts.append(((dx, -0.19, 0.66), (0.03, 0.03, 0.4), "walnut", 0.004))
    for k, (loc, size, mat, bev) in enumerate(parts):
        o = box(f"{name}-{k}", loc, size, mats[mat], bevel=bev)
        o.parent = root


def table_lamp(name, x, y, z, mats):
    """A small brass reading lamp with a dome shade and a warm bulb."""
    cylinder(name + "Base", (x, y, z + 0.008), 0.07, 0.016, mats["brass"], vertices=32, bevel=0.003)
    cylinder(name + "Stem", (x, y, z + 0.2), 0.006, 0.38, mats["brass"], vertices=12, bevel=0)
    pendant(name, (x, y, z + 0.5), 0.04, mats, power=6.0, radius=0.1)


def textured_plate(name, center, size, normal, mat, parent=None, bevel=0.002):
    """A thin box whose face along `normal` carries the texture, reading left to right for a viewer
    standing in front of it (other faces map to the texture's transparent corner)."""
    obj = box(name, center, size, mat, bevel=bevel, segments=2)
    if parent is not None:
        obj.parent = parent
    right = (-normal).cross(Vector((0, 0, 1))).normalized()
    width = abs(right.x) * size[0] + abs(right.y) * size[1]
    mesh = obj.data
    uv = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        front = poly.normal.dot(normal) > 0.5
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv = (co.dot(right) / width + 0.5, co.z / size[2] + 0.5) if front else (0.0, 0.0)
    return obj


def section_header(side, cy, key, mats, width=2.2, height=0.5):
    """Cut bronze letters standing 12 mm off the plaster band above the arcade beam, grazed by a warm
    line of light from a slim brass trough resting on the beam."""
    wall_face = side * (NAVE_HALF - 0.15)
    x = wall_face - side * 0.012
    zc = AISLE_HEIGHT + 0.36
    m = M(f"Header-{key}")
    img = m.node("ShaderNodeTexImage", extension="CLIP")
    img.image = bpy.data.images.load(str(TEX / f"sign-header-{key}.png"))
    m.link(tex_coord(m, "UV"), img.inputs["Vector"])
    m.link(img.outputs["Alpha"], m.bsdf.inputs["Alpha"])
    m.set(**{"Base Color": hex_rgb("#2E261E"), "Metallic": 1.0, "Roughness": 0.38})
    mesh = bpy.data.meshes.new(f"Header-{key}")
    bm = bmesh.new()
    corners = [(cy - width / 2, zc - height / 2), (cy + width / 2, zc - height / 2), (cy + width / 2, zc + height / 2), (cy - width / 2, zc + height / 2)]
    face = bm.faces.new([bm.verts.new((x, y, z)) for y, z in corners])
    uv = bm.loops.layers.uv.new("UVMap")
    for loop in face.loops:
        y, z = loop.vert.co.y, loop.vert.co.z
        u = (cy + width / 2 - y) / width if side > 0 else (y - cy + width / 2) / width
        loop[uv].uv = (u, (z - zc + height / 2) / height)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(m.mat)
    obj = bpy.data.objects.new(f"Header-{key}", mesh)
    solid = obj.modifiers.new("Depth", "SOLIDIFY")
    solid.thickness = 0.004
    link(obj)
    light = bpy.data.lights.new(f"HeaderLight-{key}", "AREA")
    light.shape = "RECTANGLE"
    light.size, light.size_y = 0.03, width + 0.3
    light.energy = 14.0
    light.color = (1.0, 0.78, 0.55)
    lo = bpy.data.objects.new(f"HeaderLight-{key}", light)
    box(f"HeaderTrough-{key}", (wall_face - side * 0.04, cy, AISLE_HEIGHT + 0.085), (0.05, width + 0.3, 0.05), mats["brass"], bevel=0.003)
    lo.location = (wall_face - side * 0.05, cy, AISLE_HEIGHT + 0.115)
    lo.rotation_euler = (0, math.pi + side * 0.22, 0)   # aims up and onto the wall
    link(lo, "Lights")


def directory_stele(pos, turn_deg, mats):
    """A slim limestone stele with an engraved brass directory, facing the entrance."""
    root = bpy.data.objects.new("Directory", None)
    root.location = (pos[0], pos[1], 0)
    root.rotation_euler = (0, 0, math.radians(turn_deg))
    link(root)
    parts = [
        ((0, 0, 0.04), (0.64, 0.26, 0.08), "stone", 0.01),
        ((0, 0, 0.1), (0.58, 0.2, 0.04), "stone", 0.008),
        ((0, 0, 0.84), (0.52, 0.14, 1.44), "stone", 0.012),
        ((0, 0, 1.575), (0.58, 0.18, 0.03), "brass", 0.004),
    ]
    for k, (loc, size, mat, bev) in enumerate(parts):
        o = box(f"Directory-{k}", loc, size, mats[mat], bevel=bev)
        o.parent = root
    textured_plate("DirectoryPanel", (0, -0.073, 1.2), (0.42, 0.006, 0.55), Vector((0, -1, 0)), mat_engraved_brass(TEX / "sign-directory.png"), parent=root)


def pendant(name, location, drop, mats, power=60.0, radius=0.2):
    x, y, z = location
    cylinder(name + "Cord", (x, y, z - drop / 2), 0.003, drop, mats["brass"], vertices=8, bevel=0)
    mesh = bpy.data.meshes.new(name + "Shade")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=radius)
    for v in list(bm.verts):
        if v.co.z < -radius * 0.2:
            bm.verts.remove(v)
    bm.to_mesh(mesh)
    bm.free()
    shade = bpy.data.objects.new(name + "Shade", mesh)
    shade.location = (x, y, z - drop)
    mesh.materials.append(mats["shade"])
    solid = shade.modifiers.new("Thick", "SOLIDIFY")
    solid.thickness = 0.003
    for poly in mesh.polygons:
        poly.use_smooth = True
    link(shade)
    bulb = bpy.data.objects.new(name + "Bulb", bpy.data.meshes.new(name + "BulbMesh"))
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=radius * 0.22)
    bm.to_mesh(bulb.data)
    bm.free()
    bulb.data.materials.append(mats["bulb"])
    bulb.location = (x, y, z - drop - radius * 0.05)
    link(bulb)
    light = bpy.data.lights.new(name + "Light", "POINT")
    light.energy, light.color, light.shadow_soft_size = power, (1.0, 0.72, 0.42), radius * 0.2
    lo = bpy.data.objects.new(name + "Light", light)
    lo.location = (x, y, z - drop)
    link(lo, "Lights")


def medallion(center, mats):
    cx, cy = center
    r = 0.85
    ring = cylinder("MedallionRing", (cx, cy, 0.0006), r, 0.0012, mats["brass_polished"], vertices=128, bevel=0)
    cylinder("MedallionField", (cx, cy, 0.0009), r - 0.03, 0.0012, mats["floor"], vertices=128, bevel=0)
    star = []
    for k in range(16):
        rad = (r - 0.08) if k % 2 == 0 else (r - 0.08) * 0.62
        a = math.pi / 2 + k * math.pi / 8
        star.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    polygon_prism("MedallionStarBrass", star, 0.0, 0.0022, mats["brass_polished"])
    inner = []
    for k in range(16):
        rad = (r - 0.12) if k % 2 == 0 else (r - 0.12) * 0.6
        a = math.pi / 2 + k * math.pi / 8
        inner.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    polygon_prism("MedallionStarLapis", inner, 0.0, 0.0026, mats["lapis"])
    cylinder("MedallionCentre", (cx, cy, 0.0016), 0.12, 0.0026, mats["brass_polished"], vertices=64, bevel=0)


def desk(mats):
    x, y = DESK
    box("DeskBody", (x, y, 0.46), (1.9, 0.72, 0.9), mats["ash"], bevel=0.012)
    # Reeded (fluted) ash front and back: vertical half-round reeds, 3 cm apart.
    reed = bpy.data.meshes.new("Reed")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.014, radius2=0.014, depth=0.8)
    bm.to_mesh(reed)
    bm.free()
    for poly in reed.polygons:
        poly.use_smooth = True
    reed.materials.append(mats["ash_v"])
    n = 62
    for s in (-1, 1):
        for i in range(n):
            o = bpy.data.objects.new("Reed", reed)
            o.location = (x - 0.915 + i * 1.83 / (n - 1), y + s * 0.36, 0.5)
            link(o)
    box("DeskKick", (x, y, 0.05), (1.92, 0.76, 0.1), mats["brass"], bevel=0.002)
    box("DeskTop", (x, y, 0.93), (2.0, 0.8, 0.05), mats["ash"], bevel=0.008)
    box("DeskLeather", (x, y, 0.956), (1.6, 0.5, 0.004), mats["leather"], bevel=0.002)
    for s in (-1, 1):
        box(f"DeskEdge{s}", (x, y + s * 0.401, 0.93), (2.0, 0.006, 0.05), mats["brass"], bevel=0.0015)
    box("DeskPlinth", (x, y, 0.03), (1.8, 0.62, 0.06), mats["walnut"], bevel=0.004)
    # Three angled stands, each holding a book showing its cover toward the entrance (-y). Each book
    # rests on its back-bottom edge on the stand's ledge with its back cover flat on the tilted plate.
    top = 0.958                      # leather surface
    tilt = math.radians(18)          # plates lean back (top toward +y)
    n = Vector((0, math.cos(tilt), -math.sin(tilt)))   # plate front-face normal, pointing into the plate
    up = Vector((0, math.sin(tilt), math.cos(tilt)))   # along the plate, upward
    t, h, d = 0.035, 0.24, 0.17
    books = [("#7A2E8C", -0.62, "muqaddimah", 1), ("#3A6E4F", 0.0, "kalila", -1), ("#8C3A2E", 0.62, "miserables", 1)]
    for color, dx, cover, binding in books:
        bx = x + dx
        ledge_top = top + 0.02
        corner = Vector((bx, y - 0.06, ledge_top))   # where the plate's front face meets the ledge
        box(f"StandLedge{dx}", (bx, corner.y - 0.022, top + 0.01), (0.3, 0.05, 0.02), mats["brass"], bevel=0.003)
        box(f"StandStop{dx}", (bx, corner.y - 0.044, ledge_top + 0.006), (0.3, 0.006, 0.012), mats["brass"], bevel=0.002)
        plate_c = corner + n * 0.006 + up * (0.14 - 0.02)
        plate = box(f"Stand{dx}", tuple(plate_c), (0.3, 0.012, 0.28), mats["walnut"], bevel=0.003)
        plate.rotation_euler = (-tilt, 0, 0)
        strut_c = Vector((bx, plate_c.y + 0.07, top + 0.08))
        strut = box(f"StandStrut{dx}", tuple(strut_c), (0.03, 0.012, 0.19), mats["walnut"], bevel=0.002)
        strut.rotation_euler = (math.radians(35), 0, 0)
        # The book's back-bottom edge sits on the corner; its origin (bottom centre) is half a
        # thickness in front of it, along the cover normal.
        origin = corner - n * (t / 2 + 0.0004)
        book, pages = add_book(0, 0, 0, t, h, d, color, mats["cloth"], mats["pages"], collection="Desk")
        for o in (book, pages):
            o.location = tuple(origin)
            # Western binding: spine to the viewer's left; Arabic binding: spine to the right.
            o.rotation_euler = Euler((-tilt, 0, math.radians(90 * binding)), "ZXY")
        cover_plate(book, t, h, d, binding, cover)
    pendant("DeskPendant", (x, y, NAVE_HEIGHT), 3.2, mats, power=120.0, radius=0.24)


def cover_plate(book, t, h, d, binding, cover):
    """Gilt foil title and frame on the front cover facing the viewer (a masked plane on the board)."""
    m = M(f"Cover-{cover}")
    img = m.node("ShaderNodeTexImage", extension="CLIP")
    img.image = bpy.data.images.load(str(TEX / f"cover-{cover}.png"))
    m.link(tex_coord(m, "UV"), img.inputs["Vector"])
    m.link(img.outputs["Alpha"], m.bsdf.inputs["Alpha"])
    m.set(**{"Base Color": hex_rgb("#D8B77A"), "Metallic": 1.0, "Roughness": 0.3})
    face_x = -binding * (t / 2 + 0.0004)    # local -x faces the viewer for Western binding
    y0, y1, z0, z1 = -d / 2 + 0.004, d / 2 - 0.008, 0.004, h - 0.004
    mesh = bpy.data.meshes.new(f"Cover-{cover}")
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((face_x, yy, zz)) for yy, zz in ((y0, z0), (y1, z0), (y1, z1), (y0, z1))])
    uv = bm.loops.layers.uv.new("UVMap")
    for loop in face.loops:
        yy, zz = loop.vert.co.y, loop.vert.co.z
        u = (y1 - yy) / (y1 - y0) if binding > 0 else (yy - y0) / (y1 - y0)
        loop[uv].uv = (u, (zz - z0) / (z1 - z0))
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(m.mat)
    obj = bpy.data.objects.new(f"Cover-{cover}", mesh)
    obj.parent = book
    link(obj, "Desk")


def bookcase(name, side, y_face, facing, mats, plate=None):
    """Ash bookcase against a partition, its front facing +y (facing=1) or -y; filled with books."""
    x0, x1 = (2.65, 5.75) if side > 0 else (-5.75, -2.65)
    width = x1 - x0
    cx = (x0 + x1) / 2
    depth, height = 0.36, 2.55
    back_y = y_face - facing * 0.0
    front_y = y_face + facing * depth
    cy = (back_y + front_y) / 2
    box(name + "Back", (cx, back_y + facing * 0.01, height / 2), (width, 0.02, height), mats["ash"], bevel=0.002)
    for sx in (x0, x1):
        box(name + f"Side{sx}", (sx, cy, height / 2), (0.03, depth, height), mats["ash_v"], bevel=0.004)
        # The end panel facing the nave: a range plate at eye level, a mashrabiya insert below it.
        if abs(sx) < 3.0:
            face_x = sx - side * 0.015
            lattice_panel(name + f"Insert{sx}", depth * 0.62, 0.88, 0.11, 0.006, 0.008, mats["screen"], (face_x - side * 0.005, cy, 0.72), rotation=(math.radians(90), 0, math.radians(90)))
            if plate:
                textured_plate(name + "RangePlate", (face_x - side * 0.003, cy, 1.45), (0.006, 0.26, 0.26), Vector((-side, 0, 0)), mat_engraved_brass(TEX / f"sign-range-{plate}.png"))
    box(name + "Top", (cx, cy, height + 0.02), (width + 0.06, depth + 0.03, 0.04), mats["ash"], bevel=0.006)
    box(name + "Crown", (cx, cy + facing * 0.012, height + 0.06), (width + 0.1, depth + 0.05, 0.04), mats["walnut"], bevel=0.008)
    box(name + "Plinth", (cx, cy - facing * 0.015, 0.05), (width, depth - 0.03, 0.1), mats["walnut"], bevel=0.004)
    shelves = [0.1, 0.56, 1.02, 1.48, 1.94, 2.4]
    for k, z in enumerate(shelves):
        box(name + f"Shelf{k}", (cx, cy, z + 0.01), (width - 0.06, depth - 0.02, 0.02), mats["ash"], bevel=0.002)
        box(name + f"Lip{k}", (cx, front_y - facing * 0.012, z + 0.012), (width - 0.06, 0.022, 0.034), mats["walnut"], bevel=0.003)
    # Vertical dividers every ~1 m.
    for k in range(1, 3):
        dx = x0 + k * width / 3
        box(name + f"Divider{k}", (dx, cy, height / 2), (0.022, depth - 0.02, height), mats["ash_v"], bevel=0.003)
    # Books, shelf by shelf, section by section.
    for k, z in enumerate(shelves[:-1]):
        gap = shelves[k + 1] - z - 0.03
        for sec in range(3):
            sx0 = x0 + sec * width / 3 + 0.03
            sx1 = x0 + (sec + 1) * width / 3 - 0.03
            fill_section(sx0, sx1, z + 0.02, gap, front_y, facing, mats)


# Shelf filling. Every book is placed from exact contact geometry: upright books stand on the shelf
# with hairline gaps, spines aligned just behind the shelf lip; rows end against the side panel, a
# bookend block, a leaning book resting on its neighbour, or a flat stack lying fully on the shelf.

SPINE_SETBACK = 0.026   # spine face behind the shelf front (the walnut lip is 23 mm deep)
MAX_DEPTH = 0.27        # keeps fore-edges clear of the back panel


def spine_reach(thickness, depth):
    """Distance from a book's origin to the outermost point of its rounded spine (local +y)."""
    return depth / 2 - 0.004 + min(0.012, thickness * 0.28)


def book_y(front_y, facing, thickness, depth):
    return front_y - facing * (SPINE_SETBACK + rng.uniform(0.0, 0.0015) + spine_reach(thickness, depth))


def upright(x_left, z, t, h, d, color, front_y, facing, mats):
    rot = 0.0 if facing > 0 else math.pi
    add_book(x_left + t / 2, book_y(front_y, facing, t, d), z, t, h, d, color, mats["cloth"], mats["pages"], rot_z=rot)


def leaning(x_contact, contact_h, z, t, h, d, color, front_y, facing, mats, theta):
    """A book leaning left onto a neighbour whose right face is at x_contact (height contact_h).

    It pivots on its bottom-left edge, which rests on the shelf; its left face touches the neighbour's
    top edge (or its top-left corner touches the neighbour's face). Returns its rightmost x.
    """
    if h * math.cos(theta) <= contact_h:
        xb = x_contact + h * math.sin(theta)        # top-left corner on the neighbour's face
    else:
        xb = x_contact + contact_h * math.tan(theta)  # left face on the neighbour's top edge
    xb += 0.0006
    rot = 0.0 if facing > 0 else math.pi
    tilt = -theta if facing > 0 else theta           # top toward -x in world space either way
    half = t / 2
    add_book(xb + half * math.cos(theta), book_y(front_y, facing, t, d), z + half * math.sin(theta), t, h, d, color, mats["cloth"], mats["pages"], rot_z=rot, tilt=tilt)
    return xb + t * math.cos(theta)


def flat_stack(x_left, z, front_y, facing, mats, count, room_above):
    """Books lying flat, largest at the bottom, spines to the front. Returns (right x, top z)."""
    sizes = sorted(((rng.uniform(0.2, 0.27), rng.choice([0.022, 0.028, 0.034, 0.04])) for _ in range(count)), reverse=True)
    base_len = sizes[0][0]
    top = z
    rot = 0.0 if facing > 0 else math.pi
    for h, t in sizes:
        if top + t - z > room_above:
            break
        d = min(MAX_DEPTH, h * rng.uniform(0.68, 0.74))
        offset = (base_len - h) / 2 + rng.uniform(-0.006, 0.006) * (base_len - h > 0.012)
        start = x_left + max(0.0, min(base_len - h, offset))
        # Lying flat: local z (height) runs along world +x (or -x when turned to face -y).
        ox = start if facing > 0 else start + h
        shell, block = add_book(ox, book_y(front_y, facing, t, d), top + t / 2, t, h, d, rng.choice(PALETTE), mats["cloth"], mats["pages"])
        for o in (shell, block):
            o.rotation_euler = Euler((0, math.radians(90), rot))
        top += t
    return x_left + base_len, top


def ornament(x_left, z, front_y, facing, mats, room):
    """A small ceramic vase or brass bowl on top of a stack. Returns its right x."""
    cy = front_y - facing * 0.14
    if rng.random() < 0.5 and room > 0.2:
        h = min(room - 0.04, rng.uniform(0.13, 0.18))
        cylinder("Vase", (x_left + 0.05, cy, z + h / 2), 0.045, h, mats["ceramic"], vertices=48, bevel=0.01, collection="Books")
        return x_left + 0.1
    cylinder("Bowl", (x_left + 0.06, cy, z + 0.025), 0.06, 0.05, mats["brass"], vertices=48, bevel=0.012, collection="Books")
    return x_left + 0.12


def fill_section(sx0, sx1, z, gap, front_y, facing, mats):
    """Fill one shelf compartment (sx0..sx1 between its panels; z is the shelf's top surface)."""
    max_h = gap - 0.04
    style = rng.choices(["full", "bookend", "lean", "stack_end", "stack_start"], weights=[3, 3, 3, 2, 1])[0]
    x = sx0 + 0.002
    end = sx1 - 0.002
    if style == "stack_start":
        right, top = flat_stack(x, z, front_y, facing, mats, rng.randint(2, 4), max_h)
        if rng.random() < 0.35:
            ornament((x + right) / 2 - 0.05, top, front_y, facing, mats, gap - (top - z) - 0.02)
        x = right + rng.uniform(0.01, 0.03)
    reserve = {"full": 0.0, "bookend": rng.uniform(0.05, 0.25), "lean": rng.uniform(0.12, 0.3), "stack_end": 0.3, "stack_start": rng.uniform(0.0, 0.1)}[style]
    stop = end - reserve
    last = None  # (right x, height) of the last upright book
    while True:
        # A run: a set or a few related volumes with the same height and cloth family.
        family = rng.choice(PALETTE)
        series = rng.random() < 0.35
        run_h = min(max_h, rng.choice([0.2, 0.215, 0.23, 0.24, 0.255, 0.27, 0.29, 0.31]))
        run_t = rng.choice([0.024, 0.03, 0.036, 0.044])
        placed = 0
        for _ in range(rng.randint(3, 11)):
            t = run_t if series else rng.choice([0.018, 0.022, 0.026, 0.03, 0.034, 0.04, 0.048, 0.056])
            h = run_h if series else min(max_h, run_h + rng.choice([-0.03, -0.015, 0.0, 0.0, 0.015, 0.03]))
            if x + t > stop:
                break
            d = min(MAX_DEPTH, h * rng.uniform(0.66, 0.74))
            color = family if (series or rng.random() < 0.5) else rng.choice(PALETTE)
            upright(x, z, t, h, d, color, front_y, facing, mats)
            x += t
            last = (x, h)
            x += rng.uniform(0.0004, 0.0018)
            placed += 1
        if placed == 0:
            break
    if last is None:
        return
    if style == "bookend" and last[0] + 0.062 <= end:
        box("Bookend", (last[0] + 0.0005 + 0.03, front_y - facing * (SPINE_SETBACK + 0.075), z + 0.07), (0.06, 0.13, 0.14), mats["marble"], bevel=0.004, collection="Books")
    elif style == "lean":
        t = rng.choice([0.022, 0.028, 0.034])
        h = min(max_h, last[1] + rng.uniform(-0.02, 0.03))
        theta = math.radians(rng.uniform(9, 22))
        # Only if it fits between its neighbour and the panel.
        reach = last[0] + h * math.sin(theta) + t * math.cos(theta) + 0.004
        if reach <= end:
            d = min(MAX_DEPTH, h * 0.7)
            leaning(last[0], last[1], z, t, h, d, rng.choice(PALETTE), front_y, facing, mats, theta)
    elif style == "stack_end":
        start = last[0] + rng.uniform(0.015, 0.04)
        if end - start >= 0.27:
            right, top = flat_stack(start, z, front_y, facing, mats, rng.randint(2, 4), max_h)
            if rng.random() < 0.4:
                ornament((start + right) / 2 - 0.05, top, front_y, facing, mats, gap - (top - z) - 0.02)


# --- Lighting and cameras -----------------------------------------------------------------------


def lighting(scene):
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING" if hasattr(sky, "sky_type") and "MULTIPLE_SCATTERING" in [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items] else "NISHITA"
    sky.sun_disc = False
    sky.sun_elevation = math.radians(SUN_ELEVATION)
    sky.sun_rotation = math.radians(90 - SUN_AZIMUTH)
    sky.sun_intensity = 1.0
    sky.altitude = 200
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.5
    # Sun (explicit, for crisp lattice shadows).
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 6.5
    sun.angle = math.radians(0.6)
    sun.color = (1.0, 0.9, 0.76)
    so = bpy.data.objects.new("Sun", sun)
    el, az = math.radians(SUN_ELEVATION), math.radians(SUN_AZIMUTH)
    to_sun = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    so.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    link(so, "Lights")
    # Skylight portals: soft daylight down the wells (cool, ~5000 K).
    for y in [1.6, 5.0, 9.7, 13.1, 16.0]:
        area = bpy.data.lights.new(f"SkyFill{y}", "AREA")
        area.shape = "RECTANGLE"
        area.size, area.size_y = 3.2, 1.6
        area.energy = 140.0
        area.color = (0.92, 0.95, 1.0)
        ao = bpy.data.objects.new(f"SkyFill{y}", area)
        ao.location = (0, y, NAVE_HEIGHT + 1.05)
        link(ao, "Lights")
    # Clerestory daylight into the nave.
    for s in (-1, 1):
        for a, b in [(1.2, 3.2), (4.2, 6.2), (8.4, 10.6), (11.8, 14.0), (15.2, 17.1)]:
            area = bpy.data.lights.new(f"Clere{s}{a}", "AREA")
            area.shape = "RECTANGLE"
            area.size, area.size_y = b - a, 1.2
            area.energy = 25.0
            area.color = (0.93, 0.96, 1.0)
            ao = bpy.data.objects.new(f"Clere{s}{a}", area)
            ao.location = (s * (NAVE_HALF + 0.4), (a + b) / 2, (AISLE_HEIGHT + NAVE_HEIGHT) / 2 + 0.3)
            ao.rotation_euler = Euler((0, math.radians(-90 * s), 0))
            link(ao, "Lights")
    # Soft fill in the side aisles (bounce from the windows behind).
    for side, y0, y1, name, _ in BAYS:
        area = bpy.data.lights.new(f"AisleFill{name}", "AREA")
        area.shape = "RECTANGLE"
        area.size, area.size_y = 2.6, 2.6
        area.energy = 20.0
        area.color = (1.0, 0.92, 0.82)
        ao = bpy.data.objects.new(f"AisleFill{name}", area)
        ao.location = (side * 4.3, (y0 + y1) / 2, AISLE_HEIGHT - 0.05)
        link(ao, "Lights")
        # Warm wall-washer grazing the bay's back wall.
        wash = bpy.data.lights.new(f"Wash{name}", "AREA")
        wash.shape = "RECTANGLE"
        wash.size, wash.size_y = 0.15, 2.6
        wash.energy = 90.0
        wash.color = (1.0, 0.8, 0.58)
        wo = bpy.data.objects.new(f"Wash{name}", wash)
        wo.location = (side * (INNER_HALF - 0.35), (y0 + y1) / 2, AISLE_HEIGHT - 0.1)
        wo.rotation_euler = Euler((0, math.radians(-28 * side), 0))
        link(wo, "Lights")


SHOTS = {
    # name: (location, look-at, focal length mm)
    "entrance": ((0.0, 0.45, 1.62), (0.0, 7.0, 1.02), 22),
    "nave": ((0.6, 7.2, 1.62), (-0.2, 16.0, 2.4), 24),
    "bay": ((4.0, 13.05, 1.32), (4.0, 11.8, 1.02), 40),
    "desk": ((-1.6, 2.4, 1.45), (0.1, 4.6, 1.05), 32),
    "overview": ((-1.8, 0.8, 3.4), (0.6, 10.0, 1.3), 18),
    "bayview": ((0.4, 8.5, 1.6), (5.2, 10.3, 1.35), 22),
}


def camera(scene, shot):
    loc, target, lens = SHOTS[shot]
    cam_data = bpy.data.cameras.new(f"Camera-{shot}")
    cam_data.lens = lens
    cam_data.sensor_width = 36
    cam = bpy.data.objects.new(f"Camera-{shot}", cam_data)
    cam.location = loc
    direction = Vector(target) - Vector(loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if shot in ("bay", "desk"):
        cam_data.dof.use_dof = True
        cam_data.dof.focus_distance = direction.length
        cam_data.dof.aperture_fstop = 2.8 if shot == "bay" else 4.0
    link(cam, "Cameras")
    return cam


def obb(obj):
    """World-space oriented box of an object's local bounding box: (centre, axes, half sizes)."""
    mw = obj.matrix_world
    bb = [Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in bb), min(c.y for c in bb), min(c.z for c in bb)))
    hi = Vector((max(c.x for c in bb), max(c.y for c in bb), max(c.z for c in bb)))
    rot = mw.to_3x3()
    axes = [rot.col[i].normalized() for i in range(3)]
    scale = [rot.col[i].length for i in range(3)]
    centre = mw @ ((lo + hi) / 2)
    half = [(hi[i] - lo[i]) / 2 * scale[i] for i in range(3)]
    return centre, axes, half


def obb_overlap(a, b, tol=0.0002):
    """Separating axis test; True when the boxes overlap by more than tol."""
    (ca, aa, ha), (cb, ab, hb) = a, b
    d = cb - ca
    axes = list(aa) + list(ab)
    for u in aa:
        for v in ab:
            w = u.cross(v)
            if w.length > 1e-6:
                axes.append(w.normalized())
    for ax in axes:
        ra = sum(ha[i] * abs(aa[i].dot(ax)) for i in range(3))
        rb = sum(hb[i] * abs(ab[i].dot(ax)) for i in range(3))
        if abs(d.dot(ax)) > ra + rb - tol:
            return False
    return True


def collision_report():
    """Check every shelf book against nearby books and bookcase parts, and that each one is supported."""
    bpy.context.view_layer.update()
    books = [o for o in bpy.data.collections["Books"].objects if o.name.startswith("Book") and not o.name.startswith("BookPages") and o.type == "MESH" and not o.name.startswith("Bookend")]
    others = [o for o in bpy.data.collections["Books"].objects if o.name.startswith(("Bookend", "Vase", "Bowl"))]
    wood = [o for o in bpy.data.collections["Hall"].objects if o.name.startswith("Bookcase") and o.type == "MESH" and "Insert" not in o.name]
    boxes = {o.name: obb(o) for o in books + others + wood}
    grid: dict[tuple, list] = {}
    for o in books + others:
        c = boxes[o.name][0]
        grid.setdefault((round(c.x / 0.5), round(c.y / 0.5), round(c.z / 0.5)), []).append(o)
    def near(o):
        c = boxes[o.name][0]
        k = (round(c.x / 0.5), round(c.y / 0.5), round(c.z / 0.5))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    yield from grid.get((k[0] + dx, k[1] + dy, k[2] + dz), [])
    hits_bb, hits_wood, floating = [], [], []
    names = [o.name for o in books + others]
    order = {n: i for i, n in enumerate(names)}
    for o in books + others:
        for q in near(o):
            if order[q.name] <= order[o.name]:
                continue
            if obb_overlap(boxes[o.name], boxes[q.name]):
                hits_bb.append((o.name, q.name))
    for o in books + others:
        c = boxes[o.name][0]
        for w in wood:
            cw = boxes[w.name][0]
            if (cw - c).length > 2.5:
                continue
            if obb_overlap(boxes[o.name], boxes[w.name]):
                hits_wood.append((o.name, w.name))
    # Support: the lowest corner must touch a shelf top or another book's top (within 1 mm).
    def corners(b):
        c, ax, h = b
        return [c + ax[0] * sx * h[0] + ax[1] * sy * h[1] + ax[2] * sz * h[2] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    tops = sorted({round(max(p.z for p in corners(boxes[w.name])), 4) for w in wood if "Shelf" in w.name})
    book_tops = {o.name: max(p.z for p in corners(boxes[o.name])) for o in books}
    for o in books + others:
        zmin = min(p.z for p in corners(boxes[o.name]))
        ok = any(abs(zmin - t) < 0.001 for t in tops)
        if not ok:
            ok = any(abs(zmin - book_tops[q.name]) < 0.001 for q in near(o) if q.name in book_tops and q is not o)
        if not ok:
            floating.append((o.name, round(zmin, 4)))
    print(f"check: {len(books)} books, {len(others)} props, {len(wood)} bookcase parts")
    print(f"check: book/prop overlaps: {len(hits_bb)}; into wood: {len(hits_wood)}; unsupported: {len(floating)}")
    for row in (hits_bb[:10], hits_wood[:10], floating[:10]):
        for item in row:
            print("  ", item)
    return not (hits_bb or hits_wood or floating)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--shot", default="entrance", help="comma-separated shot names")
    parser.add_argument("--res", type=int, default=960)
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--outdir", default=str(HERE / "renders"))
    parser.add_argument("--tag", default="")
    parser.add_argument("--blend", default="")
    parser.add_argument("--exposure", type=float, default=0.0)
    parser.add_argument("--counts", default="", help="build, write the books per section as JSON to this path, no render")
    parser.add_argument("--check", action="store_true", help="build, run the collision report, no render")
    parser.add_argument("--haze", type=float, default=0.0, help="volume density inside the hall, e.g. 0.004")
    args = parser.parse_args(argv)
    scene = reset()
    build(scene)
    if args.counts:
        Path(args.counts).write_text(json.dumps(SECTION_COUNTS))
        print("counts", SECTION_COUNTS)
        sys.exit(0)
    if args.check:
        sys.exit(0 if collision_report() else 1)
    lighting(scene)
    if args.haze > 0:
        haze = M("Haze")
        haze.nodes.remove(haze.bsdf)
        vol = haze.node("ShaderNodeVolumePrincipled")
        vol.inputs["Density"].default_value = args.haze
        vol.inputs["Anisotropy"].default_value = 0.45
        vol.inputs["Color"].default_value = hex_rgb("#F2EEE6")
        haze.link(vol.outputs["Volume"], haze.out.inputs["Volume"])
        box("HazeVolume", (0, LENGTH / 2, NAVE_HEIGHT / 2 + 0.6), (INNER_HALF * 2 - 0.02, LENGTH - 0.02, NAVE_HEIGHT + 1.2), haze.mat, bevel=0)
        scene.cycles.volume_bounces = 1
    shots = [name.strip() for name in args.shot.split(",") if name.strip()]
    cams = {name: camera(scene, name) for name in shots}
    scene.view_settings.exposure = args.exposure
    scene.cycles.samples = args.samples
    scene.render.resolution_x = args.res
    scene.render.resolution_y = round(args.res * 9 / 16)
    scene.render.image_settings.file_format = "PNG"
    outdir = Path(args.outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    if args.blend:
        scene.camera = cams[shots[0]]
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.blend).resolve()))
    books = len(bpy.data.collections["Books"].objects) // 2
    print(f"scene: {len(bpy.data.objects)} objects, {books} books", flush=True)
    for name in shots:
        scene.camera = cams[name]
        out = outdir / f"{name}{args.tag}.png"
        scene.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        print("done", out, flush=True)


if __name__ == "__main__":
    main()
