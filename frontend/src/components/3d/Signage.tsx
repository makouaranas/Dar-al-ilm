"use client";

/**
 * Signage in three levels (US-20, docs/DESIGN.md section 2, docs/ARCHITECTURE.md 9.4 and 10.7).
 *
 * 1. Section headers: each bay's category name in dark bronze cut letters on the plaster band
 *    above the arcade beam, over the bay's opening, grazed by warm light from a slim brass trough
 *    on the beam (an additive wash merged into the hall; no real-time light per sign).
 * 2. Range plates: a brass plate at eye level on the end of each bookcase that faces the nave,
 *    with the category name and its book count.
 * 3. The directory: a limestone stele by the entrance path with an engraved brass panel, the
 *    bays to the reader's left and right in two columns. Hovering a line lights it gilt; a
 *    click flies to that bay's opening.
 *
 * Every sign is drawn on a 2D canvas once the fonts have loaded (docs/ARCHITECTURE.md 10.7) and
 * uploaded as a single-channel mask; the material gives the metal. Static parts (troughs,
 * plate bodies, the stele) are merged into the hall's geometry, so each bay adds two draw calls
 * (its header and its plates).
 */

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { playerCommands } from "@/components/3d/PlayerControls";
import type { Category } from "@/lib/api";
import {
  SIGN,
  canvasFontsReady,
  directoryRows,
  directorySize,
  drawDirectoryMask,
  drawHeaderMask,
  drawPlateMask,
  ensureCanvasFonts,
  planDirectory,
  type DirectoryEntry,
  type DirectoryLine,
  type SignText,
} from "@/lib/canvasText";
import { ARCADE, DIRECTORY, HALL, type BayLayout, type HallLayout } from "@/lib/hallLayout";
import { t, type Language } from "@/lib/i18n";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

// --- Placement --------------------------------------------------------------------------------

/** The header's centre: on the plaster band between the beam and the clerestory windows. */
export const HEADER = { y: 3.78, standOff: 0.012 } as const;
/** The range plates: centre height, and their brass body's thickness on the end panel. */
export const PLATE = { y: 1.5, thickness: 0.006 } as const;
/** The directory panel on the stele's front: the height of its top edge (it grows down). */
const DIRECTORY_PANEL_TOP = 1.5;
const STELE_DEPTH = 0.13;

const BRONZE = "#3a2e22";
const ENGRAVING = "#2b2116";
const GILT = "#D8B77A";

type Geometry = THREE.BufferGeometry;

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): Geometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  return flat;
}

/** The bookcases whose end faces the nave: the first one on each wall of the bay. */
function naveFacingBookcases(bay: BayLayout) {
  return bay.bookcases.filter((bookcase) => bookcase.index < 2);
}

/** The x of a bay's first bookcases' nave-facing end panel. */
function bookcaseEndX(bay: BayLayout): number {
  return bay.side * (HALL.bayStartX + HALL.bayFront);
}

/** The directory panel's size for the bays in `layout`, and the height of its centre. */
function directoryPanel(layout: HallLayout) {
  const named = layout.bays.filter((bay) => bay.categoryId !== null);
  const size = directorySize(directoryRows(named.filter((bay) => bay.side > 0).length, named.filter((bay) => bay.side < 0).length));
  return { ...size, centerY: DIRECTORY_PANEL_TOP - size.height / 2 };
}

/** The stele's frame: turned to face the entrance, standing on the floor at its position. */
function steleMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(DIRECTORY.x, 0, DIRECTORY.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), DIRECTORY.rotationY),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * The static parts of the signs, in world space and by material, for the hall to merge: brass
 * troughs on the beam, the plates' brass bodies, the stele in limestone with its brass cap and
 * panel; and the troughs' warm light on the band (plain quads the hall turns into washes).
 */
