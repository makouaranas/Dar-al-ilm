/**
 * The library hall's layout (docs/ARCHITECTURE.md sections 9.3-9.5): bays, bookcases,
 * columns, the desk, the hall size and the collision boxes, computed from the categories and
 * the books' shelf numbers. Pure functions, unit-tested; the 3D components only draw it.
 *
 * Units are metres. The floor is the XZ plane, +Y is up, the entrance is at z = 0 and the
 * hall extends toward +Z.
 */

export const BOOKS_PER_SHELF = 30;
export const SHELVES_PER_CASE = 5;
/** Shelf `n` sits on tier TIER_ORDER[n % 5] of bookcase n // 5: the first books at eye level. */
export const TIER_ORDER = [3, 2, 4, 1, 0] as const;
/** Top surface height of each tier's shelf board. */
export const SHELF_HEIGHTS = [0.12, 0.57, 1.02, 1.47, 1.92] as const;

export const BOOKCASE = {
  length: 2.6,
  depth: 0.36,
  height: 2.45,
  /** Length taken along the bay wall, including the 0.1 m gap. */
  pitch: 2.7,
  shelfLength: 2.4,
  shelfDepth: 0.32,
} as const;

export const HALL = {
  naveHalfWidth: 2.0,
  /** Bays start at |x| = 2.4; the columns stand at |x| = 2.2. */
  bayStartX: 2.4,
  columnX: 2.2,
  entranceDepth: 8,
  bayPitch: 3.4,
  bayFront: 0.2,
  bayBack: 0.6,
  sideMargin: 0.4,
  endZone: 2.0,
  ceiling: 6.0,
  /** Height of the side-aisle ceiling; the nave rises to `ceiling` (tunable). */
  aisleCeiling: 3.4,
  partition: 0.12,
  wall: 0.3,
  eyeHeight: 1.62,
  playerRadius: 0.3,
  columnHalf: 0.2,
} as const;

export const DESK = { x: 0, z: 3.6, width: 1.8, depth: 0.7, height: 0.95 } as const;

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
}

/** Spawn and Home pose (section 9.4). */
export const SPAWN: Pose = { position: [0, HALL.eyeHeight, 1.4], target: [0, 1.1, 3.6] };

export type ColliderKind = "wall" | "partition" | "bookcase" | "column" | "desk";

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  kind: ColliderKind;
}

export interface BookcaseLayout {
  /** Index within the bay: bookcase `k` holds shelves 5k .. 5k + 4. */
  index: number;
  /** 0 = the bay wall at the bay's lower z, 1 = the wall at its higher z. */
  wall: 0 | 1;
  x: number;
  z: number;
  /** Rotation about Y: the shelves face +Z at 0 and -Z at PI (toward the bay's aisle). */
  rotationY: number;
}

export interface BayLayout {
  /** null for the empty bay outline shown when there are no categories. */
  categoryId: number | null;
  columnIndex: number;
  /** -1 = the -X side of the nave, 1 = the +X side. */
  side: -1 | 1;
  row: number;
  zStart: number;
  zEnd: number;
  zCenter: number;
  depth: number;
  bookCount: number;
  bookcases: BookcaseLayout[];
  column: { x: number; z: number };
}

export interface HallLayout {
  width: number;
  length: number;
  rows: number;
  bays: BayLayout[];
  /** z of each bay-row boundary (the partitions between bays). */
  partitions: number[];
  /** z centres of the nave's skylight slots. */
  skylights: number[];
  colliders: Box[];
  /** True when there are no categories (the hall shows one empty bay outline). */
  empty: boolean;
}

export interface LayoutCategory {
  id: number;
  column_index: number;
}

export interface LayoutBook {
  category_id: number;
  shelf_number: number;
}

/** The bookcase and tier holding shelf `shelfNumber` (section 9.3). */
export function shelfLocation(shelfNumber: number): { bookcase: number; tier: number } {
  return { bookcase: Math.floor(shelfNumber / SHELVES_PER_CASE), tier: TIER_ORDER[shelfNumber % SHELVES_PER_CASE]! };
}

export function bayDepth(bookcases: number): number {
  return HALL.bayFront + Math.ceil(Math.max(bookcases, 1) / 2) * BOOKCASE.pitch + HALL.bayBack;
}

function bookcasePlacement(side: -1 | 1, zStart: number, zEnd: number, index: number): BookcaseLayout {
  const wall = (index % 2) as 0 | 1;
  const along = Math.floor(index / 2);
  const x = side * (HALL.bayStartX + HALL.bayFront + along * BOOKCASE.pitch + BOOKCASE.length / 2);
  // Back against the partition: half the partition, a 3 cm gap, half the bookcase depth.
  const inset = HALL.partition / 2 + 0.03 + BOOKCASE.depth / 2;
  return wall === 0
    ? { index, wall, x, z: zStart + inset, rotationY: 0 }
    : { index, wall, x, z: zEnd - inset, rotationY: Math.PI };
}

