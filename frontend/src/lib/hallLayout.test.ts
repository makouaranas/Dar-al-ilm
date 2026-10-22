import { describe, expect, it } from "vitest";

import {
  BOOKCASE,
  DESK,
  HALL,
  SPAWN,
  bayDepth,
  computeHallLayout,
  distanceToBox,
  homeWaypoints,
  isWalkable,
  moveWithCollisions,
  pathLength,
  pointAlong,
  segmentIsClear,
  shelfLocation,
  type Box,
  type HallLayout,
  type LayoutBook,
} from "./hallLayout";

const categories = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, column_index: i }));

function booksIn(categoryId: number, count: number): LayoutBook[] {
  return Array.from({ length: count }, (_, i) => ({ category_id: categoryId, shelf_number: Math.floor(i / 30) }));
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9;
}

/** No two solid objects inside the hall overlap, and everything is inside the walls. */
function expectConsistent(layout: HallLayout) {
  const inner = layout.colliders.filter((box) => box.kind !== "wall");
  for (let i = 0; i < inner.length; i += 1) {
    for (let j = i + 1; j < inner.length; j += 1) {
      const [a, b] = [inner[i]!, inner[j]!];
      if (a.kind === "partition" && b.kind === "partition") continue;
      expect(overlaps(a, b), `${a.kind} ${JSON.stringify(a)} overlaps ${b.kind} ${JSON.stringify(b)}`).toBe(false);
    }
    const box = inner[i]!;
    expect(box.minX).toBeGreaterThanOrEqual(-layout.width / 2 - 1e-9);
    expect(box.maxX).toBeLessThanOrEqual(layout.width / 2 + 1e-9);
    expect(box.minZ).toBeGreaterThanOrEqual(0);
    expect(box.maxZ).toBeLessThanOrEqual(layout.length);
  }
  // The spawn point and the nave are walkable.
  expect(isWalkable(SPAWN.position[0], SPAWN.position[2], layout.colliders)).toBe(true);
  for (let z = DESK.z + DESK.depth / 2 + 0.35; z < layout.length - 0.5; z += 0.5) {
    expect(isWalkable(0, z, layout.colliders)).toBe(true);
  }
  for (let z = 0.5; z < layout.length - 0.5; z += 0.5) expect(isWalkable(1.5, z, layout.colliders)).toBe(true);
}

describe("shelf locations", () => {
  it("maps shelves to bookcases and tiers, eye level first", () => {
    expect(shelfLocation(0)).toEqual({ bookcase: 0, tier: 3 });
    expect(shelfLocation(1)).toEqual({ bookcase: 0, tier: 2 });
    expect(shelfLocation(4)).toEqual({ bookcase: 0, tier: 0 });
    expect(shelfLocation(5)).toEqual({ bookcase: 1, tier: 3 });
    expect(shelfLocation(66)).toEqual({ bookcase: 13, tier: 2 });
  });

  it("sizes a bay by its bookcases", () => {
    expect(bayDepth(0)).toBeCloseTo(3.5);
    expect(bayDepth(1)).toBeCloseTo(3.5);
    expect(bayDepth(2)).toBeCloseTo(3.5);
    expect(bayDepth(3)).toBeCloseTo(6.2);
  });
});

describe("hall layout", () => {
  it("0 categories: entrance zone, desk and one empty bay outline", () => {
    const layout = computeHallLayout([], []);
    expect(layout.empty).toBe(true);
    expect(layout.bays).toHaveLength(1);
    expect(layout.bays[0]).toMatchObject({ categoryId: null, side: -1, row: 0, bookcases: [] });
    expect(layout.rows).toBe(1);
    expect(layout.length).toBeCloseTo(8 + 3.4 + 2);
    expect(layout.width).toBeCloseTo(4 + 2 * (0.4 + 3.5));
    expect(layout.colliders.some((box) => box.kind === "desk")).toBe(true);
    expect(layout.colliders.some((box) => box.kind === "bookcase" || box.kind === "column")).toBe(false);
    expectConsistent(layout);
  });

  it("1 category: one bay on the -X side with one bookcase facing the aisle", () => {
    const layout = computeHallLayout(categories(1), booksIn(1, 12));
    const bay = layout.bays[0]!;
    expect(bay).toMatchObject({ categoryId: 1, side: -1, row: 0, zStart: 8, zEnd: 11.4, bookCount: 12 });
    expect(bay.bookcases).toHaveLength(1);
    const [bookcase] = bay.bookcases;
    expect(bookcase!.x).toBeCloseTo(-(2.4 + 0.2 + 1.3));
    expect(bookcase!.rotationY).toBe(0);
    expect(bay.column).toEqual({ x: -2.2, z: 9.7 });
    expect(layout.length).toBeCloseTo(13.4);
    expectConsistent(layout);
  });

  it("2 categories: one bay on each side of the same row", () => {
    const layout = computeHallLayout(categories(2), [...booksIn(1, 5), ...booksIn(2, 31)]);
    expect(layout.bays.map((bay) => [bay.side, bay.row])).toEqual([
      [-1, 0],
      [1, 0],
    ]);
    // 31 books: shelf 1 still lives in bookcase 0.
    expect(layout.bays[1]!.bookcases).toHaveLength(1);
    expect(layout.rows).toBe(1);
    expectConsistent(layout);
  });

  it("5 categories: three rows, alternating sides", () => {
    const layout = computeHallLayout(categories(5), [1, 2, 3, 4, 5].flatMap((id) => booksIn(id, 10 * id)));
    expect(layout.bays.map((bay) => [bay.side, bay.row])).toEqual([
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
      [-1, 2],
    ]);
    expect(layout.rows).toBe(3);
    expect(layout.length).toBeCloseTo(8 + 3 * 3.4 + 2);
    expect(layout.partitions).toEqual([8, 11.4, 14.8, 18.2].map((z) => expect.closeTo(z, 9)));
    expect(layout.skylights.length).toBeGreaterThanOrEqual(5);
    expectConsistent(layout);
  });

  it("a category with 2,000 books: 14 bookcases on both walls of a deep bay", () => {
    const layout = computeHallLayout(categories(2), [...booksIn(1, 2000), ...booksIn(2, 3)]);
    const bay = layout.bays[0]!;
    expect(bay.bookcases).toHaveLength(14); // shelves 0..66 -> bookcases 0..13
    expect(bay.bookcases.filter((b) => b.wall === 0)).toHaveLength(7);
    expect(bay.bookcases.filter((b) => b.wall === 1).every((b) => b.rotationY === Math.PI)).toBe(true);
    expect(bay.depth).toBeCloseTo(0.2 + 7 * 2.7 + 0.6);
    expect(layout.width).toBeCloseTo(4 + 2 * (0.4 + bay.depth));
    // The aisle between facing bookcases is 2.5 m wide.
    const [a, b] = [bay.bookcases[0]!, bay.bookcases[1]!];
    expect(Math.abs(b.z - a.z) - BOOKCASE.depth).toBeCloseTo(2.5);
    // The deepest bookcase stays inside the hall.
    const outer = Math.max(...bay.bookcases.map((c) => Math.abs(c.x) + BOOKCASE.length / 2));
    expect(outer).toBeLessThanOrEqual(layout.width / 2 - HALL.sideMargin + 1e-9);
    expectConsistent(layout);
  });
});

