"use client";

/**
 * The 3D curved page-flipping reader (FR-12, docs/ARCHITECTURE.md section 11).
 *
 * The book lies open at the origin: spine on the y axis, pages in the z = 0 plane facing +z,
 * page height 1. Flat pages show the current spread; during a turn a curled leaf (front and
 * back faces) sweeps from one side to the other. The component renders frames only while a
 * leaf moves (frameloop="demand"); `invalidate()` is called from the animation loop only.
 */

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { bookMaterials, coverPlaceholder, coverTexture, getBookSource, takeOpenFrom } from "@/components/3d/BookPresenter";
import { useReaderTransition } from "@/components/3d/readerTransition";
import { ReaderToolbar } from "@/components/ui/ReaderToolbar";
import { pageUrl, type Book, type GraphicsQuality } from "@/lib/api";
import { useReadingSession } from "@/lib/bookmark";
import {
  IDENTITY,
  KEY_ZOOM_STEP,
  MIN_BOOK_ZOOM,
  approach,
  clampTransform,
  panBy,
  sameTransform,
  wheelScale,
  zoomAbout,
  type BookTransform,
} from "@/lib/bookZoom";
import { bookSize } from "@/lib/hallLayout";
import {
  arrowIsForward,
  clampSpread,
  clickIsForward,
  getSpread,
  planFlip,
  spreadCount,
  type FlipPlan,
  type ReadingDirection,
  type Side,
} from "@/lib/spreads";
import { countFrame, registerReader, registerRenderer, registerTestHook } from "@/lib/testApi";
import { TexturePool } from "@/lib/texturePool";
import { rendersInSoftware } from "@/lib/webglCheck";
import { useLibraryStore } from "@/store/useLibraryStore";

import {
  containRect,
  createFlatPageGeometry,
  createLeafGeometry,
  createPageMaterial,
  deformLeaf,
  easeInOutCubic,
  mirroredUv,
} from "./pageCurl";

export const PAGE_HEIGHT = 1;
export const FLIP_MS = 550;
export const QUEUED_FLIP_MS = 280;
/** Jumps of more than one spread play a short riffle of fast turns (section 11.2). */
export const RIFFLE_MS = 120;
const RIFFLE_TURNS = 3;

/**
 * Commands for UI outside the canvas (toolbar buttons). The mounted reader registers itself;
 * there is one reader at a time.
 */
export const readerCommands: { turn: (forward: boolean) => void } = { turn: () => undefined };

const BEND = 0.85;
const LEAF_LIFT = 0.0015;
const DRAG_ZONE = 0.3; // the outer 30 % of a page starts a drag
const CLICK_SLOP_PX = 6;
const FLICK_SPEED = 0.6; // page widths per second (section 11.2)
const PAGE_EDGE_COLOR = "#efe9dc";

// --- Book dimensions ------------------------------------------------------------------

export interface BookDimensions {
  width: number;
  height: number;
  /** Total thickness of the paper block, in scene units. */
  block: number;
  board: number;
  margin: number;
}

/** Same formulas as the shelves (docs/ARCHITECTURE.md 9.2), scaled to a page height of 1. */
export function bookDimensions(book: Pick<Book, "page_width_pt" | "page_height_pt" | "page_count">): BookDimensions {
  const aspect = book.page_width_pt / book.page_height_pt;
  const heightMetres = Math.min(0.4, Math.max(0.15, (book.page_height_pt * 0.0254) / 72 + 0.006));
  const thicknessMetres = Math.min(0.08, Math.max(0.015, 0.004 + 0.00005 * book.page_count));
  const scale = PAGE_HEIGHT / heightMetres;
  return {
    width: PAGE_HEIGHT * aspect,
    height: PAGE_HEIGHT,
    block: thicknessMetres * scale,
    board: 0.012,
    margin: 0.018,
  };
}

// --- Page textures: progressive low -> high with a 3-spread GPU window (US-07) ------------

export const CROSSFADE_MS = 150;
const PREFETCH_SPREADS = 3;

