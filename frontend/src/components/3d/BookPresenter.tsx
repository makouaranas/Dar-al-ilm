"use client";

/**
 * Presenting a book (FR-09, docs/DESIGN.md sections 5 and 10.3).
 *
 * A click lifts the book off its shelf (or the desk) and turns its front cover toward the
 * camera at arm's length in 450 ms (easeInOutCubic), loading the cover image; a compact panel
 * beneath it offers Open, Edit and Delete. Esc or a click elsewhere puts it back. Walking is
 * paused while a book is presented.
 *
 * Books use one canonical frame: x is the thickness (the front cover faces +x for left-to-right
 * books and -x for right-to-left ones), y is up, z is the depth with the spine at +z.
 */

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { easeInOutCubic } from "@/components/3d/pageCurl";
import { apiUrl, type Book } from "@/lib/api";
import { canvasFont, canvasFontsReady, layoutText, scriptOf } from "@/lib/canvasText";
import { bookSize, type BookSize } from "@/lib/hallLayout";
import { t } from "@/lib/i18n";
import { spreadForPage } from "@/lib/spreads";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

export const PRESENT_MS = 450;
const REDUCED_MS = 200;
const ARM = 0.62;

// --- Sources: where each book is now ------------------------------------------------------

export interface BookSource {
  position: THREE.Vector3;
  /** Rotation of the book's canonical frame. */
  quaternion: THREE.Quaternion;
  size: BookSize;
}

const sources = new Map<number, () => BookSource>();

export function registerBookSource(bookId: number, source: () => BookSource): () => void {
  sources.set(bookId, source);
  return () => {
    if (sources.get(bookId) === source) sources.delete(bookId);
  };
}

// --- Covers --------------------------------------------------------------------------------

const covers = new Map<string, { texture: THREE.Texture; loaded: boolean; listeners: Set<() => void> }>();
const loader = new THREE.TextureLoader();

/** The cover texture for `book` (cached); `onLoad` runs when the image arrives. */
export function coverTexture(book: Book, onLoad?: () => void): { texture: THREE.Texture; loaded: boolean } {
  const url = apiUrl(book.cover_url);
  let entry = covers.get(url);
  if (!entry) {
    const listeners = new Set<() => void>();
    const texture = loader.load(url, () => {
      const current = covers.get(url);
      if (current) current.loaded = true;
      for (const listener of listeners) listener();
      listeners.clear();
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    entry = { texture, loaded: false, listeners };
    covers.set(url, entry);
    // Keep the cache small: the oldest covers are released.
    if (covers.size > 12) {
      const [oldest] = covers.keys();
      if (oldest && oldest !== url) {
        covers.get(oldest)?.texture.dispose();
        covers.delete(oldest);
      }
    }
  }
  if (!entry.loaded && onLoad) entry.listeners.add(onLoad);
  return entry;
}

/** Until the image loads: a paper card with the title set in type (DESIGN.md 12.1). */
export function coverPlaceholder(book: Book): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = Math.round(256 * (book.page_height_pt / Math.max(1, book.page_width_pt)));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#F6F5F2";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (canvasFontsReady()) {
    const script = scriptOf(book.title);
    const layout = layoutText(book.title, {
      maxWidth: canvas.width - 40,
      baseSize: 26,
      maxLines: 2,
      measure: (text, size) => {
        ctx.font = canvasFont(script, 600, size);
        return ctx.measureText(text).width;
      },
    });
    ctx.fillStyle = "#5B6070";
    ctx.textAlign = "center";
    ctx.direction = script === "arabic" ? "rtl" : "ltr";
    ctx.font = canvasFont(script, 600, layout.size);
    layout.lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height * 0.4 + i * layout.size * 1.3));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Cloth, paper and cover materials for a book box in the canonical frame. */
