/**
 * Camera flights (docs/ARCHITECTURE.md section 9.6): from where the camera is to a stand point
 * 1.3 m in front of a book (search) or back to the Entrance Desk (Home), along a centripetal
 * Catmull-Rom spline through waypoints that all lie in walkable space, eased along its arc
 * length. Pure functions, unit-tested.
 */

import { HALL, SPAWN, homeWaypoints, pathLength, segmentIsClear, type BayLayout, type Box } from "./hallLayout";

export interface Point {
  x: number;
  z: number;
}

/** The book's spine centre (world) and the outward normal of its bookcase. */
export interface FlightTarget {
  x: number;
  y: number;
  z: number;
  normalX: number;
  normalZ: number;
}

export interface FlightEnd {
  x: number;
  z: number;
  /** Radians; yaw 0 looks toward -Z, PI toward +Z (PlayerControls' convention). */
  yaw: number;
  pitch: number;
}

export interface FlightPlan {
  waypoints: Point[];
  /** Dense samples of the smoothed path. */
  points: Point[];
  length: number;
  /** Seconds. */
  duration: number;
  end: FlightEnd;
}

export const STAND_DISTANCE = 1.3;
export const MAX_FLIGHT_S = 1.5;
export const HOME_MAX_S = 0.8;
/** Clearance kept from every box along a flight (half the walking radius). */
export const FLIGHT_MARGIN = HALL.playerRadius / 2;
/** The lanes down the nave beside the desk, clear of the arcade columns. */
const NAVE_LANE = 1.45;
/** How far into the bay the camera enters before turning to the book. */
const BAY_ENTRY = 0.5;

export function flightDuration(length: number, max = MAX_FLIGHT_S): number {
  return Math.min(max, Math.max(0.6, 0.6 + length / 25));
}

/** Yaw (PlayerControls' convention) of a horizontal direction. */
export function yawOf(dx: number, dz: number): number {
  // `0 - dx` rather than `-dx`: -0 would make a straight look down +Z read -180° instead of 180°.
  return Math.atan2(0 - dx, 0 - dz);
}

/** Where to stand to read a book: 1.3 m out from its spine, eye height, looking at it. */
export function standPose(target: FlightTarget): FlightEnd {
  const x = target.x + target.normalX * STAND_DISTANCE;
  const z = target.z + target.normalZ * STAND_DISTANCE;
  return {
    x,
    z,
    yaw: yawOf(target.x - x, target.z - z),
    pitch: Math.atan2(target.y - HALL.eyeHeight, STAND_DISTANCE),
  };
}

/** Centripetal Catmull-Rom spline through `points` (alpha 0.5: no cusps, no self-loops). */
export function catmullRom(points: readonly Point[], samplesPerSegment = 16, alpha = 0.5): Point[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const first = points[0]!;
  const last = points.at(-1)!;
  // Mirror the ends so the curve passes through the first and last points.
  const padded = [
    { x: 2 * first.x - points[1]!.x, z: 2 * first.z - points[1]!.z },
    ...points,
    { x: 2 * last.x - points.at(-2)!.x, z: 2 * last.z - points.at(-2)!.z },
  ];
  const out: Point[] = [{ ...first }];
  const knot = (a: Point, b: Point) => Math.max(1e-6, Math.hypot(b.x - a.x, b.z - a.z) ** alpha);
  for (let i = 1; i < padded.length - 2; i += 1) {
    const [p0, p1, p2, p3] = [padded[i - 1]!, padded[i]!, padded[i + 1]!, padded[i + 2]!];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 1; s <= samplesPerSegment; s += 1) {
      if (s === samplesPerSegment) {
        // Segments end exactly on their waypoint.
        out.push({ ...p2 });
        break;
      }
      const t = t1 + ((t2 - t1) * s) / samplesPerSegment;
      const lerp = (a: Point, b: Point, ta: number, tb: number): Point => {
        const u = (t - ta) / (tb - ta);
        return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
      };
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

function polylineClear(points: readonly Point[], colliders: readonly Box[], margin: number): boolean {
  return points.every((p, i) => i === 0 || segmentIsClear(points[i - 1]!, p, colliders, margin));
}

/** Smooth the waypoints; keep the straight polyline if smoothing would cut a corner too close. */
function smooth(waypoints: Point[], colliders: readonly Box[]): Point[] {
  const curve = catmullRom(waypoints);
  return polylineClear(curve, colliders, FLIGHT_MARGIN * 0.6) ? curve : waypoints;
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.z - points[i - 1]!.z) > 1e-3);
}

