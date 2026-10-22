/**
 * Spread model of an open book (docs/ARCHITECTURE.md section 11.1).
 *
 * - LTR: page 1 alone on the right, then (2,3), (4,5)... with the lower page on the left.
 * - RTL: mirrored: page 1 alone on the left, then page 2 on the right and page 3 on the left.
 * Spread k shows pages 2k and 2k+1 (spread 0 only shows page 1).
 */

export type ReadingDirection = "LTR" | "RTL";
export type Side = "left" | "right";

export interface Spread {
  index: number;
  left: number | null;
  right: number | null;
}

export function spreadCount(pageCount: number): number {
  return Math.floor(pageCount / 2) + 1;
}

export function clampSpread(index: number, pageCount: number): number {
  return Math.min(Math.max(0, Math.round(index)), spreadCount(pageCount) - 1);
}

export function getSpread(index: number, pageCount: number, direction: ReadingDirection): Spread {
  const lowerCandidate = index === 0 ? null : 2 * index;
  const higherCandidate = index === 0 ? 1 : 2 * index + 1;
  const lower = lowerCandidate !== null && lowerCandidate <= pageCount ? lowerCandidate : null;
  const higher = higherCandidate <= pageCount ? higherCandidate : null;
  return direction === "LTR" ? { index, left: lower, right: higher } : { index, left: higher, right: lower };
}

/** Pages visible in a spread, in ascending order. */
export function spreadPages(spread: Spread): number[] {
  return [spread.left, spread.right].filter((page): page is number => page !== null).sort((a, b) => a - b);
}

/** The spread that shows `page`. */
export function spreadForPage(page: number, pageCount: number): number {
  return clampSpread(Math.floor(Math.max(1, page) / 2), pageCount);
}

/** `last_read_page` for a spread: the lowest page number visible (section 11.1). */
export function lastReadPage(index: number, pageCount: number): number {
  return index === 0 ? 1 : Math.min(2 * index, pageCount);
}

export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

/** Which side's leaf turns: forward in LTR turns the right page, in RTL the left page. */
export function turningSide(direction: ReadingDirection, forward: boolean): Side {
  return (direction === "LTR") === forward ? "right" : "left";
}

/** Arrow keys follow the physical side (section 11.2): LTR ArrowRight = next, RTL ArrowLeft = next. */
export function arrowIsForward(key: "ArrowLeft" | "ArrowRight", direction: ReadingDirection): boolean {
  return (key === "ArrowRight") === (direction === "LTR");
}

/** Which way clicking a page turns the book: the clicked side's leaf turns over. */
export function clickIsForward(side: Side, direction: ReadingDirection): boolean {
  return turningSide(direction, true) === side;
}

/** Pages involved in turning from `from` to the adjacent spread `to`. */
export interface FlipPlan {
  /** Side whose leaf turns over. */
  side: Side;
  /** Face of the turning leaf visible when it starts. */
  leafStart: number | null;
  /** Face of the turning leaf visible when it lands. */
  leafEnd: number | null;
  /** Page revealed under the leaf on the turning side. */
  under: number | null;
  /** Page that stays on the other side until the leaf lands. */
  other: number | null;
}

export function planFlip(from: Spread, to: Spread, direction: ReadingDirection): FlipPlan {
  const forward = to.index > from.index;
  const side = turningSide(direction, forward);
  const opposite = otherSide(side);
  return {
    side,
    leafStart: from[side],
    leafEnd: to[opposite],
    under: to[side],
    other: from[opposite],
  };
}