export function bookMaterials(book: Book, cover: THREE.Texture): THREE.Material[] {
  const color = new THREE.Color(book.spine_color);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s * 0.85, hsl.l);
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const paper = new THREE.MeshStandardMaterial({ color: "#EFE9DC", roughness: 0.85 });
  const front = new THREE.MeshStandardMaterial({ map: cover, roughness: 0.6 });
  const ltr = book.reading_direction === "LTR";
  // BoxGeometry face order: +x, -x, +y, -y, +z (spine), -z (fore-edge).
  return [ltr ? front : cloth, ltr ? cloth : front, paper, paper, cloth, paper];
}

// --- The presenter ---------------------------------------------------------------------------

type Phase = "idle" | "in" | "shown" | "out";

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const presenterDebug: { id: number | null; phase: Phase; coverLoaded: boolean } = { id: null, phase: "idle", coverLoaded: false };
registerTestHook("presenter", () => ({ ...presenterDebug }));

function reducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function BookPresenter() {
  const presentedId = useLibraryStore((state) => state.presentedBookId);
  const books = useLibraryStore((state) => state.books);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const { camera, gl, invalidate } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const timeline = useRef<{ start: number; duration: number; from: Pose; to: Pose; lift: THREE.Vector3 } | null>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);

  const book = presentedId === null ? undefined : books.find((candidate) => candidate.id === presentedId);
  const size = useMemo(() => (book ? bookSize(book) : null), [book]);

  const setPhaseBoth = (next: Phase) => {
    phaseRef.current = next;
    presenterDebug.phase = next;
    setPhase(next);
  };

  // Materials: the cover arrives asynchronously; a paper card with the title until then.
  const [cover, setCover] = useState<THREE.Texture | null>(null);
  const bookId = book?.id;
  const coverUrl = book?.cover_url;
  useEffect(() => {
    if (!book) {
      setCover(null);
      return;
    }
    const cached = coverTexture(book, () => {
      setCoverLoaded(true);
      invalidate();
    });
    setCover(cached.texture);
    setCoverLoaded(cached.loaded);
    // The cover depends only on the book and its cover URL.
  }, [bookId, coverUrl]);
  const placeholder = useMemo(() => (book ? coverPlaceholder(book) : null), [bookId, coverUrl]);
  useEffect(() => () => placeholder?.dispose(), [placeholder]);
  const list = useMemo(() => {
    if (!book || !placeholder) return null;
    return bookMaterials(book, coverLoaded && cover ? cover : placeholder);
  }, [book, placeholder, cover, coverLoaded]);
  useEffect(() => () => list?.forEach((material) => material.dispose()), [list]);
  const geometry = useMemo(() => (size ? new THREE.BoxGeometry(size.thickness, size.height, size.depth) : null), [size]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  useEffect(() => {
    presenterDebug.id = presentedId;
    presenterDebug.coverLoaded = coverLoaded;
  }, [presentedId, coverLoaded]);

  // Start presenting when a book is chosen.
  useEffect(() => {
    if (presentedId === null || !book || !size) {
      timeline.current = null;
      setPhaseBoth("idle");
      return;
    }
    const source = sources.get(presentedId)?.();
    camera.updateMatrixWorld();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const toCamera = forward.clone().negate();
    const x = book.reading_direction === "LTR" ? toCamera : forward.clone();
    const z = new THREE.Vector3().crossVectors(x, up).normalize();
    const to: Pose = {
      position: camera.position.clone().addScaledVector(forward, ARM).addScaledVector(up, -0.05),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z)),
    };
    const from: Pose = source ? { position: source.position, quaternion: source.quaternion } : to;
    // Lift out along the shelf's outward direction (the book's spine side) first.
    const lift = new THREE.Vector3(0, 0, 1).applyQuaternion(from.quaternion).multiplyScalar(0.14).add(new THREE.Vector3(0, 0.05, 0));
    timeline.current = { start: performance.now(), duration: reducedMotion() ? REDUCED_MS : PRESENT_MS, from, to, lift };
    setPhaseBoth("in");
    invalidate();
  }, [presentedId]);

  const dismiss = () => {
    const current = timeline.current;
    if (!current || phaseRef.current === "out" || phaseRef.current === "idle") return;
    const group = groupRef.current;
    const now: Pose = group ? { position: group.position.clone(), quaternion: group.quaternion.clone() } : current.to;
    timeline.current = { ...current, start: performance.now(), from: current.from, to: now };
    setPhaseBoth("out");
    invalidate();
  };

  // Esc, or a click on the canvas that misses the book, puts it back.
  useEffect(() => {
    if (presentedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      down = null;
      const group = groupRef.current;
      if (!group) return dismiss();
      const rect = gl.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.intersectObject(group, true).length === 0) dismiss();
    };
    window.addEventListener("keydown", onKey);
    gl.domElement.addEventListener("pointerdown", onDown);
    gl.domElement.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      gl.domElement.removeEventListener("pointerdown", onDown);
      gl.domElement.removeEventListener("pointerup", onUp);
    };
  }, [presentedId, camera, gl]);

  useFrame(() => {
    const group = groupRef.current;
    const current = timeline.current;
    if (!group || !current) return;
    const phaseNow = phaseRef.current;
    if (phaseNow !== "in" && phaseNow !== "out") return;
    const raw = Math.min(1, (performance.now() - current.start) / current.duration);
    const e = easeInOutCubic(raw);
    // "in": shelf -> camera; "out": current pose -> shelf (from is always the shelf).
    const [a, b] = phaseNow === "in" ? [current.from, current.to] : [current.to, current.from];
    group.position.lerpVectors(a.position, b.position, e).addScaledVector(current.lift, Math.sin(Math.PI * e));
    group.quaternion.slerpQuaternions(a.quaternion, b.quaternion, e);
    if (raw >= 1) {
      if (phaseNow === "in") setPhaseBoth("shown");
      else {
        setPhaseBoth("idle");
        timeline.current = null;
        useLibraryStore.getState().presentBook(null);
      }
    }
    invalidate();
  });

  if (!book || !size || !geometry || !list || phase === "idle") return null;

  const pages = t("count.pages", { count: book.page_count }, language);
  const onOpen = () => {
    const state = useLibraryStore.getState();
    state.presentBook(null);
    state.openBook(book.id, spreadForPage(book.last_read_page, book.page_count));
  };

  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} material={list} name="presented-book" />
      {phase === "shown" ? (
        <Html position={[0, -size.height / 2 - 0.025, 0]} center={false} zIndexRange={[40, 0]} style={{ transform: "translate(-50%, 0)" }}>
          <div
            className="panel flex w-64 flex-col gap-2 rounded-panel p-4 text-ink"
            data-testid="present-panel"
            onKeyDown={(event) => {
              if (event.key === "Escape") dismiss();
            }}
          >
            <div className="flex flex-col gap-0.5">
              <p className="text-16 leading-snug font-semibold" dir="auto">
                {book.title}
              </p>
              {book.author ? (
                <p className="text-14 text-slate" dir="auto">
                  {book.author}
                </p>
              ) : null}
              <p className="tabular text-12 text-slate">{pages}</p>
            </div>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                autoFocus
                data-testid="present-open"
                onClick={onOpen}
                className="h-10 flex-1 rounded-control bg-lapis px-3 text-14 font-medium text-white transition-colors duration-(--motion-fast) ease-out hover:bg-[#3a5aab]"
              >
                {t("present.open", {}, language)}
              </button>
              <button
                type="button"
                data-testid="present-edit"
                onClick={() => useLibraryStore.getState().openEditBook(book.id)}
                className="h-10 rounded-control border border-limestone px-3 text-14 font-medium text-ink transition-colors duration-(--motion-fast) ease-out hover:border-slate/40"
              >
                {t("present.edit", {}, language)}
              </button>
              <button
                type="button"
                data-testid="present-delete"
                onClick={() => useLibraryStore.getState().openDeleteBook(book.id)}
                className="h-10 rounded-control border border-limestone px-3 text-14 font-medium text-rubric transition-colors duration-(--motion-fast) ease-out hover:border-rubric/40"
              >
                {t("present.delete", {}, language)}
              </button>
            </div>
          </div>
        </Html>
      ) : null}
    </group>
  );
}