async function decodePage(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Page request failed: ${response.status}`);
  // Decoded off the main thread; flipped here so textures keep flipY = false.
  return createImageBitmap(await response.blob(), { imageOrientation: "flipY" });
}

/**
 * The pool owns page textures; disposal is deferred through `retire` until no material
 * references the texture any more. Disposing a texture that is still bound would make
 * three.js upload it again on the next frame, and that copy would never be freed.
 */
function usePagePool(
  bookId: number,
  onChange: () => void,
  retire: (texture: THREE.Texture) => void,
): TexturePool<THREE.Texture> {
  const gl = useThree((state) => state.gl);
  const pool = useMemo(() => {
    const anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    return new TexturePool<THREE.Texture>({
      url: (page, quality) => pageUrl(bookId, page, quality),
      decode: (url, signal) => decodePage(url, signal),
      createTexture: (image) => {
        const texture = new THREE.Texture(image as ImageBitmap);
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = anisotropy;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.needsUpdate = true;
        return { texture, dispose: () => retire(texture) };
      },
      onChange,
    });
  }, [bookId, gl, onChange, retire]);
  useEffect(() => () => pool.dispose(), [pool]);
  return pool;
}

// --- Component ---------------------------------------------------------------------------

interface View {
  left: number | null;
  right: number | null;
  leafSide: Side | null;
  leafStart: number | null;
  leafEnd: number | null;
}

interface Flip {
  plan: FlipPlan;
  from: number;
  to: number;
  mode: "auto" | "drag";
  start: number;
  duration: number;
  startProgress: number;
  target: 0 | 1;
  progress: number;
  twist: number;
}

interface Drag {
  side: Side;
  pointerId: number;
  startX: number;
  startY: number;
  canDrag: boolean;
  twist: number;
  samples: { time: number; progress: number }[];
}

function viewOf(spread: { left: number | null; right: number | null }): View {
  return { left: spread.left, right: spread.right, leafSide: null, leafStart: null, leafEnd: null };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export interface CurvedBookReaderProps {
  book: Book;
  /** Spread to show; a change while idle jumps there. */
  spreadIndex: number;
  /** Called when a turn lands on a new spread. */
  onSpreadChange: (spreadIndex: number) => void;
  /** Page turning input: keys, clicks and drags (false while zoomed or behind a modal). */
  active: boolean;
  /** Wheel, drag and keyboard zoom (false during the open and close transitions). */
  zoomable?: boolean;
  /**
   * On its own canvas the reader brings its own lights. Inside the hall it adds none (that
   * would recompile every hall material on open and close) and its boards are unlit.
   */
  standalone?: boolean;
}

export function CurvedBookReader({ book, spreadIndex, onSpreadChange, active, zoomable = true, standalone = true }: CurvedBookReaderProps) {
  const direction: ReadingDirection = book.reading_direction;
  const pageCount = book.page_count;
  const dims = useMemo(() => bookDimensions(book), [book]);
  const { width: W, height: H } = dims;

  const { camera, gl, invalidate } = useThree();
  /** The tilted reading plane; `groupRef` (the pages) is scaled and moved inside it to zoom. */
  const tiltRef = useRef<THREE.Group>(null);
  const groupRef = useRef<THREE.Group>(null);
  const leafRef = useRef<THREE.Group>(null);

  const displayed = useRef(clampSpread(spreadIndex, pageCount));
  const queue = useRef<{ to: number; duration?: number }[]>([]);
  const flip = useRef<Flip | null>(null);
  const drag = useRef<Drag | null>(null);
  /** The last spread reported through `onSpreadChange`, and a jump waiting for the leaf. */
  const reported = useRef(spreadIndex);
  const pendingJump = useRef<number | null>(null);
  const [view, setView] = useState<View>(() => viewOf(getSpread(displayed.current, pageCount, direction)));
  const [settled, setSettled] = useState(displayed.current);

  // Geometry and materials, created once per page size.
  const geometry = useMemo(() => {
    const leafFront = createLeafGeometry(W, H);
    const leafBack = leafFront.clone();
    leafBack.setAttribute("position", leafFront.getAttribute("position"));
    leafBack.setAttribute("color", (leafFront.getAttribute("color") as THREE.BufferAttribute).clone());
    const uvNormal = leafFront.getAttribute("uv") as THREE.BufferAttribute;
    const uvMirrored = mirroredUv(leafFront);
    return {
      left: createFlatPageGeometry(W, H, "left"),
      right: createFlatPageGeometry(W, H, "right"),
      leafFront,
      leafBack,
      uvNormal,
      uvMirrored,
    };
  }, [W, H]);

  const materials = useMemo(
    () => ({
      left: createPageMaterial(THREE.FrontSide),
      right: createPageMaterial(THREE.FrontSide),
      leafFront: createPageMaterial(THREE.FrontSide),
      leafBack: createPageMaterial(THREE.BackSide),
    }),
    [],
  );

  useEffect(
    () => () => {
      for (const g of [geometry.left, geometry.right, geometry.leafFront, geometry.leafBack]) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
    [geometry, materials],
  );

  // Textures: a version counter re-runs the material assignment when the pool changes.
  const [version, setVersion] = useState(0);
  const onPoolChange = useCallback(() => {
    setVersion((v) => v + 1);
    invalidate();
  }, [invalidate]);
  const retired = useRef(new Set<THREE.Texture>());
  const retire = useCallback(
    (texture: THREE.Texture) => {
      retired.current.add(texture);
      setVersion((v) => v + 1);
    },
    [],
  );
  const pool = usePagePool(book.id, onPoolChange, retire);
  const turning = view.leafSide !== null;
  const storeZoom = useLibraryStore((state) => state.reader.zoom);
  const setZoom = useLibraryStore((state) => state.setZoom);
  const zoomedIn = storeZoom > MIN_BOOK_ZOOM;

  // GPU window: the pages on screen plus the previous and next spreads; RAM prefetch: the
  // low images of the next spreads in reading order.
  const applyWindow = useRef<() => void>(() => undefined);
  /** The `settled` flag last given to the pool (the frame loop re-applies when it changes). */
  const windowResting = useRef<boolean | null>(null);
  useEffect(() => {
    const pagesOf = (index: number) => {
      if (index < 0 || index >= spreadCount(pageCount)) return [];
      const spread = getSpread(index, pageCount, direction);
      return [spread.left, spread.right].filter((page): page is number => page !== null);
    };
    const visible = [view.left, view.right, view.leafStart, view.leafEnd].filter(
      (page): page is number => page !== null,
    );
    const shown = new Set(visible);
    const neighbours = [settled - 1, settled, settled + 1].flatMap(pagesOf).filter((page) => !shown.has(page));
    const prefetch: number[] = [];
    for (let i = 2; i <= PREFETCH_SPREADS + 1; i += 1) prefetch.push(...pagesOf(settled + i));
    // Settled means at rest with nothing queued: between the turns of a riffle the leaf is at
    // rest for a moment, and high images requested then would land on the next turning page.
    applyWindow.current = () => {
      const resting = !turning && queue.current.length === 0 && pendingJump.current === null;
      windowResting.current = resting;
      pool.setWindow({ visible, neighbours, prefetch, settled: resting, zoomed: zoomedIn });
    };
    applyWindow.current();
  }, [pool, view, settled, turning, pageCount, direction, zoomedIn]);

  // Which surface shows which page, and running low -> high and high -> zoom cross-fades
  // (page -> start time).
  const fades = useRef(new Map<number, number>());
  const zoomFades = useRef(new Map<number, number>());
  const surfaces = useMemo(
    () =>
      [
        [materials.left, view.left],
        [materials.right, view.right],
        [materials.leafFront, view.leafStart],
        [materials.leafBack, view.leafEnd],
      ] as const,
    [materials, view],
  );

  useLayoutEffect(() => {
    const frameAspect = W / H;
    const now = performance.now();
    for (const [material, page] of surfaces) {
      const uniforms = material.uniforms;
      const textures = page === null ? {} : pool.get(page);
      const rect = containRect(textures.aspect ?? frameAspect, frameAspect);
      uniforms.rectA!.value = rect;
      uniforms.rectB!.value = rect;
      if (page !== null && textures.zoom && textures.high) {
        // Zoomed in: the 4096 px image fades in over the 2048 px one.
        if (!zoomFades.current.has(page)) zoomFades.current.set(page, now);
        if (fades.current.delete(page)) uniforms.mixB!.value = 0;
        uniforms.mapA!.value = textures.high;
        uniforms.mapB!.value = textures.zoom;
        uniforms.hasA!.value = 1;
        uniforms.hasB!.value = 1;
      } else if (page !== null && textures.low && textures.high) {
        if (!fades.current.has(page)) fades.current.set(page, now);
        uniforms.mapA!.value = textures.low;
        uniforms.mapB!.value = textures.high;
        uniforms.hasA!.value = 1;
        uniforms.hasB!.value = 1;
      } else {
        const texture = textures.zoom ?? textures.high ?? textures.low ?? null;
        uniforms.mapA!.value = texture;
        uniforms.hasA!.value = texture ? 1 : 0;
        uniforms.hasB!.value = 0;
        uniforms.mixB!.value = 0;
        if (page !== null) fades.current.delete(page);
      }
      if (page !== null && !textures.zoom) zoomFades.current.delete(page);
    }
    // Now that the materials point at the current textures, free the retired ones.
    const bound = new Set<unknown>();
    for (const material of Object.values(materials)) {
      bound.add(material.uniforms.mapA!.value);
      bound.add(material.uniforms.mapB!.value);
    }
    for (const texture of retired.current) {
      if (bound.has(texture)) continue;
      texture.dispose();
      retired.current.delete(texture);
    }
    invalidate();
  }, [surfaces, version, pool, materials, W, H, invalidate]);

  useEffect(
    () => () => {
      for (const texture of retired.current) texture.dispose();
      retired.current.clear();
    },
    [],
  );

  // --- Turning -------------------------------------------------------------------------

  /**
   * A view set from the frame loop is not on screen until React commits it. The leaf shows,
   * and the next queued turn starts, only after that commit; otherwise one frame could show the
   * previous spread's pages on the turning leaf.
   */
  const viewPending = useRef(false);
  /** The view on screen (the test report reads it; a passive effect would lag a frame). */
  const committedView = useRef(view);
  useLayoutEffect(() => {
    committedView.current = view;
    viewPending.current = false;
    if (flip.current && leafRef.current) leafRef.current.visible = true;
    invalidate();
  }, [view, invalidate]);

  const startFlip = useCallback(
    (to: number, mode: Flip["mode"], duration: number, twist = 0) => {
      const from = displayed.current;
      const plan = planFlip(getSpread(from, pageCount, direction), getSpread(to, pageCount, direction), direction);
      flip.current = {
        plan,
        from,
        to,
        mode,
        start: performance.now(),
        duration,
        startProgress: 0,
        target: 1,
        progress: 0,
        twist,
      };
      viewPending.current = true;
      setView({
        left: plan.side === "left" ? plan.under : plan.other,
        right: plan.side === "right" ? plan.under : plan.other,
        leafSide: plan.side,
        leafStart: plan.leafStart,
        leafEnd: plan.leafEnd,
      });
      // Mirror the leaf for left-side turns and pick the UV set that reads correctly.
      const right = plan.side === "right";
      geometry.leafFront.setAttribute("uv", right ? geometry.uvNormal : geometry.uvMirrored);
      geometry.leafBack.setAttribute("uv", right ? geometry.uvMirrored : geometry.uvNormal);
      // The leaf becomes visible once this view is committed (see viewPending).
      if (leafRef.current) leafRef.current.scale.x = right ? 1 : -1;
      invalidate();
    },
    [pageCount, direction, geometry, invalidate],
  );

  const finishFlip = useCallback(
    (completed: boolean) => {
      const current = flip.current;
      if (!current) return;
      flip.current = null;
      if (leafRef.current) leafRef.current.visible = false;
      const landed = completed ? current.to : current.from;
      displayed.current = landed;
      viewPending.current = true;
      setView(viewOf(getSpread(landed, pageCount, direction)));
      setSettled(landed);
      rectsDirty.current = true;
      if (completed) {
        reported.current = landed;
        onSpreadChange(landed);
      }
      invalidate();
    },
    [pageCount, direction, onSpreadChange, invalidate],
  );

  const requestTurn = useCallback(
    (forward: boolean) => {
      const base = queue.current.at(-1)?.to ?? flip.current?.to ?? displayed.current;
      const next = base + (forward ? 1 : -1);
      if (next < 0 || next >= spreadCount(pageCount)) return;
      queue.current.push({ to: next });
      invalidate();
    },
    [pageCount, invalidate],
  );

  useEffect(() => {
    readerCommands.turn = (forward: boolean) => {
      if (active) requestTurn(forward);
    };
    return () => {
      readerCommands.turn = () => undefined;
    };
  }, [active, requestTurn]);

  // Jumps from outside (slider, page input): a short riffle of fast turns, then land. The
  // reader's own reports (`onSpreadChange`) come back as `spreadIndex` and are not jumps.
  useEffect(() => {
    if (spreadIndex === reported.current) return;
    reported.current = spreadIndex;
    queue.current = [];
    pendingJump.current = clampSpread(spreadIndex, pageCount);
    invalidate();
  }, [spreadIndex, pageCount, invalidate]);

  const planJump = useCallback(
    (target: number) => {
      const distance = Math.abs(target - displayed.current);
      if (distance === 0) return;
      const step = target > displayed.current ? 1 : -1;
      if (distance > 1) {
        const from = target - step * Math.min(RIFFLE_TURNS, distance);
        if (from !== displayed.current) {
          displayed.current = from;
          viewPending.current = true;
          setView(viewOf(getSpread(from, pageCount, direction)));
          setSettled(from);
        }
        for (let s = from + step; s !== target + step; s += step) queue.current.push({ to: s, duration: RIFFLE_MS });
      } else {
        queue.current.push({ to: target });
      }
    },
    [pageCount, direction],
  );

  // Book changes reset everything.
  useEffect(() => {
    queue.current = [];
    pendingJump.current = null;
    flip.current = null;
    if (leafRef.current) leafRef.current.visible = false;
  }, [book.id]);

  // Keyboard: arrows follow the physical side; Space turns forward.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        requestTurn(arrowIsForward(event.key, direction));
      } else if (event.key === " ") {
        event.preventDefault();
        requestTurn(!event.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, direction, requestTurn]);

  // --- Pointer: click a page to turn it, drag its outer part to turn it by hand -----------

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const toLocal = useCallback(
    (clientX: number, clientY: number): THREE.Vector3 | null => {
      const group = groupRef.current;
      if (!group) return null;
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
      const hit = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), new THREE.Vector3());
      return hit ? group.worldToLocal(hit) : null;
    },
    [camera, gl, raycaster],
  );

  const dragProgress = useCallback(
    (side: Side, local: THREE.Vector3) => {
      const edge = side === "right" ? local.x : -local.x;
      return Math.acos(Math.min(1, Math.max(-1, edge / W))) / Math.PI;
    },
    [W],
  );

  // --- Zoom (section 11.4): the book grows about the point under the cursor -----------------

  const extent = useMemo(() => ({ halfWidth: W + dims.margin, halfHeight: H / 2 + dims.margin }), [W, H, dims.margin]);
  const zoomNow = useRef<BookTransform>(IDENTITY);
  const zoomTarget = useRef<BookTransform>(IDENTITY);
  const lastZoomFrame = useRef<number | null>(null);

  /** Puts the page group where `zoomNow` says. */
  const applyZoom = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    const { scale, x, y } = zoomNow.current;
    group.position.set(x, y, 0);
    group.scale.setScalar(scale);
    rectsDirty.current = true;
  }, []);

  /** The point of the reading plane under a screen position (tilted-plane coordinates). */
  const planePoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const tilt = tiltRef.current;
      if (!tilt) return null;
      tilt.updateWorldMatrix(true, false);
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(tilt.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(tilt.matrixWorld);
      const hit = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), new THREE.Vector3());
      if (!hit) return null;
      const local = tilt.worldToLocal(hit);
      return { x: local.x, y: local.y };
    },
    [camera, gl, raycaster],
  );

  /** Zoom to `scale` about a plane point (default: the point under the middle of the view). */
  const zoomTo = useCallback(
    (scale: number, at: { x: number; y: number } | null = null) => {
      const rect = gl.domElement.getBoundingClientRect();
      const point = at ?? planePoint(rect.left + rect.width / 2, rect.top + rect.height / 2) ?? { x: 0, y: 0 };
      const next = scale <= MIN_BOOK_ZOOM + 1e-3 ? IDENTITY : zoomAbout(zoomTarget.current, scale, point.x, point.y, extent);
      zoomTarget.current = next;
      setZoom(next.scale);
      invalidate();
    },
    [gl, planePoint, extent, setZoom, invalidate],
  );

  // The zoom changed from outside (the toolbar's reset, a new book): follow it.
  useEffect(() => {
    if (Math.abs(storeZoom - zoomTarget.current.scale) < 1e-3) return;
    zoomTarget.current = storeZoom <= MIN_BOOK_ZOOM ? IDENTITY : clampTransform({ ...zoomTarget.current, scale: storeZoom }, extent);
    invalidate();
  }, [storeZoom, extent, invalidate]);

  // A new book starts at 100 %, without animating from the previous book's zoom.
  useEffect(() => {
    zoomNow.current = IDENTITY;
    zoomTarget.current = IDENTITY;
    applyZoom();
  }, [book.id, applyZoom]);

  // Wheel (and trackpad pinch) zooms toward the cursor; a drag pans while zoomed in; + and -
  // zoom around the middle of the view, 0 and Esc return to 100 %.
  useEffect(() => {
    if (!zoomable) return;
    const element = gl.domElement;
    const onWheel = (event: WheelEvent) => {
      const target = zoomTarget.current;
      if (target.scale <= MIN_BOOK_ZOOM && event.deltaY >= 0) return;
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      const point = planePoint(event.clientX, event.clientY);
      if (point) zoomTo(wheelScale(target.scale, pixels, event.ctrlKey), point);
    };
    let pan: { pointerId: number; start: { x: number; y: number }; from: BookTransform } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || zoomTarget.current.scale <= MIN_BOOK_ZOOM) return;
      const start = planePoint(event.clientX, event.clientY);
      if (!start) return;
      pan = { pointerId: event.pointerId, start, from: { ...zoomTarget.current } };
      element.style.cursor = "grabbing";
    };
    const onMove = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      const now = planePoint(event.clientX, event.clientY);
      if (!now) return;
      // A drag follows the hand directly, without easing.
      const next = panBy(pan.from, now.x - pan.start.x, now.y - pan.start.y, extent);
      zoomTarget.current = next;
      zoomNow.current = next;
      applyZoom();
      invalidate();
    };
    const onUp = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      pan = null;
      element.style.cursor = zoomTarget.current.scale > MIN_BOOK_ZOOM ? "grab" : "";
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const scale = zoomTarget.current.scale;
      if (event.key === "+" || event.key === "=") zoomTo(scale * KEY_ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") zoomTo(scale / KEY_ZOOM_STEP);
      else if (event.key === "0" || (event.key === "Escape" && scale > MIN_BOOK_ZOOM)) zoomTo(MIN_BOOK_ZOOM);
      else return;
      // Esc while zoomed only resets the zoom; the book stays open.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, { capture: true });
      element.style.cursor = "";
    };
  }, [zoomable, gl, planePoint, zoomTo, extent, applyZoom, invalidate]);

  // The cursor shows that a zoomed book can be dragged.
  useEffect(() => {
    gl.domElement.style.cursor = zoomedIn && zoomable ? "grab" : "";
  }, [gl, zoomedIn, zoomable]);

  const onPagePointerDown = useCallback(
    (side: Side) => (event: ThreeEvent<PointerEvent>) => {
      if (!active || event.button !== 0) return;
      event.stopPropagation();
      const local = groupRef.current?.worldToLocal(event.point.clone());
      if (!local) return;
      const fromSpine = Math.abs(local.x) / W;
      drag.current = {
        side,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        canDrag: fromSpine > 1 - DRAG_ZONE,
        twist: Math.abs(local.y) > H * 0.3 ? Math.sign(local.y) : 0,
        samples: [],
      };
    },
    [active, W, H],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (!flip.current && current.canDrag && moved > CLICK_SLOP_PX && queue.current.length === 0) {
        const forward = clickIsForward(current.side, direction);
        const to = displayed.current + (forward ? 1 : -1);
        if (to >= 0 && to < spreadCount(pageCount)) startFlip(to, "drag", FLIP_MS, current.twist);
      }
      const turning = flip.current;
      if (turning?.mode === "drag") {
        const local = toLocal(event.clientX, event.clientY);
        if (local) {
          turning.progress = dragProgress(current.side, local);
          current.samples.push({ time: performance.now(), progress: turning.progress });
          if (current.samples.length > 6) current.samples.shift();
          invalidate();
        }
      }
    };
    const onUp = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      drag.current = null;
      const turning = flip.current;
      if (turning?.mode === "drag") {
        const first = current.samples[0];
        const last = current.samples.at(-1);
        const elapsed = first && last ? (last.time - first.time) / 1000 : 0;
        // A full turn moves the edge across two page widths.
        const speed = first && last && elapsed > 0 ? ((last.progress - first.progress) * 2) / elapsed : 0;
        const complete = turning.progress > 0.5 || speed > FLICK_SPEED;
        turning.mode = "auto";
        turning.startProgress = turning.progress;
        turning.target = complete ? 1 : 0;
        turning.start = performance.now();
        turning.duration = Math.max(120, FLIP_MS * Math.abs(turning.target - turning.progress));
        invalidate();
        return;
      }
      const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (moved <= CLICK_SLOP_PX) requestTurn(clickIsForward(current.side, direction));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [direction, pageCount, startFlip, toLocal, dragProgress, requestTurn, invalidate]);

  // --- Animation loop (runs only while something moves) -----------------------------------

  const positions = geometry.leafFront.getAttribute("position") as THREE.BufferAttribute;
  const frontColors = geometry.leafFront.getAttribute("color") as THREE.BufferAttribute;
  const backColors = geometry.leafBack.getAttribute("color") as THREE.BufferAttribute;

  useFrame(() => {
    const now = performance.now();
    if (rectsDirty.current && !flip.current) {
      rectsDirty.current = false;
      reportRects();
    }
    if (!flip.current && pendingJump.current !== null) {
      planJump(pendingJump.current);
      pendingJump.current = null;
    }
    if (!flip.current && queue.current.length > 0 && !viewPending.current) {
      const next = queue.current.shift()!;
      startFlip(next.to, "auto", next.duration ?? (queue.current.length > 0 ? QUEUED_FLIP_MS : FLIP_MS));
    }
    const current = flip.current;
    if (current) {
      if (current.mode === "auto") {
        const t = Math.min(1, (now - current.start) / current.duration);
        current.progress = current.startProgress + (current.target - current.startProgress) * easeInOutCubic(t);
        if (t >= 1) {
          finishFlip(current.target === 1);
        }
      }
      if (flip.current) {
        deformLeaf(
          positions.array as Float32Array,
          frontColors.array as Float32Array,
          backColors.array as Float32Array,
          W,
          H,
          { progress: current.progress, bend: BEND, twist: current.twist },
        );
        positions.needsUpdate = true;
        frontColors.needsUpdate = true;
        backColors.needsUpdate = true;
      }
    }
    // Cross-fades from the low to the high image (150 ms), then the low texture is released.
    for (const [page, started] of fades.current) {
      const t = Math.min(1, (now - started) / CROSSFADE_MS);
      for (const [material, surfacePage] of surfaces) {
        if (surfacePage === page) material.uniforms.mixB!.value = t;
      }
      if (t >= 1) {
        fades.current.delete(page);
        pool.releaseLow(page);
      }
    }
    for (const [page, started] of zoomFades.current) {
      const t = Math.min(1, (now - started) / CROSSFADE_MS);
      for (const [material, surfacePage] of surfaces) {
        if (surfacePage === page) material.uniforms.mixB!.value = t;
      }
      if (t >= 1) zoomFades.current.delete(page);
    }
    // The zoom animation: the page group eases toward its target transform.
    const zoomMoving = !sameTransform(zoomNow.current, zoomTarget.current);
    if (zoomMoving) {
      const dt = lastZoomFrame.current === null ? 16 : now - lastZoomFrame.current;
      zoomNow.current = approach(zoomNow.current, zoomTarget.current, Math.min(dt, 50));
      lastZoomFrame.current = now;
      applyZoom();
    } else {
      lastZoomFrame.current = null;
    }
    // The queue or a pending jump emptied without a new view (a jump to the spread on screen):
    // tell the pool the book is at rest, so the pages sharpen.
    const resting = !flip.current && queue.current.length === 0 && pendingJump.current === null;
    if (windowResting.current !== null && resting !== windowResting.current) applyWindow.current();
    if (
      flip.current?.mode === "auto" ||
      queue.current.length > 0 ||
      pendingJump.current !== null ||
      fades.current.size > 0 ||
      zoomFades.current.size > 0 ||
      zoomMoving
    ) {
      invalidate();
    }
  });

  // Screen rectangles of the two pages (zoom included), for the tests and the toolbar.
  const size = useThree((state) => state.size);
  const rectsDirty = useRef(true);
  useEffect(() => {
    rectsDirty.current = true;
    invalidate();
  }, [size, view.left, view.right, W, H, camera, invalidate]);
  const reportRects = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    group.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const project = (x0: number, x1: number) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of [
        [x0, -H / 2],
        [x0, H / 2],
        [x1, -H / 2],
        [x1, H / 2],
      ] as const) {
        const v = new THREE.Vector3(x, y, 0).applyMatrix4(group.matrixWorld).project(camera);
        const px = ((v.x + 1) / 2) * size.width;
        const py = ((1 - v.y) / 2) * size.height;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    };
    useLibraryStore.getState().setPageRects({
      left: view.left !== null ? project(-W, 0) : null,
      right: view.right !== null ? project(0, W) : null,
      leftPage: view.left,
      rightPage: view.right,
    });
  }, [camera, size, view.left, view.right, W, H]);

  // Test hooks: hold the leaf at a given progress (software rendering is too slow to catch
  // a 550 ms turn mid-way), then release it like a drag.
  useEffect(() => {
    registerTestHook("readerHold", (progress: number, forward = true) => {
      if (!flip.current) {
        const to = displayed.current + (forward ? 1 : -1);
        if (to < 0 || to >= spreadCount(pageCount)) return false;
        startFlip(to, "drag", FLIP_MS);
      }
      const turning = flip.current;
      if (!turning) return false;
      turning.mode = "drag";
      turning.progress = Math.min(1, Math.max(0, progress));
      invalidate();
      return true;
    });
    registerTestHook("readerRelease", () => {
      const turning = flip.current;
      if (!turning || turning.mode !== "drag") return false;
      turning.mode = "auto";
      turning.startProgress = turning.progress;
      turning.target = turning.progress > 0.5 ? 1 : 0;
      turning.start = performance.now();
      turning.duration = Math.max(120, FLIP_MS * Math.abs(turning.target - turning.progress));
      invalidate();
      return true;
    });
    return () => {
      registerTestHook("readerHold", undefined);
      registerTestHook("readerRelease", undefined);
    };
  }, [pageCount, startFlip, invalidate]);

  // Report state for the end-to-end tests.
  useEffect(() => {
    registerReader(() => {
      const stats = pool.stats();
      return {
        spreadIndex: displayed.current,
        flipping: flip.current !== null,
        queued: queue.current.length,
        textures: stats.qualities,
        prefetched: stats.prefetched,
        gpuPages: stats.gpuPages,
        visible: (({ left, right, leafStart, leafEnd }) => [left, right, leafStart, leafEnd])(committedView.current).filter(
          (page): page is number => page !== null,
        ),
        zoom: { ...zoomNow.current, target: zoomTarget.current.scale },
      };
    });
    // The book point (page-group coordinates) under a screen position: it must stay put
    // under the cursor while the wheel zooms.
    registerTestHook("readerBookPoint", (clientX: number, clientY: number) => {
      const point = planePoint(clientX, clientY);
      const { scale, x, y } = zoomNow.current;
      return point ? { x: (point.x - x) / scale, y: (point.y - y) / scale } : null;
    });
    return () => {
      registerReader(null);
      registerTestHook("readerBookPoint", undefined);
    };
  }, [pool, planePoint]);

  // --- Scene -------------------------------------------------------------------------------

  const spread = getSpread(settled, pageCount, direction);
  const lowerVisible = spread.left !== null && spread.right !== null ? Math.min(spread.left, spread.right) : (spread.left ?? spread.right ?? 1);
  const passedFraction = pageCount > 1 ? Math.min(1, Math.max(0, (lowerVisible - 1) / (pageCount - 1))) : 0;
  const readFraction = direction === "LTR" ? passedFraction : 1 - passedFraction;
  const leftBlock = Math.max(0.0005, dims.block * readFraction);
  const rightBlock = Math.max(0.0005, dims.block * (1 - readFraction));
  const boardColor = useMemo(() => desaturate(book.spine_color, 0.15), [book.spine_color]);

  return (
    <group ref={tiltRef} rotation={[-0.1, 0, 0]}>
      {standalone ? (
        <>
          <ambientLight intensity={1.1} />
          <directionalLight position={[-1.2, 1.6, 2.4]} intensity={1.6} />
        </>
      ) : null}
      <group ref={groupRef}>

      {/* Cover boards and paper block */}
      <mesh position={[0, 0, -Math.max(leftBlock, rightBlock) - dims.board / 2 - 0.001]} raycast={() => null}>
        <boxGeometry args={[2 * W + 2 * dims.margin, H + 2 * dims.margin, dims.board]} />
        {standalone ? <meshLambertMaterial color={boardColor} /> : <meshBasicMaterial color={boardColor} toneMapped={false} />}
      </mesh>
      <mesh position={[-W / 2, 0, -leftBlock / 2 - 0.0005]} raycast={() => null}>
        <boxGeometry args={[W, H, leftBlock]} />
        {standalone ? <meshLambertMaterial color={PAGE_EDGE_COLOR} /> : <meshBasicMaterial color="#d9d2c4" toneMapped={false} />}
      </mesh>
      <mesh position={[W / 2, 0, -rightBlock / 2 - 0.0005]} raycast={() => null}>
        <boxGeometry args={[W, H, rightBlock]} />
        {standalone ? <meshLambertMaterial color={PAGE_EDGE_COLOR} /> : <meshBasicMaterial color="#d9d2c4" toneMapped={false} />}
      </mesh>

      {/* Flat pages */}
      <mesh
        geometry={geometry.left}
        material={materials.left}
        visible={view.left !== null}
        onPointerDown={onPagePointerDown("left")}
        name="page-left"
      />
      <mesh
        geometry={geometry.right}
        material={materials.right}
        visible={view.right !== null}
        onPointerDown={onPagePointerDown("right")}
        name="page-right"
      />

      {/* The turning leaf */}
      <group ref={leafRef} position={[0, 0, LEAF_LIFT]} visible={false}>
        <mesh geometry={geometry.leafFront} material={materials.leafFront} frustumCulled={false} raycast={() => null} />
        <mesh geometry={geometry.leafBack} material={materials.leafBack} frustumCulled={false} raycast={() => null} />
      </group>
      </group>
    </group>
  );
}

/** Book cloth colours are desaturated so many covers stay harmonious (docs/DESIGN.md 4). */
export function desaturate(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s * (1 - amount), hsl.l);
  return `#${color.getHexString()}`;
}

