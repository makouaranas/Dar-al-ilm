"use client";

/**
 * Adaptive render quality (docs/ARCHITECTURE.md section 10.2), replacing drei's
 * `<PerformanceMonitor>`, which reads the idle gaps of `frameloop="demand"` as low FPS.
 *
 * Frame times are sampled only while something moves, deltas above 100 ms are gaps (not slow
 * frames), and the median of each window of 60 samples decides: two slow windows in a row
 * step the pixel ratio down, four fast windows step it up, at most three changes per
 * session. The level is remembered per device.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { GraphicsQuality } from "@/lib/api";

export const QUALITY_STORAGE_KEY = "dar.quality.level";
export const WINDOW_SIZE = 60;
const GAP_MS = 100;
const MAX_CHANGES = 3;

/** Distinct pixel ratios from sharpest to cheapest, capped at the device's ratio. */
export function dprLevels(deviceRatio: number): number[] {
  const levels = [Math.min(deviceRatio, 2.0), 1.5, 1.25, 1.0, 0.85].map((value) => Math.min(value, deviceRatio));
  return levels.filter((value, index) => levels.indexOf(value) === index);
}

export interface AdaptiveQualityOptions {
  preset: GraphicsQuality;
  deviceRatio: number;
  /** Level remembered from an earlier session (auto preset only). */
  storedLevel?: number | null;
  targetMs?: number;
}

export class AdaptiveQuality {
  readonly preset: GraphicsQuality;
  readonly levels: number[];
  level: number;
  targetMs: number;
  changes = 0;
  /** Median frame time of the last full window, in ms (null before the first window). */
  medianMs: number | null = null;
  private window: number[] = [];
  private slowWindows = 0;
  private fastWindows = 0;

  constructor({ preset, deviceRatio, storedLevel = null, targetMs = 1000 / 60 }: AdaptiveQualityOptions) {
    this.preset = preset;
    this.targetMs = targetMs;
    if (preset === "performance") {
      this.levels = [Math.min(deviceRatio, 1.0)];
      this.level = 0;
      return;
    }
    this.levels = dprLevels(deviceRatio);
    if (preset === "high") {
      this.level = 0;
    } else {
      const start = this.levels.findIndex((value) => value <= 1.25);
      const fallback = start === -1 ? this.levels.length - 1 : start;
      this.level =
        storedLevel !== null && Number.isInteger(storedLevel) && storedLevel >= 0 && storedLevel < this.levels.length
          ? storedLevel
          : fallback;
    }
  }

  get dpr(): number {
    return this.levels[this.level]!;
  }

  /** Record one frame time (ms) of active motion. Returns true when the level changed. */
  sample(deltaMs: number): boolean {
    if (!(deltaMs > 0) || deltaMs > GAP_MS || this.preset === "performance") return false;
    this.window.push(deltaMs);
    if (this.window.length < WINDOW_SIZE) return false;
    const sorted = [...this.window].sort((a, b) => a - b);
    this.window = [];
    const median = (sorted[WINDOW_SIZE / 2 - 1]! + sorted[WINDOW_SIZE / 2]!) / 2;
    this.medianMs = median;
    if (median > 1.2 * this.targetMs) {
      this.slowWindows += 1;
      this.fastWindows = 0;
      if (this.slowWindows >= 2) {
        this.slowWindows = 0;
        return this.step(1);
      }
    } else if (median < 0.8 * this.targetMs) {
      this.fastWindows += 1;
      this.slowWindows = 0;
      if (this.fastWindows >= 4) {
        this.fastWindows = 0;
        // The high preset only adapts downward.
        return this.preset === "high" ? false : this.step(-1);
      }
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }
    return false;
  }

  private step(direction: 1 | -1): boolean {
    const next = this.level + direction;
    if (this.changes >= MAX_CHANGES || next < 0 || next >= this.levels.length) return false;
    this.level = next;
    this.changes += 1;
    return true;
  }
}

/** Live numbers for the debug overlay (read by `DebugHud`, never rendered from React state). */
export const qualityStats: {
  preset: GraphicsQuality;
  dpr: number;
  level: number;
  levels: number;
  changes: number;
  medianMs: number | null;
  /** Frame time of the latest motion frame, in ms. */
  lastMs: number | null;
  targetMs: number;
} = { preset: "auto", dpr: 1, level: 0, levels: 1, changes: 0, medianMs: null, lastMs: null, targetMs: 1000 / 60 };

function readStoredLevel(): number | null {
  try {
    const value = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY);
    return value === null || value === undefined ? null : Number(value);
  } catch {
    return null;
  }
}

/** Median interval between animation frames: the display's refresh period. */
function measureRefresh(frames = 24): Promise<number> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const tick = (time: number) => {
      stamps.push(time);
      if (stamps.length <= frames) requestAnimationFrame(tick);
      else {
        const deltas = stamps.slice(1).map((t, i) => t - stamps[i]!).sort((a, b) => a - b);
        resolve(deltas[Math.floor(deltas.length / 2)]!);
      }
    };
    requestAnimationFrame(tick);
  });
}

function publish(controller: AdaptiveQuality) {
  Object.assign(qualityStats, {
    preset: controller.preset,
    dpr: controller.dpr,
    level: controller.level,
    levels: controller.levels.length,
    changes: controller.changes,
    medianMs: controller.medianMs,
    targetMs: controller.targetMs,
  });
}

/**
 * The pixel ratio for the canvas and a `sample(deltaSeconds)` callback to call from the render
 * loop while something moves.
 */
export function useAdaptiveQuality(preset: GraphicsQuality): { dpr: number; sample: (deltaSeconds: number) => void } {
  const controller = useMemo(
    () =>
      new AdaptiveQuality({
        preset,
        deviceRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
        storedLevel: preset === "auto" ? readStoredLevel() : null,
      }),
    [preset],
  );
  const [dpr, setDpr] = useState(controller.dpr);

  useEffect(() => {
    setDpr(controller.dpr);
    publish(controller);
    let cancelled = false;
    void measureRefresh().then((period) => {
      // Ignore implausible values (background tabs, throttled timers).
      if (!cancelled && period >= 4 && period <= 50) {
        controller.targetMs = period;
        publish(controller);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [controller]);

  const sample = useCallback(
    (deltaSeconds: number) => {
      const ms = deltaSeconds * 1000;
      qualityStats.lastMs = ms;
      const changed = controller.sample(ms);
      publish(controller);
      if (!changed) return;
      setDpr(controller.dpr);
      if (controller.preset === "auto") {
        try {
          globalThis.localStorage?.setItem(QUALITY_STORAGE_KEY, String(controller.level));
        } catch {
          // Storage can be unavailable; the level is then chosen again next time.
        }
      }
    },
    [controller],
  );

  return { dpr, sample };
}