describe("collision", () => {
  const layout = computeHallLayout(categories(4), [1, 2, 3, 4].flatMap((id) => booksIn(id, 10)));
  const bookcase = layout.colliders.find((box) => box.kind === "bookcase")!;

  it("stops at a box and keeps the radius", () => {
    // Walk from the aisle straight into the first bookcase (it faces +Z).
    const startX = (bookcase.minX + bookcase.maxX) / 2;
    let p = { x: startX, z: bookcase.maxZ + 1.0 };
    for (let i = 0; i < 60; i += 1) p = moveWithCollisions(p.x, p.z, 0, -0.05, layout.colliders);
    expect(p.z).toBeCloseTo(bookcase.maxZ + HALL.playerRadius, 3);
    expect(distanceToBox(p.x, p.z, bookcase)).toBeGreaterThanOrEqual(HALL.playerRadius - 1e-6);
  });

  it("slides along a wall when walking into it at an angle", () => {
    const half = layout.width / 2;
    const start = { x: half - 1.0, z: 6.0 }; // the side lobby by the entrance
    let p = start;
    for (let i = 0; i < 80; i += 1) p = moveWithCollisions(p.x, p.z, 0.05, -0.03, layout.colliders);
    expect(p.x).toBeCloseTo(half - HALL.playerRadius, 3);
    expect(p.z).toBeLessThan(start.z - 0.5);
  });

  it("never tunnels through a thin partition, even with a large step", () => {
    const partition = layout.colliders.find((box) => box.kind === "partition" && box.minX > 0)!;
    const x = partition.maxX - 0.5;
    const p = moveWithCollisions(x, partition.minZ - 0.5, 0, 3, layout.colliders);
    expect(p.z).toBeLessThanOrEqual(partition.minZ - HALL.playerRadius + 1e-9);
  });

  it("random walks never enter a box", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    let p = { x: SPAWN.position[0], z: SPAWN.position[2] };
    for (let i = 0; i < 4000; i += 1) {
      p = moveWithCollisions(p.x, p.z, random() * 0.3, random() * 0.3 + 0.02, layout.colliders);
      for (const box of layout.colliders) expect(distanceToBox(p.x, p.z, box)).toBeGreaterThanOrEqual(HALL.playerRadius - 1e-6);
    }
  });
});

describe("paths", () => {
  const layout = computeHallLayout(categories(4), [1, 2, 3, 4].flatMap((id) => booksIn(id, 10)));

  it("detects segments through boxes", () => {
    const desk = { x: DESK.x, z: DESK.z };
    expect(segmentIsClear({ x: 0, z: 1.4 }, { x: 0, z: 6 }, layout.colliders)).toBe(false);
    expect(segmentIsClear({ x: 0, z: 1.4 }, { x: 1.6, z: 1.4 }, layout.colliders)).toBe(true);
    expect(segmentIsClear({ x: -1.6, z: desk.z - 1 }, { x: -1.6, z: desk.z + 1 }, layout.colliders)).toBe(true);
  });

  it("Home finds a clear route out of a bay and around the desk", () => {
    const bay = layout.bays[0]!;
    const from = { x: bay.column.x - 1.2, z: bay.zCenter };
    const path = homeWaypoints(from, layout.colliders);
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual({ x: SPAWN.position[0], z: SPAWN.position[2] });
    for (let i = 1; i < path.length; i += 1) {
      expect(segmentIsClear(path[i - 1]!, path[i]!, layout.colliders, HALL.playerRadius * 0.5)).toBe(true);
    }
    expect(pathLength(path)).toBeGreaterThan(Math.hypot(from.x, from.z - SPAWN.position[2]));
  });

  it("walks along a polyline by distance", () => {
    const line = [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 3, z: 4 },
    ];
    expect(pathLength(line)).toBe(7);
    expect(pointAlong(line, 1.5)).toEqual({ x: 1.5, z: 0 });
    expect(pointAlong(line, 5)).toEqual({ x: 3, z: 2 });
    expect(pointAlong(line, 99)).toEqual({ x: 3, z: 4 });
  });
});
