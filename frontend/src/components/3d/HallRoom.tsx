"use client";

/**
 * The library hall's architecture, materials and light (docs/DESIGN.md sections 2-4,
 * docs/ARCHITECTURE.md sections 9.4 and 10.6).
 *
 * A tall limestone nave lit by mashrabiya-screened skylights, whose star pattern falls on the
 * floor as a static light map; lower side aisles divided into one bay per category; slim
 * columns with stepped capitals; a pointed entrance arch, an arched reading niche at the far
 * end, and the Entrance Desk under a warm brass pendant.
 *
 * Static geometry is merged per material, so the whole room is about twenty draw calls
 * however many categories there are. Nothing animates: the scene renders only when the camera
 * moves.
 */

import { Environment, Lightformer, useTexture } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { GraphicsQuality } from "@/lib/api";
import { BOOKCASE, DESK, HALL, SHELF_HEIGHTS, type HallLayout } from "@/lib/hallLayout";

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

/** Skylight light map: one 4.0 x 3.4 m tile per skylight, its patch 1.1 m past the tile start. */
const LIGHT_TILE = 3.4;
const LIGHT_PATCH_OFFSET = 1.1;
export const MEDALLION = { z: 3.0, radius: 0.85 } as const;
const DESK_PENDANT_Y = 2.75;
const BAY_LAMP_INSET = 0.85;
const BAY_PENDANT_Y = 2.85;

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
  brass: Geometry;
  brassPolished: Geometry;
  shades: Geometry;
  bulbs: Geometry;
  sky: Geometry;
  daylight: Geometry;
  mashrabiya: Geometry;
  pools: Geometry;
  washes: Geometry;
  contact: Geometry;
  halos: Float32Array;
  litStart: number;
}

function bookcaseCarcass(ash: Geometry[], walnut: Geometry[], x: number, z: number, rotationY: number) {
  const { length: L, depth: D, height: H } = BOOKCASE;
  const local: { parts: Geometry[]; target: Geometry[] }[] = [];
  const ashParts: Geometry[] = [];
  const walnutParts: Geometry[] = [];
  const side = 0.03;
  ashParts.push(box(side, H, D, -L / 2 + side / 2, H / 2, 0, { uvScale: 1 }));
  ashParts.push(box(side, H, D, L / 2 - side / 2, H / 2, 0, { uvScale: 1 }));
  ashParts.push(box(L, 0.04, D, 0, H - 0.02, 0, { uvScale: 1 }));
  ashParts.push(box(L - 2 * side, H - 0.12, 0.012, 0, 0.1 + (H - 0.12) / 2, -D / 2 + 0.006, { uvScale: 1 }));
  walnutParts.push(box(L - 2 * side - 0.02, 0.1, D - 0.06, 0, 0.05, -0.02));
  for (const top of SHELF_HEIGHTS) {
    ashParts.push(box(L - 2 * side, 0.025, BOOKCASE.shelfDepth, 0, top - 0.0125, -0.01, { uvScale: 1 }));
    walnutParts.push(box(L - 2 * side, 0.03, 0.014, 0, top - 0.015, -0.01 + BOOKCASE.shelfDepth / 2 + 0.007));
  }
  local.push({ parts: ashParts, target: ash }, { parts: walnutParts, target: walnut });
  for (const { parts, target } of local) {
    for (const part of parts) {
      part.rotateY(rotationY);
      part.translate(x, 0, z);
      target.push(part);
    }
  }
}