/** Counts rendered frames for the frameloop="demand" checks. */
export function FrameCounter() {
  useFrame(() => countFrame());
  return null;
}

/**
 * Keeps a spread of `width` x `height` framed with margins as the canvas resizes, centred in
 * the area between the top and bottom insets (CSS pixels kept clear for the reader controls).
 */
export function FitCamera({
  width,
  height,
  margin = 1.14,
  insets = { top: 0, bottom: 0 },
}: {
  width: number;
  height: number;
  margin?: number;
  insets?: { top: number; bottom: number };
}) {
  const { camera, size, invalidate } = useThree();
  const { top, bottom } = insets;
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const aspect = size.width / Math.max(1, size.height);
    const usable = Math.max(0.3, (size.height - top - bottom) / Math.max(1, size.height));
    const forHeight = (height * margin) / 2 / (tan * usable);
    const forWidth = (width * margin) / 2 / (tan * aspect);
    const distance = Math.max(forHeight, forWidth);
    // Shift the camera so the book's centre lands in the middle of the clear area.
    const unitsPerPixel = (2 * distance * tan) / Math.max(1, size.height);
    const shift = ((top - bottom) / 2) * unitsPerPixel;
    camera.position.set(0, shift, distance);
    camera.lookAt(0, shift, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size, width, height, margin, top, bottom, invalidate]);
  return null;
}

