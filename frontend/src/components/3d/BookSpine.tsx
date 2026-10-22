"use client";

/**
 * Books on a bookcase (docs/ARCHITECTURE.md section 10.5, docs/DESIGN.md sections 5 and 11).
 *
 * One instanced mesh per bookcase: a box whose vertices carry a face kind (spine, cover, page
 * edge, top) and whose instances carry the cloth colour, the label colour and the label's
 * place in the atlas texture array. The shader lays the gilt or ink title over the cloth once
 * the bay's atlas page is resident (fading in over 200 ms), shows paper on the page edges and
 * the boards framing the page block on top.
 *
 * Hover slides a book out 5 cm with a warm rim (critically damped: 180 ms out, 220 ms back)
 * and a title tooltip; a click presents it (BookPresenter).
 */

import { Html } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { registerBookSource } from "@/components/3d/BookPresenter";
import type { Book } from "@/lib/api";
import type { BookcaseLayout } from "@/lib/hallLayout";
import { registerTestHook } from "@/lib/testApi";
import { GILT, INK, labelInk, type SpineAtlas } from "@/lib/spineAtlas";
import { useLibraryStore } from "@/store/useLibraryStore";

export const FACE = { spine: 0, cover: 1, page: 2, top: 3 } as const;
const CAPACITY = 150;
const SLIDE = 0.05;
const OMEGA_OUT = 5.8 / 0.18; // critically damped, settles in about 180 ms
const OMEGA_BACK = 5.8 / 0.22;
const LABEL_FADE_MS = 200;

/** The atlas shared by every bookcase in the hall. */
export const SpineAtlasContext = createContext<SpineAtlas | null>(null);

// --- Geometry and material -------------------------------------------------------------------

/** A unit box (x: thickness, y: height, z: depth, spine at +z) with face kinds and spine UVs. */
function createBookGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const position = box.getAttribute("position") as THREE.BufferAttribute;
  const kinds = new Float32Array(position.count);
  const spineUv = new Float32Array(position.count * 2);
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 vertices each).
  const order = [FACE.cover, FACE.cover, FACE.top, FACE.page, FACE.spine, FACE.page];
  for (let i = 0; i < position.count; i += 1) {
    kinds[i] = order[Math.floor(i / 4)]!;
    // The label is turned 90 degrees clockwise: the cell's x runs down the spine and its
    // top edge lies along the spine's right side (+x).
    spineUv[i * 2] = 0.5 - position.getY(i);
    spineUv[i * 2 + 1] = 0.5 - position.getX(i);
  }
  box.setAttribute("faceKind", new THREE.BufferAttribute(kinds, 1));
  box.setAttribute("spineUv", new THREE.BufferAttribute(spineUv, 2));
  return box;
}

const baseGeometry = createBookGeometry();