export function computeHallLayout(categories: LayoutCategory[], books: LayoutBook[]): HallLayout {
  const casesByCategory = new Map<number, number>();
  const booksByCategory = new Map<number, number>();
  for (const book of books) {
    const cases = shelfLocation(book.shelf_number).bookcase + 1;
    casesByCategory.set(book.category_id, Math.max(casesByCategory.get(book.category_id) ?? 1, cases));
    booksByCategory.set(book.category_id, (booksByCategory.get(book.category_id) ?? 0) + 1);
  }

  const sources: { categoryId: number | null; columnIndex: number; cases: number; books: number }[] =
    categories.length > 0
      ? [...categories]
          .sort((a, b) => a.column_index - b.column_index)
          .map((category) => ({
            categoryId: category.id,
            columnIndex: category.column_index,
            cases: casesByCategory.get(category.id) ?? 1,
            books: booksByCategory.get(category.id) ?? 0,
          }))
      : [{ categoryId: null, columnIndex: 0, cases: 1, books: 0 }];

  const bays: BayLayout[] = sources.map((source) => {
    const side: -1 | 1 = source.columnIndex % 2 === 0 ? -1 : 1;
    const row = Math.floor(source.columnIndex / 2);
    const zStart = HALL.entranceDepth + HALL.bayPitch * row;
    const zEnd = zStart + HALL.bayPitch;
    const zCenter = (zStart + zEnd) / 2;
    const bookcases =
      source.categoryId === null
        ? []
        : Array.from({ length: source.cases }, (_, index) => bookcasePlacement(side, zStart, zEnd, index));
    return {
      categoryId: source.categoryId,
      columnIndex: source.columnIndex,
      side,
      row,
      zStart,
      zEnd,
      zCenter,
      depth: bayDepth(source.cases),
      bookCount: source.books,
      bookcases,
      column: { x: side * HALL.columnX, z: zCenter },
    };
  });

  const rows = Math.max(1, Math.ceil(sources.length / 2), ...bays.map((bay) => bay.row + 1));
  const deepest = Math.max(...bays.map((bay) => bay.depth));
  const width = 2 * HALL.naveHalfWidth + 2 * (HALL.sideMargin + deepest);
  const length = HALL.entranceDepth + HALL.bayPitch * rows + HALL.endZone;
  const half = width / 2;

  const partitions = Array.from({ length: rows + 1 }, (_, r) => HALL.entranceDepth + HALL.bayPitch * r);
  const skylights: number[] = [];
  for (let z = 2.9; z + 1.4 < length - 0.4; z += HALL.bayPitch) skylights.push(z);

  const colliders: Box[] = [
    // Outer walls.
    { minX: -half - HALL.wall, maxX: -half, minZ: -HALL.wall, maxZ: length + HALL.wall, kind: "wall" },
    { minX: half, maxX: half + HALL.wall, minZ: -HALL.wall, maxZ: length + HALL.wall, kind: "wall" },
    { minX: -half, maxX: half, minZ: -HALL.wall, maxZ: 0, kind: "wall" },
    { minX: -half, maxX: half, minZ: length, maxZ: length + HALL.wall, kind: "wall" },
    // The desk.
    {
      minX: DESK.x - DESK.width / 2,
      maxX: DESK.x + DESK.width / 2,
      minZ: DESK.z - DESK.depth / 2,
      maxZ: DESK.z + DESK.depth / 2,
      kind: "desk",
    },
  ];
  for (const z of partitions) {
    for (const side of [-1, 1] as const) {
      const [a, b] = [side * HALL.bayStartX, side * half];
      colliders.push({
        minX: Math.min(a, b),
        maxX: Math.max(a, b),
        minZ: z - HALL.partition / 2,
        maxZ: z + HALL.partition / 2,
        kind: "partition",
      });
    }
  }
  for (const bay of bays) {
    if (bay.categoryId === null) continue;
    colliders.push({
      minX: bay.column.x - HALL.columnHalf,
      maxX: bay.column.x + HALL.columnHalf,
      minZ: bay.column.z - HALL.columnHalf,
      maxZ: bay.column.z + HALL.columnHalf,
      kind: "column",
    });
    for (const bookcase of bay.bookcases) {
      colliders.push({
        minX: bookcase.x - BOOKCASE.length / 2,
        maxX: bookcase.x + BOOKCASE.length / 2,
        minZ: bookcase.z - BOOKCASE.depth / 2,
        maxZ: bookcase.z + BOOKCASE.depth / 2,
        kind: "bookcase",
      });
    }
  }

  return { width, length, rows, bays, partitions, skylights, colliders, empty: categories.length === 0 };
}

// --- Collision -------------------------------------------------------------------------------

const EPSILON = 1e-4;
const MAX_STEP = 0.1;

