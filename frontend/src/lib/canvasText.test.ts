import { describe, expect, it } from "vitest";

import { layoutText, scriptOf } from "./canvasText";

// A monospace stand-in for the canvas: every character is 0.5 em wide.
const measure = (text: string, size: number) => Array.from(text).length * size * 0.5;

describe("scriptOf", () => {
  it("follows the first strong character", () => {
    expect(scriptOf("العربية")).toBe("arabic");
    expect(scriptOf("Histoire")).toBe("latin");
    expect(scriptOf("2024 تاريخ")).toBe("arabic");
    expect(scriptOf("Python للمبتدئين")).toBe("latin");
    expect(scriptOf("")).toBe("latin");
  });
});

describe("layoutText", () => {
  const base = { baseSize: 100, measure };

  it("keeps a short name on one line at full size", () => {
    expect(layoutText("Novels", { ...base, maxWidth: 600 })).toEqual({ lines: ["Novels"], size: 100, scale: 1, truncated: false });
  });

  it("shrinks one line down to 80 % before wrapping", () => {
    // 14 characters: 700 px at 100 %, 560 px at 80 %.
    const layout = layoutText("Programming 101", { ...base, maxWidth: 600 });
    expect(layout.lines).toEqual(["Programming 101"]);
    expect(layout.scale).toBeCloseTo(0.8);
  });

  it("wraps onto two balanced lines and keeps shrinking down to 60 %", () => {
    const layout = layoutText("Histoire de la Méditerranée", { ...base, maxWidth: 600 });
    expect(layout.lines).toEqual(["Histoire de la", "Méditerranée"]);
    expect(layout.scale).toBeGreaterThanOrEqual(0.6);
    expect(layout.truncated).toBe(false);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(600);
  });

  it("never goes below 60 %, and then truncates with an ellipsis", () => {
    const name = "A very long category name that cannot possibly fit on a small brass plaque";
    const layout = layoutText(name, { ...base, maxWidth: 600 });
    expect(layout.scale).toBe(0.6);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[1]!.endsWith("…")).toBe(true);
    expect(layout.truncated).toBe(true);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(600);
  });

  it("truncates a single unbreakable word", () => {
    const layout = layoutText("Supercalifragilisticexpialidocious", { ...base, maxWidth: 300 });
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.endsWith("…")).toBe(true);
    expect(measure(layout.lines[0]!, layout.size)).toBeLessThanOrEqual(300);
  });

  it("handles Arabic words the same way (code points, no letter spacing involved)", () => {
    const layout = layoutText("تاريخ الأندلس والمغرب", { ...base, maxWidth: 700 });
    expect(layout.lines.join(" ")).toBe("تاريخ الأندلس والمغرب");
    expect(layout.truncated).toBe(false);
  });
});
