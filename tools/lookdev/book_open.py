"""Book-opening look-development (Blender 5.2 as a Python module, Cycles).

An Arabic hardcover (right-to-left binding) arrives in front of the reader, its front cover
swings open on the spine, a riffle of leaves follows to the bookmarked spread, the pages settle
with a soft gutter curve, and the camera pushes in to show the print. The textures come from
book_pages.mjs (tex/book/).

    python book_open.py --res 1280 --samples 32 --outdir renders/book [--frames 1-156] [--still 120]

Axes: the book lies in the x-y plane (y = the page's height, up on screen), z toward the
camera. The spine is the y axis; the front cover's hinge runs along it at height ZH.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy  # noqa: I001  (bpy must load before bmesh)
import bmesh
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from hall import M, bump, hex_rgb, link, reset, tex_coord  # noqa: E402

TEX = HERE / "tex" / "book"
FPS = 24

# Book (metres): page height H, page width D, board thickness TB, board overhang O, block T.
H, D, TB, O, T = 0.24, 0.17, 0.0028, 0.003, 0.032
ZH = TB + T / 2           # the hinge axis height (and the open spread's page level)
LEAVES = 8
DELTA = (T / 2) / LEAVES  # pages carried by each riffled leaf
CLOTH = "#2C4A3B"


def frame(seconds: float) -> int:
    return round(seconds * FPS) + 1


def ease(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return 4 * t**3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return 1 - (1 - t) ** 3


def keys(obj, path: str, values, index: int = -1):
    """Insert keyframes from (seconds, value) pairs; interpolation is linear between our own
    eased samples, so sample densely where the motion is eased."""
    for seconds, value in values:
        target = obj
        if index >= 0:
            getattr(target, path)[index] = value
            target.keyframe_insert(path, index=index, frame=frame(seconds))
        else:
            setattr(target, path, value)
            target.keyframe_insert(path, frame=frame(seconds))


def eased_samples(t0: float, t1: float, v0: float, v1: float, fn=ease, step: float = 1 / FPS):
    n = max(1, round((t1 - t0) / step))
    return [(t0 + (t1 - t0) * i / n, v0 + (v1 - v0) * fn(i / n)) for i in range(n + 1)]


def linear_fcurves():
    for action in bpy.data.actions:
        for layer in getattr(action, "layers", []):
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for point in curve.keyframe_points:
                            point.interpolation = "LINEAR"
        for curve in getattr(action, "fcurves", []):
            for point in curve.keyframe_points:
                point.interpolation = "LINEAR"


# --- Materials --------------------------------------------------------------------------------


def image(name: str):
    return bpy.data.images.load(str(TEX / f"{name}.png"), check_existing=True)


def mat_cloth(name: str, mask: str | None) -> bpy.types.Material:
    """Book cloth with a fine weave; where the mask is white, gilt foil pressed into it."""
    m = M(name)
    weave = m.node("ShaderNodeTexNoise", Scale=1400.0, Detail=1.0)
    m.link(tex_coord(m, "Object"), weave.inputs["Vector"])
    m.set(**{"Base Color": hex_rgb(CLOTH), "Roughness": 0.78})
    m.bsdf.inputs["Sheen Weight"].default_value = 0.35
    if mask is None:
        bump(m, weave.outputs["Fac"], strength=0.15, distance=0.0004)
        return m.mat
    img = m.node("ShaderNodeTexImage", extension="CLIP", interpolation="Cubic")
    img.image = image(mask)
    m.link(tex_coord(m, "UV"), img.inputs["Vector"])
    color = m.node("ShaderNodeMix", data_type="RGBA")
    m.link(img.outputs["Alpha"], color.inputs["Factor"])
    color.inputs["A"].default_value = hex_rgb(CLOTH)
    color.inputs["B"].default_value = hex_rgb("#D8B77A")
    m.link(color.outputs["Result"], m.bsdf.inputs["Base Color"])
    m.link(img.outputs["Alpha"], m.bsdf.inputs["Metallic"])
    rough = m.node("ShaderNodeMix", data_type="FLOAT")
    m.link(img.outputs["Alpha"], rough.inputs["Factor"])
    rough.inputs["A"].default_value = 0.78
    rough.inputs["B"].default_value = 0.28
    m.link(rough.outputs["Result"], m.bsdf.inputs["Roughness"])
    # Foil is pressed in: the mask lowers the surface; the weave stays on the cloth.
    height = m.node("ShaderNodeMath", operation="MULTIPLY_ADD")
    m.link(img.outputs["Alpha"], height.inputs[0])
    height.inputs[1].default_value = -1.0
    m.link(weave.outputs["Fac"], height.inputs[2])
    bump(m, height.outputs["Value"], strength=0.35, distance=0.0006)
    return m.mat


def mat_paper(name: str, front: str, back: str | None = None) -> bpy.types.Material:
    """A printed page (UV mapped); with `back`, the other side of the leaf shows another page."""
    m = M(name)
    uv = tex_coord(m, "UV")
    a = m.node("ShaderNodeTexImage", interpolation="Cubic")
    a.image = image(front)
    m.link(uv, a.inputs["Vector"])
    color = a.outputs["Color"]
    if back:
        flip = m.node("ShaderNodeMapping")
        flip.inputs["Scale"].default_value = (-1.0, 1.0, 1.0)
        flip.inputs["Location"].default_value = (1.0, 0.0, 0.0)
        m.link(uv, flip.inputs["Vector"])
        b = m.node("ShaderNodeTexImage", interpolation="Cubic")
        b.image = image(back)
        m.link(flip.outputs["Vector"], b.inputs["Vector"])
        geo = m.node("ShaderNodeNewGeometry")
        mix = m.node("ShaderNodeMix", data_type="RGBA")
        m.link(geo.outputs["Backfacing"], mix.inputs["Factor"])
        m.link(a.outputs["Color"], mix.inputs["A"])
        m.link(b.outputs["Color"], mix.inputs["B"])
        color = mix.outputs["Result"]
    m.link(color, m.bsdf.inputs["Base Color"])
    m.set(Roughness=0.86)
    return m.mat


def mat_page_edges() -> bpy.types.Material:
    """The block's cut edges: warm paper with the fine lines of stacked leaves."""
    m = M("PageEdges")
    co = tex_coord(m, "Object")
    lines = m.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z")
    lines.inputs["Scale"].default_value = 2600.0
    lines.inputs["Distortion"].default_value = 2.0
    m.link(co, lines.inputs["Vector"])
    ramp = m.node("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hex_rgb("#D9CDB4")
    ramp.color_ramp.elements[1].color = hex_rgb("#F1E9D8")
    m.link(lines.outputs["Fac"], ramp.inputs["Fac"])
    m.link(ramp.outputs["Color"], m.bsdf.inputs["Base Color"])
    m.set(Roughness=0.9)
    return m.mat


# --- Geometry ---------------------------------------------------------------------------------


def slab(name: str, x0: float, x1: float, y0: float, y1: float, z0: float, z1: float, top, side, bottom=None,
         nx: int = 1, top_uv_flip: bool = False, bottom_uv_flip: bool = False, origin=(0.0, 0.0, 0.0)) -> bpy.types.Object:
    """A box with separate materials and UVs on its top (+z) and bottom (-z) faces; `nx` splits it
    along x (for the gutter curve)."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    ox, oy, oz = origin
    xs = [x0 + (x1 - x0) * i / nx for i in range(nx + 1)]
    top_v = [[bm.verts.new((x - ox, y - oy, z1 - oz)) for y in (y0, y1)] for x in xs]
    bot_v = [[bm.verts.new((x - ox, y - oy, z0 - oz)) for y in (y0, y1)] for x in xs]

    def face(verts, mat_index, uv_of=None):
        f = bm.faces.new(verts)
        f.material_index = mat_index
        f.smooth = False
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = uv_of(co.x + ox, co.y + oy) if uv_of else (0.0, 0.0)
        return f

    def uv_top(x, y):
        u = (x - x0) / (x1 - x0)
        return (1 - u if top_uv_flip else u, (y - y0) / (y1 - y0))

    def uv_bottom(x, y):
        u = (x - x0) / (x1 - x0)
        return (1 - u if bottom_uv_flip else u, (y - y0) / (y1 - y0))

    for i in range(nx):
        face([top_v[i][0], top_v[i + 1][0], top_v[i + 1][1], top_v[i][1]], 0, uv_top)
        face([bot_v[i][1], bot_v[i + 1][1], bot_v[i + 1][0], bot_v[i][0]], 2, uv_bottom)
        face([bot_v[i][0], bot_v[i + 1][0], top_v[i + 1][0], top_v[i][0]], 1)
        face([top_v[i][1], top_v[i + 1][1], bot_v[i + 1][1], bot_v[i][1]], 1)
    face([bot_v[0][1], bot_v[0][0], top_v[0][0], top_v[0][1]], 1)
    face([bot_v[nx][0], bot_v[nx][1], top_v[nx][1], top_v[nx][0]], 1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    for material in (top, side, bottom or side):
        mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = origin
    bevel = obj.modifiers.new("Bevel", "BEVEL")
    bevel.width, bevel.segments, bevel.limit_method = 0.0006, 2, "ANGLE"
    return link(obj, "Book")


def gutter_shape_key(obj: bpy.types.Object, side: int, depth: float = 0.009, reach: float = 0.03):
    """A shape key that dips the top surface into the gutter (x = 0) like an open book."""
    obj.shape_key_add(name="Basis")
    key = obj.shape_key_add(name="Gutter")
    top = max(v.co.z for v in obj.data.vertices)
    for i, v in enumerate(obj.data.vertices):
        world_x = v.co.x + obj.location.x
        distance = abs(world_x)
        if v.co.z > top - 1e-6 and distance < reach:
            key.data[i].co.z -= depth * (1 - distance / reach) ** 2
    return key


def leaf(name: str, z_offset: float, material) -> bpy.types.Object:
    """One leaf lying on the left of the spine, pivoting on the hinge axis; it curls while moving."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    n = 48
    xs = [-(D - 0.0015) + (D - 0.0025) * i / n for i in range(n + 1)]
    rows = [[bm.verts.new((x, y, z_offset)) for y in (-H / 2, H / 2)] for x in xs]
    for i in range(n):
        f = bm.faces.new([rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]])
        f.smooth = True
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = ((co.x - xs[0]) / (xs[-1] - xs[0]), (co.y + H / 2) / H)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = (0, 0, ZH)
    curl = obj.modifiers.new("Curl", "SIMPLE_DEFORM")
    curl.deform_method = "BEND"
    curl.deform_axis = "Y"
    curl.angle = 0.0
    return link(obj, "Book")


