import { describe, expect, it } from "vitest";

import {
  IDENTITY,
  MAX_BOOK_ZOOM,
  approach,
  clampTransform,
  panBy,
  sameTransform,
  wheelScale,
  zoomAbout,
  type BookTransform,
} from "./bookZoom";

const extent = { halfWidth: 1.5, halfHeight: 0.6 };
/** Where a book point (qx, qy) lands on the plane under a transform. */
const place = (t: BookTransform, qx: number, qy: number) => ({ x: t.x + t.scale * qx, y: t.y + t.scale * qy });

describe("book zoom", () => {
  it("keeps the point under the cursor fixed", () => {
    const a = zoomAbout(IDENTITY, 2, 0.4, 0.2, extent);
    expect(a.scale).toBe(2);
    // The book point (0.4, 0.2) is still at (0.4, 0.2).
    expect(place(a, 0.4, 0.2).x).toBeCloseTo(0.4, 10);
    expect(place(a, 0.4, 0.2).y).toBeCloseTo(0.2, 10);
    // Zooming again about another point keeps that one fixed too.
    const q = { x: (-0.3 - a.x) / a.scale, y: (0.1 - a.y) / a.scale };
    const b = zoomAbout(a, 3, -0.3, 0.1, extent);
    expect(place(b, q.x, q.y).x).toBeCloseTo(-0.3, 10);
    expect(place(b, q.x, q.y).y).toBeCloseTo(0.1, 10);
  });

  it("returns exactly to the centred book at 100 %", () => {
    const zoomed = zoomAbout(IDENTITY, 3, 1.2, -0.5, extent);
    expect(zoomAbout(zoomed, 1, 0.7, 0.3, extent)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("clamps the scale to 100 %-400 % and the offset to the book's own edges", () => {
    expect(clampTransform({ scale: 9, x: 0, y: 0 }, extent).scale).toBe(MAX_BOOK_ZOOM);
    expect(clampTransform({ scale: 0.5, x: 3, y: 3 }, extent)).toEqual({ scale: 1, x: 0, y: 0 });
    // At 200 % the centre may move at most half the book's width and height.
    const panned = panBy({ scale: 2, x: 0, y: 0 }, 10, -10, extent);
    expect(panned).toEqual({ scale: 2, x: 1.5, y: -0.6 });
    // The left edge stays at or left of where it was at 100 %.
    expect(panned.x - panned.scale * extent.halfWidth).toBeCloseTo(-extent.halfWidth, 10);
  });

  it("turns wheel deltas into scale changes (pinch is stronger)", () => {
    expect(wheelScale(1, 100, false)).toBe(1); // cannot zoom out below 100 %
    expect(wheelScale(1, -231, false)).toBeCloseTo(Math.SQRT2, 2);
    expect(wheelScale(2, 231, false)).toBeCloseTo(Math.SQRT2, 2);
    expect(wheelScale(1, -10, true)).toBeGreaterThan(wheelScale(1, -10, false));
    expect(wheelScale(3.9, -1000, false)).toBe(MAX_BOOK_ZOOM);
  });

  it("animates toward the target and snaps when close", () => {
    const target = { scale: 2, x: 0.5, y: -0.2 };
    let current = IDENTITY;
    current = approach(current, target, 70);
    expect(current.scale).toBeCloseTo(1 + (1 - Math.exp(-1)), 6);
    for (let i = 0; i < 40; i += 1) current = approach(current, target, 16);
    expect(current).toEqual(target);
    expect(sameTransform(approach(target, target, 16), target)).toBe(true);
  });
});
