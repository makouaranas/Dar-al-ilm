import { describe, expect, it } from "vitest";

import { containRect, createLeafGeometry, deformLeaf, easeInOutCubic, SEGMENTS_X, SEGMENTS_Y } from "./pageCurl";

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

  it("is flat on the right at the start and mirrored on the left at the end", () => {
    const start = deform(0).positions;
    const end = deform(1).positions;
    for (let i = 0; i < start.length; i += 3) {
      expect(start[i + 2]).toBeCloseTo(0, 6);
      expect(end[i + 2]).toBeCloseTo(0, 6);
      expect(end[i]).toBeCloseTo(-start[i]!, 6);
      expect(start[i]).toBeGreaterThanOrEqual(-1e-9);
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
