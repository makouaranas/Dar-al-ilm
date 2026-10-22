import type * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createBlockGeometry, createHardcoverParts } from "./bookModel";
import { restProfile, SEGMENTS_X } from "./pageCurl";

const W = 0.7;
const H = 1;

function bounds(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe("open book block", () => {
  it("follows the curved page from its top down to the board, on the fore-edge, head and tail", () => {
    const thickness = 0.08;
    const right = createBlockGeometry(W, H, thickness, "right");
    const box = bounds(right);
    const { x, z } = restProfile(W);
    expect(box.min.z).toBeCloseTo(-thickness, 6);
    // Its top stays just under the page (never above it), up to the crown.
    expect(box.max.z).toBeLessThan(Math.max(...z));
    expect(box.max.z).toBeGreaterThan(Math.max(...z) - 0.002);
    expect(box.max.x).toBeCloseTo(x[SEGMENTS_X]!, 6);
    expect(box.min.y).toBeCloseTo(-H / 2, 6);
    expect(box.max.y).toBeCloseTo(H / 2, 6);
    // The left block is the mirror image.
    const left = bounds(createBlockGeometry(W, H, thickness, "left"));
    expect(left.min.x).toBeCloseTo(-box.max.x, 6);
  });

  it("maps the depth below the top page to u, for the paper edge lines", () => {
    const geometry = createBlockGeometry(W, H, 0.08, "right");
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    let max = 0;
    for (let i = 0; i < uv.count; i += 1) max = Math.max(max, uv.getX(i));
    // About (crown + thickness) / 0.16 at the deepest point.
    expect(max).toBeGreaterThan(0.08 / 0.16);
    expect(max).toBeLessThan(0.13 / 0.16);
  });
});

describe("closed hardcover", () => {
  const size = { thickness: 0.035, height: 0.24, depth: 0.17 };
  const parts = createHardcoverParts(size);

  it("has boards with real thickness that overhang an inset page block", () => {
    const board = bounds(parts.frontBoard);
    const block = bounds(parts.block);
    expect(board.max.x - board.min.x).toBeCloseTo(parts.board, 6);
    expect(parts.board).toBeGreaterThan(0.0015);
    // The block is shorter than the boards by the overhang at the head, tail and fore-edge.
    expect(board.max.y - board.min.y - (block.max.y - block.min.y)).toBeCloseTo(2 * parts.overhang, 6);
    expect(block.min.z - -size.depth / 2).toBeCloseTo(parts.overhang, 6);
    // And it fills the space between the two boards.
    expect(block.max.x - block.min.x).toBeCloseTo(size.thickness - 2 * parts.board, 6);
  });

  it("has a rounded spine across the full thickness and two gilt bands", () => {
    const spine = bounds(parts.spine);
    expect(spine.max.x - spine.min.x).toBeCloseTo(size.thickness, 6);
    expect(spine.max.z).toBeGreaterThan(size.depth / 2 - parts.joint);
    expect(parts.bands).toHaveLength(2);
  });
});
