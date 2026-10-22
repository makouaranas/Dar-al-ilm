"use client";

/**
 * Bookcases and the books on them (docs/ARCHITECTURE.md sections 9.2-9.3, docs/DESIGN.md 2).
 *
 * Light ash carcasses with a walnut edge on every shelf and a small mashrabiya insert on each
 * end panel; their static geometry is merged into the hall (`bookcaseParts`). The books of a
 * bookcase are one instanced mesh, placed from their shelf numbers and slots: shelf `n` is on
 * bookcase `n // 5`, tier `[3, 2, 4, 1, 0][n % 5]`. An empty category shows a ghost "Add book"
 * slot at eye level.
 */

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { Book } from "@/lib/api";
import { canvasFontsReady, drawLabel, ensureCanvasFonts } from "@/lib/canvasText";
import { BOOKCASE, SHELF_HEIGHTS, SHELF_FRONT_Z, TIER_ORDER, placeBooks, type BayLayout, type BookcaseLayout } from "@/lib/hallLayout";
import { t } from "@/lib/i18n";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

// --- Carcass (merged into the hall) ---------------------------------------------------------

/** World-UV box (metres / uvScale), placed in a bookcase's frame then in the world. */
function part(w: number, h: number, d: number, x: number, y: number, z: number, uvScale = 1): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const faces: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i += 1) {
    const [fu, fv] = faces[Math.floor(i / 4)]!;
    uv.setXY(i, (uv.getX(i) * fu) / uvScale, (uv.getY(i) * fv) / uvScale);
  }
  geometry.translate(x, y, z);
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  return flat;
}

const SIDE = 0.03;

/**
 * The static parts of one bookcase in world space, by material: ash (sides, top, back,
 * shelves), walnut (plinth and shelf edges) and the mashrabiya end-panel inserts.
 */
export function bookcaseParts(bookcase: Pick<BookcaseLayout, "x" | "z" | "rotationY">): {
  ash: THREE.BufferGeometry[];
  walnut: THREE.BufferGeometry[];
  lattice: THREE.BufferGeometry[];
} {
  const { length: L, depth: D, height: H } = BOOKCASE;
  const ash = [
    part(SIDE, H, D, -L / 2 + SIDE / 2, H / 2, 0),
    part(SIDE, H, D, L / 2 - SIDE / 2, H / 2, 0),
    part(L, 0.04, D, 0, H - 0.02, 0),
    part(L - 2 * SIDE, H - 0.12, 0.012, 0, 0.1 + (H - 0.12) / 2, -D / 2 + 0.006),
  ];
  const walnut = [part(L - 2 * SIDE - 0.02, 0.1, D - 0.06, 0, 0.05, -0.02)];
  for (const top of SHELF_HEIGHTS) {
    ash.push(part(L - 2 * SIDE, 0.025, BOOKCASE.shelfDepth, 0, top - 0.0125, -0.01));
    walnut.push(part(L - 2 * SIDE, 0.03, 0.014, 0, top - 0.015, SHELF_FRONT_Z + 0.007));
  }
  // A slim mashrabiya insert on the outside of each end panel, framed in walnut.
  const lattice: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const insert = new THREE.PlaneGeometry(0.2, 1.3);
    const uv = insert.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * 0.2) / 0.33, (uv.getY(i) * 1.3) / 0.33);
    insert.rotateY((side * Math.PI) / 2);
    insert.translate(side * (L / 2 + 0.0015), 1.3, 0);
    lattice.push(insert.toNonIndexed());
    insert.dispose();
    walnut.push(
      part(0.006, 0.02, 0.24, side * (L / 2 + 0.003), 1.3 + 0.66, 0),
      part(0.006, 0.02, 0.24, side * (L / 2 + 0.003), 1.3 - 0.66, 0),
      part(0.006, 1.34, 0.02, side * (L / 2 + 0.003), 1.3, 0.11),
      part(0.006, 1.34, 0.02, side * (L / 2 + 0.003), 1.3, -0.11),
    );
  }
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(bookcase.x, 0, bookcase.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bookcase.rotationY),
    new THREE.Vector3(1, 1, 1),
  );
  for (const geometry of [...ash, ...walnut, ...lattice]) geometry.applyMatrix4(matrix);
  return { ash, walnut, lattice };
}

// --- Books ----------------------------------------------------------------------------------

/** Book cloth colours are desaturated 15 % so many covers stay harmonious (DESIGN.md 4). */
export function clothColor(hex: string): THREE.Color {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l);
}

export interface ShelfBookDebug {
  id: number;
  shelf: number;
  slot: number;
  bookcase: number;
  tier: number;
  /** World-space box of the book. */
  min: [number, number, number];
  max: [number, number, number];
}

const shelfDebug = new Map<number, { categoryId: number; bookcases: number; ghost: boolean; books: ShelfBookDebug[] }>();
registerTestHook("shelves", () => [...shelfDebug.values()]);

const BOOKS_PER_CASE = 150;
const bookGeometry = new THREE.BoxGeometry(1, 1, 1);
const bookMaterial = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });

function worldBox(bookcase: BookcaseLayout, x: number, y: number, z: number, w: number, h: number, d: number) {
  const cos = Math.cos(bookcase.rotationY);
  const sin = Math.sin(bookcase.rotationY);
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [x + (sx * w) / 2, z + (sz * d) / 2] as const));
  const xs = corners.map(([cx, cz]) => bookcase.x + cx * cos + cz * sin);
  const zs = corners.map(([cx, cz]) => bookcase.z - cx * sin + cz * cos);
  return {
    min: [Math.min(...xs), y - h / 2, Math.min(...zs)] as [number, number, number],
    max: [Math.max(...xs), y + h / 2, Math.max(...zs)] as [number, number, number],
  };
}

