"use client";

/**
 * Single-page zoom (FR-14, docs/ARCHITECTURE.md section 11.4).
 *
 * Above 100 % an HTML image of the page is laid exactly over the page's rectangle on screen
 * and scaled with a CSS transform: sharp text, simple panning, and no 12-megapixel texture
 * upload. Page turning is locked while zoomed (the store's `flipLocked`).
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { pageUrl } from "@/lib/api";
import { MAX_ZOOM, MIN_ZOOM, useLibraryStore, type PageRects, type ScreenRect } from "@/store/useLibraryStore";

export const ZOOM_STEP = 0.25;
const WHEEL_SENSITIVITY = 0.0015;

interface View {
  page: number;
  rect: ScreenRect;
  /** Translation of the scaled image inside the page rectangle, in CSS pixels (<= 0). */
  tx: number;
  ty: number;
}

/** Commands for the toolbar (one zoom overlay at a time). */
export const zoomCommands: { step: (direction: 1 | -1) => void; reset: () => void } = {
  step: () => undefined,
  reset: () => undefined,
};

function clampTranslation(view: View, zoom: number): View {
  const { width, height } = view.rect;
  return {
    ...view,
    tx: Math.min(0, Math.max(width - width * zoom, view.tx)),
    ty: Math.min(0, Math.max(height - height * zoom, view.ty)),
  };
}

function pagesOf(rects: PageRects): { rect: ScreenRect; page: number }[] {
  return [
    { rect: rects.left, page: rects.leftPage },
    { rect: rects.right, page: rects.rightPage },
  ].filter((c): c is { rect: ScreenRect; page: number } => c.rect !== null && c.page !== null);
}

