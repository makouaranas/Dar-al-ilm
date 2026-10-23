"use client";

/**
 * The library hall's architecture, materials and light (docs/DESIGN.md sections 2-4,
 * docs/ARCHITECTURE.md sections 9.4 and 10.6).
 *
 * A tall limestone nave lit by mashrabiya-screened skylights set in deep wells between plaster
 * beams, whose star pattern falls on the floor as a static light map; a limestone arcade along
 * both nave edges, its beam carried by fluted columns at every bay boundary; a clerestory with
 * lattice windows above it; lower side aisles under slatted ash ceilings, divided into one bay
 * per category, each lit by an arched lattice window in its back wall; window seats in the
 * entrance zone; a pointed entrance arch, an arched reading niche at the far end, and the
 * Entrance Desk under a warm brass pendant.
 *
 * Static geometry is merged per material, so the whole room is about twenty draw calls
 * however many categories there are. Nothing animates: the scene renders only when the camera
 * moves.
 */

import { Environment, Lightformer, useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { CategoryShelves, bookcaseParts } from "@/components/3d/Bookcase";
import { BookPresenter } from "@/components/3d/BookPresenter";
import { SpineAtlasContext } from "@/components/3d/BookSpine";
import { DESK_STANDS, EntranceDesk, standPlateCenter } from "@/components/3d/EntranceDesk";
import { Signage, signageParts } from "@/components/3d/Signage";
import type { Book, GraphicsQuality } from "@/lib/api";
import { ensureCanvasFonts } from "@/lib/canvasText";
import { ARCADE, BOOKCASE, DESK, HALL, SHELF_FRONT_Z, SHELF_HEIGHTS, WINDOW_SEAT, bookSize, placeBooks, type HallLayout } from "@/lib/hallLayout";
import { ATLAS_CONFIG, SpineAtlas, atlasPages, planResident, type AtlasBay, type AtlasPage } from "@/lib/spineAtlas";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

// --- Palette (docs/DESIGN.md section 4) -------------------------------------------------------

export const HALL_COLORS = {
  limestone: "#E7E3DB",
  plaster: "#EEEBE5",
  ash: "#C8B699",
  walnut: "#5A4636",
  brass: "#B08A4E",
  lapis: "#2C4C9C",
  mashrabiya: "#3A3026",
  daylight: "#EEF2F8", // ~5000 K, neutral-cool
  lamp: "#FFB86E", // ~2700 K
  washer: "#FFC88F", // ~3000 K
} as const;

const TEXTURES = {
  floor: "/textures/limestone-floor.webp",
  limestone: "/textures/limestone.webp",
  ash: "/textures/ash.webp",
  walnut: "/textures/walnut.webp",
  plaster: "/textures/plaster.webp",
  mashrabiya: "/textures/mashrabiya.webp",
  floorLight: "/textures/floor-light.webp",
  medallion: "/textures/medallion.webp",
  medallionMr: "/textures/medallion-mr.webp",
  halo: "/textures/halo.webp",
  wallWash: "/textures/wall-wash.webp",
  shadeGlow: "/textures/shade-glow.webp",
  contact: "/textures/contact.webp",
};

const ANISOTROPY: Record<GraphicsQuality, number> = { performance: 2, auto: 4, high: 8 };

/**
 * Draw order of the opaque room meshes. They are merged at the origin, so three.js cannot sort
 * them front to back by distance: books, furniture and columns go first, the big shells (floor,
 * walls, ceilings) after them, and what is only seen through openings (the day, the lattices)
 * last, so the depth test rejects the hidden pixels instead of shading them twice.
 */
const DRAW_ORDER = { furniture: 1, shell: 2, beyond: 3 } as const;

/** Skylight light map: one 4.0 x 3.4 m tile per skylight, its patch 1.1 m past the tile start. */
const LIGHT_TILE = 3.4;
const LIGHT_PATCH_OFFSET = 1.1;
export const MEDALLION = { z: 3.0, radius: 0.85 } as const;
const DESK_PENDANT_Y = 2.75;
const BAY_LAMP_INSET = 0.85;
const BAY_PENDANT_Y = 2.85;

/** The clerestory wall stands on the arcade line, above the beam, up to the nave ceiling. */
const CLERESTORY = { thickness: 0.24, sill: 4.1, head: 5.5, bayWindow: 2.2, entranceWindow: 1.6 } as const;
/** Arched lattice windows in the side walls: per bay (its back wall) and in the entrance zone. */
const BAY_WINDOW = { width: 1.3, sill: 0.85, spring: 1.45 } as const;
const ENTRANCE_WINDOW = { width: 1.3, sill: 0.55, spring: 1.9 } as const;
/** Skylight wells: the slot in the ceiling, the well's height, and the plaster beams between wells. */
const SKYLIGHT = { halfWidth: 0.7, halfLength: 1.3, well: 0.8, beamWidth: 0.4, beamDepth: 0.28 } as const;
/** Ash slats under the side-aisle ceilings, running across the aisle. */
const SLAT = { size: 0.045, pitch: 0.1 } as const;
/** Upright ash slats over walnut cladding the partition faces that close the side aisles. */
const CLADDING = { width: 0.03, depth: 0.022, pitch: 0.062, height: 3.0 } as const;
/** Fluted column shafts. */
const COLUMN = { radius: 0.16, flutes: 24, fluteDepth: 0.012, base: 0.46, baseHeight: 0.24, plinth: 0.4, plinthHeight: 0.06 } as const;
/** Lattice tile sizes (metres per texture repeat). */
const LATTICE_TILE = { skylight: 1.3, window: 0.8 } as const;

// --- Geometry helpers -------------------------------------------------------------------------

type Geometry = THREE.BufferGeometry;

/** A box whose UVs are in metres divided by `uvScale` (textures keep their real size). */
function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  options: { uvScale?: number; rotateY?: number; rotateX?: number } = {},
): Geometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const scale = options.uvScale ?? 1;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  // Faces in order +x, -x, +y, -y, +z, -z; 4 vertices each.
  const faces: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i += 1) {
    const [fu, fv] = faces[Math.floor(i / 4)]!;
    uv.setXY(i, (uv.getX(i) * fu) / scale, (uv.getY(i) * fv) / scale);
  }
  if (options.rotateX) geometry.rotateX(options.rotateX);
  if (options.rotateY) geometry.rotateY(options.rotateY);
  geometry.translate(x, y, z);
  return flat(geometry);
}

type BoxFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
const BOX_FACES: BoxFace[] = ["+x", "-x", "+y", "-y", "+z", "-z"];

/**
 * A box with only some of its faces (for the many slats, whose other faces are never seen:
 * half the triangles).
 */
