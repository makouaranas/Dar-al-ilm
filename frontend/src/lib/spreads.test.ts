import { describe, expect, it } from "vitest";

import {
  arrowIsForward,
  clampSpread,
  clickIsForward,
  getSpread,
  lastReadPage,
  planFlip,
  spreadCount,
  spreadForPage,
  spreadPages,
  turningSide,
} from "./spreads";

describe("spread layout", () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [10, 6],
    [11, 6],
  ])("%i pages -> %i spreads", (pages, spreads) => {
    expect(spreadCount(pages)).toBe(spreads);
  });

  it("LTR: page 1 alone on the right, then lower page on the left", () => {
    expect(getSpread(0, 10, "LTR")).toEqual({ index: 0, left: null, right: 1 });
    expect(getSpread(1, 10, "LTR")).toEqual({ index: 1, left: 2, right: 3 });
    expect(getSpread(5, 10, "LTR")).toEqual({ index: 5, left: 10, right: null });
    expect(getSpread(5, 11, "LTR")).toEqual({ index: 5, left: 10, right: 11 });
  });

  it("RTL: mirrored, page 2 on the right and page 3 on the left", () => {
    expect(getSpread(0, 10, "RTL")).toEqual({ index: 0, left: 1, right: null });
    expect(getSpread(1, 10, "RTL")).toEqual({ index: 1, left: 3, right: 2 });
    expect(getSpread(5, 10, "RTL")).toEqual({ index: 5, left: null, right: 10 });
  });

  it("single and two-page books", () => {
    expect(getSpread(0, 1, "LTR")).toEqual({ index: 0, left: null, right: 1 });
    expect(getSpread(1, 2, "LTR")).toEqual({ index: 1, left: 2, right: null });
    expect(getSpread(1, 3, "RTL")).toEqual({ index: 1, left: 3, right: 2 });
  });

  it("every page appears in exactly one spread", () => {
    for (const pages of [1, 2, 3, 10, 11, 57]) {
      for (const direction of ["LTR", "RTL"] as const) {
        const seen = Array.from({ length: spreadCount(pages) }, (_, i) => spreadPages(getSpread(i, pages, direction))).flat();
        expect(seen).toEqual(Array.from({ length: pages }, (_, i) => i + 1));
      }
    }
  });
});

describe("page and spread mapping", () => {
  it("maps pages to spreads and back to last_read_page", () => {
    expect(spreadForPage(1, 10)).toBe(0);
    expect(spreadForPage(2, 10)).toBe(1);
    expect(spreadForPage(3, 10)).toBe(1);
    expect(spreadForPage(10, 10)).toBe(5);
    expect(spreadForPage(99, 10)).toBe(5);
    expect(lastReadPage(0, 10)).toBe(1);
    expect(lastReadPage(1, 10)).toBe(2);
    expect(lastReadPage(5, 10)).toBe(10);
    for (const page of [1, 2, 3, 4, 9, 10]) {
      const spread = spreadForPage(page, 10);
      expect(spreadPages(getSpread(spread, 10, "LTR"))).toContain(lastReadPage(spread, 10));
      expect(spreadPages(getSpread(spread, 10, "LTR"))).toContain(page);
    }
  });

  it("clamps spread indexes", () => {
    expect(clampSpread(-3, 10)).toBe(0);
    expect(clampSpread(42, 10)).toBe(5);
  });
});

describe("turning", () => {
  it("arrow keys follow the physical side", () => {
    expect(arrowIsForward("ArrowRight", "LTR")).toBe(true);
    expect(arrowIsForward("ArrowLeft", "LTR")).toBe(false);
    expect(arrowIsForward("ArrowLeft", "RTL")).toBe(true);
    expect(arrowIsForward("ArrowRight", "RTL")).toBe(false);
  });

  it("forward turns the right leaf in LTR and the left leaf in RTL", () => {
    expect(turningSide("LTR", true)).toBe("right");
    expect(turningSide("LTR", false)).toBe("left");
    expect(turningSide("RTL", true)).toBe("left");
    expect(turningSide("RTL", false)).toBe("right");
    expect(clickIsForward("right", "LTR")).toBe(true);
    expect(clickIsForward("left", "RTL")).toBe(true);
  });

  it("plans the pages of a forward LTR turn", () => {
    const plan = planFlip(getSpread(1, 10, "LTR"), getSpread(2, 10, "LTR"), "LTR");
    expect(plan).toEqual({ side: "right", leafStart: 3, leafEnd: 4, under: 5, other: 2 });
  });

  it("plans the pages of a backward LTR turn", () => {
    const plan = planFlip(getSpread(2, 10, "LTR"), getSpread(1, 10, "LTR"), "LTR");
    expect(plan).toEqual({ side: "left", leafStart: 4, leafEnd: 3, under: 2, other: 5 });
  });

  it("plans the pages of a forward RTL turn", () => {
    const plan = planFlip(getSpread(0, 10, "RTL"), getSpread(1, 10, "RTL"), "RTL");
    expect(plan).toEqual({ side: "left", leafStart: 1, leafEnd: 2, under: 3, other: null });
  });
});
