/**
 * Page geometry, curl deformation and the page material (docs/ARCHITECTURE.md 11.2-11.3).
 *
 * A leaf is a grid that starts flat on the right of the spine (x in [0, W]) and turns over to
 * the left. Each row is integrated along the paper from the spine with a bend angle that lags
 * at the outer edge, so the sheet curls like paper while keeping its exact length. Leaves that
 * start on the left are drawn mirrored (scale.x = -1) by the component.
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
  /** 0 = flat on the start side, 1 = flat on the other side. */
  progress: number;
  /** How much the outer edge lags behind the spine edge, in radians at mid-turn. */
  bend: number;
  /** Lift of one corner when dragging from a corner (-1 bottom .. 1 top), 0 for none. */
  twist: number;
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
        const phi = theta - lift * (state.bend * s * s + state.twist * 0.35 * yNorm * s);
        x += ds * Math.cos(phi);
        z += ds * Math.sin(phi);
      }
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;

      const s = column / SEGMENTS_X;
      const phi = theta - lift * (state.bend * s * s + state.twist * 0.35 * yNorm * s);
      // Front face normal (rotated +z); the back face is its opposite.
      const nx = -Math.sin(phi);
      const nz = Math.cos(phi);
      const facing = nx * LIGHT.x + nz * LIGHT.z;
      const curl = lift * 0.12;
      const front = 0.8 + 0.2 * Math.max(0, facing) - curl * s;
      const back = 0.8 + 0.2 * Math.max(0, -facing) - curl * s;
      frontShade.fill(Math.max(0.55, Math.min(1, front)), index * 3, index * 3 + 3);
      backShade.fill(Math.max(0.55, Math.min(1, back)), index * 3, index * 3 + 3);
    }
  }
}

/** Shading of a page lying flat: full light, with a soft shadow into the gutter. */
export function gutterShade(geometry: THREE.BufferGeometry, width: number, spineAtX: number): void {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const colors = geometry.getAttribute("color") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i += 1) {
    const distance = Math.abs(positions.getX(i) - spineAtX) / width;
    const shade = 1 - 0.2 * Math.exp(-distance / 0.05);
    colors.setXYZ(i, shade, shade, shade);
  }
  colors.needsUpdate = true;
}

/** A flat page with a gutter shadow: x in [0, W] (right page) or [-W, 0] (left page). */
export function createFlatPageGeometry(width: number, height: number, side: "left" | "right"): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, 24, 1);
  geometry.translate(side === "right" ? width / 2 : -width / 2, 0, 0);
  const colors = new Float32Array(geometry.getAttribute("position").count * 3).fill(1);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  gutterShade(geometry, width, 0);
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
        return texture2D(map, local).rgb;
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