/** One bookcase's books as a single instanced mesh. */
function BookcaseBooks({ bookcase, entries }: { bookcase: BookcaseLayout; entries: { book: Book; x: number; y: number; z: number; w: number; h: number; d: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    entries.forEach((entry, i) => {
      position.set(entry.x, entry.y, entry.z);
      scale.set(entry.w, entry.h, entry.d);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      mesh.setColorAt(i, clothColor(entry.book.spine_color));
    });
    mesh.count = entries.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [entries, invalidate]);

  return (
    <group position={[bookcase.x, 0, bookcase.z]} rotation={[0, bookcase.rotationY, 0]}>
      {/* Capacity: a full bookcase (5 shelves of 30); `count` is the books actually there. */}
      <instancedMesh ref={ref} args={[bookGeometry, bookMaterial, BOOKS_PER_CASE]} frustumCulled />
    </group>
  );
}

/** The ghost "Add book" slot of an empty category: a translucent book and a label. */
function GhostSlot({ categoryId, bookcase }: { categoryId: number; bookcase: BookcaseLayout }) {
  const language = useLibraryStore((state) => state.settings.ui_language);
  const openAddBook = useLibraryStore((state) => state.openAddBook);
  const { gl, invalidate } = useThree();
  const [hovered, setHovered] = useState(false);
  const [ready, setReady] = useState(canvasFontsReady());
  useEffect(() => {
    if (!ready) void ensureCanvasFonts().then(() => setReady(true));
  }, [ready]);
  const texture = useMemo(() => {
    if (!ready) return null;
    const canvas = document.createElement("canvas");
    drawLabel(canvas, t("shelf.addBook", {}, language));
    const result = new THREE.CanvasTexture(canvas);
    result.colorSpace = THREE.SRGBColorSpace;
    result.anisotropy = 4;
    return result;
  }, [ready, language]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useEffect(() => invalidate(), [texture, hovered, invalidate]);

  const tier = TIER_ORDER[0];
  const shelfTop = SHELF_HEIGHTS[tier];
  const onClick = (event: ThreeEvent<MouseEvent>) => {
    // A drag to look around is not a click.
    if (event.delta > 4) return;
    event.stopPropagation();
    openAddBook(categoryId);
  };
  const over = (value: boolean) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(value);
    gl.domElement.style.cursor = value ? "pointer" : "";
  };

  return (
    <group position={[bookcase.x, 0, bookcase.z]} rotation={[0, bookcase.rotationY, 0]}>
      <mesh
        position={[-0.9, shelfTop + 0.15, SHELF_FRONT_Z - 0.01 - 0.11]}
        onClick={onClick}
        onPointerOver={over(true)}
        onPointerOut={over(false)}
        name="ghost-book"
      >
        <boxGeometry args={[0.035, 0.3, 0.22]} />
        <meshStandardMaterial color="#2C4C9C" transparent opacity={hovered ? 0.45 : 0.22} depthWrite={false} roughness={0.6} />
      </mesh>
      {texture ? (
        <mesh
          position={[-0.45, shelfTop + 0.12, SHELF_FRONT_Z + 0.004]}
          onClick={onClick}
          onPointerOver={over(true)}
          onPointerOut={over(false)}
          name="ghost-label"
        >
          <planeGeometry args={[0.6, 0.15]} />
          <meshBasicMaterial map={texture} transparent toneMapped={false} opacity={hovered ? 1 : 0.9} />
        </mesh>
      ) : null}
    </group>
  );
}

/** All bookcases of one bay with their books (or the ghost slot when the category is empty). */
export function CategoryShelves({ bay, books }: { bay: BayLayout; books: Book[] }) {
  const categoryId = bay.categoryId!;
  const byBookcase = useMemo(() => {
    const { placements } = placeBooks(books);
    const groups = new Map<number, { book: Book; x: number; y: number; z: number; w: number; h: number; d: number }[]>();
    for (const book of books) {
      const p = placements.get(book)!;
      const list = groups.get(p.bookcase) ?? [];
      list.push({ book, x: p.x, y: p.y, z: p.z, w: p.thickness, h: p.height, d: p.depth });
      groups.set(p.bookcase, list);
    }
    return groups;
  }, [books]);

  useEffect(() => {
    const debug: ShelfBookDebug[] = [];
    for (const [index, entries] of byBookcase) {
      const bookcase = bay.bookcases[index];
      if (!bookcase) continue;
      for (const entry of entries) {
        const box = worldBox(bookcase, entry.x, entry.y, entry.z, entry.w, entry.h, entry.d);
        debug.push({
          id: entry.book.id,
          shelf: entry.book.shelf_number,
          slot: entry.book.slot_index,
          bookcase: index,
          tier: TIER_ORDER[entry.book.shelf_number % 5]!,
          ...box,
        });
      }
    }
    shelfDebug.set(categoryId, { categoryId, bookcases: bay.bookcases.length, ghost: books.length === 0, books: debug });
    return () => {
      shelfDebug.delete(categoryId);
    };
  }, [byBookcase, bay, categoryId, books.length]);

  return (
    <>
      {bay.bookcases.map((bookcase) => {
        const entries = byBookcase.get(bookcase.index) ?? [];
        return entries.length > 0 ? <BookcaseBooks key={bookcase.index} bookcase={bookcase} entries={entries} /> : null;
      })}
      {books.length === 0 && bay.bookcases[0] ? <GhostSlot categoryId={categoryId} bookcase={bay.bookcases[0]} /> : null}
    </>
  );
}