function contains(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function ZoomOverlay({ bookId, stage }: { bookId: number; stage: HTMLElement | null }) {
  const zoom = useLibraryStore((state) => state.reader.zoom);
  const setZoom = useLibraryStore((state) => state.setZoom);
  const pageRects = useLibraryStore((state) => state.pageRects);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const lastHovered = useRef<number | null>(null);

  /** The page under (x, y), or the nearest one. */
  const pageAt = useCallback((x: number, y: number): View | null => {
    const candidates = pagesOf(useLibraryStore.getState().pageRects);
    if (candidates.length === 0) return null;
    const distance = (r: ScreenRect) => {
      const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
      const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
      return Math.hypot(dx, dy);
    };
    const best = candidates.sort((a, b) => distance(a.rect) - distance(b.rect))[0]!;
    return { page: best.page, rect: best.rect, tx: 0, ty: 0 };
  }, []);

  /** Zoom to `next` keeping the point (x, y) (stage coordinates) fixed on screen. */
  const zoomAt = useCallback(
    (next: number, x: number, y: number) => {
      const current = zoomRef.current;
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      const base = current > MIN_ZOOM && viewRef.current ? viewRef.current : pageAt(x, y);
      if (!base || clamped <= MIN_ZOOM + 1e-3) {
        setView(null);
        setZoom(MIN_ZOOM);
        return;
      }
      const px = x - base.rect.x;
      const py = y - base.rect.y;
      // The page point under (x, y) before the change stays under it afterwards.
      const cx = (px - base.tx) / current;
      const cy = (py - base.ty) / current;
      setView(clampTranslation({ ...base, tx: px - cx * clamped, ty: py - cy * clamped }, clamped));
      setZoom(clamped);
    },
    [pageAt, setZoom],
  );

  // The mouse wheel over the stage zooms toward the cursor; hovering remembers the page for
  // the toolbar buttons.
  useEffect(() => {
    if (!stage) return;
    const local = (event: MouseEvent) => {
      const bounds = stage.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const onWheel = (event: WheelEvent) => {
      if (zoomRef.current <= MIN_ZOOM && event.deltaY >= 0) return;
      if (event.target instanceof Element && event.target.closest("[role=toolbar]")) return;
      const { x, y } = local(event);
      event.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-event.deltaY * WHEEL_SENSITIVITY), x, y);
    };
    const onMove = (event: PointerEvent) => {
      // Only the pages themselves count, not the toolbar floating over them.
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const { x, y } = local(event);
      const hit = pagesOf(useLibraryStore.getState().pageRects).find((c) => contains(c.rect, x, y));
      if (hit) lastHovered.current = hit.page;
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointermove", onMove);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointermove", onMove);
    };
  }, [stage, zoomAt]);

  // Toolbar commands: 25 % steps around the centre of the zoomed (or last hovered) page.
  useEffect(() => {
    zoomCommands.step = (direction) => {
      const current = viewRef.current;
      let rect = current?.rect ?? null;
      if (!rect) {
        const candidates = pagesOf(useLibraryStore.getState().pageRects);
        const hovered = candidates.find((c) => c.page === lastHovered.current);
        // Default: the first page in reading order, which is the lower page number.
        const first = [...candidates].sort((a, b) => a.page - b.page)[0];
        rect = (hovered ?? first)?.rect ?? null;
      }
      if (!rect) return;
      zoomAt(zoomRef.current + direction * ZOOM_STEP, rect.x + rect.width / 2, rect.y + rect.height / 2);
    };
    zoomCommands.reset = () => {
      setView(null);
      setZoom(MIN_ZOOM);
    };
    return () => {
      zoomCommands.step = () => undefined;
      zoomCommands.reset = () => undefined;
    };
  }, [zoomAt, setZoom]);

  // Esc resets the zoom (Esc at 100 % is handled by the reader shell: it closes the book).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || zoomRef.current <= MIN_ZOOM) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      zoomCommands.reset();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Keep the overlay on its page when the window is resized while zoomed.
  useEffect(() => {
    const current = viewRef.current;
    if (!current) return;
    const match = pagesOf(pageRects).find((c) => c.page === current.page);
    if (!match) {
      setView(null);
      setZoom(MIN_ZOOM);
      return;
    }
    const { rect } = match;
    if (rect.x === current.rect.x && rect.y === current.rect.y && rect.width === current.rect.width) return;
    const scale = rect.width / current.rect.width;
    setView(clampTranslation({ ...current, rect, tx: current.tx * scale, ty: current.ty * scale }, zoomRef.current));
  }, [pageRects, setZoom]);

  // Image: the high image first (already in the browser cache), then the 4096 px zoom image
  // once it has loaded.
  const [src, setSrc] = useState<string | null>(null);
  const [sharp, setSharp] = useState(false);
  const page = view?.page ?? null;
  useEffect(() => {
    setSharp(false);
    if (page === null) {
      setSrc(null);
      return;
    }
    setSrc(pageUrl(bookId, page, "high"));
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      setSrc(pageUrl(bookId, page, "zoom"));
      setSharp(true);
    };
    image.src = pageUrl(bookId, page, "zoom");
    return () => {
      image.onload = null;
    };
  }, [bookId, page]);

  // Drag to pan, clamped to the page edges.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!view || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || !view) return;
    setView(clampTranslation({ ...view, tx: start.tx + event.clientX - start.x, ty: start.ty + event.clientY - start.y }, zoom));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  if (!view || zoom <= MIN_ZOOM || !src) return null;

  return (
    <div
      data-testid="zoom-overlay"
      data-page={view.page}
      data-zoom={zoom.toFixed(2)}
      data-sharp={sharp}
      data-tx={Math.round(view.tx)}
      data-ty={Math.round(view.ty)}
      className="absolute overflow-hidden bg-paper"
      style={{
        left: view.rect.x,
        top: view.rect.y,
        width: view.rect.width,
        height: view.rect.height,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-0 left-0 h-full w-full origin-top-left select-none object-contain"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${zoom})` }}
      />
    </div>
  );
}
