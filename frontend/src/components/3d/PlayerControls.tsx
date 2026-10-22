"use client";

/**
 * The only camera owner in the hall (docs/ARCHITECTURE.md section 9.5): walking with the
 * arrow keys and WASD, turning, drag-to-look without pointer lock, collision with sliding,
 * and the Home flight back to the Entrance Desk.
 *
 * Frames are requested only while the camera moves (`frameloop="demand"`).
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import { easeInOutCubic } from "@/components/3d/pageCurl";
import { getBookTarget } from "@/components/3d/BookSpine";
import { planBookFlight, planHomeFlight, type FlightPlan } from "@/lib/flightPath";
import { HALL, SPAWN, moveWithCollisions, pointAlong, type HallLayout } from "@/lib/hallLayout";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

export const WALK_SPEED = 1.4;
export const RUN_SPEED = 2.8;
const ACCEL_TIME = 0.25;
const STOP_TIME = 0.2;
const TURN_RATE = Math.PI / 2;
const LOOK_RATE = (0.25 * Math.PI) / 180; // per pixel of drag
const PITCH_LIMIT = (35 * Math.PI) / 180;
const DRAG_SLOP_PX = 3;
const CUT_MS = 300;

const MOVE_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

/** Walking state for overlays: the top bar fades while walking, the key hint hides once walked. */
export const hallMotion = {
  moving: false,
  walked: false,
  /** The camera's floor position (for the key hint's "in the entrance zone" check). */
  position: { x: SPAWN.position[0], z: SPAWN.position[2] },
  listeners: new Set<(moving: boolean) => void>(),
  subscribe(listener: (moving: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  set(moving: boolean) {
    if (moving === this.moving) return;
    this.moving = moving;
    if (moving) this.walked = true;
    for (const listener of this.listeners) listener(moving);
  },
};

/** Commands for UI outside the canvas (one hall at a time). */
export const playerCommands: { home: () => void; flyToBook: (bookId: number) => boolean } = {
  home: () => undefined,
  flyToBook: () => false,
};

function anglesTo(position: readonly number[], target: readonly number[]): { yaw: number; pitch: number } {
  const dx = target[0]! - position[0]!;
  const dy = target[1]! - position[1]!;
  const dz = target[2]! - position[2]!;
  return { yaw: Math.atan2(0 - dx, 0 - dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function shortestAngle(from: number, to: number): number {
  return ((((to - from + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

function isTypingTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const SPAWN_ANGLES = anglesTo(SPAWN.position, SPAWN.target);
const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

interface Flight {
  points: { x: number; z: number }[];
  length: number;
  start: number;
  duration: number;
  from: { yaw: number; pitch: number };
  end: { yaw: number; pitch: number };
  cut: boolean;
  jumped: boolean;
  onArrive?: () => void;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface PlayerControlsProps {
  layout: HallLayout;
  /** False while the reader or a modal is open: input is ignored. */
  enabled?: boolean;
  /** Called with each frame's delta (seconds) while the camera moves (adaptive quality). */
  onMotionFrame?: (deltaSeconds: number) => void;
  /** An ink overlay used for reduced-motion cuts (opacity animated directly). */
  fadeRef?: RefObject<HTMLDivElement | null>;
}

export function PlayerControls({ layout, enabled = true, onMotionFrame, fadeRef }: PlayerControlsProps) {
  const { camera, gl, invalidate } = useThree();
  const pose = useRef({ x: SPAWN.position[0], z: SPAWN.position[2], yaw: SPAWN_ANGLES.yaw, pitch: SPAWN_ANGLES.pitch });
  const velocity = useRef({ x: 0, z: 0, turn: 0 });
  const keys = useRef(new Set<string>());
  const flight = useRef<Flight | null>(null);
  const lastFlight = useRef<{ start: number; end: number | null; length: number; duration: number; frames: number[] } | null>(null);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; active: boolean; id: number } | null>(null);
  const colliders = useRef(layout.colliders);
  colliders.current = layout.colliders;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const apply = useCallback(() => {
    const p = pose.current;
    hallMotion.position = { x: p.x, z: p.z };
    camera.position.set(p.x, HALL.eyeHeight, p.z);
    camera.rotation.order = "YXZ";
    camera.rotation.set(p.pitch, p.yaw, 0);
    camera.updateMatrixWorld();
  }, [camera]);

  useEffect(() => {
    apply();
    invalidate();
  }, [apply, invalidate]);

  /** Fly along a planned path (or cut with reduced motion), then call `onArrive`. */
  const startFlight = useCallback(
    (plan: FlightPlan, onArrive?: () => void) => {
      const p = pose.current;
      if (plan.length < 0.01 && Math.abs(shortestAngle(p.yaw, plan.end.yaw)) < 1e-3 && Math.abs(plan.end.pitch - p.pitch) < 1e-3) {
        onArrive?.();
        return;
      }
      const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const duration = reduced ? CUT_MS : plan.duration * 1000;
      const start = performance.now();
      flight.current = {
        points: plan.points,
        length: plan.length,
        start,
        duration,
        from: { yaw: p.yaw, pitch: p.pitch },
        end: { yaw: plan.end.yaw, pitch: plan.end.pitch },
        cut: Boolean(reduced),
        jumped: false,
        onArrive,
      };
      lastFlight.current = { start, end: null, length: plan.length, duration, frames: [] };
      velocity.current = { x: 0, z: 0, turn: 0 };
      invalidate();
    },
    [invalidate],
  );

  const startHome = useCallback(() => {
    const p = pose.current;
    startFlight(planHomeFlight({ x: p.x, z: p.z }, colliders.current));
  }, [startFlight]);

  /** Search: fly to a book's stand point, then let it glow. Returns false if it is not shelved. */
  const flyToBook = useCallback(
    (bookId: number) => {
      const target = getBookTarget(bookId);
      const bay = target ? layoutRef.current.bays.find((candidate) => candidate.categoryId === target.categoryId) : undefined;
      if (!target || !bay) return false;
      const p = pose.current;
      const plan = planBookFlight({ x: p.x, z: p.z }, target, bay, colliders.current);
      startFlight(plan, () => useLibraryStore.getState().highlightBook(bookId));
      return true;
    },
    [startFlight],
  );

  useEffect(() => {
    playerCommands.home = startHome;
    playerCommands.flyToBook = flyToBook;
    return () => {
      playerCommands.home = () => undefined;
      playerCommands.flyToBook = () => false;
    };
  }, [startHome, flyToBook]);

  // --- Keyboard ----------------------------------------------------------------------------
  useEffect(() => {
    const blocked = (event: KeyboardEvent) =>
      !enabledRef.current ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isTypingTarget(document.activeElement) ||
      document.querySelector('[aria-modal="true"]') !== null;
    const onDown = (event: KeyboardEvent) => {
      if (blocked(event)) return;
      if (event.code === "Home") {
        event.preventDefault();
        if (!event.repeat) startHome();
        return;
      }
      if (!MOVE_CODES.has(event.code)) return;
      event.preventDefault();
      keys.current.add(event.code);
      invalidate();
    };
    const onUp = (event: KeyboardEvent) => {
      keys.current.delete(event.code);
    };
    const clear = () => keys.current.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
    };
  }, [startHome, invalidate]);

  useEffect(() => {
    if (enabled) return;
    keys.current.clear();
    velocity.current = { x: 0, z: 0, turn: 0 };
    drag.current = null;
  }, [enabled]);

  // --- Drag to look (no pointer lock: the cursor stays free) --------------------------------
  useEffect(() => {
    const element = gl.domElement;
    const onDown = (event: PointerEvent) => {
      if (!enabledRef.current || event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, active: false, id: event.pointerId };
    };
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.id || flight.current) return;
      if (!current.active) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_SLOP_PX) return;
        current.active = true;
        element.style.cursor = "grabbing";
      }
      const p = pose.current;
      p.yaw -= (event.clientX - current.x) * LOOK_RATE;
      p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p.pitch - (event.clientY - current.y) * LOOK_RATE));
      current.x = event.clientX;
      current.y = event.clientY;
      apply();
      invalidate();
    };
    const onUp = (event: PointerEvent) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      element.style.cursor = "";
    };
    element.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gl, apply, invalidate]);

  // --- Test hooks ----------------------------------------------------------------------------
  useEffect(() => {
    registerTestHook("hall", {
      pose: () => {
        const p = pose.current;
        const v = velocity.current;
        return {
          x: p.x,
          y: HALL.eyeHeight,
          z: p.z,
          yaw: toDegrees(p.yaw),
          pitch: toDegrees(p.pitch),
          moving: Math.hypot(v.x, v.z) > 1e-4 || Math.abs(v.turn) > 1e-4,
          flying: flight.current !== null,
        };
      },
      teleport: (x: number, z: number, yaw?: number, pitch?: number) => {
        const p = pose.current;
        p.x = x;
        p.z = z;
        if (yaw !== undefined) p.yaw = toRadians(yaw);
        if (pitch !== undefined) p.pitch = toRadians(pitch);
        velocity.current = { x: 0, z: 0, turn: 0 };
        flight.current = null;
        apply();
        invalidate();
      },
      colliders: () => colliders.current,
      lastFlight: () => lastFlight.current,
    });
    return () => registerTestHook("hall", undefined);
  }, [apply, invalidate]);

  // --- Per frame -------------------------------------------------------------------------------
  useFrame((_, delta) => {
    const p = pose.current;
    const v = velocity.current;
    const dt = Math.min(delta, 0.1);

    const current = flight.current;
    if (current) {
      const now = performance.now();
      lastFlight.current?.frames.push(now);
      const t = Math.min(1, (now - current.start) / current.duration);
      const end = current.points.at(-1)!;
      if (current.cut) {
        // Reduced motion: fade out, cut to the end pose, fade in.
        if (t >= 0.5 && !current.jumped) {
          current.jumped = true;
          p.x = end.x;
          p.z = end.z;
          p.yaw = current.end.yaw;
          p.pitch = current.end.pitch;
        }
        if (fadeRef?.current) fadeRef.current.style.opacity = String(1 - Math.abs(2 * t - 1));
      } else {
        // Eased along the arc length; the view turns toward the travel direction, then settles
        // on the destination's view.
        const e = easeInOutCubic(t);
        const s = e * current.length;
        const point = pointAlong(current.points, s);
        p.x = point.x;
        p.z = point.z;
        const ahead = pointAlong(current.points, Math.min(current.length, s + 0.6));
        const travel = Math.hypot(ahead.x - point.x, ahead.z - point.z) > 0.05 ? Math.atan2(-(ahead.x - point.x), -(ahead.z - point.z)) : current.end.yaw;
        const toTravel = current.length > 1.5 ? smoothstep(0, 0.25, e) * (1 - smoothstep(0.55, 0.95, e)) : 0;
        const settle = smoothstep(0, 1, e);
        const base = current.from.yaw + shortestAngle(current.from.yaw, current.end.yaw) * settle;
        p.yaw = base + shortestAngle(base, travel) * toTravel;
        const levelPitch = current.from.pitch + (current.end.pitch - current.from.pitch) * settle;
        p.pitch = levelPitch * (1 - toTravel * 0.7);
      }
      if (t >= 1) {
        p.x = end.x;
        p.z = end.z;
        p.yaw = current.end.yaw;
        p.pitch = current.end.pitch;
      }
      apply();
      onMotionFrame?.(delta);
      hallMotion.set(true);
      if (t >= 1) {
        flight.current = null;
        if (lastFlight.current) lastFlight.current.end = now;
        if (fadeRef?.current) fadeRef.current.style.opacity = "0";
        hallMotion.set(false);
        current.onArrive?.();
      }
      invalidate();
      return;
    }

    const k = keys.current;
    const active = enabledRef.current;
    const forward = active ? Number(k.has("KeyW") || k.has("ArrowUp")) - Number(k.has("KeyS") || k.has("ArrowDown")) : 0;
    const strafe = active ? Number(k.has("KeyD")) - Number(k.has("KeyA")) : 0;
    const turn = active ? Number(k.has("ArrowLeft")) - Number(k.has("ArrowRight")) : 0;
    const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;

    // Desired velocity in the world from the camera's heading.
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let wx = forward * fx + strafe * -fz;
    let wz = forward * fz + strafe * fx;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) {
      wx = (wx / wl) * speed;
      wz = (wz / wl) * speed;
    }
    // Linear ramps: full speed in 250 ms, a stop in 200 ms, no sliding after release.
    const currentSpeed = Math.hypot(v.x, v.z);
    const rate = wl > 0 ? speed / ACCEL_TIME : Math.max(WALK_SPEED, currentSpeed) / STOP_TIME;
    const dx = wx - v.x;
    const dz = wz - v.z;
    const gap = Math.hypot(dx, dz);
    if (gap <= rate * dt) {
      v.x = wx;
      v.z = wz;
    } else {
      v.x += (dx / gap) * rate * dt;
      v.z += (dz / gap) * rate * dt;
    }
    const wantTurn = turn * TURN_RATE;
    const turnRate = (turn !== 0 ? TURN_RATE / ACCEL_TIME : TURN_RATE / STOP_TIME) * dt;
    v.turn += Math.max(-turnRate, Math.min(turnRate, wantTurn - v.turn));

    const moving = Math.hypot(v.x, v.z) > 1e-4 || Math.abs(v.turn) > 1e-4;
    if (moving) {
      p.yaw += v.turn * dt;
      const next = moveWithCollisions(p.x, p.z, v.x * dt, v.z * dt, colliders.current);
      p.x = next.x;
      p.z = next.z;
      apply();
      onMotionFrame?.(delta);
      invalidate();
    } else {
      v.x = 0;
      v.z = 0;
      v.turn = 0;
    }
    hallMotion.set(moving);
  });

  return null;
}