function boxFaces(w: number, h: number, d: number, x: number, y: number, z: number, keep: BoxFace[], uvScale = 1): Geometry {
  const full = box(w, h, d, x, y, z, { uvScale });
  const result = new THREE.BufferGeometry();
  // A non-indexed box has 6 vertices per face, in BOX_FACES order.
  const faces = BOX_FACES.map((face, i) => (keep.includes(face) ? i : -1)).filter((i) => i >= 0);
  for (const name of ["position", "normal", "uv"] as const) {
    const source = full.getAttribute(name) as THREE.BufferAttribute;
    const size = source.itemSize;
    const array = new Float32Array(faces.length * 6 * size);
    faces.forEach((face, k) => array.set((source.array as Float32Array).subarray(face * 6 * size, (face + 1) * 6 * size), k * 6 * size));
    result.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  full.dispose();
  return result;
}

/** A horizontal rectangle at height y (facing up, or down) with world-space UVs. */
function floorRect(x0: number, x1: number, z0: number, z1: number, y: number, uvScale: number, facingDown = false): Geometry {
  const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geometry.rotateX(facingDown ? Math.PI / 2 : -Math.PI / 2);
  geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) uv.setXY(i, position.getX(i) / uvScale, position.getZ(i) / uvScale);
  return flat(geometry);
}

/** A vertical rectangle facing `normal` (one of the axes), centred at (x, y, z). */
function wallRect(width: number, height: number, x: number, y: number, z: number, facing: "+x" | "-x" | "+z" | "-z"): Geometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  const angle = { "+z": 0, "-z": Math.PI, "+x": Math.PI / 2, "-x": -Math.PI / 2 }[facing];
  geometry.rotateY(angle);
  geometry.translate(x, y, z);
  return flat(geometry);
}

/** Outline of a clean pointed (equilateral) arch, from the left springing point to the right. */
function pointedArch(width: number, springY: number, segments = 20): THREE.Vector2[] {
  const r = width;
  const h = Math.sqrt(r * r - (r - width / 2) ** 2);
  const points: THREE.Vector2[] = [];
  const leftCenter = -width / 2 + r;
  const apexLeft = Math.atan2(h, -leftCenter);
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI + (apexLeft - Math.PI) * (i / segments);
    points.push(new THREE.Vector2(leftCenter + r * Math.cos(a), springY + r * Math.sin(a)));
  }
  const rightCenter = width / 2 - r;
  const apexRight = Math.atan2(h, -rightCenter);
  for (let i = 1; i <= segments; i += 1) {
    const a = apexRight + (0 - apexRight) * (i / segments);
    points.push(new THREE.Vector2(rightCenter + r * Math.cos(a), springY + r * Math.sin(a)));
  }
  return points;
}

/**
 * An end wall across the hall (nave 6 m high, aisles 3.4 m) with a pointed arch notch in the
 * middle, extruded `depth` along +Z from z = `z`.
 */
function archedWall(halfWidth: number, archWidth: number, springY: number, z: number, depth: number): Geometry {
  const outline = [
    new THREE.Vector2(-halfWidth, 0),
    new THREE.Vector2(-archWidth / 2, 0),
    ...pointedArch(archWidth, springY),
    new THREE.Vector2(archWidth / 2, 0),
    new THREE.Vector2(halfWidth, 0),
    new THREE.Vector2(halfWidth, HALL.aisleCeiling),
    new THREE.Vector2(HALL.bayStartX, HALL.aisleCeiling),
    new THREE.Vector2(HALL.bayStartX, HALL.ceiling),
    new THREE.Vector2(-HALL.bayStartX, HALL.ceiling),
    new THREE.Vector2(-HALL.bayStartX, HALL.aisleCeiling),
    new THREE.Vector2(-halfWidth, HALL.aisleCeiling),
  ];
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, z);
  return flat(geometry);
}

/** The niche behind the end wall: an arch-shaped tube seen from inside (rendered BackSide). */
function nicheLiner(archWidth: number, springY: number, z: number, depth: number): Geometry {
  const outline = [new THREE.Vector2(-archWidth / 2, 0), ...pointedArch(archWidth, springY), new THREE.Vector2(archWidth / 2, 0)];
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, z);
  return flat(geometry);
}

/**
 * A wall in a YZ plane (running along the nave), `thickness` thick outward from |x| = `inner`
 * on `side`, from z0 to z1 and y0 to y1, with openings (paths in (z, y)) cut through it.
 * UVs are metres divided by `uvScale`.
 */
function wallAlongNave(
  side: -1 | 1,
  inner: number,
  thickness: number,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  openings: THREE.Path[],
  uvScale: number,
): Geometry {
  const shape = new THREE.Shape([new THREE.Vector2(z0, y0), new THREE.Vector2(z1, y0), new THREE.Vector2(z1, y1), new THREE.Vector2(z0, y1)]);
  shape.holes.push(...openings);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  // Shape (x, y) -> world (z, y); the extrusion runs toward -x, so the wall spans x in [-thickness, 0].
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(side > 0 ? inner + thickness : -inner, 0, 0);
  return scaleUv(flat(geometry), 1 / uvScale);
}

/** A pointed-arch opening (a path in (z, y)): straight jambs from the sill up to the springing. */
function archOpening(zCenter: number, width: number, sill: number, spring: number): THREE.Path {
  const arch = pointedArch(width, spring).map((p) => new THREE.Vector2(zCenter + p.x, p.y));
  return new THREE.Path([new THREE.Vector2(zCenter - width / 2, sill), ...arch, new THREE.Vector2(zCenter + width / 2, sill)]);
}

/** Top of a pointed (equilateral) arch above its springing. */
function archRise(width: number): number {
  return (Math.sqrt(3) / 2) * width;
}

function rectOpening(zCenter: number, width: number, y0: number, y1: number): THREE.Path {
  return new THREE.Path([
    new THREE.Vector2(zCenter - width / 2, y0),
    new THREE.Vector2(zCenter + width / 2, y0),
    new THREE.Vector2(zCenter + width / 2, y1),
    new THREE.Vector2(zCenter - width / 2, y1),
  ]);
}

/** A vertical lattice screen across an opening, in the YZ plane at x, with world-space UVs. */
function latticeAlongNave(x: number, zCenter: number, width: number, y0: number, y1: number, tile: number): Geometry {
  const geometry = new THREE.PlaneGeometry(width, y1 - y0);
  geometry.rotateY(Math.PI / 2);
  geometry.translate(x, (y0 + y1) / 2, zCenter);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) uv.setXY(i, position.getZ(i) / tile, position.getY(i) / tile);
  return flat(geometry);
}