/** Screen space kept clear for the top bar and the bottom toolbar (CSS pixels). */
const READER_INSETS = { top: 72, bottom: 92 };

/**
 * Pixel ratio while a book is open (section 11.4). The open book is a handful of quads, so the
 * reader renders at the screen's full ratio (at most 2), and at 1.5 on standard screens
 * (supersampled text is crisper). Software rendering and the performance preset skip the
 * supersampling: there it only slows every frame down.
 */
export function readerPixelRatio(preset: GraphicsQuality): number {
  const device = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  if (preset === "performance") return Math.min(device, 1);
  if (rendersInSoftware()) return Math.min(device, 2);
  return Math.min(2, Math.max(1.5, device));
}

/** Escape closes the book unless the user is typing in a text field. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return target.type !== "range";
  return target.isContentEditable || ["TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The reader on its own canvas with its toolbar and reading session (dev route,
 * US-06 to US-08; the hall takes it over in US-12).
 */
export function ReaderStage({ book, onClose }: { book: Book; onClose: () => void }) {
  const spreadIndex = useLibraryStore((state) => state.reader.spreadIndex);
  const flipLocked = useLibraryStore((state) => state.reader.flipLocked);
  const setSpreadIndex = useLibraryStore((state) => state.setSpreadIndex);
  const upsertBook = useLibraryStore((state) => state.upsertBook);
  // The scene depends only on these fields; a new bookmark or open date keeps the same object.
  const sceneBook = useMemo(
    () => book,
    [book.id, book.page_count, book.page_width_pt, book.page_height_pt, book.reading_direction, book.spine_color],
  );

  useReadingSession(book, spreadIndex, upsertBook);

  // Esc at 100 % closes the book (while zoomed, the reader takes Esc first to reset the zoom).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTextField(event.target)) return;
      if (useLibraryStore.getState().reader.zoom > 1) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="relative h-dvh w-full overflow-hidden"
      data-testid="reader-stage"
      // Ink backdrop with a soft vignette behind the book (docs/DESIGN.md section 6); the page
      // itself is never tinted.
      style={{ background: "radial-gradient(ellipse at center, #2a2f40 0%, #1e2230 55%, #14161f 100%)" }}
    >
      <ReaderCanvas book={sceneBook} spreadIndex={spreadIndex} active={!flipLocked} onSpreadChange={setSpreadIndex} />
      <ReaderToolbar book={book} onClose={onClose} onTurn={(forward) => readerCommands.turn(forward)} />
    </div>
  );
}