/** Distance from a point to a box in the XZ plane (0 inside). */
export function distanceToBox(x: number, z: number, box: Box): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dz = Math.max(box.minZ - z, 0, z - box.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Move a circle of `radius` by (dx, dz), resolving X and Z separately so it slides along
 * walls (section 9.5). Long moves are split into steps of at most 0.1 m so thin boxes cannot
 * be tunnelled through. Boxes are expanded by the radius (square corners: conservative).
 */
export function moveWithCollisions(
  x: number,
  z: number,
  dx: number,
  dz: number,
  colliders: readonly Box[],
  radius: number = HALL.playerRadius,
): { x: number; z: number } {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / MAX_STEP));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i += 1) {
    if (sx !== 0) {
      let nx = x + sx;
      for (const box of colliders) {
        if (z <= box.minZ - radius || z >= box.maxZ + radius) continue;
        if (nx <= box.minX - radius || nx >= box.maxX + radius) continue;
        nx = sx > 0 ? Math.min(nx, box.minX - radius - EPSILON) : Math.max(nx, box.maxX + radius + EPSILON);
      }
      // Never move backwards because of a box we were already touching.
      x = sx > 0 ? Math.max(x, nx) : Math.min(x, nx);
    }
    if (sz !== 0) {
      let nz = z + sz;
      for (const box of colliders) {
        if (x <= box.minX - radius || x >= box.maxX + radius) continue;
        if (nz <= box.minZ - radius || nz >= box.maxZ + radius) continue;
        nz = sz > 0 ? Math.min(nz, box.minZ - radius - EPSILON) : Math.max(nz, box.maxZ + radius + EPSILON);
      }
      z = sz > 0 ? Math.max(z, nz) : Math.min(z, nz);
    }
  }
  return { x, z };
}

/** True if the point (with `radius`) touches no collider. */
export function isWalkable(x: number, z: number, colliders: readonly Box[], radius: number = HALL.playerRadius): boolean {
  return colliders.every((box) => distanceToBox(x, z, box) >= radius - EPSILON);
}

/** True if the segment a-b stays at least `margin` away from every box (slab test). */
export function segmentIsClear(
  a: { x: number; z: number },
  b: { x: number; z: number },
  colliders: readonly Box[],
  margin: number = HALL.playerRadius,
): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const box of colliders) {
    let t0 = 0;
    let t1 = 1;
    let hit = true;
    for (const [p, d, lo, hi] of [
      [a.x, dx, box.minX - margin, box.maxX + margin],
      [a.z, dz, box.minZ - margin, box.maxZ + margin],
    ] as const) {
      if (Math.abs(d) < 1e-12) {
        if (p <= lo || p >= hi) {
          hit = false;
          break;
        }
        continue;
      }
      let ta = (lo - p) / d;
      let tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1) {
        hit = false;
        break;
      }
    }
    if (hit) return false;
  }
  return true;
}

/**
 * Waypoints from `from` back to the spawn point that avoid every collider: straight to the
 * nave first, then down the nave (section 9.6). Falls back to a direct line.
 */
export function homeWaypoints(from: { x: number; z: number }, colliders: readonly Box[]): { x: number; z: number }[] {
  const home = { x: SPAWN.position[0], z: SPAWN.position[2] };
  const margin = HALL.playerRadius * 0.5;
  if (segmentIsClear(from, home, colliders, margin)) return [from, home];
  const naveX = Math.max(-1.4, Math.min(1.4, from.x));
  // Leave toward the nave at the current depth, or slightly before or after it (around a column).
  for (const offset of [0, -0.7, 0.7, -1.2, 1.2]) {
    const exit = { x: from.x, z: from.z + offset };
    const nave = { x: naveX, z: from.z + offset };
    const points = offset === 0 ? [from, nave] : [from, exit, nave];
    const clear = points.every((p, i) => i === 0 || segmentIsClear(points[i - 1]!, p, colliders, margin));
    if (!clear) continue;
    // Down the nave, passing the desk on the side nearer to the current x.
    const deskSide = naveX >= 0 ? 1 : -1;
    const pastDesk = { x: deskSide * (DESK.width / 2 + 0.55), z: DESK.z + DESK.depth / 2 + 0.6 };
    const beside = { x: pastDesk.x, z: DESK.z - DESK.depth / 2 - 0.4 };
    for (const route of [[home], [pastDesk, beside, home]]) {
      const path = [...points, ...route];
      if (path.every((p, i) => i === 0 || segmentIsClear(path[i - 1]!, p, colliders, margin))) return path;
    }
  }
  return [from, home];
}

/** Total length of a polyline. */
export function pathLength(points: readonly { x: number; z: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  return total;
}

/** The point at distance `s` along a polyline. */
export function pointAlong(points: readonly { x: number; z: number }[], s: number): { x: number; z: number } {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= segment || i === points.length - 1) {
      const t = segment > 0 ? Math.min(1, remaining / segment) : 1;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    remaining -= segment;
  }
  return { ...points[points.length - 1]! };
}