/** A column shaft with concave flutes between sharp arrises, standing on y = 0. */
function flutedShaft(height: number): Geometry {
  const { radius, flutes, fluteDepth } = COLUMN;
  const perFlute = 6;
  const geometry = new THREE.CylinderGeometry(radius, radius, height, flutes * perFlute, 1, true);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const angle = Math.atan2(x, z);
    // Distance from the nearest flute centre, in [-1, 1] across one flute.
    const phase = ((((angle * flutes) / (2 * Math.PI)) % 1) + 1) % 1;
    const u = phase * 2 - 1;
    const r = radius - fluteDepth * Math.sqrt(Math.max(0, 1 - u * u));
    position.setXYZ(i, Math.sin(angle) * r, position.getY(i) + height / 2, Math.cos(angle) * r);
  }
  geometry.computeVertexNormals();
  return flat(geometry);
}

/** Scales a geometry's UVs (textures keep their real size when UVs are in metres). */
function scaleUv(geometry: Geometry, factor: number): Geometry {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * factor, uv.getY(i) * factor);
  return geometry;
}

/** Non-indexed copy (merging needs one layout); geometries that already are stay as they are. */
function flat(geometry: Geometry): Geometry {
  if (!geometry.index) return geometry;
  const copy = geometry.toNonIndexed();
  geometry.dispose();
  return copy;
}

function merge(parts: Geometry[]): Geometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("HallRoom: incompatible geometry attributes");
  merged.computeBoundingSphere();
  return merged;
}