/**
 * The canvas, memoized: React Three Fiber invalidates its root whenever `<Canvas>` renders, so
 * store updates that do not change the scene (a saved bookmark, the toolbar) must not reach
 * it, or the idle reader would draw frames.
 */
const ReaderCanvas = memo(function ReaderCanvas({
  book,
  spreadIndex,
  active,
  onSpreadChange,
}: {
  book: Book;
  spreadIndex: number;
  active: boolean;
  onSpreadChange: (spreadIndex: number) => void;
}) {
  const dims = bookDimensions(book);
  return (
    <Canvas
      frameloop="demand"
      flat
      dpr={readerPixelRatio("auto")}
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: 30, near: 0.05, far: 50, position: [0, 0, 4] }}
      onCreated={({ gl }) => registerRenderer(gl)}
    >
      <FrameCounter />
      <FitCamera
        width={2 * dims.width + 2 * dims.margin}
        height={dims.height + 2 * dims.margin}
        margin={1.04}
        insets={READER_INSETS}
      />
      <CurvedBookReader book={book} spreadIndex={spreadIndex} onSpreadChange={onSpreadChange} active={active} />
    </Canvas>
  );
});

// --- Inside the hall (US-12, docs/ARCHITECTURE.md section 11.6) ------------------------------

export const OPEN_MS = 700;
/** Of the 700 ms: the closed book's flight, then its cover swinging open. */
const FLY_MS = 500;
const REDUCED_MS = 200;
const TILT = -0.1;

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** The reading pose in front of the camera: the spread fills the view between the bars. */
function readingAnchor(camera: THREE.Camera, size: { width: number; height: number }, book: Book): { pose: Pose; scale: number } {
  const real = bookSize(book);
  const dims = bookDimensions(book);
  const scale = real.height / dims.height;
  const width = (2 * dims.width + 2 * dims.margin) * scale;
  const height = (dims.height + 2 * dims.margin) * scale;
  const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 55;
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const aspect = size.width / Math.max(1, size.height);
  const usable = Math.max(0.3, (size.height - READER_INSETS.top - READER_INSETS.bottom) / Math.max(1, size.height));
  const margin = 1.04;
  const distance = Math.max((height * margin) / 2 / (tan * usable), (width * margin) / 2 / (tan * aspect));
  const unitsPerPixel = (2 * distance * tan) / Math.max(1, size.height);
  const shift = ((READER_INSETS.top - READER_INSETS.bottom) / 2) * unitsPerPixel;
  camera.updateMatrixWorld();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const position = camera.position.clone().addScaledVector(forward, distance).addScaledVector(up, -shift);
  return { pose: { position, quaternion: camera.quaternion.clone() }, scale };
}

