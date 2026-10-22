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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { pageUrl, type Book } from "@/lib/api";
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
  /** Keyboard and pointer input (false while zoomed or behind a modal). */
  active: boolean;
}

export function CurvedBookReader({ book, spreadIndex, onSpreadChange, active }: CurvedBookReaderProps) {
  const direction: ReadingDirection = book.reading_direction;
  const pageCount = book.page_count;
  const dims = useMemo(() => bookDimensions(book), [book]);
  const { width: W, height: H } = dims;

  const { camera, gl, invalidate } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const leafRef = useRef<THREE.Group>(null);

  const displayed = useRef(clampSpread(spreadIndex, pageCount));
  const queue = useRef<number[]>([]);
  const flip = useRef<Flip | null>(null);
  const drag = useRef<Drag | null>(null);
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

  // GPU window: the pages on screen plus the previous and next spreads; RAM prefetch: the
  // low images of the next spreads in reading order.
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
    pool.setWindow({ visible, neighbours, prefetch, settled: !turning });
  }, [pool, view, settled, turning, pageCount, direction]);

  // Which surface shows which page, and running low -> high cross-fades (page -> start time).
  const fades = useRef(new Map<number, number>());
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
      if (page !== null && textures.low && textures.high) {
        if (!fades.current.has(page)) fades.current.set(page, now);
        uniforms.mapA!.value = textures.low;
        uniforms.mapB!.value = textures.high;
        uniforms.hasA!.value = 1;
        uniforms.hasB!.value = 1;
      } else {
        const texture = textures.high ?? textures.low ?? null;
        uniforms.mapA!.value = texture;
        uniforms.hasA!.value = texture ? 1 : 0;
        uniforms.hasB!.value = 0;
        uniforms.mixB!.value = 0;
        if (page !== null) fades.current.delete(page);
      }
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
      if (leafRef.current) {
        leafRef.current.scale.x = right ? 1 : -1;
        leafRef.current.visible = true;
      }
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
      setView(viewOf(getSpread(landed, pageCount, direction)));
      setSettled(landed);
      if (completed) onSpreadChange(landed);
      invalidate();
    },
    [pageCount, direction, onSpreadChange, invalidate],
  );

  const requestTurn = useCallback(
    (forward: boolean) => {
      const base = queue.current.at(-1) ?? flip.current?.to ?? displayed.current;
      const next = base + (forward ? 1 : -1);
      if (next < 0 || next >= spreadCount(pageCount)) return;
      queue.current.push(next);
      invalidate();
    },
    [pageCount, invalidate],
  );

  // Jumps from outside (jump-to-page arrives in US-08): show the new spread directly.
  useEffect(() => {
    const target = clampSpread(spreadIndex, pageCount);
    if (flip.current || queue.current.length || target === displayed.current) return;
    displayed.current = target;
    setView(viewOf(getSpread(target, pageCount, direction)));
    setSettled(target);
  }, [spreadIndex, pageCount, direction]);

  // Book changes reset everything.
  useEffect(() => {
    queue.current = [];
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
    if (!flip.current && queue.current.length > 0) {
      const to = queue.current.shift()!;
      startFlip(to, "auto", queue.current.length > 0 ? QUEUED_FLIP_MS : FLIP_MS);
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
    if (flip.current?.mode === "auto" || queue.current.length > 0 || fades.current.size > 0) invalidate();
  });

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
        visible: [view.left, view.right, view.leafStart, view.leafEnd].filter((page): page is number => page !== null),
      };
    });
    return () => registerReader(null);
  }, [pool, view]);

  // --- Scene -------------------------------------------------------------------------------

  const spread = getSpread(settled, pageCount, direction);
  const lowerVisible = spread.left !== null && spread.right !== null ? Math.min(spread.left, spread.right) : (spread.left ?? spread.right ?? 1);
  const passedFraction = pageCount > 1 ? Math.min(1, Math.max(0, (lowerVisible - 1) / (pageCount - 1))) : 0;
  const readFraction = direction === "LTR" ? passedFraction : 1 - passedFraction;
  const leftBlock = Math.max(0.0005, dims.block * readFraction);
  const rightBlock = Math.max(0.0005, dims.block * (1 - readFraction));
  const boardColor = useMemo(() => desaturate(book.spine_color, 0.15), [book.spine_color]);

  return (
    <group ref={groupRef} rotation={[-0.1, 0, 0]}>
      <ambientLight intensity={1.1} />
      <directionalLight position={[-1.2, 1.6, 2.4]} intensity={1.6} />

      {/* Cover boards and paper block */}
      <mesh position={[0, 0, -Math.max(leftBlock, rightBlock) - dims.board / 2 - 0.001]} raycast={() => null}>
        <boxGeometry args={[2 * W + 2 * dims.margin, H + 2 * dims.margin, dims.board]} />
        <meshLambertMaterial color={boardColor} />
      </mesh>
      <mesh position={[-W / 2, 0, -leftBlock / 2 - 0.0005]} raycast={() => null}>
        <boxGeometry args={[W, H, leftBlock]} />
        <meshLambertMaterial color={PAGE_EDGE_COLOR} />
      </mesh>
      <mesh position={[W / 2, 0, -rightBlock / 2 - 0.0005]} raycast={() => null}>
        <boxGeometry args={[W, H, rightBlock]} />
        <meshLambertMaterial color={PAGE_EDGE_COLOR} />
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

/** Keeps a spread of `width` x `height` framed with margins as the canvas resizes. */
export function FitCamera({ width, height, margin = 1.14 }: { width: number; height: number; margin?: number }) {
  const { camera, size, invalidate } = useThree();
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const aspect = size.width / Math.max(1, size.height);
    const forHeight = ((height * margin) / 2) / Math.tan(halfFov);
    const forWidth = ((width * margin) / 2) / (Math.tan(halfFov) * aspect);
    camera.position.set(0, 0, Math.max(forHeight, forWidth));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size, width, height, margin, invalidate]);
  return null;
}

/** A canvas showing only the reader (dev route, US-06 to US-08). */
export function ReaderStage({ book }: { book: Book }) {
  const spreadIndex = useLibraryStore((state) => state.reader.spreadIndex);
  const flipLocked = useLibraryStore((state) => state.reader.flipLocked);
  const setSpreadIndex = useLibraryStore((state) => state.setSpreadIndex);
  const dims = bookDimensions(book);

  return (
    <div
      className="relative h-dvh w-full"
      data-testid="reader-stage"
      // Ink backdrop with a soft vignette behind the book (docs/DESIGN.md section 6); the page
      // itself is never tinted.
      style={{ background: "radial-gradient(ellipse at center, #2a2f40 0%, #1e2230 55%, #14161f 100%)" }}
    >
      <Canvas
        frameloop="demand"
        flat
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ fov: 30, near: 0.05, far: 50, position: [0, 0, 4] }}
        onCreated={({ gl }) => registerRenderer(gl)}
      >
        <FrameCounter />
        <FitCamera width={2 * dims.width + 2 * dims.margin} height={dims.height + 2 * dims.margin} />
        <CurvedBookReader book={book} spreadIndex={spreadIndex} onSpreadChange={setSpreadIndex} active={!flipLocked} />
      </Canvas>
    </div>
  );
}