/** Flat decal quads with a per-quad colour (additive light pools and washes). */
function decal(geometry: Geometry, color: THREE.Color, strength: number): Geometry {
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r * strength;
    colors[i * 3 + 1] = color.g * strength;
    colors[i * 3 + 2] = color.b * strength;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// --- The room's geometry, by material -------------------------------------------------------

interface RoomGeometry {
  floor: Geometry;
  naveLit: Geometry;
  plaster: Geometry;
  ceiling: Geometry;
  niche: Geometry;
  limestone: Geometry;
  ash: Geometry;
  walnut: Geometry;
  aisleCeiling: Geometry;
  leather: Geometry;
  brass: Geometry;
  brassPolished: Geometry;
  signBrass: Geometry;
  shades: Geometry;
  bulbs: Geometry;
  sky: Geometry;
  outside: Geometry;
  daylight: Geometry;
  mashrabiya: Geometry;
  pools: Geometry;
  washes: Geometry;
  contact: Geometry;
  halos: Float32Array;
  litStart: number;
}

/** A placeholder for an empty group (merging needs at least one part). */
function nothing(): Geometry {
  return floorRect(0, 0.001, 0, 0.001, -1, 1);
}

function buildRoom(layout: HallLayout): RoomGeometry {
  const half = layout.width / 2;
  const L = layout.length;
  const T = HALL.wall;
  const aisle = HALL.aisleCeiling;
  const arcadeX = HALL.bayStartX;
  const lamp = new THREE.Color(HALL_COLORS.lamp);
  const washer = new THREE.Color(HALL_COLORS.washer);
  const day = new THREE.Color(HALL_COLORS.daylight);
  const rowCenters = Array.from({ length: layout.rows }, (_, r) => HALL.entranceDepth + HALL.bayPitch * (r + 0.5));
  const spans = ARCADE.entranceSpans;
  const entranceCenters = Array.from({ length: spans }, (_, i) => (HALL.entranceDepth * (i + 0.5)) / spans);

  // Floor: the nave strip under the skylights carries the light map; the rest is plain.
  const litStart = layout.skylights.length > 0 ? layout.skylights[0]! - LIGHT_PATCH_OFFSET : 0;
  const litEnd = layout.skylights.length > 0 ? litStart + LIGHT_TILE * layout.skylights.length : 0;
  const nx = HALL.naveHalfWidth;
  const floorParts = [floorRect(-half, -nx, 0, L, 0, 2.4), floorRect(nx, half, 0, L, 0, 2.4)];
  if (litStart > 0) floorParts.push(floorRect(-nx, nx, 0, litStart, 0, 2.4));
  if (litEnd < L) floorParts.push(floorRect(-nx, nx, Math.max(litStart, litEnd), L, 0, 2.4));
  const floor = merge(floorParts);
  const naveLit = litEnd > litStart ? merge([floorRect(-nx, nx, litStart, litEnd, 0, 2.4)]) : merge([nothing()]);

  const plaster: Geometry[] = [];
  const limestone: Geometry[] = [];
  const ash: Geometry[] = [];
  const walnut: Geometry[] = [];
  const aisleCeiling: Geometry[] = [];
  const leather: Geometry[] = [];
  const brass: Geometry[] = [];
  const brassPolished: Geometry[] = [];
  // Sign plates: brushed brass that keeps its colour on vertical faces (less mirror-like).
  const signBrass: Geometry[] = [];
  const lattice: Geometry[] = [];
  const outside: Geometry[] = [];
  const pools: Geometry[] = [];
  const washes: Geometry[] = [];

  for (const s of [-1, 1] as const) {
    // Side walls, with an arched lattice window at the back of every bay and three in the
    // entrance zone, above the window seat. Daylight comes in through them.
    const sideWindows = [
      ...rowCenters.map((z) => ({ z, ...BAY_WINDOW })),
      ...entranceCenters.map((z) => ({ z, ...ENTRANCE_WINDOW })),
    ];
    plaster.push(
      wallAlongNave(
        s,
        half,
        T,
        -T,
        L + T,
        0,
        aisle,
        sideWindows.map((w) => archOpening(w.z, w.width, w.sill, w.spring)),
        2,
      ),
    );
    for (const w of sideWindows) {
      const top = w.spring + archRise(w.width);
      lattice.push(latticeAlongNave(s * (half + T / 2), w.z, w.width, w.sill, top, LATTICE_TILE.window));
      // A limestone sill inside, and a soft patch of daylight on the floor below.
      limestone.push(box(0.12, 0.05, w.width + 0.1, s * (half - 0.04), w.sill - 0.025, w.z, { uvScale: 0.6 }));
      if (w.sill > 0.7) pools.push(decal(floorRect(s * (half - 1.6), s * (half - 0.1), w.z - 0.9, w.z + 0.9, 0.004, 1), day, 0.13));
    }
    // The bright day beyond the side windows.
    outside.push(wallRect(L + 2, aisle + 0.4, s * (half + T + 0.35), aisle / 2, L / 2, s > 0 ? "-x" : "+x"));

    // The arcade: a limestone beam on the nave edge, at the side-aisle ceiling.
    limestone.push(box(ARCADE.beamWidth, ARCADE.beamTop - ARCADE.beamBottom, L + 2 * T, s * arcadeX, (ARCADE.beamTop + ARCADE.beamBottom) / 2, L / 2, { uvScale: 0.6 }));

    // The clerestory above it: a lattice window over each bay row and each entrance span.
    const clerestoryWindows = [
      ...rowCenters.map((z) => ({ z, width: CLERESTORY.bayWindow })),
      ...entranceCenters.map((z) => ({ z, width: CLERESTORY.entranceWindow })),
    ];
    // It starts inside the aisle ceiling's slab, so no two faces lie in one plane.
    plaster.push(
      wallAlongNave(
        s,
        arcadeX,
        CLERESTORY.thickness,
        -T,
        L + T,
        aisle + 0.06,
        HALL.ceiling,
        clerestoryWindows.map((w) => rectOpening(w.z, w.width, CLERESTORY.sill, CLERESTORY.head)),
        2,
      ),
    );
    for (const w of clerestoryWindows) {
      lattice.push(latticeAlongNave(s * (arcadeX + CLERESTORY.thickness / 2), w.z, w.width, CLERESTORY.sill, CLERESTORY.head, LATTICE_TILE.window));
    }
    outside.push(wallRect(L + 2, HALL.ceiling - aisle + 0.6, s * (arcadeX + CLERESTORY.thickness + 0.45), (HALL.ceiling + aisle) / 2, L / 2, s > 0 ? "-x" : "+x"));
    // A plaster cornice where the clerestory meets the nave ceiling.
    plaster.push(box(0.24, 0.2, L + 2 * T, s * (arcadeX - 0.12), HALL.ceiling - 0.1, L / 2, { uvScale: 2 }));

    // Side-aisle ceilings: a dark wood soffit with ash slats running across the aisle.
    const aisleWidth = half - arcadeX;
    aisleCeiling.push(box(aisleWidth, 0.12, L, s * ((half + arcadeX) / 2), aisle + 0.06, L / 2));
    const slatInner = arcadeX + ARCADE.beamWidth / 2;
    for (let z = SLAT.pitch / 2; z < L; z += SLAT.pitch) {
      // Their tops touch the soffit and their ends the beam and the wall: only three faces show.
      ash.push(boxFaces(half - slatInner, SLAT.size, SLAT.size, s * ((half + slatInner) / 2), aisle - 0.002 - SLAT.size / 2, z, ["-y", "+z", "-z"]));
    }

    // Partitions between bays (each ends in an arcade column on the nave side).
    for (const z of layout.partitions) {
      plaster.push(box(half - arcadeX, aisle, HALL.partition, s * ((half + arcadeX) / 2), aisle / 2, z, { uvScale: 2 }));
    }
    // The first partition's face toward the entrance and the last one's toward the end wall
    // close the side aisles: they are clad in upright ash slats over walnut.
    const cladX0 = arcadeX + COLUMN.base / 2 + 0.08;
    const cladX1 = half - 0.04;
    for (const [z, facing] of [
      [layout.partitions[0]!, -1],
      [layout.partitions.at(-1)!, 1],
    ] as const) {
      const face = z + facing * (HALL.partition / 2);
      walnut.push(box(cladX1 - cladX0, CLADDING.height, 0.01, s * ((cladX0 + cladX1) / 2), CLADDING.height / 2, face + facing * 0.005));
      for (let x = cladX0 + CLADDING.width / 2; x < cladX1 - CLADDING.width / 2; x += CLADDING.pitch) {
        // Only the front and the two sides show (the top is far above eye level).
        ash.push(boxFaces(CLADDING.width, CLADDING.height, CLADDING.depth, s * x, CLADDING.height / 2, face + facing * (0.01 + CLADDING.depth / 2), ["+x", "-x", facing > 0 ? "+z" : "-z"]));
      }
    }

    // Limestone skirting along the side wall.
    limestone.push(box(0.025, 0.14, L, s * (half - 0.0125), 0.07, L / 2, { uvScale: 0.6 }));

    // The entrance zone's window seat: an ash bench with a leather cushion and a walnut kick.
    const seatLength = WINDOW_SEAT.zEnd - WINDOW_SEAT.zStart;
    const seatZ = (WINDOW_SEAT.zStart + WINDOW_SEAT.zEnd) / 2;
    const seatDepth = WINDOW_SEAT.depth;
    ash.push(box(seatDepth, 0.34, seatLength, s * (half - seatDepth / 2), 0.06 + 0.17, seatZ, { uvScale: 1 }));
    walnut.push(box(seatDepth - 0.04, 0.06, seatLength - 0.04, s * (half - seatDepth / 2 + 0.02), 0.03, seatZ));
    leather.push(box(seatDepth - 0.04, WINDOW_SEAT.height - 0.4, seatLength - 0.06, s * (half - seatDepth / 2 + 0.01), 0.4 + (WINDOW_SEAT.height - 0.4) / 2, seatZ));
  }

  // Arcade columns: base, plinth, fluted shaft and a three-step capital under the beam.
  const shaftBottom = COLUMN.baseHeight + COLUMN.plinthHeight;
  const capitalSteps = [0.4, 0.48, 0.56];
  const capitalBottom = ARCADE.beamBottom - 0.08 * capitalSteps.length;
  const shaft = flutedShaft(capitalBottom - shaftBottom);
  for (const { x, z } of layout.columns) {
    limestone.push(box(COLUMN.base, COLUMN.baseHeight, COLUMN.base, x, COLUMN.baseHeight / 2, z, { uvScale: 0.6 }));
    limestone.push(box(COLUMN.plinth, COLUMN.plinthHeight, COLUMN.plinth, x, COLUMN.baseHeight + COLUMN.plinthHeight / 2, z, { uvScale: 0.6 }));
    const part = shaft.clone();
    part.translate(x, shaftBottom, z);
    limestone.push(part);
    capitalSteps.forEach((size, k) => limestone.push(box(size, 0.08, size, x, capitalBottom + 0.04 + 0.08 * k, z, { uvScale: 0.6 })));
  }
  shaft.dispose();

  // Entrance wall with the pointed arch; end wall with the reading niche.
  plaster.push(scaleUv(archedWall(half, 2.6, 3.0, -T, T), 0.5));
  plaster.push(scaleUv(archedWall(half, 2.0, 2.0, L, T), 0.5));

  // Nave ceiling: each skylight slot opens into a deep well with a lattice at its mouth and the
  // sky above; deep plaster beams cross the nave between the wells.
  const ceilingShape = new THREE.Shape([
    new THREE.Vector2(-arcadeX, 0),
    new THREE.Vector2(arcadeX, 0),
    new THREE.Vector2(arcadeX, L),
    new THREE.Vector2(-arcadeX, L),
  ]);
  const { halfWidth: slotHalfW, halfLength: slotHalfL, well } = SKYLIGHT;
  const wells: Geometry[] = [];
  const sky: Geometry[] = [];
  for (const z of layout.skylights) {
    ceilingShape.holes.push(
      new THREE.Path([
        new THREE.Vector2(-slotHalfW, z - slotHalfL),
        new THREE.Vector2(-slotHalfW, z + slotHalfL),
        new THREE.Vector2(slotHalfW, z + slotHalfL),
        new THREE.Vector2(slotHalfW, z - slotHalfL),
      ]),
    );
    const y = HALL.ceiling + well / 2;
    wells.push(box(0.04, well, 2 * slotHalfL, -slotHalfW - 0.02, y, z, { uvScale: 2 }), box(0.04, well, 2 * slotHalfL, slotHalfW + 0.02, y, z, { uvScale: 2 }));
    wells.push(box(2 * slotHalfW + 0.08, well, 0.04, 0, y, z - slotHalfL - 0.02, { uvScale: 2 }), box(2 * slotHalfW + 0.08, well, 0.04, 0, y, z + slotHalfL + 0.02, { uvScale: 2 }));
    sky.push(floorRect(-slotHalfW, slotHalfW, z - slotHalfL, z + slotHalfL, HALL.ceiling + well, 1, true));
    lattice.push(floorRect(-slotHalfW, slotHalfW, z - slotHalfL, z + slotHalfL, HALL.ceiling - 0.02, LATTICE_TILE.skylight, true));
  }
  const beamZs = layout.skylights.map((z) => z + HALL.bayPitch / 2);
  if (layout.skylights.length > 0 && layout.skylights[0]! - HALL.bayPitch / 2 > 0.4) beamZs.unshift(layout.skylights[0]! - HALL.bayPitch / 2);
  for (const z of beamZs) {
    if (z > L - 0.3) continue;
    plaster.push(box(2 * arcadeX, SKYLIGHT.beamDepth, SKYLIGHT.beamWidth, 0, HALL.ceiling - SKYLIGHT.beamDepth / 2, z, { uvScale: 2 }));
  }
  const ceilingGeometry = new THREE.ShapeGeometry(ceilingShape);
  ceilingGeometry.rotateX(Math.PI / 2);
  ceilingGeometry.translate(0, HALL.ceiling, 0);
  const ceiling = merge([scaleUv(flat(ceilingGeometry), 0.5), ...wells]);

  const niche = merge([scaleUv(nicheLiner(2.0, 2.0, L + T, 0.6), 0.5)]);

  // The desk top in limestone.
  limestone.push(box(DESK.width + 0.04, 0.04, DESK.depth + 0.04, DESK.x, DESK.height - 0.02, DESK.z, { uvScale: 0.6 }));

  // Ash and walnut: the desk, its book stands, the niche bench and the bookcases.
  ash.push(box(DESK.width, DESK.height - 0.12, DESK.depth, DESK.x, 0.08 + (DESK.height - 0.12) / 2, DESK.z, { uvScale: 1 }));
  walnut.push(box(DESK.width - 0.14, 0.08, DESK.depth - 0.14, DESK.x, 0.04, DESK.z));
  brassPolished.push(box(DESK.width + 0.05, 0.014, 0.014, DESK.x, DESK.height - 0.045, DESK.z - DESK.depth / 2 - 0.025));
  for (const offset of DESK_STANDS.offsets) {
    // Angled stand: a back plate leaning away from the entrance, and a brass lip.
    const { width, height, thickness } = DESK_STANDS.plate;
    const center = standPlateCenter(offset);
    const plate = box(width, height, thickness, 0, 0, 0, { uvScale: 1, rotateX: DESK_STANDS.lean });
    plate.translate(center.x, center.y, center.z);
    ash.push(plate);
    brass.push(box(width, 0.024, 0.04, DESK.x + offset, DESK.height + 0.012, DESK_STANDS.lipZ));
  }
  // The niche bench.
  ash.push(box(1.5, 0.06, 0.42, 0, 0.42, L + T + 0.33, { uvScale: 1 }));
  walnut.push(box(1.4, 0.39, 0.34, 0, 0.195, L + T + 0.34));
  for (const bay of layout.bays) {
    for (const bookcase of bay.bookcases) {
      const parts = bookcaseParts(bookcase);
      ash.push(...parts.ash);
      walnut.push(...parts.walnut);
      lattice.push(...parts.lattice);
    }
  }

  // Baked contact darkening under the desk, the bench and the bookcases (multiplied).
  const contact: Geometry[] = [floorRect(DESK.x - DESK.width / 2 - 0.3, DESK.x + DESK.width / 2 + 0.3, DESK.z - DESK.depth / 2 - 0.3, DESK.z + DESK.depth / 2 + 0.3, 0.002, 1)];
  for (const bay of layout.bays) {
    for (const bookcase of bay.bookcases) {
      const halfL = BOOKCASE.length / 2 + 0.2;
      const halfD = BOOKCASE.depth / 2 + 0.22;
      contact.push(floorRect(bookcase.x - halfL, bookcase.x + halfL, bookcase.z - halfD, bookcase.z + halfD, 0.002, 1));
    }
  }
  for (const { x, z } of layout.columns) {
    const r = COLUMN.base / 2 + 0.22;
    contact.push(floorRect(x - r, x + r, z - r, z + r, 0.002, 1));
  }
  for (const part of contact) {
    // UVs 0..1 across each footprint.
    const uv = part.getAttribute("uv") as THREE.BufferAttribute;
    const position = part.getAttribute("position") as THREE.BufferAttribute;
    let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < position.count; i += 1) {
      minX = Math.min(minX, position.getX(i));
      maxX = Math.max(maxX, position.getX(i));
      minZ = Math.min(minZ, position.getZ(i));
      maxZ = Math.max(maxZ, position.getZ(i));
    }
    for (let i = 0; i < position.count; i += 1) {
      uv.setXY(i, (position.getX(i) - minX) / (maxX - minX), (position.getZ(i) - minZ) / (maxZ - minZ));
    }
  }

  // The signs' static parts: header troughs and their light on the band, range plate bodies,
  // and the directory stele (their engraved faces are drawn per category by <Signage>).
  const signs = signageParts(layout);
  brass.push(...signs.brass);
  signBrass.push(...signs.plates);
  limestone.push(...signs.limestone);
  for (const wash of signs.washes) washes.push(decal(wash, washer, 0.42));

  // Brass inlay lines down the nave, and the empty bay's floor outline.
  for (const x of [-1.5, 1.5]) brassPolished.push(box(0.03, 0.004, L - 1.2, x, 0.002, L / 2 + 0.2));
  for (const bay of layout.bays) {
    if (bay.categoryId !== null) continue;
    const inner = bay.side * (arcadeX + 0.4);
    const outer = bay.side * (half - 0.4);
    const [x0, x1] = [Math.min(inner, outer), Math.max(inner, outer)];
    const [z0, z1] = [bay.zStart + 0.4, bay.zEnd - 0.4];
    brassPolished.push(
      box(x1 - x0, 0.004, 0.025, (x0 + x1) / 2, 0.002, z0),
      box(x1 - x0, 0.004, 0.025, (x0 + x1) / 2, 0.002, z1),
      box(0.025, 0.004, z1 - z0, x0, 0.002, (z0 + z1) / 2),
      box(0.025, 0.004, z1 - z0, x1, 0.002, (z0 + z1) / 2),
    );
  }

  // Pendants: the desk's, and a smaller one at each bay opening. Cables in brass.
  const shades: Geometry[] = [];
  const bulbs: Geometry[] = [];
  const halos: number[] = [];
  const pendant = (x: number, y: number, z: number, radius: number, top: number) => {
    const shade = new THREE.SphereGeometry(radius, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    shade.translate(x, y, z);
    shades.push(flat(shade));
    const bulb = new THREE.SphereGeometry(radius * 0.22, 16, 8);
    bulb.translate(x, y - radius * 0.1, z);
    bulbs.push(flat(bulb));
    const cable = new THREE.CylinderGeometry(0.004, 0.004, top - y - radius, 6, 1);
    cable.translate(x, (top + y + radius) / 2, z);
    brass.push(flat(cable));
    halos.push(x, y - radius * 0.15, z);
  };
  pendant(DESK.x, DESK_PENDANT_Y, DESK.z, 0.24, HALL.ceiling);
  pools.push(decal(floorRect(DESK.x - 1.9, DESK.x + 1.9, DESK.z - 1.9, DESK.z + 1.9, 0.004, 3.8), lamp, 0.22));
  for (const bay of layout.bays) {
    const x = bay.side * (arcadeX + BAY_LAMP_INSET);
    // Hung from the aisle ceiling's slats.
    if (bay.categoryId !== null) pendant(x, BAY_PENDANT_Y, bay.zCenter, 0.15, aisle - SLAT.size);
    pools.push(decal(floorRect(x - 1.5, x + 1.5, bay.zCenter - 1.5, bay.zCenter + 1.5, 0.004, 3), lamp, bay.categoryId === null ? 0.45 : 0.24));
    // A warm wall-washer on the bay's outer wall, around its window.
    washes.push(decal(wallRect(2.6, 3.2, bay.side * (half - 0.01), 1.65, bay.zCenter, bay.side > 0 ? "-x" : "+x"), washer, 0.32));
  }
  // The niche's wall-washer, and daylight spilling in through the entrance arch.
  washes.push(decal(wallRect(1.8, 2.8, 0, 1.45, L + T + 0.58, "-z"), washer, 0.55));
  pools.push(decal(floorRect(-1.6, 1.6, 0, 2.6, 0.004, 3.2), day, 0.16));

  const daylight = merge([wallRect(5, 6, 0, 3, -T - 1.2, "+z")]);

  return {
    floor,
    naveLit,
    plaster: merge(plaster),
    ceiling,
    niche,
    limestone: merge(limestone),
    ash: merge(ash),
    walnut: merge(walnut),
    aisleCeiling: merge(aisleCeiling),
    leather: merge(leather),
    brass: merge(brass),
    brassPolished: merge(brassPolished),
    signBrass: merge(signBrass.length > 0 ? signBrass : [nothing()]),
    shades: merge(shades),
    bulbs: merge(bulbs),
    sky: merge(sky.length > 0 ? sky : [nothing()]),
    outside: merge(outside),
    daylight,
    mashrabiya: merge(lattice),
    pools: merge(pools),
    washes: merge(washes),
    contact: merge(contact),
    halos: new Float32Array(halos),
    litStart,
  };
}

// --- Component --------------------------------------------------------------------------------

function useHallTextures(preset: GraphicsQuality) {
  const textures = useTexture(TEXTURES);
  const { gl } = useThree();
  useMemo(() => {
    const anisotropy = Math.min(ANISOTROPY[preset], gl.capabilities.getMaxAnisotropy());
    for (const [name, texture] of Object.entries(textures)) {
      texture.colorSpace = name === "medallionMr" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      if (name === "floorLight") texture.wrapS = THREE.ClampToEdgeWrapping;
      if (["halo", "wallWash", "medallion", "medallionMr", "contact"].includes(name)) {
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      texture.needsUpdate = true;
    }
  }, [textures, preset, gl]);
  return textures;
}

export interface HallRoomProps {
  layout: HallLayout;
  preset: GraphicsQuality;
}

export function HallRoom({ layout, preset }: HallRoomProps) {
  const textures = useHallTextures(preset);
  const { gl, invalidate } = useThree();
  const room = useMemo(() => buildRoom(layout), [layout]);

  const materials = useMemo(() => {
    const floorLight = textures.floorLight;
    // Light map tile: across the nave once, along it once per skylight (UVs are metres / 2.4).
    floorLight.repeat.set(2.4 / 4.0, 2.4 / LIGHT_TILE);
    floorLight.offset.set(0.5, -room.litStart / LIGHT_TILE);
    floorLight.updateMatrix();
    const additive = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
    return {
      floor: new THREE.MeshStandardMaterial({ map: textures.floor, roughness: 0.4 }),
      naveLit: new THREE.MeshStandardMaterial({
        map: textures.floor,
        roughness: 0.4,
        lightMap: floorLight,
        lightMapIntensity: 5.5,
      }),
      plaster: new THREE.MeshStandardMaterial({ map: textures.plaster, roughness: 0.9 }),
      ceiling: new THREE.MeshStandardMaterial({ map: textures.plaster, roughness: 0.9, side: THREE.DoubleSide }),
      niche: new THREE.MeshStandardMaterial({ map: textures.plaster, roughness: 0.9, side: THREE.BackSide }),
      limestone: new THREE.MeshStandardMaterial({ map: textures.limestone, roughness: 0.7 }),
      ash: new THREE.MeshStandardMaterial({ map: textures.ash, roughness: 0.55 }),
      walnut: new THREE.MeshStandardMaterial({ map: textures.walnut, roughness: 0.5 }),
      // The aisle ceilings' soffit: walnut, darkened, so the ash slats read against it.
      aisleCeiling: new THREE.MeshStandardMaterial({ map: textures.walnut, color: "#7d6f62", roughness: 0.6 }),
      leather: new THREE.MeshStandardMaterial({ color: "#4a3328", roughness: 0.55 }),
      brass: new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 1, roughness: 0.35 }),
      brassPolished: new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 1, roughness: 0.25 }),
      // Brushed brass plates (range plates, the directory): part metal, part diffuse, so a plate
      // facing a dim wall still reads as brass rather than a dark mirror.
      signBrass: new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 0.55, roughness: 0.45 }),
      shade: new THREE.MeshStandardMaterial({
        color: HALL_COLORS.brass,
        metalness: 1,
        roughness: 0.35,
        side: THREE.DoubleSide,
        emissive: HALL_COLORS.lamp,
        emissiveMap: textures.shadeGlow,
        emissiveIntensity: 1.6,
      }),
      bulb: new THREE.MeshBasicMaterial({ color: new THREE.Color(HALL_COLORS.lamp).multiplyScalar(4) }),
      sky: new THREE.MeshBasicMaterial({ color: new THREE.Color(HALL_COLORS.daylight).multiplyScalar(3.2) }),
      // The day seen through the side and clerestory windows (behind the lattices).
      outside: new THREE.MeshBasicMaterial({ color: new THREE.Color("#F6F2EA").multiplyScalar(1.9) }),
      daylight: new THREE.MeshBasicMaterial({ color: new THREE.Color("#FFF4E4").multiplyScalar(2.6) }),
      mashrabiya: new THREE.MeshStandardMaterial({
        map: textures.mashrabiya,
        alphaTest: 0.5,
        roughness: 0.6,
        side: THREE.DoubleSide,
      }),
      medallion: new THREE.MeshStandardMaterial({
        map: textures.medallion,
        metalnessMap: textures.medallionMr,
        roughnessMap: textures.medallionMr,
        metalness: 1,
        roughness: 1,
        transparent: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
      contact: new THREE.MeshBasicMaterial({
        map: textures.contact,
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        toneMapped: false,
      }),
      pools: additive(textures.halo),
      washes: additive(textures.wallWash),
      halo: new THREE.PointsMaterial({
        map: textures.halo,
        color: new THREE.Color(HALL_COLORS.lamp).multiplyScalar(0.9),
        size: 0.9,
        sizeAttenuation: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    };
  }, [textures, room.litStart]);

  const haloGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(room.halos, 3));
    return geometry;
  }, [room.halos]);
  const medallionGeometry = useMemo(() => {
    const geometry = new THREE.CircleGeometry(MEDALLION.radius, 72);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0.003, MEDALLION.z);
    return geometry;
  }, []);

  useEffect(
    () => () => {
      for (const geometry of Object.values(room)) if (geometry instanceof THREE.BufferGeometry) geometry.dispose();
      haloGeometry.dispose();
    },
    [room, haloGeometry],
  );
  useEffect(() => () => medallionGeometry.dispose(), [medallionGeometry]);
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);

  // The single shadow map renders once per layout (section 10.6).
  useLayoutEffect(() => {
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [gl, layout, invalidate]);

  const shadows = preset !== "performance";
  const castShadows = shadows;

  return (
    <group>
      <HallLights layout={layout} preset={preset} />

      <mesh geometry={room.floor} material={materials.floor} receiveShadow={shadows} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={room.naveLit} material={materials.naveLit} receiveShadow={shadows} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={medallionGeometry} material={materials.medallion} receiveShadow={shadows} />
      <mesh geometry={room.plaster} material={materials.plaster} castShadow={castShadows} receiveShadow={shadows} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={room.ceiling} material={materials.ceiling} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={room.niche} material={materials.niche} receiveShadow={shadows} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={room.limestone} material={materials.limestone} castShadow={castShadows} receiveShadow={shadows} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.ash} material={materials.ash} castShadow={castShadows} receiveShadow={shadows} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.walnut} material={materials.walnut} castShadow={castShadows} receiveShadow={shadows} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.aisleCeiling} material={materials.aisleCeiling} castShadow={castShadows} receiveShadow={shadows} renderOrder={DRAW_ORDER.shell} />
      <mesh geometry={room.leather} material={materials.leather} receiveShadow={shadows} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.brass} material={materials.brass} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.brassPolished} material={materials.brassPolished} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.signBrass} material={materials.signBrass} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.shades} material={materials.shade} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.bulbs} material={materials.bulb} renderOrder={DRAW_ORDER.furniture} />
      <mesh geometry={room.sky} material={materials.sky} renderOrder={DRAW_ORDER.beyond} />
      <mesh geometry={room.outside} material={materials.outside} renderOrder={DRAW_ORDER.beyond} />
      <mesh geometry={room.daylight} material={materials.daylight} renderOrder={DRAW_ORDER.beyond} />
      <mesh geometry={room.mashrabiya} material={materials.mashrabiya} renderOrder={DRAW_ORDER.beyond} />
      <mesh geometry={room.contact} material={materials.contact} renderOrder={1} />
      <mesh geometry={room.pools} material={materials.pools} renderOrder={1} />
      <mesh geometry={room.washes} material={materials.washes} renderOrder={1} />
      <points geometry={haloGeometry} material={materials.halo} renderOrder={2} />
      <Shelves layout={layout} preset={preset} />
      <Signage layout={layout} />
      <EntranceDesk />
      <BookPresenter />
    </group>
  );
}