/** The closed book's pose at the reading anchor: on the half where page 1 lies, cover to us. */
function closedPoseAt(anchor: Pose, book: Book): Pose {
  const real = bookSize(book);
  const ltr = book.reading_direction === "LTR";
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), TILT);
  const frame = anchor.quaternion.clone().multiply(tilt);
  // Canonical book frame: x = front cover normal (LTR) toward the viewer, y up, z the spine.
  const x = new THREE.Vector3(0, 0, ltr ? 1 : -1);
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3().crossVectors(x, y);
  const local = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const offset = new THREE.Vector3((ltr ? 1 : -1) * (real.depth / 2), 0, -real.thickness / 2).applyQuaternion(frame);
  return { position: anchor.position.clone().add(offset), quaternion: frame.multiply(local) };
}

/**
 * The flying closed book of the transitions: a page block and a front cover hinged at the
 * spine, so it can swing open just before the spread appears.
 */
function ClosedBook({ book, groupRef, hingeRef }: { book: Book; groupRef: React.RefObject<THREE.Group | null>; hingeRef: React.RefObject<THREE.Group | null> }) {
  const size = useMemo(() => bookSize(book), [book]);
  const invalidate = useThree((state) => state.invalidate);
  const [cover, setCover] = useState<THREE.Texture | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const cached = coverTexture(book, () => {
      setLoaded(true);
      invalidate();
    });
    setCover(cached.texture);
    setLoaded(cached.loaded);
  }, [book, invalidate]);
  const placeholder = useMemo(() => coverPlaceholder(book), [book]);
  useEffect(() => () => placeholder.dispose(), [placeholder]);
  const ltr = book.reading_direction === "LTR";
  const blockMaterials = useMemo(() => {
    // The block shows paper where the front cover lifts away.
    const list = bookMaterials(book, placeholder);
    const paper = list[2]!;
    list[ltr ? 0 : 1] = paper;
    return list;
  }, [book, placeholder, ltr]);
  const coverMaterials = useMemo(() => {
    const color = clothColorOf(book.spine_color);
    return {
      outside: new THREE.MeshStandardMaterial({ map: loaded && cover ? cover : placeholder, roughness: 0.6 }),
      inside: new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
    };
  }, [book, loaded, cover, placeholder]);
  useEffect(() => () => blockMaterials.forEach((m) => m.dispose()), [blockMaterials]);
  useEffect(
    () => () => {
      coverMaterials.outside.dispose();
      coverMaterials.inside.dispose();
    },
    [coverMaterials],
  );
  const side = ltr ? 1 : -1;
  return (
    <group ref={groupRef} visible={false} name="closed-book">
      <mesh material={blockMaterials}>
        <boxGeometry args={[size.thickness * 0.9, size.height * 0.985, size.depth * 0.985]} />
      </mesh>
      {/* The front cover, hinged along the spine edge (+Z). */}
      <group ref={hingeRef} position={[side * (size.thickness / 2), 0, size.depth / 2]}>
        <mesh position={[0, 0, -size.depth / 2]} rotation={[0, side * (Math.PI / 2), 0]} material={coverMaterials.outside}>
          <planeGeometry args={[size.depth, size.height]} />
        </mesh>
        <mesh position={[-side * 0.0008, 0, -size.depth / 2]} rotation={[0, -side * (Math.PI / 2), 0]} material={coverMaterials.inside}>
          <planeGeometry args={[size.depth, size.height]} />
        </mesh>
      </group>
    </group>
  );
}

