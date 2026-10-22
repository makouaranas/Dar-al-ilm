import { describe, expect, it } from "vitest";

import { AdaptiveQuality, WINDOW_SIZE, dprLevels } from "./useAdaptiveQuality";

const TARGET = 1000 / 60;

function feed(quality: AdaptiveQuality, ms: number, windows: number): boolean[] {
  const changes: boolean[] = [];
  for (let w = 0; w < windows; w += 1) {
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      const changed = quality.sample(ms);
      if (i < WINDOW_SIZE - 1) expect(changed).toBe(false);
      else changes.push(changed);
    }
  }
  return changes;
}

describe("dprLevels", () => {
  it("caps at the device ratio and drops duplicates", () => {
    expect(dprLevels(2)).toEqual([2, 1.5, 1.25, 1, 0.85]);
    expect(dprLevels(3)).toEqual([2, 1.5, 1.25, 1, 0.85]);
    expect(dprLevels(1)).toEqual([1, 0.85]);
    expect(dprLevels(1.25)).toEqual([1.25, 1, 0.85]);
  });
});

describe("AdaptiveQuality", () => {
  it("auto starts at 1.25 and steps down after two slow windows", () => {
    const quality = new AdaptiveQuality({ preset: "auto", deviceRatio: 2, targetMs: TARGET });
    expect(quality.dpr).toBe(1.25);
    expect(feed(quality, 25, 2)).toEqual([false, true]);
    expect(quality.dpr).toBe(1);
  });

  it("ignores gaps longer than 100 ms (idle time between frames on demand)", () => {
    const quality = new AdaptiveQuality({ preset: "auto", deviceRatio: 2, targetMs: TARGET });
    for (let i = 0; i < 1000; i += 1) expect(quality.sample(500)).toBe(false);
    expect(quality.dpr).toBe(1.25);
    expect(quality.medianMs).toBeNull();
  });

  it("steps up only after four fast windows", () => {
    const quality = new AdaptiveQuality({ preset: "auto", deviceRatio: 2, targetMs: TARGET });
    expect(feed(quality, 8, 4)).toEqual([false, false, false, true]);
    expect(quality.dpr).toBe(1.5);
  });

  it("a normal window resets the streak (hysteresis)", () => {
    const quality = new AdaptiveQuality({ preset: "auto", deviceRatio: 2, targetMs: TARGET });
    feed(quality, 25, 1);
    feed(quality, TARGET, 1);
    expect(feed(quality, 25, 1)).toEqual([false]);
    expect(quality.dpr).toBe(1.25);
  });

  it("changes the level at most three times per session", () => {
    const quality = new AdaptiveQuality({ preset: "auto", deviceRatio: 2, targetMs: TARGET });
    feed(quality, 30, 2); // 1.0
    feed(quality, 8, 4); // 1.25
    feed(quality, 30, 2); // 1.0
    expect(quality.changes).toBe(3);
    expect(feed(quality, 30, 4)).toEqual([false, false, false, false]);
    expect(quality.dpr).toBe(1);
  });

  it("remembers a stored level for auto", () => {
    expect(new AdaptiveQuality({ preset: "auto", deviceRatio: 2, storedLevel: 4 }).dpr).toBe(0.85);
    expect(new AdaptiveQuality({ preset: "auto", deviceRatio: 2, storedLevel: 9 }).dpr).toBe(1.25);
  });

  it("high starts at up to 2.0 and only adapts downward", () => {
    const quality = new AdaptiveQuality({ preset: "high", deviceRatio: 2, targetMs: TARGET });
    expect(quality.dpr).toBe(2);
    feed(quality, 30, 2);
    expect(quality.dpr).toBe(1.5);
    feed(quality, 8, 8);
    expect(quality.dpr).toBe(1.5);
  });

  it("performance stays fixed at 1.0 or less", () => {
    const quality = new AdaptiveQuality({ preset: "performance", deviceRatio: 2, targetMs: TARGET });
    expect(quality.dpr).toBe(1);
    feed(quality, 40, 4);
    expect(quality.dpr).toBe(1);
    expect(new AdaptiveQuality({ preset: "performance", deviceRatio: 0.9 }).dpr).toBe(0.9);
  });
});
