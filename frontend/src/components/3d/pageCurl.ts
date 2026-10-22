/**
 * Page geometry, curl deformation and the page material (docs/ARCHITECTURE.md 11.2-11.3).
 *
 * Open pages are not flat: bound at the spine, each page rises out of the gutter, crowns and
 * settles toward the fore-edge, like a real book lying open (`restProfile`). A leaf is a grid
 * that starts resting on the right of the spine (x in [0, W]) and turns over to the left. Each
 * row is integrated along the paper from the spine with a bend angle that lags at the outer
 * edge, so the sheet curls like paper while keeping its exact length; at rest the same
 * integration gives the page's curved shape, so a leaf starts and lands exactly on the page
 * under it. Leaves that start on the left are drawn mirrored (scale.x = -1) by the component.
 *
 * The deformation runs on the CPU: a leaf has 49 x 9 vertices, a fraction of a millisecond
 * per frame, and the maths stays unit-testable.
 */

import * as THREE from "three";

export const SEGMENTS_X = 48;
export const SEGMENTS_Y = 8;

const LIGHT = new THREE.Vector3(-0.35, 0.45, 0.82).normalize();
export const PAPER_COLOR = new THREE.Color("#f6f5f2");

export interface CurlState {
  /** 0 = resting on the start side, 1 = resting on the other side. */
  progress: number;
  /** How much the outer edge lags behind the spine edge, in radians at mid-turn. */
  bend: number;
  /** Lift of one corner when dragging from a corner (-1 bottom .. 1 top), 0 for none. */
  twist: number;
  /** The leaf is drawn mirrored (a turn that starts on the left): light it as seen. */
  mirrored?: boolean;
}

// --- The resting shape of an open page -------------------------------------------------------

/** How high a page crowns above the spine line (page heights), and over what part of its width. */
export const PAGE_RISE = 0.045;
const RISE_LENGTH = 0.1;
/** How much it settles again toward the fore-edge. */
const FORE_DROP = 0.018;

/** Slope (radians) of a resting page at s = distance from the spine / page width (0..1). */
export function restAngle(s: number, width: number): number {
  const slope = (PAGE_RISE / RISE_LENGTH) * Math.exp(-s / RISE_LENGTH) - 2 * FORE_DROP * s;
  return Math.atan(slope / width);
}

/**
 * Cross-section of a resting page at each grid column (0..segments): x from the spine and the
 * height z, integrated along the paper so the page keeps its width.
 */
export function restProfile(width: number, segments = SEGMENTS_X): { x: Float32Array; z: Float32Array } {
  const x = new Float32Array(segments + 1);
  const z = new Float32Array(segments + 1);
  const ds = width / segments;
  for (let c = 1; c <= segments; c += 1) {
    const angle = restAngle((c - 0.5) / segments, width);
    x[c] = x[c - 1]! + ds * Math.cos(angle);
    z[c] = z[c - 1]! + ds * Math.sin(angle);
  }
  return { x, z };
}

/**
 * Light baked into paper (the reader adds no lights): Lambert from a soft light at the upper
 * left, and the shadow down into the gutter (`gutter` 0..1 fades it while a leaf lifts).
 */
export function paperShade(normalX: number, normalZ: number, s: number, gutter = 1, lightX = LIGHT.x): number {
  const facing = normalX * lightX + normalZ * LIGHT.z;
  const lambert = 0.74 + (0.26 * Math.max(0, facing)) / LIGHT.z;
  const occlusion = 1 - 0.38 * gutter * Math.exp(-s / 0.06);
  return Math.max(0.55, Math.min(1, lambert * occlusion));
}

/** Leaf grid: positions along the paper (d from the spine) and height y; z = 0. */
export function createLeafGeometry(width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, SEGMENTS_X, SEGMENTS_Y);
  geometry.translate(width / 2, 0, 0);
  const colors = new Float32Array(geometry.getAttribute("position").count * 3).fill(1);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** UVs mirrored left to right, for faces seen from behind or on a mirrored leaf. */
export function mirroredUv(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const mirrored = uv.clone();
  for (let i = 0; i < mirrored.count; i += 1) mirrored.setX(i, 1 - uv.getX(i));
  return mirrored;
}

/**
 * Deform a leaf in place. Writes positions and per-vertex shading for the front face
 * (`frontShade`) and the back face (`backShade`).
 */