function clothColorOf(hex: string): THREE.Color {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l);
}

/** The ink vignette behind the open book, in the scene so it dims the hall but not the book. */
function createVignetteMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: { amount: { value: 0 }, solid: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float amount;
      uniform float solid;
      varying vec2 vUv;
      void main() {
        float r = length((vUv - 0.5) * vec2(1.6, 1.0));
        // Over the hall: ink at 60 % in the centre to 85 % at the edges (DESIGN.md 6).
        float alpha = mix(0.6, 0.85, smoothstep(0.15, 0.7, r)) * amount;
        // Once the hall is hidden: the reader's opaque ink backdrop.
        vec3 ink = vec3(0.118, 0.133, 0.188);
        vec3 backdrop = mix(vec3(0.165, 0.184, 0.251), mix(ink, vec3(0.078, 0.086, 0.122), smoothstep(0.35, 0.8, r)), smoothstep(0.0, 0.35, r));
        vec3 color = mix(ink, backdrop, solid);
        gl_FragColor = vec4(color, mix(alpha, 1.0, solid));
        #include <colorspace_fragment>
      }`,
  });
}

const transitionDebug: { started: number; frames: number; hold: number | null } = { started: 0, frames: 0, hold: null };

/**
 * The reader inside the hall's canvas: Open lifts the closed book from where it was to the
 * reading position, swings its cover open and hands over to the curved reader while the hall
 * recedes behind the ink vignette (700 ms); closing runs the reverse and puts the book back
 * on its shelf. The hall is hidden while the book is open.
 */
export function HallReaderScene() {
  const activeBookId = useLibraryStore((state) => state.reader.activeBookId);
  const books = useLibraryStore((state) => state.books);
  const spreadIndex = useLibraryStore((state) => state.reader.spreadIndex);
  const flipLocked = useLibraryStore((state) => state.reader.flipLocked);
  const setSpreadIndex = useLibraryStore((state) => state.setSpreadIndex);
  const phase = useReaderTransition((state) => state.phase);
  const bookId = useReaderTransition((state) => state.bookId);
  const { camera, size, invalidate } = useThree();
  const book = books.find((candidate) => candidate.id === bookId);

  const closedRef = useRef<THREE.Group>(null);
  const hingeRef = useRef<THREE.Group>(null);
  const vignetteRef = useRef<THREE.Mesh>(null);
  const vignette = useMemo(() => createVignetteMaterial(), []);
  useEffect(() => () => vignette.dispose(), [vignette]);
  const [anchor, setAnchor] = useState<{ pose: Pose; scale: number } | null>(null);
  const timeline = useRef<{ kind: "open" | "close"; start: number; duration: number; from: Pose; to: Pose } | null>(null);

  // Open: the store asks for a book; start from where it is held or stands.
  useEffect(() => {
    const state = useReaderTransition.getState();
    if (activeBookId === null || state.phase !== "closed") return;
    const opening = books.find((candidate) => candidate.id === activeBookId);
    if (!opening) return;
    const target = readingAnchor(camera, size, opening);
    const end = closedPoseAt(target.pose, opening);
    const held = takeOpenFrom();
    const source = held ?? getBookSource(opening.id, "shelf") ?? end;
    const reduced = typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    setAnchor(target);
    timeline.current = { kind: "open", start: performance.now(), duration: reduced ? REDUCED_MS : OPEN_MS, from: source, to: end };
    transitionDebug.started = performance.now();
    transitionDebug.frames = 0;
    state.set({ phase: "opening", bookId: opening.id, hallVisible: true });
    invalidate();
  }, [activeBookId]); // Starts once per open request.

  // Close: run the reverse, then put the book back on its shelf and close it in the store.
  useEffect(() => {
    if (phase !== "closing" || !book || !anchor) return;
    const end = closedPoseAt(anchor.pose, book);
    const shelf = getBookSource(book.id, "shelf") ?? end;
    const reduced = typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    timeline.current = { kind: "close", start: performance.now(), duration: reduced ? REDUCED_MS : OPEN_MS, from: end, to: shelf };
    transitionDebug.started = performance.now();
    transitionDebug.frames = 0;
    useReaderTransition.getState().set({ hallVisible: true });
    invalidate();
  }, [phase]); // Runs when closing starts.

  // A resized window keeps the open book framed.
  useEffect(() => {
    if (phase === "open" && book) setAnchor(readingAnchor(camera, size, book));
  }, [size.width, size.height]); // Only on resize.

  useEffect(() => {
    registerTestHook("readerTransition", () => ({ ...useReaderTransition.getState(), ...transitionDebug }));
    // Tests: freeze the running transition at a fraction (software rendering is too slow to
    // catch a 700 ms transition mid-way), then let it finish.
    registerTestHook("readerTransitionHold", (fraction: number | null) => {
      transitionDebug.hold = fraction;
      if (fraction === null && timeline.current) {
        timeline.current.start = performance.now() - (heldAt.current ?? 0) * timeline.current.duration;
      }
      invalidate();
    });
    return () => {
      registerTestHook("readerTransition", undefined);
      registerTestHook("readerTransitionHold", undefined);
    };
  }, [invalidate]);
  const heldAt = useRef<number | null>(null);

  useFrame(() => {
    const current = timeline.current;
    const closed = closedRef.current;
    const hinge = hingeRef.current;
    const plane = vignetteRef.current;
    if (plane && anchor) {
      // Keep the vignette just behind the book, covering the whole view.
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 55;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const distance = anchor.pose.position.clone().sub(camera.position).dot(forward) + 0.08 * anchor.scale + 0.05;
      const h = 2.4 * distance * Math.tan(THREE.MathUtils.degToRad(fov / 2));
      plane.position.copy(camera.position).addScaledVector(forward, distance);
      plane.quaternion.copy(camera.quaternion);
      plane.scale.set((h * size.width) / Math.max(1, size.height), h, 1);
    }
    if (!current || !closed || !hinge || !book) return;
    transitionDebug.frames += 1;
    let raw = Math.min(1, (performance.now() - current.start) / current.duration);
    let frozen = false;
    if (transitionDebug.hold !== null) {
      frozen = raw >= transitionDebug.hold;
      raw = Math.min(raw, transitionDebug.hold);
      heldAt.current = raw;
    }
    const fly = FLY_MS / OPEN_MS;
    const side = book.reading_direction === "LTR" ? -1 : 1;
    closed.visible = true;
    if (current.kind === "open") {
      const e = easeInOutCubic(Math.min(1, raw / fly));
      closed.position.lerpVectors(current.from.position, current.to.position, e);
      closed.quaternion.slerpQuaternions(current.from.quaternion, current.to.quaternion, e);
      hinge.rotation.y = side * Math.PI * easeInOutCubic(Math.max(0, (raw - fly) / (1 - fly)));
      vignette.uniforms.amount!.value = easeInOutCubic(raw);
      vignette.uniforms.solid!.value = 0;
      if (raw >= 1) {
        timeline.current = null;
        closed.visible = false;
        vignette.uniforms.solid!.value = 1;
        useReaderTransition.getState().set({ phase: "open", hallVisible: false });
      }
    } else {
      const swing = 1 - fly;
      hinge.rotation.y = side * Math.PI * (1 - easeInOutCubic(Math.min(1, raw / swing)));
      const e = easeInOutCubic(Math.max(0, (raw - swing) / fly));
      closed.position.lerpVectors(current.from.position, current.to.position, e);
      closed.quaternion.slerpQuaternions(current.from.quaternion, current.to.quaternion, e);
      vignette.uniforms.solid!.value = 0;
      vignette.uniforms.amount!.value = 1 - easeInOutCubic(raw);
      if (raw >= 1) {
        timeline.current = null;
        closed.visible = false;
        vignette.uniforms.amount!.value = 0;
        useReaderTransition.getState().set({ phase: "closed", bookId: null, hallVisible: true });
        useLibraryStore.getState().closeBook();
        setAnchor(null);
      }
    }
    // Held by a test: draw the frozen pose once, then rest until the hold moves.
    if (!frozen) invalidate();
  });

  if (!book || !anchor) return null;
  const showReader = phase === "open" || phase === "opening";

  return (
    <>
      <mesh ref={vignetteRef} material={vignette} renderOrder={5} frustumCulled={false} name="reader-vignette">
        <planeGeometry args={[1, 1]} />
      </mesh>
      <ClosedBook book={book} groupRef={closedRef} hingeRef={hingeRef} />
      {showReader ? (
        // Mounted during the opening (hidden) so the first pages load while the book flies.
        <group position={anchor.pose.position} quaternion={anchor.pose.quaternion} scale={anchor.scale} visible={phase === "open"}>
          <CurvedBookReader
            book={book}
            spreadIndex={spreadIndex}
            onSpreadChange={setSpreadIndex}
            active={phase === "open" && !flipLocked}
            zoomable={phase === "open"}
            standalone={false}
          />
        </group>
      ) : null}
    </>
  );
}

/** The reader's DOM layer in the hall: toolbar, bookmark session, Esc to close. */
export function HallReaderOverlay() {
  const phase = useReaderTransition((state) => state.phase);
  const bookId = useReaderTransition((state) => state.bookId);
  const book = useLibraryStore((state) => state.books.find((candidate) => candidate.id === bookId));
  if (phase !== "open" || !book) return null;
  return <HallReaderControls book={book} />;
}

function HallReaderControls({ book }: { book: Book }) {
  const spreadIndex = useLibraryStore((state) => state.reader.spreadIndex);
  const upsertBook = useLibraryStore((state) => state.upsertBook);
  const requestClose = useReaderTransition((state) => state.requestClose);
  useReadingSession(book, spreadIndex, upsertBook);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTextField(event.target)) return;
      if (useLibraryStore.getState().reader.zoom > 1) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);
  return <ReaderToolbar book={book} onClose={requestClose} onTurn={(forward) => readerCommands.turn(forward)} />;
}
