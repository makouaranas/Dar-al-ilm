"use client";

/**
 * A closed hardcover with real volume (US-18, docs/ARCHITECTURE.md section 11.7), in the
 * canonical book frame (x = thickness with the front cover toward +x for left-to-right books and
 * toward -x for right-to-left books, y up, spine at +z): two cloth boards with rounded edges
 * overhanging an inset page block with paper edges, a rounded spine with two gilt bands, and
 * the cover image on the front board. The front board hangs from `hingeRef` at the spine, so the
 * opening transition can swing it open.
 */

import { useEffect, useMemo, type RefObject } from "react";
import * as THREE from "three";

import type { Book } from "@/lib/api";
import { bookSize } from "@/lib/hallLayout";

import { createHardcoverParts, paperEdgeTexture } from "./bookModel";

/** Book cloth: the spine colour desaturated 15 % (docs/DESIGN.md 4). */
export function clothColor(hex: string): THREE.Color {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l);
}

export function Hardcover({ book, cover, hingeRef }: { book: Book; cover: THREE.Texture; hingeRef?: RefObject<THREE.Group | null> }) {
  const size = useMemo(() => bookSize(book), [book.page_count, book.page_width_pt, book.page_height_pt]);
  const parts = useMemo(() => createHardcoverParts(size), [size]);
  useEffect(
    () => () => {
      for (const geometry of [parts.frontBoard, parts.backBoard, parts.block, parts.spine, ...parts.bands]) geometry.dispose();
    },
    [parts],
  );
  const ltr = book.reading_direction === "LTR";
  const side = ltr ? 1 : -1;
  const materials = useMemo(() => {
    const cloth = new THREE.MeshStandardMaterial({ color: clothColor(book.spine_color), roughness: 0.72 });
    const front = new THREE.MeshStandardMaterial({ map: cover, roughness: 0.55 });
    const endpaper = new THREE.MeshStandardMaterial({ color: "#efe6d2", roughness: 0.9 });
    const paper = new THREE.MeshStandardMaterial({ color: "#f6f5f2", roughness: 0.88 });
    const edges = new THREE.MeshStandardMaterial({ map: paperEdgeTexture(), roughness: 0.9 });
    const gilt = new THREE.MeshStandardMaterial({ color: "#D8B77A", metalness: 0.85, roughness: 0.32 });
    const spine = cloth.clone();
    spine.side = THREE.DoubleSide;
    // BoxGeometry face order: +x, -x, +y, -y, +z (spine side), -z (fore-edge).
    return {
      all: [cloth, front, endpaper, paper, edges, gilt, spine],
      front: ltr ? [front, endpaper, cloth, cloth, cloth, cloth] : [endpaper, front, cloth, cloth, cloth, cloth],
      back: ltr ? [endpaper, cloth, cloth, cloth, cloth, cloth] : [cloth, endpaper, cloth, cloth, cloth, cloth],
      block: [paper, paper, edges, edges, paper, edges],
      spine,
      gilt,
    };
  }, [book.spine_color, cover, ltr]);
  useEffect(() => () => materials.all.forEach((material) => material.dispose()), [materials]);

  const { thickness, depth } = size;
  const { board, joint } = parts;
  return (
    <group>
      <mesh geometry={parts.block} material={materials.block} />
      <mesh geometry={parts.spine} material={materials.spine} />
      {parts.bands.map((band, index) => (
        <mesh key={index} geometry={band} material={materials.gilt} />
      ))}
      <mesh geometry={parts.backBoard} material={materials.back} position={[-side * (thickness / 2 - board / 2), 0, -joint / 2]} />
      {/* The front board hangs from the outer corner of its spine edge. */}
      <group ref={hingeRef} position={[side * (thickness / 2), 0, depth / 2 - joint]}>
        <mesh geometry={parts.frontBoard} material={materials.front} position={[-side * (board / 2), 0, -(depth - joint) / 2]} />
      </group>
    </group>
  );
}