# --- Scene ------------------------------------------------------------------------------------


def build():
    cloth_plain = mat_cloth("Cloth", None)
    cover_out = mat_cloth("CoverFoil", "cover-mask")
    spine_mat = mat_cloth("SpineFoil", "spine-mask")
    endpaper = mat_paper("Endpaper", "endpaper")
    edges = mat_page_edges()

    root = bpy.data.objects.new("BookRoot", None)
    link(root, "Book")

    def child(obj):
        obj.parent = root
        return obj

    # Back cover (static, lying on the backdrop) and the remaining pages on it (left side).
    child(slab("BackCover", -(D + O), -0.0015, -(H / 2 + O), H / 2 + O, 0.0, TB, endpaper, cloth_plain, cloth_plain))
    left = child(slab("LeftBlock", -D, -0.0012, -H / 2, H / 2, TB, TB + T, mat_paper("LeftPage", "page-cont"), edges, nx=40,
                      origin=(0.0, 0.0, TB)))
    gutter_left = gutter_shape_key(left, -1)
    # Pages that have crossed over (right side), growing as leaves land.
    right = child(slab("RightBlock", 0.0012, D, -H / 2, H / 2, TB, TB + T, mat_paper("RightPage", "page-chapter"), edges, nx=40,
                       origin=(0.0, 0.0, TB)))
    gutter_right = gutter_shape_key(right, 1)
    # Front cover: hinged on the spine axis at ZH; outside foil faces the camera when closed.
    front = child(slab("FrontCover", -(D + O), -0.0015, -(H / 2 + O), H / 2 + O, TB + T, 2 * TB + T, cover_out, cloth_plain,
                       endpaper, bottom_uv_flip=True, origin=(0.0, 0.0, ZH)))
    # Spine: a shallow rounded shell between the boards, turning half as far as the cover.
    spine = bpy.data.meshes.new("Spine")
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    steps = 24
    rz, rx = T / 2 + TB, 0.005
    ring = [(rx * math.cos(a), rz * math.sin(a)) for a in (math.pi * (-0.5 + i / steps) for i in range(steps + 1))]
    cols = [[bm.verts.new((x, y, z)) for y in (-(H / 2 + O), H / 2 + O)] for x, z in ring]
    for i in range(steps):
        f = bm.faces.new([cols[i][0], cols[i + 1][0], cols[i + 1][1], cols[i][1]])
        f.smooth = True
        for loop in f.loops:
            co = loop.vert.co
            # Text runs along the height, read with the book's head to the right of the reader.
            loop[uvl].uv = ((co.y + H / 2 + O) / (H + 2 * O), 1 - (co.z / rz + 1) / 2)
    bm.to_mesh(spine)
    bm.free()
    spine.materials.append(spine_mat)
    spine_obj = child(link(bpy.data.objects.new("Spine", spine), "Book"))
    spine_obj.location = (0, 0, ZH)
    solid = spine_obj.modifiers.new("Board", "SOLIDIFY")
    solid.thickness = TB * 0.8
    # Headbands at the head and tail of the block.
    band = M("Headband")
    stripes = band.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z")
    stripes.inputs["Scale"].default_value = 260.0
    band.link(tex_coord(band, "Object"), stripes.inputs["Vector"])
    ramp = band.node("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hex_rgb("#7A2230")
    ramp.color_ramp.elements[1].color = hex_rgb("#D8B77A")
    ramp.color_ramp.interpolation = "CONSTANT"
    band.link(stripes.outputs["Fac"], ramp.inputs["Fac"])
    band.link(ramp.outputs["Color"], band.bsdf.inputs["Base Color"])
    band.set(Roughness=0.5)
    for sy in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.0022, depth=T * 0.96, location=(-0.0012, sy * (H / 2 - 0.0008), T / 2))
        head = bpy.context.active_object
        head.data.materials.append(band.mat)
        for c in head.users_collection:
            c.objects.unlink(head)
        link(head, "Book")
        head.parent = left

    # Leaves for the riffle (each carries DELTA of the pages across).
    textures = [("endpaper", "endpaper"), ("page-a", "page-b"), ("page-c", "page-d"), ("page-a", "page-b"),
                ("page-c", "page-d"), ("page-a", "page-b"), ("page-c", "page-d"), ("page-cont", "page-chapter")]
    leaves = []
    for k, (front_tex, back_tex) in enumerate(textures, start=1):
        # Mirrored about the hinge, a leaf starting at height ZH + z lands at ZH - z: just above
        # the right block's top once this leaf's share of pages has crossed over.
        z = (TB + T - k * DELTA) - ZH - 0.0004
        lf = child(leaf(f"Leaf{k}", z, mat_paper(f"Leaf{k}", front_tex, back_tex)))
        leaves.append(lf)

    # The backdrop: the reader's ink, with a soft light pool.
    ink = M("Ink")
    ink.set(**{"Base Color": hex_rgb("#151823"), "Roughness": 0.95})
    ink.bsdf.inputs["Sheen Weight"].default_value = 0.4
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, -0.0004))
    plane = bpy.context.active_object
    plane.data.materials.append(ink.mat)
    return root, left, right, front, spine_obj, leaves, gutter_left, gutter_right