/**
 * Waypoints from `from` out to the nave lane on `side`, along it to `laneZ`, then through
 * `tail` (all of it in walkable space). From inside a bay the path first leaves it toward the
 * nave, at the current depth or around a column.
 */
function route(from: Point, side: -1 | 1, laneZ: number, tail: Point[], colliders: readonly Box[]): Point[] {
  const laneX = side * NAVE_LANE;
  const approach: Point[] = [{ x: laneX, z: laneZ }, ...tail];
  const candidates: Point[][] = [];
  const inBay = Math.abs(from.x) > HALL.bayStartX;
  if (inBay) {
    for (const offset of [0, -0.7, 0.7, -1.2, 1.2]) {
      const exit = Math.sign(from.x) * (HALL.bayStartX + BAY_ENTRY);
      candidates.push([from, { x: from.x, z: from.z + offset }, { x: exit, z: from.z + offset }, { x: Math.sign(from.x) * NAVE_LANE, z: from.z + offset }, ...approach]);
    }
  } else {
    candidates.push([from, { x: laneX, z: from.z }, ...approach]);
    candidates.push([from, ...approach]);
    for (const offset of [-0.8, 0.8, -1.4, 1.4]) candidates.push([from, { x: from.x, z: from.z + offset }, { x: laneX, z: from.z + offset }, ...approach]);
  }
  return candidates.map(dedupe).find((points) => polylineClear(points, colliders, FLIGHT_MARGIN)) ?? dedupe(candidates[0]!);
}

function plan(waypoints: Point[], end: FlightEnd, colliders: readonly Box[]): FlightPlan {
  const points = smooth(waypoints, colliders);
  const length = pathLength(points);
  return { waypoints, points, length, duration: flightDuration(length), end };
}

/**
 * From `from` to the stand point of a book in `bay`: out to the nave lane on the bay's side,
 * along it to the bay, in through the middle of the bay opening (the arcade columns stand at
 * its edges), then to the stand point facing the book.
 */
export function planBookFlight(from: Point, target: FlightTarget, bay: BayLayout, colliders: readonly Box[]): FlightPlan {
  const end = standPose(target);
  const entry = { x: bay.side * (HALL.bayStartX + BAY_ENTRY), z: bay.zCenter };
  return plan(route(from, bay.side, bay.zCenter, [entry, { x: end.x, z: end.z }], colliders), end, colliders);
}

/** Where the directory's shortcut ends: this far in front of the arcade line, in the nave. */
export const BAY_VIEW_SETBACK = 0.35;

/**
 * The directory's shortcut (US-20): to the middle of a bay's opening, just in front of the
 * arcade line, looking straight into the bay at eye level. Same lanes and timing as search.
 */
export function planBayFlight(from: Point, bay: BayLayout, colliders: readonly Box[]): FlightPlan {
  const end: FlightEnd = { x: bay.side * (HALL.bayStartX - BAY_VIEW_SETBACK), z: bay.zCenter, yaw: yawOf(bay.side, 0), pitch: 0 };
  return plan(route(from, bay.side, bay.zCenter, [{ x: end.x, z: end.z }], colliders), end, colliders);
}

/** Back to the Entrance Desk pose (Home): at most 0.8 s. */
export function planHomeFlight(from: Point, colliders: readonly Box[]): FlightPlan {
  const waypoints = dedupe(homeWaypoints(from, colliders));
  const points = smooth(waypoints, colliders);
  const length = pathLength(points);
  const [px, py, pz] = SPAWN.position;
  const [tx, ty, tz] = SPAWN.target;
  return {
    waypoints,
    points,
    length,
    duration: flightDuration(length, HOME_MAX_S),
    end: { x: px, z: pz, yaw: yawOf(tx - px, tz - pz), pitch: Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) },
  };
}