export function signageParts(layout: HallLayout): { brass: Geometry[]; plates: Geometry[]; limestone: Geometry[]; washes: Geometry[] } {
  const brass: Geometry[] = [];
  const plates: Geometry[] = [];
  const limestone: Geometry[] = [];
  const washes: Geometry[] = [];
  for (const bay of layout.bays) {
    if (bay.categoryId === null) continue;
    const s = bay.side;
    // A slim brass trough resting on the beam's ledge in front of the band (it hides the light).
    brass.push(boxAt(0.06, 0.05, SIGN.header.width + 0.3, s * (HALL.bayStartX - 0.045), ARCADE.beamTop + 0.025, bay.zCenter));
    // Its light grazing the band: bright at the bottom, fading up (the wash texture flipped).
    const wash = new THREE.PlaneGeometry(SIGN.header.width + 0.5, 0.62);
    const uv = wash.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i += 1) uv.setY(i, 1 - uv.getY(i));
    wash.rotateY(s > 0 ? -Math.PI / 2 : Math.PI / 2);
    wash.translate(s * (HALL.bayStartX - 0.004), ARCADE.beamTop + 0.31, bay.zCenter);
    washes.push(wash.toNonIndexed());
    wash.dispose();
    // Range plates' bodies on the nave-facing bookcase ends.
    for (const bookcase of naveFacingBookcases(bay)) {
      plates.push(boxAt(PLATE.thickness, SIGN.plate.height + 0.012, SIGN.plate.width + 0.012, bookcaseEndX(bay) - s * (PLATE.thickness / 2), PLATE.y, bookcase.z));
    }
  }
  // The stele: base, plinth, body, brass cap and the brass panel on its front (local -Z).
  if (!layout.bays.some((bay) => bay.categoryId !== null)) return { brass, plates, limestone, washes };
  const matrix = steleMatrix();
  const panel = directoryPanel(layout);
  const stone = [
    boxAt(DIRECTORY.width, 0.08, DIRECTORY.depth, 0, 0.04, 0),
    boxAt(DIRECTORY.width - 0.06, 0.04, DIRECTORY.depth - 0.04, 0, 0.1, 0),
    boxAt(DIRECTORY.width - 0.12, DIRECTORY.height - 0.18, STELE_DEPTH, 0, 0.12 + (DIRECTORY.height - 0.18) / 2, 0),
  ];
  const cap = boxAt(DIRECTORY.width - 0.06, 0.03, STELE_DEPTH + 0.04, 0, DIRECTORY.height - 0.045, 0);
  const face = boxAt(panel.width + 0.02, panel.height + 0.02, 0.006, 0, panel.centerY, -STELE_DEPTH / 2 - 0.003);
  for (const geometry of [...stone, cap, face]) geometry.applyMatrix4(matrix);
  limestone.push(...stone);
  brass.push(cap);
  plates.push(face);
  return { brass, plates, limestone, washes };
}

// --- Masks ----------------------------------------------------------------------------------

/** A drawn canvas as a single-channel (R8) texture, rows flipped so v runs up. */
function maskTexture(canvas: HTMLCanvasElement): THREE.DataTexture {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const source = (height - 1 - y) * width * 4;
    const target = y * width;
    for (let x = 0; x < width; x += 1) data[target + x] = rgba[source + x * 4]!;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Metal letters or engraving whose coverage comes from an R8 mask (red channel). */
function maskMaterial(mask: THREE.Texture, color: string, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    alphaMap: mask,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  // three.js reads alpha maps from the green channel; the masks are single-channel (red).
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <alphamap_fragment>",
      "#ifdef USE_ALPHAMAP\n\tdiffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).r;\n#endif",
    );
  };
  material.customProgramCacheKey = () => "sign-mask-r";
  return material;
}

/** A quad of `width` x `height` facing `normal` (+x or -x, or the stele's front), at `center`. */
function quadFacingX(width: number, height: number, side: -1 | 1, center: THREE.Vector3): Geometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  // A plane faces +Z; turn it to face -side along X (toward the nave).
  geometry.rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2);
  geometry.translate(center.x, center.y, center.z);
  return geometry;
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(canvasFontsReady());
  useEffect(() => {
    if (!ready) void ensureCanvasFonts().then(() => setReady(true));
  }, [ready]);
  return ready;
}

// --- Test hooks ----------------------------------------------------------------------------

export interface HeaderDebug extends Omit<SignText, "layout"> {
  categoryId: number;
  name: string;
  lines: string[];
  scale: number;
  truncated: boolean;
  textureId: string;
  /** World centre of the header and the normal of its face. */
  center: [number, number, number];
  normal: [number, number, number];
}

export interface PlateDebug {
  categoryId: number;
  name: string;
  count: string;
  lines: string[];
  textureId: string;
  centers: [number, number, number][];
}

