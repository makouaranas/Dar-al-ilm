import { describe, expect, it } from "vitest";

import { FLIGHT_MARGIN, STAND_DISTANCE, catmullRom, flightDuration, planBookFlight, planHomeFlight, standPose, type FlightTarget } from "./flightPath";
import { BOOKCASE, SHELF_FRONT_Z, SPAWN, computeHallLayout, distanceToBox, isWalkable, placeBooks, type HallLayout, type ShelvedBook } from "./hallLayout";

function library(categories: number, booksPerCategory: number) {
  const cats = Array.from({ length: categories }, (_, i) => ({ id: i + 1, column_index: i }));
  const books: (ShelvedBook & { id: number })[] = [];
  let id = 1;
  for (const cat of cats) {
    for (let i = 0; i < booksPerCategory; i += 1) {
      books.push({ id: id++, category_id: cat.id, shelf_number: Math.floor(i / 30), slot_index: i % 30, page_count: 100 + 37 * i, page_width_pt: 595, page_height_pt: 842 });
    }
  }
  return { layout: computeHallLayout(cats, books), books };
}

/** World spine centre and outward normal of every book (as BookSpine reports them). */
function targets(layout: HallLayout, books: ReturnType<typeof library>["books"]) {
  const result: { id: number; target: FlightTarget; bayIndex: number }[] = [];
  layout.bays.forEach((bay, bayIndex) => {
    const own = books.filter((b) => b.category_id === bay.categoryId);
    for (const [book, p] of placeBooks(own).placements) {
      const bookcase = bay.bookcases[p.bookcase]!;
      const cos = Math.cos(bookcase.rotationY);
      const sin = Math.sin(bookcase.rotationY);
      const lz = p.z + p.depth / 2;
      result.push({
        id: book.id,
        bayIndex,
        target: { x: bookcase.x + p.x * cos + lz * sin, y: p.y, z: bookcase.z - p.x * sin + lz * cos, normalX: sin, normalZ: cos },
      });
    }
  });
  return result;
}

describe("catmullRom", () => {
  it("passes through every waypoint", () => {
    const points = [
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 3 },
      { x: 5, z: 3 },
    ];
    const curve = catmullRom(points, 8);
    for (const p of points) expect(curve.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 1e-9)).toBe(true);
    expect(curve[0]).toEqual(points[0]);
    expect(curve.at(-1)!.x).toBeCloseTo(5);
  });
});

describe("flight durations", () => {
  it("are 0.6 + distance / 25 s, between 0.6 and 1.5 s (Home at most 0.8 s)", () => {
    expect(flightDuration(0)).toBe(0.6);
    expect(flightDuration(10)).toBeCloseTo(1.0);
    expect(flightDuration(100)).toBe(1.5);
    expect(flightDuration(100, 0.8)).toBe(0.8);
  });
});

describe("book flights", () => {
  const minClearance = (points: { x: number; z: number }[], layout: HallLayout) => {
    let min = Infinity;
    for (const point of points) for (const box of layout.colliders) min = Math.min(min, distanceToBox(point.x, point.z, box));
    return min;
  };

  for (const [name, categories, perCategory, step] of [
    ["demo library", 4, 10, 1],
    ["large library", 9, 70, 9],
  ] as const) {
    it(`${name}: every waypoint is walkable and the path never comes near a box`, () => {
      const { layout, books } = library(categories, perCategory);
      const starts = [
        { x: SPAWN.position[0], z: SPAWN.position[2] },
        { x: 1.2, z: layout.length - 1.5 },
        { x: -1.0, z: 6 },
      ];
      const all = targets(layout, books).filter((_, i) => i % step === 0);
      expect(all.length).toBeGreaterThan(30);
      for (const { target, bayIndex } of all) {
        for (const start of starts) {
          const plan = planBookFlight(start, target, layout.bays[bayIndex]!, layout.colliders);
          for (const point of plan.waypoints.slice(1)) expect(isWalkable(point.x, point.z, layout.colliders, FLIGHT_MARGIN)).toBe(true);
          expect(minClearance(plan.points, layout)).toBeGreaterThanOrEqual(FLIGHT_MARGIN * 0.6 - 1e-6);
          expect(plan.duration).toBeLessThanOrEqual(1.5);
          expect(plan.duration).toBeGreaterThanOrEqual(0.6);
        }
      }
    });
  }

  it("arrives 1.3 m in front of the book, facing it", () => {
    const { layout, books } = library(4, 10);
    const { target, bayIndex } = targets(layout, books)[0]!;
    const plan = planBookFlight({ x: 0, z: 0.7 }, target, layout.bays[bayIndex]!, layout.colliders);
    const end = plan.points.at(-1)!;
    expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeCloseTo(STAND_DISTANCE, 5);
    // Looking from the stand point straight at the book.
    const look = { x: -Math.sin(plan.end.yaw), z: -Math.cos(plan.end.yaw) };
    expect(look.x * target.normalX + look.z * target.normalZ).toBeCloseTo(-1, 5);
    expect(plan.end).toEqual(standPose(target));
    // A bookcase's front is at its centre + depth / 2: the stand point is in the aisle.
    expect(BOOKCASE.depth / 2).toBeGreaterThan(SHELF_FRONT_Z);
  });

  it("can leave a bay to reach a book in another bay", () => {
    const { layout, books } = library(4, 10);
    const all = targets(layout, books);
    const first = all.find((t) => t.bayIndex === 0)!;
    const other = all.find((t) => t.bayIndex === 3)!;
    const start = standPose(first.target);
    const plan = planBookFlight(start, other.target, layout.bays[3]!, layout.colliders);
    for (const point of plan.points) {
      for (const box of layout.colliders) expect(distanceToBox(point.x, point.z, box)).toBeGreaterThanOrEqual(FLIGHT_MARGIN * 0.6 - 1e-6);
    }
  });
});

describe("Home flight", () => {
  it("ends at the spawn pose within 0.8 s on a clear path", () => {
    const { layout, books } = library(4, 10);
    const { target } = targets(layout, books)[5]!;
    const plan = planHomeFlight(standPose(target), layout.colliders);
    expect(plan.duration).toBeLessThanOrEqual(0.8);
    expect(plan.points.at(-1)).toEqual({ x: SPAWN.position[0], z: SPAWN.position[2] });
    for (const point of plan.points) {
      for (const box of layout.colliders) expect(distanceToBox(point.x, point.z, box)).toBeGreaterThanOrEqual(FLIGHT_MARGIN * 0.6 - 1e-6);
    }
  });
});