const NO_BOOKS: Book[] = [];

/** Each category's shelves, from the store (books grouped per category). */
function Shelves({ layout, preset }: { layout: HallLayout; preset: GraphicsQuality }) {
  const categories = useLibraryStore((state) => state.categories);
  const books = useLibraryStore((state) => state.books);
  // Regroup only when something visible on the shelves changes (not on a saved bookmark).
  const signature = JSON.stringify(
    books.map((b) => [b.id, b.category_id, b.shelf_number, b.slot_index, b.page_count, b.page_width_pt, b.page_height_pt, b.spine_color, b.title, b.author]),
  );
  const byCategory = useMemo(() => {
    const groups = new Map<number, Book[]>();
    for (const book of books) {
      const list = groups.get(book.category_id) ?? [];
      list.push(book);
      groups.set(book.category_id, list);
    }
    return groups;
  }, [signature]);

  const atlas = useMemo(() => new SpineAtlas(ATLAS_CONFIG[preset]), [preset]);
  useEffect(() => () => atlas.dispose(), [atlas]);
  const atlasBays = useMemo<AtlasBay[]>(
    () =>
      layout.bays
        .filter((bay) => bay.categoryId !== null)
        .map((bay) => {
          const list = [...(byCategory.get(bay.categoryId!) ?? [])].sort((a, b) => a.shelf_number - b.shelf_number || a.slot_index - b.slot_index);
          return {
            key: String(bay.categoryId),
            x: bay.side * HALL.bayStartX,
            z: bay.zCenter,
            labels: list.map((book) => {
              const size = bookSize(book);
              return { id: book.id, title: book.title, author: book.author, thickness: size.thickness, height: size.height };
            }),
          };
        }),
    [layout, byCategory],
  );

  return (
    <SpineAtlasContext.Provider value={atlas}>
      <AtlasPlanner atlas={atlas} bays={atlasBays} />
      {layout.bays.map((bay) => {
        const category = bay.categoryId === null ? undefined : categories.find((c) => c.id === bay.categoryId);
        if (!category) return null;
        return (
          <group key={category.id}>
            <CategoryShelves bay={bay} books={byCategory.get(category.id) ?? NO_BOOKS} />
          </group>
        );
      })}
      <Bookends layout={layout} byCategory={byCategory} />
    </SpineAtlasContext.Provider>
  );
}

