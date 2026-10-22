"use client";

/**
 * The Entrance Desk's Currently Reading stands (FR-11, docs/DESIGN.md sections 2, 12.2, 14).
 *
 * The three most recently opened books stand on the desk's angled stands with their covers
 * toward the entrance, 1st (latest), 2nd and 3rd from the UI's start side: left in English,
 * right in Arabic. Empty stands show an embossed 1, 2 or 3; with no books the desk's front
 * reads "Books you open will appear here." Clicking a desk book presents it.
 */

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

import { coverPlaceholder, coverTexture, registerBookSource, setPresentOrigin } from "@/components/3d/BookPresenter";
import { Hardcover } from "@/components/3d/Hardcover";
import { useReaderTransition } from "@/components/3d/readerTransition";
import { registerBookCenter } from "@/components/3d/BookSpine";
import type { Book } from "@/lib/api";
import { canvasFont, canvasFontsReady, ensureCanvasFonts, layoutText, scriptOf } from "@/lib/canvasText";
import { DESK, bookSize } from "@/lib/hallLayout";
import { t } from "@/lib/i18n";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

/** The stands: x offsets on the desk, the plates' backward lean and their size. */
export const DESK_STANDS = {
  offsets: [-0.58, 0, 0.58],
  lean: 0.28,
  plate: { width: 0.3, height: 0.34, thickness: 0.014 },
  /** z of the plate's bottom edge and of the brass lip in front of it. */
  plateZ: DESK.z - 0.02,
  lipZ: DESK.z - 0.05,
} as const;

/** The plate's centre (its bottom edge rests on the desk at `plateZ`). */
export function standPlateCenter(offset: number): THREE.Vector3 {
  const { lean, plate } = DESK_STANDS;
  return new THREE.Vector3(
    DESK.x + offset,
    DESK.height + (plate.height / 2) * Math.cos(lean),
    DESK_STANDS.plateZ + (plate.height / 2) * Math.sin(lean),
  );
}

const plateUp = () => new THREE.Vector3(0, Math.cos(DESK_STANDS.lean), Math.sin(DESK_STANDS.lean));
/** The plate's front normal: toward the entrance, tilted up. */
const plateFront = () => new THREE.Vector3(0, Math.sin(DESK_STANDS.lean), -Math.cos(DESK_STANDS.lean));

const deskDebug: { slots: { position: number; bookId: number | null; x: number }[]; emptyLine: boolean } = { slots: [], emptyLine: false };
registerTestHook("desk", () => structuredClone(deskDebug));

/** Pose of a book resting on a stand, in the canonical book frame (see BookPresenter). */
function standPose(offset: number, book: Book) {
  const size = bookSize(book);
  const up = plateUp();
  const front = plateFront();
  const bottom = standPlateCenter(offset).addScaledVector(up, -DESK_STANDS.plate.height / 2);
  const position = bottom
    .addScaledVector(up, size.height / 2 + 0.012)
    .addScaledVector(front, DESK_STANDS.plate.thickness / 2 + size.thickness / 2 + 0.001);
  // The front cover faces the entrance: +x (left to right) or -x (right to left).
  const x = book.reading_direction === "LTR" ? front : front.clone().negate();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z));
  return { position, quaternion, size };
}

function DeskBook({ book, offset }: { book: Book; offset: number }) {
  const presentedId = useLibraryStore((state) => state.presentedBookId);
  const reading = useReaderTransition((state) => (state.phase !== "closed" ? state.bookId : null));
  const { gl, invalidate } = useThree();
  const pose = useMemo(() => standPose(offset, book), [offset, book]);
  const [loaded, setLoaded] = useState(false);
  const [cover, setCover] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    const cached = coverTexture(book, () => {
      setLoaded(true);
      invalidate();
    });
    setCover(cached.texture);
    setLoaded(cached.loaded);
    // The cover depends only on the book and its cover URL.
  }, [book.id, book.cover_url, invalidate]);
  const placeholder = useMemo(() => coverPlaceholder(book), [book]);
  useEffect(() => () => placeholder.dispose(), [placeholder]);

  useEffect(() => {
    const unregisterSource = registerBookSource(
      book.id,
      () => ({ position: pose.position.clone(), quaternion: pose.quaternion.clone(), size: pose.size }),
      "desk",
    );
    const unregisterCenter = registerBookCenter(book.id, () => pose.position.clone(), "desk");
    return () => {
      unregisterSource();
      unregisterCenter();
    };
  }, [book.id, pose]);
  useEffect(() => invalidate(), [presentedId, reading, invalidate]);

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4 || useLibraryStore.getState().presentedBookId !== null || useReaderTransition.getState().phase !== "closed") return;
    event.stopPropagation();
    setPresentOrigin("desk");
    useLibraryStore.getState().presentBook(book.id);
  };

  return (
    <group
      position={pose.position}
      quaternion={pose.quaternion}
      visible={presentedId !== book.id && reading !== book.id}
      onClick={onClick}
      onPointerOver={(event) => {
        event.stopPropagation();
        gl.domElement.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        gl.domElement.style.cursor = "";
      }}
      name={`desk-book-${book.id}`}
    >
      <Hardcover book={book} cover={loaded && cover ? cover : placeholder} />
    </group>
  );
}