def animate(root, left, right, front, spine, leaves, gutter_left, gutter_right):
    # 0-0.7 s: the closed book arrives, tilted, and settles flat in front of the reader.
    half = (D + O) / 2
    keys(root, "location", [(s, v) for s, v in eased_samples(0.0, 0.75, -0.30, 0.0, ease_out)], index=1)
    keys(root, "location", [(s, v) for s, v in eased_samples(0.0, 0.75, 0.06, 0.0, ease_out)], index=2)
    keys(root, "rotation_euler", [(s, v) for s, v in eased_samples(0.0, 0.75, math.radians(-28), 0.0, ease_out)], index=0)
    # 0.8-2.0 s: the cover swings open; the book slides so the spread ends centred.
    keys(root, "location", [(0.0, half)] + eased_samples(0.8, 2.0, half, 0.0), index=0)
    keys(front, "rotation_euler", [(0.0, 0.0)] + eased_samples(0.8, 2.0, 0.0, math.pi), index=1)
    keys(spine, "rotation_euler", [(0.0, 0.0)] + eased_samples(0.8, 2.0, 0.0, math.pi / 2), index=1)
    # Pages curve into the gutter as the book opens.
    keys(gutter_left, "value", [(0.0, 0.0)] + eased_samples(1.0, 2.4, 0.0, 1.0))
    keys(gutter_right, "value", [(0.0, 0.0)] + eased_samples(1.0, 2.4, 0.0, 1.0))
    # 1.45-2.8 s: the riffle follows the cover. Each leaf lifts off the left, curls, and lands on
    # the right; the right block appears under the first one.
    left_t = [(0.0, 1.0)]
    right_t = [(0.0, 0.002)]
    flip = 0.6
    first_landing = 1.45 + flip
    for attr in ("hide_render", "hide_viewport"):
        setattr(right, attr, True)
        right.keyframe_insert(attr, frame=1)
        setattr(right, attr, False)
        right.keyframe_insert(attr, frame=frame(first_landing))
    for k, lf in enumerate(leaves, start=1):
        start = 1.45 + 0.11 * (k - 1)
        end = start + flip
        keys(lf, "rotation_euler", [(0.0, 0.0)] + eased_samples(start, end, 0.0, math.pi), index=1)
        curl = lf.modifiers["Curl"]
        samples = [(0.0, 0.0)] + [(s, -0.55 * math.sin(math.pi * (s - start) / flip)) for s, _ in eased_samples(start, end, 0, 1)]
        for s, v in samples:
            curl.angle = v
            lf.keyframe_insert('modifiers["Curl"].angle', frame=frame(s))
        left_t += [(start, (T - (k - 1) * DELTA) / T), (start + 2 / FPS, (T - k * DELTA) / T)]
        right_t += [(end - 2 / FPS, max(0.002, (k - 1) * DELTA / T)), (end, k * DELTA / T)]
        # A landed leaf hides once the next one lands on it (the block's top shows the page).
        if k < len(leaves):
            hide_at = 1.45 + 0.11 * k + flip
            for attr in ("hide_render", "hide_viewport"):
                setattr(lf, attr, False)
                lf.keyframe_insert(attr, frame=frame(hide_at) - 1)
                setattr(lf, attr, True)
                lf.keyframe_insert(attr, frame=frame(hide_at))
    keys(left, "scale", left_t, index=2)
    keys(right, "scale", right_t, index=2)
    linear_fcurves()


