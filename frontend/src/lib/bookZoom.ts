/**
 * Zoom of the open book (FR-14, docs/ARCHITECTURE.md section 11.4).
 *
 * The book itself grows toward the reader: the spread is scaled about the point under the
 * cursor, in the plane of the book, so that point stays under the cursor. A transform is the
 * book's scale and the offset of its centre in that plane (book units at 100 %). The offset is
 * clamped so the book never uncovers more of the screen than it covered at 100 %.
 *
 * Framework-free and unit-tested; the reader applies the transform to its page group.
 */

export const MIN_BOOK_ZOOM = 1;
export const MAX_BOOK_ZOOM = 4;
/** Zoom factor per wheel pixel (a mouse notch of 100 px zooms by about 16 %). */
export const WHEEL_ZOOM_PER_PIXEL = 0.0015;
/** Pinch gestures arrive as wheel events with ctrlKey and small deltas. */
export const PINCH_ZOOM_PER_PIXEL = 0.01;
/** Keyboard step (+ and - keys). */
export const KEY_ZOOM_STEP = 1.25;
/** Time constant of the zoom animation (ms): about 95 % of the way after 210 ms. */
export const ZOOM_TAU_MS = 70;

export interface BookTransform {
  scale: number;
  x: number;
  y: number;
}

/** Half the book's width and height (with its boards) at 100 %. */
export interface BookExtent {
  halfWidth: number;
  halfHeight: number;
}

export const IDENTITY: BookTransform = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keep the scale in range and the book's edges at or beyond where they were at 100 %. */
export function clampTransform(t: BookTransform, extent: BookExtent): BookTransform {
  const scale = clamp(t.scale, MIN_BOOK_ZOOM, MAX_BOOK_ZOOM);
  const limitX = (scale - 1) * extent.halfWidth;
  const limitY = (scale - 1) * extent.halfHeight;
  // "+ 0" turns a clamped -0 into 0 (at 100 % the book is exactly centred).
  return { scale, x: clamp(t.x, -limitX, limitX) + 0, y: clamp(t.y, -limitY, limitY) + 0 };
}

/** Zoom to `scale`, keeping the plane point (px, py) where it is (unless the clamp moves it). */
export function zoomAbout(t: BookTransform, scale: number, px: number, py: number, extent: BookExtent): BookTransform {
  const next = clamp(scale, MIN_BOOK_ZOOM, MAX_BOOK_ZOOM);
  // The book point under (px, py) before the change...
  const qx = (px - t.x) / t.scale;
  const qy = (py - t.y) / t.scale;
  // ...is under it afterwards.
  return clampTransform({ scale: next, x: px - next * qx, y: py - next * qy }, extent);
}

/** Move the zoomed book by (dx, dy) in the plane (a drag), within the clamp. */
export function panBy(t: BookTransform, dx: number, dy: number, extent: BookExtent): BookTransform {
  return clampTransform({ scale: t.scale, x: t.x + dx, y: t.y + dy }, extent);
}

/** The scale after a wheel event (deltaY in pixels; negative zooms in). */
export function wheelScale(scale: number, deltaY: number, pinch: boolean): number {
  const perPixel = pinch ? PINCH_ZOOM_PER_PIXEL : WHEEL_ZOOM_PER_PIXEL;
  return clamp(scale * Math.exp(-deltaY * perPixel), MIN_BOOK_ZOOM, MAX_BOOK_ZOOM);
}

/** One animation step from `current` toward `target`; snaps when close enough. */
export function approach(current: BookTransform, target: BookTransform, dtMs: number, tauMs = ZOOM_TAU_MS): BookTransform {
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const next = {
    scale: current.scale + (target.scale - current.scale) * a,
    x: current.x + (target.x - current.x) * a,
    y: current.y + (target.y - current.y) * a,
  };
  return sameTransform(next, target) ? { ...target } : next;
}

export function sameTransform(a: BookTransform, b: BookTransform, epsilon = 1e-4): boolean {
  return Math.abs(a.scale - b.scale) < epsilon && Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}