export function deformLeaf(
  positions: Float32Array,
  frontShade: Float32Array,
  backShade: Float32Array,
  width: number,
  height: number,
  state: CurlState,
): void {
  const theta = Math.PI * Math.min(1, Math.max(0, state.progress));
  const lift = Math.sin(theta);
  // The resting curve: present on the start side, mirrored on the other, gone mid-turn.
  const rest = Math.cos(theta);
  const lightX = state.mirrored ? -LIGHT.x : LIGHT.x;
  const columns = SEGMENTS_X + 1;
  const ds = width / SEGMENTS_X;

  for (let row = 0; row <= SEGMENTS_Y; row += 1) {
    const y = height / 2 - (row * height) / SEGMENTS_Y;
    const yNorm = y / (height / 2); // 1 at the top, -1 at the bottom
    let x = 0;
    let z = 0;
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (column > 0) {
        // Bend angle at the middle of this segment: the outer part lags behind.
        const s = (column - 0.5) / SEGMENTS_X;
        const phi = theta - lift * (state.bend * s * s + state.twist * 0.35 * yNorm * s) + rest * restAngle(s, width);
        x += ds * Math.cos(phi);
        z += ds * Math.sin(phi);
      }
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;

      const s = column / SEGMENTS_X;
      const phi = theta - lift * (state.bend * s * s + state.twist * 0.35 * yNorm * s) + rest * restAngle(s, width);
      // Front face normal (rotated +z); the back face is its opposite. At rest the leaf is lit
      // exactly like the page under it.
      const nx = -Math.sin(phi);
      const nz = Math.cos(phi);
      const curl = lift * 0.12;
      const front = paperShade(nx, nz, s, 1 - lift, lightX) - curl * s;
      const back = paperShade(-nx, -nz, s, 1 - lift, lightX) - curl * s;
      frontShade.fill(Math.max(0.55, Math.min(1, front)), index * 3, index * 3 + 3);
      backShade.fill(Math.max(0.55, Math.min(1, back)), index * 3, index * 3 + 3);
    }
  }
}

/**
 * A resting page: the curved cross-section of `restProfile`, x in [0, W] (right page) or its
 * mirror (left page), with its light and gutter shadow baked into vertex colours.
 */
export function createPageGeometry(width: number, height: number, side: "left" | "right"): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, SEGMENTS_X, 1);
  const { x, z } = restProfile(width);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  const sign = side === "right" ? 1 : -1;
  for (let i = 0; i < positions.count; i += 1) {
    // The image's left edge is at the spine on the right page and at the fore-edge on the left.
    const s = side === "right" ? uv.getX(i) : 1 - uv.getX(i);
    const column = Math.round(s * SEGMENTS_X);
    positions.setX(i, sign * x[column]!);
    positions.setZ(i, z[column]!);
    const angle = restAngle(s, width);
    const shade = paperShade(-sign * Math.sin(angle), Math.cos(angle), s);
    colors.fill(shade, i * 3, i * 3 + 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// --- Page material ----------------------------------------------------------------------

/**
 * Shows a page image exactly as it is (no tone mapping), shaded by vertex colours.
 * Two image slots (A, B) allow a cross-fade from the low to the high quality image.
 * Each slot has a rectangle so pages with another aspect are fitted inside the frame.
 * Without an image the page shows paper with faint line placeholders, never a spinner.
 */
export function createPageMaterial(side: THREE.Side): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side,
    toneMapped: false,
    vertexColors: true,
    uniforms: {
      mapA: { value: null },
      mapB: { value: null },
      hasA: { value: 0 },
      hasB: { value: 0 },
      rectA: { value: new THREE.Vector4(0, 0, 1, 1) },
      rectB: { value: new THREE.Vector4(0, 0, 1, 1) },
      mixB: { value: 0 },
      paper: { value: PAPER_COLOR.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vShade;
      void main() {
        vUv = uv;
        vShade = color.r;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D mapA;
      uniform sampler2D mapB;
      uniform float hasA;
      uniform float hasB;
      uniform vec4 rectA;
      uniform vec4 rectB;
      uniform float mixB;
      uniform vec3 paper;
      varying vec2 vUv;
      varying float vShade;

      vec3 sampleSlot(sampler2D map, vec4 rect, vec3 fallback) {
        vec2 local = (vUv - rect.xy) / rect.zw;
        if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return fallback;
        // A slightly sharper mip level keeps small print crisp when the page is shown smaller
        // than its image (no effect once zoomed in past the image's own size).
        return texture2D(map, local, -0.5).rgb;
      }

      void main() {
        vec3 base = paper;
        float empty = 1.0 - max(hasA, hasB);
        float band = step(0.12, vUv.x) * step(vUv.x, 0.88) * step(0.1, vUv.y) * step(vUv.y, 0.9);
        float row = fract(vUv.y * 30.0);
        float line = band * smoothstep(0.0, 0.08, row) * (1.0 - smoothstep(0.16, 0.24, row));
        base = mix(base, base * 0.94, line * empty);
        vec3 a = hasA > 0.5 ? sampleSlot(mapA, rectA, paper) : base;
        vec3 b = hasB > 0.5 ? sampleSlot(mapB, rectB, paper) : a;
        vec3 color = mix(a, b, mixB) * vShade;
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}

/** Rectangle (x, y, w, h in UV space) that fits an image of `imageAspect` inside the frame. */
export function containRect(imageAspect: number, frameAspect: number): THREE.Vector4 {
  if (!Number.isFinite(imageAspect) || imageAspect <= 0) return new THREE.Vector4(0, 0, 1, 1);
  if (Math.abs(imageAspect - frameAspect) / frameAspect < 0.01) return new THREE.Vector4(0, 0, 1, 1);
  if (imageAspect > frameAspect) {
    const h = frameAspect / imageAspect;
    return new THREE.Vector4(0, (1 - h) / 2, 1, h);
  }
  const w = imageAspect / frameAspect;
  return new THREE.Vector4((1 - w) / 2, 0, w, 1);
}

/** Smooth start and end (docs/DESIGN.md section 11). */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
