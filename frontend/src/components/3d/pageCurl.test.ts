import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  PAGE_RISE,
  containRect,
  createLeafGeometry,
  createPageGeometry,
  deformLeaf,
  easeInOutCubic,
  restProfile,
  SEGMENTS_X,
  SEGMENTS_Y,
} from "./pageCurl";

const W = 0.7;
const H = 1;

function deform(progress: number, bend = 0.9, twist = 0) {
  const geometry = createLeafGeometry(W, H);
  const positions = new Float32Array(geometry.getAttribute("position").array);
  const count = positions.length;
  const front = new Float32Array(count);
  const back = new Float32Array(count);
  deformLeaf(positions, front, back, W, H, { progress, bend, twist });
  return { positions, front, back };
}

function rowLength(positions: Float32Array, row: number): number {
  const columns = SEGMENTS_X + 1;
  let length = 0;
  for (let c = 1; c < columns; c += 1) {
    const a = (row * columns + c - 1) * 3;
    const b = (row * columns + c) * 3;
    length += Math.hypot(positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!);
  }
  return length;
}

describe("deformLeaf", () => {
  it("keeps the paper length at every point of the turn", () => {
    for (const progress of [0, 0.1, 0.33, 0.5, 0.8, 1]) {
      for (const twist of [0, 1, -1]) {
        const { positions } = deform(progress, 0.9, twist);
        for (let row = 0; row <= SEGMENTS_Y; row += 1) {
          expect(rowLength(positions, row)).toBeCloseTo(W, 6);
        }
      }
    }
  });

  it("rests on the curved page profile at the start and on its mirror at the end", () => {
    const start = deform(0).positions;
    const end = deform(1).positions;
    const { x, z } = restProfile(W);
    const columns = SEGMENTS_X + 1;
    for (let i = 0; i < start.length; i += 3) {
      const column = (i / 3) % columns;
      expect(start[i]).toBeCloseTo(x[column]!, 6);
      expect(start[i + 2]).toBeCloseTo(z[column]!, 6);
      expect(end[i]).toBeCloseTo(-start[i]!, 6);
      expect(end[i + 2]).toBeCloseTo(start[i + 2]!, 6);
    }
  });

  it("matches the resting page under it, shape and light, so a turn starts without a jump", () => {
    const { positions, front } = deform(0);
    const page = createPageGeometry(W, H, "right");
    const pagePositions = page.getAttribute("position") as THREE.BufferAttribute;
    const pageColors = page.getAttribute("color") as THREE.BufferAttribute;
    const columns = SEGMENTS_X + 1;
    for (let c = 0; c < columns; c += 1) {
      // Top row of the page and of the leaf.
      expect(pagePositions.getX(c)).toBeCloseTo(positions[c * 3]!, 6);
      expect(pagePositions.getZ(c)).toBeCloseTo(positions[c * 3 + 2]!, 6);
      expect(pageColors.getX(c)).toBeCloseTo(front[c * 3]!, 2);
    }
  });

  it("lifts toward the viewer and lags at the outer edge mid-turn", () => {
    const { positions } = deform(0.5);
    const columns = SEGMENTS_X + 1;
    const outer = (4 * columns + SEGMENTS_X) * 3;
    expect(positions[outer + 2]).toBeGreaterThan(0.3 * W);
    // With the lag the outer edge has not passed the spine yet at mid-turn.
    expect(positions[outer]).toBeGreaterThan(0);
  });

  it("shades the face turned away from the light darker", () => {
    const { front, back } = deform(0.5);
    const middle = (4 * (SEGMENTS_X + 1) + SEGMENTS_X / 2) * 3;
    expect(front[middle]).not.toBeCloseTo(back[middle]!, 3);
    for (const value of [...front, ...back]) {
      expect(value).toBeGreaterThanOrEqual(0.55);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("resting page", () => {
  it("rises out of the gutter, crowns and settles toward the fore-edge, keeping its width", () => {
    const { x, z } = restProfile(W);
    const crown = Math.max(...z);
    expect(z[0]).toBe(0);
    expect(crown).toBeGreaterThan(PAGE_RISE * 0.7);
    expect(crown).toBeLessThan(PAGE_RISE * 1.05);
    // Steep near the spine, nearly level by a fifth of the width, a little lower at the edge.
    expect(z[Math.round(SEGMENTS_X / 5)]! / crown).toBeGreaterThan(0.8);
    expect(z[SEGMENTS_X]!).toBeLessThan(crown);
    let length = 0;
    for (let c = 1; c <= SEGMENTS_X; c += 1) length += Math.hypot(x[c]! - x[c - 1]!, z[c]! - z[c - 1]!);
    expect(length).toBeCloseTo(W, 6);
  });

  it("is lit from the upper left and shadowed into the gutter on both pages", () => {
    const right = createPageGeometry(W, H, "right").getAttribute("color") as THREE.BufferAttribute;
    const left = createPageGeometry(W, H, "left").getAttribute("color") as THREE.BufferAttribute;
    const middle = SEGMENTS_X / 2;
    // Darker in the gutter than mid-page (right page: column 0 is at the spine).
    expect(right.getX(0)).toBeLessThan(right.getX(middle));
    expect(left.getX(SEGMENTS_X)).toBeLessThan(left.getX(middle));
  });
});

describe("helpers", () => {
  it("fits other page shapes inside the frame", () => {
    expect(containRect(0.7, 0.7).toArray()).toEqual([0, 0, 1, 1]);
    const wide = containRect(1.4, 0.7);
    // (x, y, width, height) in UV space: a wide page is letterboxed top and bottom.
    expect(wide.x).toBe(0);
    expect(wide.z).toBe(1);
    expect(wide.y).toBeCloseTo(0.25);
    expect(wide.w).toBeCloseTo(0.5);
    const tall = containRect(0.35, 0.7);
    expect(tall.z).toBeCloseTo(0.5);
    expect(tall.x).toBeCloseTo(0.25);
  });

  it("eases in and out", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
  });
});