/**
 * Keeps the atlas pages of nearby bays resident (built within 18 m, released beyond 25 m,
 * nearest first). Pages are drawn one at a time between frames so walking never stalls.
 */
function AtlasPlanner({ atlas, bays }: { atlas: SpineAtlas; bays: AtlasBay[] }) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const queue = useRef<AtlasPage[]>([]);
  const busy = useRef(false);
  const lastPlan = useRef(0);

  const pump = useCallback(() => {
    if (busy.current || queue.current.length === 0) return;
    busy.current = true;
    void ensureCanvasFonts().then(() => {
      setTimeout(() => {
        const page = queue.current.shift();
        if (page) atlas.build(page);
        busy.current = false;
        invalidate();
        pump();
      }, 0);
    });
  }, [atlas, invalidate]);

  const plan = useCallback(() => {
    const pages = atlasPages(bays, { x: camera.position.x, z: camera.position.z }, atlas.config);
    const want = planResident(pages, new Set(atlas.pages.keys()), atlas.config);
    for (const key of [...atlas.pages.keys()]) if (!want.includes(key)) atlas.release(key);
    queue.current = want.filter((key) => !atlas.pages.has(key)).map((key) => pages.find((page) => page.key === key)!);
    pump();
  }, [atlas, bays, camera, pump]);

  // New books or titles: rebuild every page.
  useEffect(() => {
    for (const key of [...atlas.pages.keys()]) atlas.release(key);
    plan();
  }, [atlas, bays, plan]);

  useEffect(() => {
    registerTestHook("atlas", () => ({
      resident: [...atlas.pages.keys()],
      layers: atlas.config.layers,
      cell: [atlas.config.cellWidth, atlas.config.cellHeight],
      builds: atlas.builds,
      releases: atlas.releases,
      labelled: atlas.entries.size,
      queued: queue.current.length,
      format: atlas.texture.format === THREE.RedFormat && atlas.texture.type === THREE.UnsignedByteType ? "R8" : "other",
      size: [atlas.texture.image.width, atlas.texture.image.height, atlas.texture.image.depth],
    }));
    return () => registerTestHook("atlas", undefined);
  }, [atlas]);

  // While the camera moves, re-plan a few times a second.
  useFrame(() => {
    const now = performance.now();
    if (now - lastPlan.current < 300) return;
    lastPlan.current = now;
    plan();
  });
  return null;
}

