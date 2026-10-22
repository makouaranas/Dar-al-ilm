"use client";

/**
 * A category's plaque (docs/DESIGN.md sections 2 and 8, docs/ARCHITECTURE.md 9.4 and 10.7).
 *
 * A brushed brass blade sign hangs from the column's capital on two thin rods, perpendicular
 * to the nave so it reads while walking. The name is drawn on a 2D canvas (Inter SemiBold for
 * Latin, Cairo Bold for Arabic, right to left, never letter-spaced) once the fonts have loaded,
 * and each face is drawn separately so both sides read correctly. Renaming redraws the texture
 * and disposes the old one. The column's stone is merged into the hall's geometry.
 */

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

import type { Category } from "@/lib/api";
import { PLAQUE_SIZE, canvasFontsReady, drawPlaque, ensureCanvasFonts, type PlaqueDrawing } from "@/lib/canvasText";
import { HALL, type BayLayout } from "@/lib/hallLayout";
import { registerTestHook } from "@/lib/testApi";

/** Brushed brass (docs/DESIGN.md section 4). */
const BRASS = "#B08A4E";

/** The plaque's lower edge, and how far it reaches from the column toward the nave. */
export const PLAQUE_BOTTOM = 2.6;
const PLAQUE_OUTER = 2.05;
const ARM_Y = 3.12;
const THICKNESS = 0.018;

export interface PlaqueDebug extends Omit<PlaqueDrawing, "layout"> {
  categoryId: number;
  name: string;
  lines: string[];
  scale: number;
  truncated: boolean;
  textureId: string;
  /** World position of the plaque's centre, and the normal of its front face. */
  center: [number, number, number];
}

const plaques = new Map<number, PlaqueDebug>();
let disposedTextures = 0;
registerTestHook("plaques", () => ({ plaques: [...plaques.values()], disposed: disposedTextures }));

// Shared geometry: the blade's two faces, each mapped to its half of the canvas.
const shared = (() => {
  const { width: w, height: h } = PLAQUE_SIZE;
  const face = (front: boolean) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i += 1) uv.setY(i, (front ? 0.5 : 0) + uv.getY(i) * 0.5);
    // The front faces the entrance (-Z); the back faces the end wall (+Z).
    if (front) geometry.rotateY(Math.PI);
    geometry.translate(0, 0, front ? -THICKNESS / 2 - 0.0006 : THICKNESS / 2 + 0.0006);
    return geometry;
  };
  const faces = (() => {
    const front = face(true);
    const back = face(false);
    const merged = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv"] as const) {
      const a = front.getAttribute(name) as THREE.BufferAttribute;
      const b = back.getAttribute(name) as THREE.BufferAttribute;
      const array = new Float32Array(a.array.length + b.array.length);
      array.set(a.array as Float32Array, 0);
      array.set(b.array as Float32Array, a.array.length);
      merged.setAttribute(name, new THREE.BufferAttribute(array, a.itemSize));
    }
    const offset = front.getAttribute("position").count;
    merged.setIndex([...Array.from(front.getIndex()!.array), ...Array.from(back.getIndex()!.array).map((i) => i + offset)]);
    front.dispose();
    back.dispose();
    return merged;
  })();
  return {
    faces,
    brass: new THREE.MeshStandardMaterial({ color: BRASS, metalness: 1, roughness: 0.35 }),
  };
})();

export function CategoryColumn({ category, bay }: { category: Category; bay: BayLayout }) {
  const invalidate = useThree((state) => state.invalidate);
  const [fontsReady, setFontsReady] = useState(canvasFontsReady());
  useEffect(() => {
    if (!fontsReady) void ensureCanvasFonts().then(() => setFontsReady(true));
  }, [fontsReady]);

  const side = bay.side;
  const centerX = side * (PLAQUE_OUTER - PLAQUE_SIZE.width / 2);
  const centerY = PLAQUE_BOTTOM + PLAQUE_SIZE.height / 2;

  const drawn = useMemo(() => {
    if (!fontsReady) return null;
    const canvas = document.createElement("canvas");
    const drawing = drawPlaque(canvas, category.name, category.id);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { texture, drawing };
  }, [fontsReady, category.name, category.id]);

  const material = useMemo(
    () =>
      drawn
        ? new THREE.MeshStandardMaterial({ map: drawn.texture, color: BRASS, metalness: 1, roughness: 0.3 })
        : shared.brass,
    [drawn],
  );

  useEffect(() => {
    if (!drawn) return;
    plaques.set(category.id, {
      categoryId: category.id,
      name: category.name,
      lines: drawn.drawing.layout.lines,
      scale: drawn.drawing.layout.scale,
      truncated: drawn.drawing.layout.truncated,
      script: drawn.drawing.script,
      direction: drawn.drawing.direction,
      textureId: drawn.texture.uuid,
      center: [centerX, centerY, bay.zCenter],
    });
    invalidate();
    return () => {
      drawn.texture.dispose();
      disposedTextures += 1;
      if (plaques.get(category.id)?.textureId === drawn.texture.uuid) plaques.delete(category.id);
    };
  }, [drawn, category.id, category.name, centerX, centerY, bay.zCenter, invalidate]);

  useEffect(
    () => () => {
      if (material !== shared.brass) material.dispose();
    },
    [material],
  );

  return (
    <group position={[0, 0, bay.zCenter]} name={`plaque-${category.id}`}>
      <mesh geometry={shared.faces} material={material} position={[centerX, centerY, 0]} />
    </group>
  );
}

/**
 * The plaque's brass in world space (arm from the capital, two rods, the blade), merged into
 * the hall's brass so every plaque costs only its face's draw call.
 */
export function plaqueBrassParts(bay: BayLayout): THREE.BufferGeometry[] {
  const side = bay.side;
  const z = bay.zCenter;
  const columnX = bay.column.x;
  const armInner = side * (PLAQUE_OUTER - PLAQUE_SIZE.width - 0.08);
  const rodLength = ARM_Y - (PLAQUE_BOTTOM + PLAQUE_SIZE.height);
  const parts: THREE.BufferGeometry[] = [];
  const arm = new THREE.BoxGeometry(Math.abs(columnX - armInner), 0.022, 0.022);
  arm.translate((columnX + armInner) / 2, ARM_Y, z);
  parts.push(arm);
  for (const x of [PLAQUE_OUTER - 0.1, PLAQUE_OUTER - PLAQUE_SIZE.width + 0.1]) {
    const rod = new THREE.CylinderGeometry(0.0045, 0.0045, rodLength, 8, 1);
    rod.translate(side * x, PLAQUE_BOTTOM + PLAQUE_SIZE.height + rodLength / 2, z);
    parts.push(rod);
  }
  const blade = new THREE.BoxGeometry(PLAQUE_SIZE.width + 0.012, PLAQUE_SIZE.height + 0.012, THICKNESS);
  blade.translate(side * (PLAQUE_OUTER - PLAQUE_SIZE.width / 2), PLAQUE_BOTTOM + PLAQUE_SIZE.height / 2, z);
  parts.push(blade);
  return parts.map((part) => {
    const flat = part.toNonIndexed();
    part.dispose();
    return flat;
  });
}

/** Columns stand at the nave edge; the plaque hangs between the column and the nave. */
export const PLAQUE_REACH = { inner: PLAQUE_OUTER - PLAQUE_SIZE.width, outer: PLAQUE_OUTER, columnX: HALL.columnX } as const;