/** MeshStandardMaterial with the spine logic patched in (lights, shadows and fog unchanged). */
export function createSpineMaterial(atlas: THREE.DataArrayTexture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.labelAtlas = { value: atlas };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float faceKind;
        attribute vec2 spineUv;
        attribute vec3 clothColor;
        attribute vec3 labelColor;
        attribute vec4 labelRect;
        attribute float labelLayer;
        attribute float labelFade;
        attribute float hover;
        varying float vFaceKind;
        varying vec2 vSpineUv;
        varying vec3 vCloth;
        varying vec3 vLabelColor;
        varying float vLayer;
        varying float vFade;
        varying float vHover;
        varying vec3 vLocal;
        varying vec3 vSize;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vFaceKind = faceKind;
        vSpineUv = labelRect.xy + clamp(spineUv, 0.0, 1.0) * labelRect.zw;
        vCloth = clothColor;
        vLabelColor = labelColor;
        vLayer = labelLayer;
        vFade = labelFade;
        vHover = hover;
        vLocal = position;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform highp sampler2DArray labelAtlas;
        varying float vFaceKind;
        varying vec2 vSpineUv;
        varying vec3 vCloth;
        varying vec3 vLabelColor;
        varying float vLayer;
        varying float vFade;
        varying float vHover;
        varying vec3 vLocal;
        varying vec3 vSize;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 bookColor = vCloth;
        if (vFaceKind > 1.5) {
          // Page edges: warm paper (#EFE9DC). On top, the boards frame the page block.
          bookColor = vec3(0.863, 0.815, 0.716);
          if (vFaceKind > 2.5) {
            float board = (0.5 - abs(vLocal.x)) * vSize.x;
            float spineEdge = (0.5 - vLocal.z) * vSize.z;
            if (board < 0.0025 || spineEdge < 0.005) bookColor = vCloth;
          }
        }
        if (vFaceKind < 0.5 && vLayer > -0.5) {
          float mask = texture(labelAtlas, vec3(vSpineUv, vLayer)).r;
          bookColor = mix(bookColor, vLabelColor, mask * vFade);
        }
        diffuseColor.rgb *= bookColor;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = vFaceKind > 1.5 ? 0.85 : 0.7;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        // Hover: a thin warm rim (gilt #D8B77A).
        float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.0);
        totalEmissiveRadiance += vec3(0.686, 0.473, 0.195) * vHover * (0.18 + 0.9 * rim);`,
      );
  };
  material.customProgramCacheKey = () => "dar-book-spine";
  return material;
}

/** Book cloth colours are desaturated 15 % so many covers stay harmonious (DESIGN.md 4). */
export function clothColor(hex: string): THREE.Color {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l);
}

const GILT_COLOR = new THREE.Color(GILT);
const INK_COLOR = new THREE.Color(INK);

// --- Debug ----------------------------------------------------------------------------------

export interface SpineDebug {
  categoryId: number;
  bookcase: number;
  count: number;
  labelled: number;
  hovered: { id: number; slide: number } | null;
}

export const spineDebug = new Map<string, SpineDebug>();

/** Book centres in world space (for tests: where to point the mouse). */
const spineCenters = new Map<number, () => THREE.Vector3>();

export function registerBookCenter(id: number, center: () => THREE.Vector3): () => void {
  spineCenters.set(id, center);
  return () => {
    if (spineCenters.get(id) === center) spineCenters.delete(id);
  };
}
let projectionCamera: THREE.Camera | null = null;
let projectionCanvas: HTMLCanvasElement | null = null;
registerTestHook("bookScreen", (id: number) => {
  const center = spineCenters.get(id)?.();
  if (!center || !projectionCamera || !projectionCanvas) return null;
  projectionCamera.updateMatrixWorld();
  const ndc = center.clone().project(projectionCamera);
  const rect = projectionCanvas.getBoundingClientRect();
  return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height, world: center.toArray() };
});
registerTestHook("spines", () => [...spineDebug.values()]);

// --- Component ------------------------------------------------------------------------------

export interface ShelfEntry {
  book: Book;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export function BookSpine({ categoryId, bookcase, entries }: { categoryId: number; bookcase: BookcaseLayout; entries: ShelfEntry[] }) {
  const atlas = useContext(SpineAtlasContext);
  const presentedId = useLibraryStore((state) => state.presentedBookId);
  const presentBook = useLibraryStore((state) => state.presentBook);
  const { gl, invalidate } = useThree();
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  const material = useMemo(() => (atlas ? createSpineMaterial(atlas.texture) : null), [atlas]);
  useEffect(() => () => material?.dispose(), [material]);

  const geometry = useMemo(() => {
    const g = baseGeometry.clone();
    const attribute = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * size), size);
    g.setAttribute("clothColor", attribute(3));
    g.setAttribute("labelColor", attribute(3));
    g.setAttribute("labelRect", attribute(4));
    const layer = attribute(1);
    (layer.array as Float32Array).fill(-1);
    g.setAttribute("labelLayer", layer);
    g.setAttribute("labelFade", attribute(1));
    g.setAttribute("hover", attribute(1));
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Per-book animation state: slide offset and velocity (hover), label fade.
  const slide = useRef(new Float32Array(CAPACITY));
  const velocity = useRef(new Float32Array(CAPACITY));
  const fadeStart = useRef(new Map<number, number>());
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  hoveredRef.current = hovered;

  const writeMatrix = (index: number) => {
    const mesh = meshRef.current;
    const entry = entries[index];
    if (!mesh || !entry) return;
    const hidden = entry.book.id === useLibraryStore.getState().presentedBookId;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(entry.x, entry.y, entry.z + slide.current[index]!),
      new THREE.Quaternion(),
      hidden ? new THREE.Vector3(1e-5, 1e-5, 1e-5) : new THREE.Vector3(entry.w, entry.h, entry.d),
    );
    mesh.setMatrixAt(index, matrix);
    mesh.instanceMatrix.needsUpdate = true;
  };

  // Static per-book data: transforms, cloth and label colours.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const cloth = geometry.getAttribute("clothColor") as THREE.InstancedBufferAttribute;
    const ink = geometry.getAttribute("labelColor") as THREE.InstancedBufferAttribute;
    entries.forEach((entry, i) => {
      slide.current[i] = 0;
      velocity.current[i] = 0;
      const color = clothColor(entry.book.spine_color);
      cloth.setXYZ(i, color.r, color.g, color.b);
      const label = labelInk(color) === "gilt" ? GILT_COLOR : INK_COLOR;
      ink.setXYZ(i, label.r, label.g, label.b);
      writeMatrix(i);
    });
    mesh.count = entries.length;
    cloth.needsUpdate = true;
    ink.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
    // writeMatrix reads the latest entries through the closure.
  }, [entries, geometry, invalidate]);

  // Labels: follow the atlas (resident pages come and go with distance).
  useEffect(() => {
    if (!atlas) return;
    const apply = () => {
      const layer = geometry.getAttribute("labelLayer") as THREE.InstancedBufferAttribute;
      const rect = geometry.getAttribute("labelRect") as THREE.InstancedBufferAttribute;
      const fade = geometry.getAttribute("labelFade") as THREE.InstancedBufferAttribute;
      const now = performance.now();
      entries.forEach((entry, i) => {
        const placed = atlas.entries.get(entry.book.id);
        const had = layer.getX(i) > -0.5;
        if (placed) {
          layer.setX(i, placed.layer);
          rect.setXYZW(i, ...placed.rect);
          if (!had) {
            fade.setX(i, 0);
            fadeStart.current.set(i, now);
          }
        } else {
          layer.setX(i, -1);
          fade.setX(i, 0);
          fadeStart.current.delete(i);
        }
      });
      layer.needsUpdate = true;
      rect.needsUpdate = true;
      fade.needsUpdate = true;
      invalidate();
    };
    apply();
    return atlas.subscribe(apply);
  }, [atlas, entries, geometry, invalidate]);

  // Hide the presented book on the shelf; show it again when it returns.
  useEffect(() => {
    entries.forEach((_, i) => writeMatrix(i));
    invalidate();
  }, [presentedId]);

  const camera = useThree((state) => state.camera);
  useEffect(() => {
    projectionCamera = camera;
    projectionCanvas = gl.domElement;
  }, [camera, gl]);

  // Sources for the presenter: each book's world transform and size.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const centers = entries.map((entry) => {
      const center = () => {
        group.updateWorldMatrix(true, false);
        return new THREE.Vector3(entry.x, entry.y, entry.z + entry.d / 2).applyMatrix4(group.matrixWorld);
      };
      spineCenters.set(entry.book.id, center);
      return () => {
        if (spineCenters.get(entry.book.id) === center) spineCenters.delete(entry.book.id);
      };
    });
    const unregister = entries.map((entry) =>
      registerBookSource(entry.book.id, () => {
        group.updateWorldMatrix(true, false);
        const position = new THREE.Vector3(entry.x, entry.y, entry.z).applyMatrix4(group.matrixWorld);
        const quaternion = new THREE.Quaternion().setFromRotationMatrix(group.matrixWorld);
        return { position, quaternion, size: { thickness: entry.w, height: entry.h, depth: entry.d } };
      }),
    );
    return () => {
      unregister.forEach((fn) => fn());
      centers.forEach((fn) => fn());
    };
  }, [entries]);

  useEffect(() => {
    const key = `${categoryId}:${bookcase.index}`;
    spineDebug.set(key, {
      categoryId,
      bookcase: bookcase.index,
      count: entries.length,
      labelled: 0,
      hovered: null,
    });
    return () => {
      spineDebug.delete(key);
    };
  }, [categoryId, bookcase.index, entries.length]);

  // Springs and fades run only while something moves (frameloop="demand").
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    let active = false;
    const hover = geometry.getAttribute("hover") as THREE.InstancedBufferAttribute;
    let hoverChanged = false;
    for (let i = 0; i < entries.length; i += 1) {
      const target = hoveredRef.current === i ? SLIDE : 0;
      const x = slide.current[i]!;
      const v = velocity.current[i]!;
      if (Math.abs(x - target) < 1e-4 && Math.abs(v) < 1e-3) {
        if (x !== target) {
          slide.current[i] = target;
          velocity.current[i] = 0;
          writeMatrix(i);
        }
      } else {
        const omega = target > 0 ? OMEGA_OUT : OMEGA_BACK;
        // Critically damped spring: no overshoot (books are heavy).
        const steps = Math.ceil(dt / 0.004);
        let px = x;
        let pv = v;
        for (let s = 0; s < steps; s += 1) {
          const h = dt / steps;
          const a = -2 * omega * pv - omega * omega * (px - target);
          pv += a * h;
          px += pv * h;
        }
        slide.current[i] = px;
        velocity.current[i] = pv;
        writeMatrix(i);
        active = true;
      }
      const glow = Math.min(1, Math.max(0, slide.current[i]! / SLIDE));
      if (Math.abs(hover.getX(i) - glow) > 1e-4) {
        hover.setX(i, glow);
        hoverChanged = true;
      }
    }
    if (hoverChanged) hover.needsUpdate = true;
    if (fadeStart.current.size > 0) {
      const fade = geometry.getAttribute("labelFade") as THREE.InstancedBufferAttribute;
      const now = performance.now();
      for (const [i, start] of fadeStart.current) {
        const t = Math.min(1, (now - start) / LABEL_FADE_MS);
        fade.setX(i, t);
        if (t >= 1) fadeStart.current.delete(i);
      }
      fade.needsUpdate = true;
      active = true;
    }
    const debug = spineDebug.get(`${categoryId}:${bookcase.index}`);
    if (debug) {
      const layer = geometry.getAttribute("labelLayer") as THREE.InstancedBufferAttribute;
      let labelled = 0;
      for (let i = 0; i < entries.length; i += 1) if (layer.getX(i) > -0.5) labelled += 1;
      debug.labelled = labelled;
      const h = hoveredRef.current;
      debug.hovered = h === null ? null : { id: entries[h]!.book.id, slide: slide.current[h]! };
    }
    if (active) invalidate();
  });

  const onMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const index = event.instanceId ?? null;
    if (index !== hoveredRef.current) {
      setHovered(index);
      gl.domElement.style.cursor = index === null ? "" : "pointer";
      invalidate();
    }
  };
  const onOut = () => {
    setHovered(null);
    gl.domElement.style.cursor = "";
    invalidate();
  };
  const onClick = (event: ThreeEvent<MouseEvent>) => {
    // A drag to look around is not a click.
    // While another book is presented, a click only puts that one back (BookPresenter).
    if (event.delta > 4 || event.instanceId === undefined || useLibraryStore.getState().presentedBookId !== null) return;
    event.stopPropagation();
    const entry = entries[event.instanceId];
    if (!entry) return;
    setHovered(null);
    presentBook(entry.book.id);
  };

  const tip = hovered !== null ? entries[hovered] : undefined;

  return (
    <group ref={groupRef} position={[bookcase.x, 0, bookcase.z]} rotation={[0, bookcase.rotationY, 0]}>
      {material ? (
        <instancedMesh
          ref={meshRef}
          args={[geometry, material, CAPACITY]}
          onPointerMove={onMove}
          onPointerOut={onOut}
          onClick={onClick}
          name={`books-${categoryId}-${bookcase.index}`}
        />
      ) : null}
      {tip && presentedId === null ? (
        <Html position={[tip.x, tip.y + tip.h / 2 + 0.05, tip.z + tip.d / 2 + SLIDE]} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div
            className="panel max-w-72 rounded-control px-3 py-1.5 text-center text-12 leading-snug whitespace-normal text-ink"
            dir="auto"
            data-testid="book-tooltip"
          >
            {tip.book.title}
          </div>
        </Html>
      ) : null}
    </group>
  );
}