/** A brass bookend after the last book of every shelf, all in one instanced mesh. */
function Bookends({ layout, byCategory }: { layout: HallLayout; byCategory: Map<number, Book[]> }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((state) => state.invalidate);
  const geometry = useMemo(() => {
    const upright = new THREE.BoxGeometry(0.004, 0.15, 0.11);
    upright.translate(0.002, 0.075, 0);
    const foot = new THREE.BoxGeometry(0.06, 0.003, 0.11);
    foot.translate(-0.03, 0.0015, 0);
    const merged = mergeGeometries([upright.toNonIndexed(), foot.toNonIndexed()], false)!;
    upright.dispose();
    foot.dispose();
    return merged;
  }, []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 1, roughness: 0.35 }), []);
  const matrices = useMemo(() => {
    const result: THREE.Matrix4[] = [];
    for (const bay of layout.bays) {
      if (bay.categoryId === null) continue;
      const { shelfEnds } = placeBooks(byCategory.get(bay.categoryId) ?? NO_BOOKS);
      for (const end of shelfEnds) {
        const bookcase = bay.bookcases[end.bookcase];
        if (!bookcase) continue;
        const local = new THREE.Matrix4().makeTranslation(end.x + 0.002, SHELF_HEIGHTS[end.tier]!, SHELF_FRONT_Z - 0.015 - 0.055);
        const world = new THREE.Matrix4().compose(
          new THREE.Vector3(bookcase.x, 0, bookcase.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bookcase.rotationY),
          new THREE.Vector3(1, 1, 1),
        );
        result.push(world.multiply(local));
      }
    }
    return result;
  }, [layout, byCategory]);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.count = matrices.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [matrices, invalidate]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  if (matrices.length === 0) return null;
  return <instancedMesh key={matrices.length} ref={ref} args={[geometry, material, matrices.length]} name="bookends" />;
}