/** Embossed 1, 2, 3 on empty stands; one canvas for all three numerals. */
function useNumerals(ready: boolean) {
  return useMemo(() => {
    if (!ready) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#C8B699";
    ctx.fillRect(0, 0, 384, 128);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = canvasFont("latin", 600, 84);
    for (let i = 0; i < 3; i += 1) {
      const x = 64 + i * 128;
      // Embossed: a light edge up-left, a shadow down-right, then the face.
      ctx.fillStyle = "rgba(255, 248, 232, 0.55)";
      ctx.fillText(String(i + 1), x - 1.5, 66 - 1.5);
      ctx.fillStyle = "rgba(70, 52, 30, 0.45)";
      ctx.fillText(String(i + 1), x + 1.5, 66 + 1.5);
      ctx.fillStyle = "#C2AE8E";
      ctx.fillText(String(i + 1), x, 66);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [ready]);
}

function EmptyLine({ language, ready }: { language: "en" | "ar"; ready: boolean }) {
  const texture = useMemo(() => {
    if (!ready) return null;
    const text = t("desk.empty", {}, language);
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    const script = scriptOf(text);
    const layout = layoutText(text, {
      maxWidth: 980,
      baseSize: 44,
      maxLines: 1,
      measure: (value, size) => {
        ctx.font = canvasFont(script, script === "arabic" ? 600 : 500, size);
        return ctx.measureText(value).width;
      },
    });
    ctx.font = canvasFont(script, script === "arabic" ? 600 : 500, layout.size);
    ctx.direction = script === "arabic" ? "rtl" : "ltr";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 248, 232, 0.5)";
    ctx.fillText(layout.lines[0] ?? text, 512, 50);
    ctx.fillStyle = "#3a3026";
    ctx.fillText(layout.lines[0] ?? text, 512, 48.5);
    const result = new THREE.CanvasTexture(canvas);
    result.colorSpace = THREE.SRGBColorSpace;
    result.anisotropy = 8;
    return result;
  }, [language, ready]);
  useEffect(() => () => texture?.dispose(), [texture]);
  if (!texture) return null;
  return (
    <mesh position={[DESK.x, 0.62, DESK.z - DESK.depth / 2 - 0.002]} rotation={[0, Math.PI, 0]} name="desk-empty-line">
      <planeGeometry args={[1.5, 0.14]} />
      <meshStandardMaterial map={texture} transparent roughness={0.6} />
    </mesh>
  );
}

export function EntranceDesk() {
  const currentlyReading = useLibraryStore((state) => state.currentlyReading);
  const books = useLibraryStore((state) => state.books);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const [ready, setReady] = useState(canvasFontsReady());
  useEffect(() => {
    if (!ready) void ensureCanvasFonts().then(() => setReady(true));
  }, [ready]);
  const numerals = useNumerals(ready);
  useEffect(() => () => numerals?.dispose(), [numerals]);

  const deskBooks = currentlyReading
    .slice(0, 3)
    .map((id) => books.find((book) => book.id === id))
    .filter((book): book is Book => book !== undefined);
  // From the entrance (looking +Z), the viewer's left is +X. English starts at the left.
  const offsets = language === "ar" ? [...DESK_STANDS.offsets] : [...DESK_STANDS.offsets].reverse();

  useEffect(() => {
    deskDebug.slots = offsets.map((offset, i) => ({ position: i + 1, bookId: deskBooks[i]?.id ?? null, x: DESK.x + offset }));
    deskDebug.emptyLine = deskBooks.length === 0;
  });

  const numeralGeometry = useMemo(() => {
    // One quad per empty stand, each showing its numeral's third of the canvas.
    const parts: THREE.BufferGeometry[] = [];
    offsets.forEach((offset, i) => {
      if (deskBooks[i]) return;
      const quad = new THREE.PlaneGeometry(0.12, 0.12);
      const uv = quad.getAttribute("uv") as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k += 1) uv.setX(k, (i + uv.getX(k)) / 3);
      const front = plateFront();
      const center = standPlateCenter(offset).addScaledVector(front, DESK_STANDS.plate.thickness / 2 + 0.0015).addScaledVector(plateUp(), 0.04);
      quad.applyMatrix4(new THREE.Matrix4().makeBasis(front.clone().cross(plateUp()).negate(), plateUp(), front));
      quad.translate(center.x, center.y, center.z);
      parts.push(quad);
    });
    if (parts.length === 0) return null;
    const merged = new THREE.BufferGeometry();
    const positions: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];
    for (const part of parts) {
      const flat = part.toNonIndexed();
      positions.push(...(flat.getAttribute("position").array as Float32Array));
      uvs.push(...(flat.getAttribute("uv").array as Float32Array));
      normals.push(...(flat.getAttribute("normal").array as Float32Array));
      flat.dispose();
      part.dispose();
    }
    merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    return merged;
    // Rebuilt when the desk's books or the UI language (stand order) change.
  }, [deskBooks.map((book) => book.id).join(","), language]);
  useEffect(() => () => numeralGeometry?.dispose(), [numeralGeometry]);

  return (
    <group name="entrance-desk">
      {deskBooks.map((book, i) => (
        <DeskBook key={book.id} book={book} offset={offsets[i]!} />
      ))}
      {numeralGeometry && numerals ? (
        <mesh geometry={numeralGeometry} name="desk-numerals">
          <meshStandardMaterial map={numerals} roughness={0.6} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      ) : null}
      {deskBooks.length === 0 ? <EmptyLine language={language} ready={ready} /> : null}
    </group>
  );
}
