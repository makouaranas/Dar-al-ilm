/**
 * Book bodies with real volume (US-18, docs/ARCHITECTURE.md section 11.7): the page blocks and
 * boards of the open book in the reader, its contact shadow, and the closed hardcover used by
 * the presenter and the opening transition.
 *
 * The open book is lit by light baked into vertex colours (`bakeLight`), because the reader
 * inside the hall adds no lights (that would recompile every hall material) and the hall's own
 * lights are hidden while a book is open. The closed hardcover lives in the lit hall and uses
 * standard materials. Textures are drawn on canvases at runtime (no files).
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { restProfile, SEGMENTS_X } from "./pageCurl";

/** Soft key light at the upper left, slightly in front (shared with the page shading). */
const LIGHT = new THREE.Vector3(-0.35, 0.45, 0.82).normalize();

/** Writes Lambert light (with ambient) for `light` into a "color" attribute from the normals. */
export function bakeLight(geometry: THREE.BufferGeometry, light: THREE.Vector3 = LIGHT, ambient = 0.62): THREE.BufferGeometry {
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const colors = new Float32Array(normals.count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < normals.count; i += 1) {
    n.fromBufferAttribute(normals, i);
    const shade = Math.min(1, ambient + (1 - ambient) * Math.max(0, n.dot(light)) * 1.15);
    colors.fill(shade, i * 3, i * 3 + 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// --- Paper edges --------------------------------------------------------------------------------

/** The period of the drawn page lines, in the units of the surface they are mapped on. */
export const EDGE_TEXTURE_SPAN = 0.16;
export const HARDCOVER_EDGE_SPAN = 0.04;

let edgeTexture: THREE.CanvasTexture | null = null;

/**
 * Cut paper edges: many fine lines of slightly different tones, one per bundle of leaves, as
 * on the edge of a real book. Lines run along v (constant u) and repeat freely; u is the depth
 * into the block divided by `EDGE_TEXTURE_SPAN` (open book, page units) or `HARDCOVER_EDGE_SPAN`
 * (closed book, metres): about 4 cm of paper per repeat either way.
 */
export function paperEdgeTexture(): THREE.CanvasTexture {
  if (edgeTexture) return edgeTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#efe7d6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Deterministic pseudo-random tones so every book looks the same from session to session.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let x = 0; x < canvas.width; x += 1) {
    const tone = 0.86 + random() * 0.14 - (x % 4 === 0 ? 0.06 : 0);
    const r = Math.round(239 * tone);
    const g = Math.round(231 * tone);
    const b = Math.round(214 * tone);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  edgeTexture = new THREE.CanvasTexture(canvas);
  edgeTexture.colorSpace = THREE.SRGBColorSpace;
  edgeTexture.wrapS = edgeTexture.wrapT = THREE.RepeatWrapping;
  edgeTexture.anisotropy = 4;
  return edgeTexture;
}

// --- The open book ------------------------------------------------------------------------------

/**
 * The visible walls of one side's page block under a resting page: the fore-edge, the head and
 * the tail follow the page's curved cross-section from its top down to the board. UV u is the
 * depth below the top page (for the edge lines), v runs along the wall.
 */
export function createBlockGeometry(width: number, height: number, thickness: number, side: "left" | "right", inset = 0.0006): THREE.BufferGeometry {
  const { x, z } = restProfile(width);
  const sign = side === "right" ? 1 : -1;
  // The leaves under the top page fan back from the fore-edge, so the cut edge slopes outward
  // and up and shows from the front, as on a real open book.
  const reach = x[SEGMENTS_X]!;
  const slant = Math.min(thickness * 0.45, 0.03);
  const under = (along: number) => (along * (reach - slant)) / reach;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const bottom = -thickness;

  const quad = (a: number[], b: number[], c: number[], d: number[], shadeTop: number, shadeBottom: number) => {
    const base = positions.length / 3;
    for (const [px, py, pz, u, v] of [a, b, c, d] as number[][]) {
      positions.push(px!, py!, pz!);
      uvs.push(u!, v!);
      const t = (pz! - bottom) / Math.max(1e-6, thickness + 0.05); // darker toward the board
      const shade = shadeBottom + (shadeTop - shadeBottom) * Math.min(1, Math.max(0, t));
      colors.push(shade, shade, shade);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Head (+y) and tail (-y): strips between the page's curve and the board.
  for (const yy of [height / 2, -height / 2]) {
    const facing = yy > 0 ? 0.98 : 0.8;
    for (let c = 0; c < SEGMENTS_X; c += 1) {
      const x0 = sign * x[c]!;
      const x1 = sign * x[c + 1]!;
      const top0 = z[c]! - inset;
      const top1 = z[c + 1]! - inset;
      const u = (depth: number) => depth / EDGE_TEXTURE_SPAN;
      const along0 = x[c]!;
      const along1 = x[c + 1]!;
      const a = [x0, yy, top0, u(0), along0];
      const b = [x1, yy, top1, u(0), along1];
      const cc = [sign * under(x[c + 1]!), yy, bottom, u(top1 - bottom), along1];
      const d = [sign * under(x[c]!), yy, bottom, u(top0 - bottom), along0];
      // Keep the triangles facing outward (+y on the head, -y on the tail).
      if ((yy > 0) === (sign > 0)) quad(a, d, cc, b, facing, facing * 0.82);
      else quad(a, b, cc, d, facing, facing * 0.82);
    }
  }
  // Fore-edge: a wall at the page's outer edge.
  const xe = sign * x[SEGMENTS_X]!;
  const topE = z[SEGMENTS_X]! - inset;
  const fore = sign > 0 ? 0.86 : 0.98; // the right block's edge faces away from the light
  const depthU = (topE - bottom) / EDGE_TEXTURE_SPAN;
  const xb = sign * (reach - slant);
  const e0 = [xe, height / 2, topE, 0, height / 2];
  const e1 = [xe, -height / 2, topE, 0, -height / 2];
  const e2 = [xb, -height / 2, bottom, depthU, -height / 2];
  const e3 = [xb, height / 2, bottom, depthU, height / 2];
  if (sign > 0) quad(e0, e3, e2, e1, fore, fore * 0.82);
  else quad(e0, e1, e2, e3, fore, fore * 0.82);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One cover board of the open book, with rounded edges and baked light. */
export function createBoardGeometry(width: number, height: number, thickness: number): THREE.BufferGeometry {
  const geometry = new RoundedBoxGeometry(width, height, thickness, 3, Math.min(thickness * 0.48, 0.006));
  return bakeLight(geometry);
}

let shadowTexture: THREE.CanvasTexture | null = null;

/** A soft rectangular contact shadow (alpha), blurred on a canvas. */
export function contactShadowTexture(): THREE.CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = "blur(18px)";
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(44, 40, 168, 176);
  shadowTexture = new THREE.CanvasTexture(canvas);
  return shadowTexture;
}

// --- The closed hardcover -------------------------------------------------------------------------

/**
 * UVs for a board's two large faces (normals along ±x), so a cover image reads correctly from
 * either side: seen from +x the spine (+z) is on the left, seen from -x it is on the right
 * (left-to-right and right-to-left books). Other faces keep their UVs.
 */
export function coverUv(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const depth = box.max.z - box.min.z;
  const height = box.max.y - box.min.y;
  for (let i = 0; i < positions.count; i += 1) {
    const nx = normals.getX(i);
    if (Math.abs(nx) < 0.5) continue;
    const z = positions.getZ(i);
    const u = nx > 0 ? (box.max.z - z) / depth : (z - box.min.z) / depth;
    uv.setXY(i, u, (positions.getY(i) - box.min.y) / height);
  }
  uv.needsUpdate = true;
}

export interface HardcoverSize {
  thickness: number;
  height: number;
  depth: number;
}

export interface HardcoverParts {
  /** Board thickness and the board's overhang beyond the page block. */
  board: number;
  overhang: number;
  /** Gap between the boards and the spine (the joint). */
  joint: number;
  frontBoard: THREE.BufferGeometry;
  backBoard: THREE.BufferGeometry;
  block: THREE.BufferGeometry;
  spine: THREE.BufferGeometry;
  bands: THREE.BufferGeometry[];
}

/**
 * Geometry of a closed hardcover in the canonical book frame (x = thickness, front cover on
 * +x for left-to-right books; y up; spine at +z): two rounded boards overhanging the page block,
 * an inset block with paper edges, a rounded spine and two gilt bands across it.
 */
export function createHardcoverParts(size: HardcoverSize): HardcoverParts {
  const { thickness, height, depth } = size;
  const board = Math.min(0.0032, Math.max(0.0016, thickness * 0.09));
  const overhang = Math.min(0.003, height * 0.012);
  const joint = Math.min(0.005, depth * 0.03);
  const bulge = Math.min(0.006, thickness * 0.22);
  const boardDepth = depth - joint;
  const front = new RoundedBoxGeometry(board, height, boardDepth, 2, board * 0.45);
  coverUv(front);
  const back = front.clone();
  // The block: inset by the overhang at the head, tail and fore-edge, between the boards.
  const blockDepth = depth - joint - overhang;
  const block = new THREE.BoxGeometry(Math.max(0.001, thickness - 2 * board), height - 2 * overhang, blockDepth);
  block.translate(0, 0, -depth / 2 + overhang + blockDepth / 2);
  // Edge lines across the thickness on the head, tail and fore-edge faces (BoxGeometry maps u
  // along x on those faces).
  const uv = block.getAttribute("uv") as THREE.BufferAttribute;
  const repeats = (thickness - 2 * board) / HARDCOVER_EDGE_SPAN;
  for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * repeats);
  // Spine: half an elliptic tube from one board to the other, bulging past the joint.
  const spine = new THREE.CylinderGeometry(1, 1, height, 28, 1, true, -Math.PI / 2, Math.PI);
  spine.scale(thickness / 2, 1, bulge);
  spine.translate(0, 0, depth / 2 - joint);
  const bands = [-1, 1].map((sign) => {
    const band = new THREE.CylinderGeometry(1, 1, height * 0.012, 28, 1, true, -Math.PI / 2, Math.PI);
    band.scale(thickness / 2 + 0.0004, 1, bulge + 0.0004);
    band.translate(0, sign * height * 0.17, depth / 2 - joint);
    return band;
  });
  return { board, overhang, joint, frontBoard: front, backBoard: back, block, spine, bands };
}
