import { describe, expect, it } from "vitest";

import { DIRECTORY_PANEL, DIRECTORY_ROWS, SIGN, SIGN_GRID, directoryRows, directorySize, layoutText, planDirectory, scriptOf, type DirectoryEntry } from "./canvasText";

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

describe("signage grid", () => {
  it("keeps one family: header letters at least three times the plates' and the directory's", () => {
    expect(SIGN_GRID.headerName / SIGN_GRID.plateName).toBeGreaterThanOrEqual(3);
    expect(SIGN_GRID.plateName).toBeGreaterThan(SIGN_GRID.directoryName);
    // Every sign's canvas has the same aspect ratio as the sign itself (no stretched letters).
    for (const sign of [...Object.values(SIGN), directorySize(3), directorySize(DIRECTORY_ROWS)]) {
      expect(sign.canvasWidth / sign.canvasHeight).toBeCloseTo(sign.width / sign.height, 1);
    }
  });

  it("sizes the directory to its longer column, three rows at least, thirteen at most", () => {
    expect(directoryRows(1, 2)).toBe(DIRECTORY_PANEL.minRows);
    expect(directoryRows(7, 4)).toBe(7);
    expect(directoryRows(40, 3)).toBe(DIRECTORY_ROWS);
    expect(directorySize(7).height).toBeCloseTo(DIRECTORY_PANEL.head + 7 * DIRECTORY_PANEL.row + DIRECTORY_PANEL.foot, 9);
    // Thirteen rows still fit on the stele's front (panel top at 1.5 m, above the plinth).
    expect(1.5 - directorySize(DIRECTORY_ROWS).height).toBeGreaterThan(0.3);
  });
});

describe("planDirectory", () => {
  const entries = (left: number, right: number): DirectoryEntry[] => [
    ...Array.from({ length: left }, (_, i) => ({ categoryId: i, name: `L${i}`, toward: "left" as const })),
    ...Array.from({ length: right }, (_, i) => ({ categoryId: 100 + i, name: `R${i}`, toward: "right" as const })),
  ];

  it("puts the bays on the reader's left and right in their own columns, in hall order", () => {
    const plan = planDirectory(entries(3, 2));
    expect(plan.left.map((e) => e.name)).toEqual(["L0", "L1", "L2"]);
    expect(plan.right.map((e) => e.name)).toEqual(["R0", "R1"]);
    expect(plan.moreLeft).toBe(0);
    expect(plan.moreRight).toBe(0);
  });

  it("fills a column exactly, then ends it with \"and {n} more\"", () => {
    const full = planDirectory(entries(DIRECTORY_ROWS, 0));
    expect(full.left).toHaveLength(DIRECTORY_ROWS);
    expect(full.moreLeft).toBe(0);
    const over = planDirectory(entries(DIRECTORY_ROWS + 4, 1));
    expect(over.left).toHaveLength(DIRECTORY_ROWS - 1);
    expect(over.moreLeft).toBe(5);
    expect(over.right).toHaveLength(1);
  });
});