export interface DirectoryDebug {
  title: string;
  lines: { categoryId: number | null; text: string; toward: "left" | "right"; truncated: boolean }[];
  textureId: string;
  hovered: number | null;
}

const headerDebug = new Map<number, HeaderDebug>();
const plateDebug = new Map<number, PlateDebug>();
let directoryDebug: DirectoryDebug | null = null;
const disposed = { headers: 0, plates: 0, directory: 0 };
/** Where a directory line is on screen (for tests to point at it). */
let directoryLineScreen: (categoryId: number) => { x: number; y: number } | null = () => null;

registerTestHook("signs", () => ({
  headers: [...headerDebug.values()],
  plates: [...plateDebug.values()],
  directory: directoryDebug,
  disposed: { ...disposed },
}));
registerTestHook("directoryLineScreen", (categoryId: number) => directoryLineScreen(categoryId));

// --- Level 1: section headers ---------------------------------------------------------------

function SectionHeader({ category, bay, fontsReady }: { category: Category; bay: BayLayout; fontsReady: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const side = bay.side;
  const center = useMemo(() => new THREE.Vector3(side * (HALL.bayStartX - HEADER.standOff), HEADER.y, bay.zCenter), [side, bay.zCenter]);
  const geometry = useMemo(() => quadFacingX(SIGN.header.width, SIGN.header.height, side, center), [side, center]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const drawn = useMemo(() => {
    if (!fontsReady) return null;
    const canvas = document.createElement("canvas");
    const text = drawHeaderMask(canvas, category.name);
    return { text, texture: maskTexture(canvas) };
  }, [fontsReady, category.name]);
  const material = useMemo(() => (drawn ? maskMaterial(drawn.texture, BRONZE, 1, 0.38) : null), [drawn]);

  // The texture lives as long as the drawing (a rename draws a new one).
  useEffect(() => {
    if (!drawn || !material) return;
    return () => {
      drawn.texture.dispose();
      material.dispose();
      disposed.headers += 1;
      if (headerDebug.get(category.id)?.textureId === drawn.texture.uuid) headerDebug.delete(category.id);
    };
  }, [drawn, material, category.id]);
  useEffect(() => {
    if (!drawn || !material) return;
    headerDebug.set(category.id, {
      categoryId: category.id,
      name: category.name,
      lines: drawn.text.layout.lines,
      scale: drawn.text.layout.scale,
      truncated: drawn.text.layout.truncated,
      script: drawn.text.script,
      direction: drawn.text.direction,
      textureId: drawn.texture.uuid,
      center: [center.x, center.y, center.z],
      normal: [-side, 0, 0],
    });
    invalidate();
  }, [drawn, material, category.id, category.name, center, side, invalidate]);

  if (!material) return null;
  return <mesh geometry={geometry} material={material} name={`header-${category.id}`} renderOrder={2} />;
}

// --- Level 2: range plates -------------------------------------------------------------------

function RangePlates({ category, bay, fontsReady, language }: { category: Category; bay: BayLayout; fontsReady: boolean; language: Language }) {
  const invalidate = useThree((state) => state.invalidate);
  const side = bay.side;
  const centers = useMemo(
    () => naveFacingBookcases(bay).map((bookcase) => new THREE.Vector3(bookcaseEndX(bay) - side * (PLATE.thickness + 0.0004), PLATE.y, bookcase.z)),
    [bay, side],
  );
  const geometry = useMemo(() => {
    if (centers.length === 0) return null;
    const quads = centers.map((center) => {
      const quad = quadFacingX(SIGN.plate.width, SIGN.plate.height, side, center);
      const flat = quad.toNonIndexed();
      quad.dispose();
      return flat;
    });
    const merged = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv"] as const) {
      const size = quads[0]!.getAttribute(name).itemSize;
      const array = new Float32Array(quads.reduce((sum, quad) => sum + quad.getAttribute(name).array.length, 0));
      let offset = 0;
      for (const quad of quads) {
        array.set(quad.getAttribute(name).array as Float32Array, offset);
        offset += quad.getAttribute(name).array.length;
      }
      merged.setAttribute(name, new THREE.BufferAttribute(array, size));
    }
    quads.forEach((quad) => quad.dispose());
    return merged;
  }, [centers, side]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const count = t("count.books", { count: bay.bookCount }, language);
  const drawn = useMemo(() => {
    if (!fontsReady) return null;
    const canvas = document.createElement("canvas");
    const text = drawPlateMask(canvas, category.name, count);
    return { text, texture: maskTexture(canvas) };
  }, [fontsReady, category.name, count]);
  const material = useMemo(() => (drawn ? maskMaterial(drawn.texture, ENGRAVING, 0.6, 0.5) : null), [drawn]);

  useEffect(() => {
    if (!drawn || !material) return;
    return () => {
      drawn.texture.dispose();
      material.dispose();
      disposed.plates += 1;
      if (plateDebug.get(category.id)?.textureId === drawn.texture.uuid) plateDebug.delete(category.id);
    };
  }, [drawn, material, category.id]);
  useEffect(() => {
    if (!drawn || !material) return;
    plateDebug.set(category.id, {
      categoryId: category.id,
      name: category.name,
      count,
      lines: drawn.text.layout.lines,
      textureId: drawn.texture.uuid,
      centers: centers.map((c) => [c.x, c.y, c.z]),
    });
    invalidate();
  }, [drawn, material, category.id, category.name, count, centers, invalidate]);

  if (!material || !geometry) return null;
  return <mesh geometry={geometry} material={material} name={`plates-${category.id}`} renderOrder={2} />;
}

// --- Level 3: the directory -------------------------------------------------------------------

function Directory({ layout, categories, fontsReady, language }: { layout: HallLayout; categories: Category[]; fontsReady: boolean; language: Language }) {
  const { gl, camera, size, invalidate } = useThree();
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  hoveredRef.current = hovered;

  // Bays in hall order; someone reading the stele faces into the hall (+Z), so the bays on the
  // +X side are to their left.
  const entries = useMemo<DirectoryEntry[]>(
    () =>
      layout.bays.flatMap((bay) => {
        const category = categories.find((c) => c.id === bay.categoryId);
        return category ? [{ categoryId: category.id, name: category.name, toward: bay.side > 0 ? "left" : "right" }] : [];
      }),
    [layout, categories],
  );
  const title = t("directory.title", {}, language);
  const drawn = useMemo(() => {
    if (!fontsReady) return null;
    const canvas = document.createElement("canvas");
    const lines = drawDirectoryMask(canvas, title, planDirectory(entries), (count) => t("directory.more", { count }, language));
    return { lines, texture: maskTexture(canvas) };
  }, [fontsReady, title, entries, language]);
  const material = useMemo(() => (drawn ? maskMaterial(drawn.texture, ENGRAVING, 0.6, 0.5) : null), [drawn]);

  // The panel in the stele's frame: on its front (local -Z), facing the entrance.
  const matrix = useMemo(() => steleMatrix(), []);
  const panel = useMemo(() => directoryPanel(layout), [layout]);
  const geometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(panel.width, panel.height);
    plane.rotateY(Math.PI);
    plane.translate(0, panel.centerY, -STELE_DEPTH / 2 - 0.0064);
    plane.applyMatrix4(matrix);
    return plane;
  }, [matrix, panel]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Canvas pixels to world: the panel's local frame, then the stele's.
  const toWorld = useMemo(() => {
    const { width, height, canvasWidth, canvasHeight, centerY } = panel;
    return (px: number, py: number, out = new THREE.Vector3()) => {
      // The plane is turned to face -Z, so the canvas's left edge is at local +X.
      const lx = (0.5 - px / canvasWidth) * width;
      const ly = centerY + (0.5 - py / canvasHeight) * height;
      return out.set(lx, ly, -STELE_DEPTH / 2 - 0.0068).applyMatrix4(matrix);
    };
  }, [matrix, panel]);

  const highlight = useMemo(() => {
    if (!drawn || hovered === null) return null;
    const line = drawn.lines.find((l) => l.categoryId === hovered);
    if (!line) return null;
    const { rect } = line;
    const plane = new THREE.PlaneGeometry((rect.width / panel.canvasWidth) * panel.width, (rect.height / panel.canvasHeight) * panel.height * 0.9);
    plane.rotateY(Math.PI);
    const center = toWorld(rect.x + rect.width / 2, rect.y + rect.height / 2);
    plane.applyMatrix4(new THREE.Matrix4().makeRotationY(DIRECTORY.rotationY));
    plane.translate(center.x, center.y, center.z);
    return plane;
  }, [drawn, hovered, toWorld, panel]);
  useEffect(() => () => highlight?.dispose(), [highlight]);
  const highlightMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(GILT).multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }),
    [],
  );
  useEffect(() => () => highlightMaterial.dispose(), [highlightMaterial]);

  useEffect(() => {
    if (!drawn || !material) return;
    return () => {
      drawn.texture.dispose();
      material.dispose();
      disposed.directory += 1;
      if (directoryDebug?.textureId === drawn.texture.uuid) directoryDebug = null;
    };
  }, [drawn, material]);
  useEffect(() => {
    if (!drawn || !material) return;
    directoryDebug = {
      title,
      lines: drawn.lines.map(({ categoryId, text, toward, truncated }) => ({ categoryId, text, toward, truncated })),
      textureId: drawn.texture.uuid,
      hovered: hoveredRef.current,
    };
    directoryLineScreen = (categoryId) => {
      const line = drawn.lines.find((l) => l.categoryId === categoryId);
      if (!line) return null;
      const point = toWorld(line.rect.x + line.rect.width / 2, line.rect.y + line.rect.height / 2).project(camera);
      return { x: ((point.x + 1) / 2) * size.width, y: ((1 - point.y) / 2) * size.height };
    };
    invalidate();
    return () => {
      directoryLineScreen = () => null;
    };
  }, [drawn, material, title, toWorld, camera, size, invalidate]);
  useEffect(() => {
    if (directoryDebug) directoryDebug.hovered = hovered;
  }, [hovered]);

  /** The line under a pointer event (from its UV on the panel). */
  const lineAt = (event: ThreeEvent<PointerEvent | MouseEvent>): DirectoryLine | null => {
    if (!drawn || !event.uv) return null;
    const px = event.uv.x * panel.canvasWidth;
    const py = (1 - event.uv.y) * panel.canvasHeight;
    return drawn.lines.find((l) => l.categoryId !== null && px >= l.rect.x && px <= l.rect.x + l.rect.width && py >= l.rect.y && py <= l.rect.y + l.rect.height) ?? null;
  };
  const busy = () => useLibraryStore.getState().presentedBookId !== null;
  const onMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const line = busy() ? null : lineAt(event);
    const id = line?.categoryId ?? null;
    if (id !== hovered) {
      setHovered(id);
      gl.domElement.style.cursor = id === null ? "" : "pointer";
      invalidate();
    }
  };
  const onOut = () => {
    if (hovered === null) return;
    setHovered(null);
    gl.domElement.style.cursor = "";
    invalidate();
  };
  const onClick = (event: ThreeEvent<MouseEvent>) => {
    // A drag to look around is not a click; nor is a click while a book is presented.
    if (event.delta > 4 || busy()) return;
    const line = lineAt(event);
    if (line?.categoryId == null) return;
    event.stopPropagation();
    setHovered(null);
    gl.domElement.style.cursor = "";
    playerCommands.flyToBay(line.categoryId);
  };

  if (!material) return null;
  return (
    <group>
      <mesh geometry={geometry} material={material} name="directory" renderOrder={2} onPointerMove={onMove} onPointerOut={onOut} onClick={onClick} />
      {highlight && <mesh geometry={highlight} material={highlightMaterial} renderOrder={3} />}
    </group>
  );
}

// --- All signs -------------------------------------------------------------------------------

export function Signage({ layout }: { layout: HallLayout }) {
  const categories = useLibraryStore((state) => state.categories);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const fontsReady = useFontsReady();
  return (
    <group name="signage">
      {layout.bays.map((bay) => {
        const category = bay.categoryId === null ? undefined : categories.find((c) => c.id === bay.categoryId);
        if (!category) return null;
        return (
          <group key={category.id}>
            <SectionHeader category={category} bay={bay} fontsReady={fontsReady} />
            <RangePlates category={category} bay={bay} fontsReady={fontsReady} language={language} />
          </group>
        );
      })}
      {categories.length > 0 && <Directory layout={layout} categories={categories} fontsReady={fontsReady} language={language} />}
    </group>
  );
}