function buildRoom(layout: HallLayout): RoomGeometry {
  const half = layout.width / 2;
  const L = layout.length;
  const T = HALL.wall;
  const lamp = new THREE.Color(HALL_COLORS.lamp);
  const washer = new THREE.Color(HALL_COLORS.washer);
  const day = new THREE.Color(HALL_COLORS.daylight);

  // Floor: the nave strip under the skylights carries the light map; the rest is plain.
  const litStart = layout.skylights.length > 0 ? layout.skylights[0]! - LIGHT_PATCH_OFFSET : 0;
  const litEnd = layout.skylights.length > 0 ? litStart + LIGHT_TILE * layout.skylights.length : 0;
  const nx = HALL.naveHalfWidth;
  const floorParts = [floorRect(-half, -nx, 0, L, 0, 2.4), floorRect(nx, half, 0, L, 0, 2.4)];
  if (litStart > 0) floorParts.push(floorRect(-nx, nx, 0, litStart, 0, 2.4));
  if (litEnd < L) floorParts.push(floorRect(-nx, nx, Math.max(litStart, litEnd), L, 0, 2.4));
  const floor = merge(floorParts);
  const naveLit = litEnd > litStart ? merge([floorRect(-nx, nx, litStart, litEnd, 0, 2.4)]) : merge([floorRect(0, 0.001, 0, 0.001, -1, 1)]);

  // Plaster: outer walls, end walls, partitions, side-aisle soffits, clerestory walls.
  const plaster: Geometry[] = [];
  const aisle = HALL.aisleCeiling;
  for (const s of [-1, 1]) {
    plaster.push(box(T, aisle, L + 2 * T, s * (half + T / 2), aisle / 2, L / 2, { uvScale: 2 }));
    // Side-aisle ceiling.
    plaster.push(box(half - HALL.bayStartX, 0.12, L, s * ((half + HALL.bayStartX) / 2), aisle + 0.06, L / 2, { uvScale: 2 }));
    // Clerestory wall above the bay openings, up to the nave ceiling.
    plaster.push(box(0.24, HALL.ceiling - aisle, L, s * (HALL.bayStartX + 0.12), (HALL.ceiling + aisle) / 2, L / 2, { uvScale: 2 }));
    for (const z of layout.partitions) {
      plaster.push(box(half - HALL.bayStartX, aisle, HALL.partition, s * ((half + HALL.bayStartX) / 2), aisle / 2, z, { uvScale: 2 }));
    }
  }
  // Entrance wall with the pointed arch; end wall with the reading niche.
  plaster.push(archedWall(half, 2.6, 3.0, -T, T));
  plaster.push(archedWall(half, 2.0, 2.0, L, T));

  // Nave ceiling with the skylight slots, their light wells and the sky above.
  const ceilingShape = new THREE.Shape([
    new THREE.Vector2(-HALL.bayStartX, 0),
    new THREE.Vector2(HALL.bayStartX, 0),
    new THREE.Vector2(HALL.bayStartX, L),
    new THREE.Vector2(-HALL.bayStartX, L),
  ]);
  const slotHalfW = 0.7;
  const slotHalfL = 1.3;
  const wells: Geometry[] = [];
  const sky: Geometry[] = [];
  const lattice: Geometry[] = [];
  for (const z of layout.skylights) {
    ceilingShape.holes.push(
      new THREE.Path([
        new THREE.Vector2(-slotHalfW, z - slotHalfL),
        new THREE.Vector2(-slotHalfW, z + slotHalfL),
        new THREE.Vector2(slotHalfW, z + slotHalfL),
        new THREE.Vector2(slotHalfW, z - slotHalfL),
      ]),
    );
    const wellH = 0.35;
    const y = HALL.ceiling + wellH / 2;
    wells.push(box(0.04, wellH, 2 * slotHalfL, -slotHalfW - 0.02, y, z), box(0.04, wellH, 2 * slotHalfL, slotHalfW + 0.02, y, z));
    wells.push(box(2 * slotHalfW + 0.08, wellH, 0.04, 0, y, z - slotHalfL - 0.02), box(2 * slotHalfW + 0.08, wellH, 0.04, 0, y, z + slotHalfL + 0.02));
    sky.push(floorRect(-slotHalfW, slotHalfW, z - slotHalfL, z + slotHalfL, HALL.ceiling + wellH, 1, true));
    lattice.push(floorRect(-slotHalfW, slotHalfW, z - slotHalfL, z + slotHalfL, HALL.ceiling - 0.02, 1.3, true));
  }
  const ceilingGeometry = new THREE.ShapeGeometry(ceilingShape);
  ceilingGeometry.rotateX(Math.PI / 2);
  ceilingGeometry.translate(0, HALL.ceiling, 0);
  const ceiling = merge([flat(ceilingGeometry), ...wells]);

  const niche = merge([nicheLiner(2.0, 2.0, L + T, 0.6)]);

  // Limestone: columns with a plinth and a three-step capital; the desk top.
  const limestone: Geometry[] = [];
  for (const bay of layout.bays) {
    if (bay.categoryId === null) continue;
    const { x, z } = bay.column;
    limestone.push(box(0.36, 0.1, 0.36, x, 0.05, z, { uvScale: 0.6 }));
    const shaft = new THREE.CylinderGeometry(0.11, 0.115, 2.86, 24, 1);
    shaft.translate(x, 0.1 + 1.43, z);
    limestone.push(flat(shaft));
    limestone.push(
      box(0.26, 0.07, 0.26, x, 2.995, z, { uvScale: 0.6 }),
      box(0.34, 0.07, 0.34, x, 3.065, z, { uvScale: 0.6 }),
      box(0.42, 0.07, 0.42, x, 3.135, z, { uvScale: 0.6 }),
    );
  }
  limestone.push(box(DESK.width + 0.04, 0.04, DESK.depth + 0.04, DESK.x, DESK.height - 0.02, DESK.z, { uvScale: 0.6 }));

  // Ash and walnut: the desk, its book stands, the niche bench and the bookcases.
  const ash: Geometry[] = [];
  const walnut: Geometry[] = [];
  const brass: Geometry[] = [];
  const brassPolished: Geometry[] = [];
  ash.push(box(DESK.width, DESK.height - 0.12, DESK.depth, DESK.x, 0.08 + (DESK.height - 0.12) / 2, DESK.z, { uvScale: 1 }));
  walnut.push(box(DESK.width - 0.14, 0.08, DESK.depth - 0.14, DESK.x, 0.04, DESK.z));
  brassPolished.push(box(DESK.width + 0.05, 0.014, 0.014, DESK.x, DESK.height - 0.045, DESK.z - DESK.depth / 2 - 0.025));
  for (const offset of [-0.58, 0, 0.58]) {
    // Angled stand: a back plate leaning away from the entrance, and a brass lip.
    const plate = box(0.3, 0.34, 0.014, 0, 0.17, 0, { uvScale: 1, rotateX: -0.28 });
    plate.translate(DESK.x + offset, DESK.height, DESK.z + 0.06);
    ash.push(plate);
    brass.push(box(0.3, 0.02, 0.05, DESK.x + offset, DESK.height + 0.01, DESK.z - 0.04));
  }
  // The niche bench.
  ash.push(box(1.5, 0.06, 0.42, 0, 0.42, L + T + 0.33, { uvScale: 1 }));
  walnut.push(box(1.4, 0.39, 0.34, 0, 0.195, L + T + 0.34));
  for (const bay of layout.bays) {
    for (const bookcase of bay.bookcases) bookcaseCarcass(ash, walnut, bookcase.x, bookcase.z, bookcase.rotationY);
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

  // Brass inlay lines down the nave, and the empty bay's floor outline.
  for (const x of [-1.5, 1.5]) brassPolished.push(box(0.03, 0.004, L - 1.2, x, 0.002, L / 2 + 0.2));
  for (const bay of layout.bays) {
    if (bay.categoryId !== null) continue;
    const inner = bay.side * (HALL.bayStartX + 0.4);
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
  const pools: Geometry[] = [];
  const washes: Geometry[] = [];
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
    const x = bay.side * (HALL.bayStartX + BAY_LAMP_INSET);
    if (bay.categoryId !== null) pendant(x, BAY_PENDANT_Y, bay.zCenter, 0.15, aisle);
    pools.push(decal(floorRect(x - 1.5, x + 1.5, bay.zCenter - 1.5, bay.zCenter + 1.5, 0.004, 3), lamp, bay.categoryId === null ? 0.45 : 0.24));
    // A warm wall-washer on the bay's outer wall.
    washes.push(decal(wallRect(2.6, 3.2, bay.side * (half - 0.01), 1.65, bay.zCenter, bay.side > 0 ? "-x" : "+x"), washer, 0.32));
  }
  // The niche's wall-washer, and daylight spilling in through the entrance arch.
  washes.push(decal(wallRect(1.8, 2.8, 0, 1.45, L + T + 0.58, "-z"), washer, 0.55));
  pools.push(decal(floorRect(-1.6, 1.6, 0, 2.6, 0.004, 3.2), day, 0.16));

  const daylight = merge([wallRect(5, 6, 0, 3, -T - 1.2, "+z")]);
  const mergedSky = sky.length > 0 ? merge(sky) : merge([floorRect(0, 0.001, 0, 0.001, -1, 1)]);
  const mergedLattice = lattice.length > 0 ? merge(lattice) : merge([floorRect(0, 0.001, 0, 0.001, -1, 1)]);

  return {
    floor,
    naveLit,
    plaster: merge(plaster),
    ceiling,
    niche,
    limestone: merge(limestone),
    ash: merge(ash),
    walnut: merge(walnut),
    brass: merge(brass),
    brassPolished: merge(brassPolished),
    shades: merge(shades),
    bulbs: merge(bulbs),
    sky: mergedSky,
    daylight,
    mashrabiya: mergedLattice,
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
      plaster: new THREE.MeshStandardMaterial({ color: HALL_COLORS.plaster, roughness: 0.9 }),
      ceiling: new THREE.MeshStandardMaterial({ color: HALL_COLORS.plaster, roughness: 0.9, side: THREE.DoubleSide }),
      niche: new THREE.MeshStandardMaterial({ color: HALL_COLORS.plaster, roughness: 0.9, side: THREE.BackSide }),
      limestone: new THREE.MeshStandardMaterial({ map: textures.limestone, roughness: 0.7 }),
      ash: new THREE.MeshStandardMaterial({ map: textures.ash, roughness: 0.55 }),
      walnut: new THREE.MeshStandardMaterial({ color: HALL_COLORS.walnut, roughness: 0.5 }),
      brass: new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 1, roughness: 0.35 }),
      brassPolished: new THREE.MeshStandardMaterial({ color: HALL_COLORS.brass, metalness: 1, roughness: 0.25 }),
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

      <mesh geometry={room.floor} material={materials.floor} receiveShadow={shadows} />
      <mesh geometry={room.naveLit} material={materials.naveLit} receiveShadow={shadows} />
      <mesh geometry={medallionGeometry} material={materials.medallion} receiveShadow={shadows} />
      <mesh geometry={room.plaster} material={materials.plaster} castShadow={castShadows} receiveShadow={shadows} />
      <mesh geometry={room.ceiling} material={materials.ceiling} />
      <mesh geometry={room.niche} material={materials.niche} receiveShadow={shadows} />
      <mesh geometry={room.limestone} material={materials.limestone} castShadow={castShadows} receiveShadow={shadows} />
      <mesh geometry={room.ash} material={materials.ash} castShadow={castShadows} receiveShadow={shadows} />
      <mesh geometry={room.walnut} material={materials.walnut} castShadow={castShadows} receiveShadow={shadows} />
      <mesh geometry={room.brass} material={materials.brass} />
      <mesh geometry={room.brassPolished} material={materials.brassPolished} />
      <mesh geometry={room.shades} material={materials.shade} />
      <mesh geometry={room.bulbs} material={materials.bulb} />
      <mesh geometry={room.sky} material={materials.sky} />
      <mesh geometry={room.daylight} material={materials.daylight} />
      <mesh geometry={room.mashrabiya} material={materials.mashrabiya} />
      <mesh geometry={room.contact} material={materials.contact} renderOrder={1} />
      <mesh geometry={room.pools} material={materials.pools} renderOrder={1} />
      <mesh geometry={room.washes} material={materials.washes} renderOrder={1} />
      <points geometry={haloGeometry} material={materials.halo} renderOrder={2} />
    </group>
  );
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
        <Lightformer form="rect" intensity={1.2} color="#FFE8C8" scale={[6, 5, 1]} position={[0, 2.5, -4]} />
        <Lightformer form="rect" intensity={0.5} color="#F2E6D4" scale={[layout.length, 3, 1]} position={[-10, 1.5, center]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={0.5} color="#F2E6D4" scale={[layout.length, 3, 1]} position={[10, 1.5, center]} rotation-y={-Math.PI / 2} />
        <Lightformer form="rect" intensity={0.7} color="#E6DCCB" scale={[30, layout.length, 1]} position={[0, -3, center]} rotation-x={-Math.PI / 2} />
      </Environment>
    </>
  );
}
