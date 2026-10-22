import { describe, expect, it } from "vitest";

import { HIGHLIGHT, highlightGlow, highlightTime } from "./BookSpine";

describe("search arrival highlight", () => {
  const at = 10_000;

  it("pulses twice, holds 3 s, then fades", () => {
    expect(highlightGlow(0)).toBeCloseTo(0, 6);
    expect(highlightGlow(0.2)).toBeCloseTo(1, 6);
    expect(highlightGlow(0.4)).toBeCloseTo(0, 6);
    expect(highlightGlow(0.6)).toBeCloseTo(1, 6);
    expect(highlightGlow(2)).toBe(1);
    expect(highlightGlow(3.95)).toBeCloseTo(0.5, 6);
    expect(highlightGlow(4.2)).toBe(0);
  });

  it("follows the clock when frames come on time", () => {
    expect(highlightTime(at + 500, at, null)).toBeCloseTo(0.5, 9);
    // The first hold frame at 0.81 s; later frames count from it.
    expect(highlightTime(at + 810, at, null)).toBe(HIGHLIGHT.pulse);
    expect(highlightTime(at + 3_000, at, at + 810)).toBeCloseTo(0.8 + 2.19, 9);
  });

  it("never skips the hold when a frame comes late", () => {
    // The first frame after the pulses arrives 5 s after the arrival, past the hold and the fade.
    const late = at + 5_000;
    expect(highlightGlow(highlightTime(late, at, null))).toBe(1);
    // The hold then lasts 3 s from that frame.
    expect(highlightGlow(highlightTime(late + 2_900, at, late))).toBe(1);
    expect(highlightGlow(highlightTime(late + 3_100, at, late))).toBeGreaterThan(0);
    expect(highlightGlow(highlightTime(late + 3_400, at, late))).toBe(0);
  });
});