/** Skylight key light (one shadow, rendered once), sky fill, the desk lamp, the niche washer. */
function HallLights({ layout, preset }: { layout: HallLayout; preset: GraphicsQuality }) {
  const target = useMemo(() => new THREE.Object3D(), []);
  const nicheTarget = useMemo(() => new THREE.Object3D(), []);
  const center = layout.length / 2;
  const reach = Math.max(layout.width, layout.length) * 0.62;
  target.position.set(0, 0, center);
  nicheTarget.position.set(0, 1.2, layout.length + HALL.wall + 0.6);
  const castShadow = preset !== "performance";
  const mapSize = preset === "high" ? 2048 : 1024;

  return (
    <>
      <primitive object={target} />
      <primitive object={nicheTarget} />
      <hemisphereLight args={["#EEF2F8", "#E4DACB", 1.55]} />
      <directionalLight
        color={HALL_COLORS.daylight}
        intensity={1.7}
        position={[-6, 18, center - 5]}
        target={target}
        castShadow={castShadow}
        shadow-mapSize={[mapSize, mapSize]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={preset === "high" ? 4 : 2}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-near={1}
        shadow-camera-far={60}
      />
      <pointLight color={HALL_COLORS.lamp} intensity={2.2} position={[DESK.x, DESK_PENDANT_Y - 0.12, DESK.z]} distance={9} decay={2} />
      <spotLight
        color={HALL_COLORS.washer}
        intensity={14}
        position={[0, 3.8, layout.length - 1.4]}
        target={nicheTarget}
        angle={0.55}
        penumbra={0.9}
        distance={9}
        decay={2}
      />
      <Environment resolution={128} frames={1} environmentIntensity={1.0}>
        <Lightformer form="rect" intensity={2.4} color={HALL_COLORS.daylight} scale={[4, layout.length, 1]} position={[0, 8, center]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.4} color="#FFEBD0" scale={[14, 12, 1]} position={[0, 4, -5]} />
        <Lightformer form="rect" intensity={0.9} color="#FFE2BE" scale={[10, 10, 1]} position={[0, 4, layout.length + 5]} rotation-y={Math.PI} />
        <Lightformer form="rect" intensity={0.5} color="#F2E6D4" scale={[layout.length, 3, 1]} position={[-10, 1.5, center]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={0.5} color="#F2E6D4" scale={[layout.length, 3, 1]} position={[10, 1.5, center]} rotation-y={-Math.PI / 2} />
        <Lightformer form="rect" intensity={0.7} color="#E6DCCB" scale={[30, layout.length, 1]} position={[0, -3, center]} rotation-x={-Math.PI / 2} />
      </Environment>
    </>
  );
}