def camera_rig(scene):
    data = bpy.data.cameras.new("Camera")
    data.lens = 50
    data.sensor_width = 36
    cam = bpy.data.objects.new("Camera", data)
    link(cam, "Cameras")
    scene.camera = cam
    target = bpy.data.objects.new("CameraTarget", None)
    link(target, "Cameras")
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis, track.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    start_cam, end_cam = (0.0, -0.27, 0.80), (0.085, -0.075, 0.34)
    start_tgt, end_tgt = (0.0, 0.0, 0.015), (0.088, 0.035, ZH)
    for i in range(3):
        keys(cam, "location", [(0.0, start_cam[i])] + eased_samples(3.3, 5.4, start_cam[i], end_cam[i]), index=i)
        keys(target, "location", [(0.0, start_tgt[i])] + eased_samples(3.3, 5.4, start_tgt[i], end_tgt[i]), index=i)
    data.dof.use_dof = True
    data.dof.focus_object = target
    data.dof.aperture_fstop = 4.0
    linear_fcurves()


def lights():
    def area(name, location, rotation, size, energy, color, spread=180.0):
        light = bpy.data.lights.new(name, "AREA")
        light.shape = "DISK"
        light.size, light.energy, light.color = size, energy, color
        light.spread = math.radians(spread)
        obj = bpy.data.objects.new(name, light)
        obj.location = location
        obj.rotation_euler = rotation
        link(obj, "Lights")

    # Warm key from the upper left, a cool soft fill, a faint rim on the right.
    # The key is focused (spread) so it pools on the book and falls off into the ink around it.
    area("Key", (-0.45, 0.35, 0.75), (math.radians(-30), math.radians(-28), 0), 0.5, 30.0, (1.0, 0.86, 0.7), spread=55.0)
    area("Fill", (0.6, -0.5, 0.6), (math.radians(40), math.radians(40), 0), 1.0, 7.0, (0.85, 0.9, 1.0))
    area("Rim", (0.55, 0.45, 0.25), (math.radians(-60), math.radians(55), 0), 0.4, 6.0, (1.0, 0.9, 0.8))
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgb("#0E1018")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--res", type=int, default=1280)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--outdir", default=str(HERE / "renders" / "book"))
    parser.add_argument("--frames", default="", help="first-last, e.g. 1-156 (default: all)")
    parser.add_argument("--still", type=int, default=0, help="render one frame as still-NNN.png")
    parser.add_argument("--blend", default="")
    args = parser.parse_args(argv)
    scene = reset()
    scene.view_settings.look = "AgX - Medium High Contrast"
    root, left, right, front, spine, leaves, gl, gr = build()
    animate(root, left, right, front, spine, leaves, gl, gr)
    camera_rig(scene)
    lights()
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, frame(6.5)
    scene.cycles.samples = args.samples
    scene.render.resolution_x = args.res
    scene.render.resolution_y = round(args.res * 9 / 16)
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.5
    scene.render.image_settings.file_format = "PNG"
    out = Path(args.outdir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.blend).resolve()))
    if args.still:
        scene.frame_set(args.still)
        scene.render.filepath = str(out / f"still-{args.still:03d}.png")
        bpy.ops.render.render(write_still=True)
        print("done", scene.render.filepath, flush=True)
        return
    first, last = (int(v) for v in args.frames.split("-")) if args.frames else (scene.frame_start, scene.frame_end)
    for f in range(first, last + 1):
        target = out / f"{f:04d}.png"
        if target.exists():
            continue
        scene.frame_set(f)
        scene.render.filepath = str(target)
        bpy.ops.render.render(write_still=True)
        print("frame", f, flush=True)
    print("done", out, flush=True)


if __name__ == "__main__":
    main()
