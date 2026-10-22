"use client";

/**
 * The hall's canvas (docs/ARCHITECTURE.md section 10): renders on demand only, AgX tone
 * mapping with the Ambient light setting as exposure, the adaptive pixel ratio, and the
 * graphics preset's context options (changing the preset remounts the canvas).
 */

import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";

import { FrameCounter, HallReaderOverlay, HallReaderScene, readerPixelRatio } from "@/components/3d/CurvedBookReader";
import { useReaderTransition } from "@/components/3d/readerTransition";
import { HALL_COLORS, HallRoom } from "@/components/3d/HallRoom";
import { PlayerControls } from "@/components/3d/PlayerControls";
import { useAdaptiveQuality } from "@/hooks/useAdaptiveQuality";
import type { GraphicsQuality } from "@/lib/api";
import { SPAWN, computeHallLayout, type HallLayout } from "@/lib/hallLayout";
import { registerRenderer, registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

/** Tone mapping and exposure, kept on the renderer without re-rendering the canvas. */
function Exposure() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const exposure = useLibraryStore((state) => state.settings.ambient_light);
  useLayoutEffect(() => {
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = exposure;
    invalidate();
  }, [gl, exposure, invalidate]);
  return null;
}

/** The walking camera, paused while a book is presented or open. */
function HallControls(props: Omit<Parameters<typeof PlayerControls>[0], "enabled">) {
  const presenting = useLibraryStore((state) => state.presentedBookId !== null);
  const reading = useReaderTransition((state) => state.phase !== "closed");
  return <PlayerControls {...props} enabled={!presenting && !reading} />;
}

/** The hall stays mounted while a book is open, but hidden (docs/ARCHITECTURE.md 11.6). */
function HallVisibility({ children }: { children: ReactNode }) {
  const visible = useReaderTransition((state) => state.hallVisible);
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => invalidate(), [visible, invalidate]);
  return <group visible={visible}>{children}</group>;
}

interface HallCanvasProps {
  preset: GraphicsQuality;
  layout: HallLayout;
  fadeRef: RefObject<HTMLDivElement | null>;
}

const HallCanvas = memo(function HallCanvas({ preset, layout, fadeRef }: HallCanvasProps) {
  const quality = useAdaptiveQuality(preset);
  // With a book open the hall is hidden and only the book is drawn: render it sharp.
  const reading = useReaderTransition((state) => state.phase === "open");
  const shadows = useMemo(
    () => (preset === "performance" ? false : { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false }),
    [preset],
  );
  const gl = useMemo(() => ({ antialias: preset !== "performance", powerPreference: "high-performance" as const }), [preset]);
  const camera = useMemo(() => ({ fov: 55, near: 0.05, far: 150, position: SPAWN.position }), []);

  return (
    <Canvas
      frameloop="demand"
      dpr={reading ? readerPixelRatio(preset) : quality.dpr}
      shadows={shadows}
      gl={gl}
      camera={camera}
      onCreated={({ gl: renderer }) => {
        registerRenderer(renderer);
        renderer.shadowMap.autoUpdate = false;
        registerTestHook("canvas", () => ({
          preset,
          antialias: renderer.getContextAttributes()?.antialias ?? null,
          shadows: renderer.shadowMap.enabled,
          dpr: renderer.getPixelRatio(),
          toneMapping: renderer.toneMapping === THREE.AgXToneMapping ? "AgX" : String(renderer.toneMapping),
          exposure: renderer.toneMappingExposure,
        }));
      }}
      data-testid="hall-canvas"
    >
      <Exposure />
      <fog attach="fog" args={[HALL_COLORS.limestone, 16, Math.max(48, layout.length * 1.6)]} />
      <FrameCounter />
      <Suspense fallback={null}>
        <HallVisibility>
          <HallRoom layout={layout} preset={preset} />
        </HallVisibility>
        <HallReaderScene />
      </Suspense>
      <HallControls layout={layout} onMotionFrame={quality.sample} fadeRef={fadeRef} />
    </Canvas>
  );
});

export function LibraryCanvas() {
  const preset = useLibraryStore((state) => state.settings.graphics_quality);
  const categories = useLibraryStore((state) => state.categories);
  const books = useLibraryStore((state) => state.books);
  const fadeRef = useRef<HTMLDivElement>(null);

  // Rebuild the layout only when something it depends on changes (not on a saved bookmark).
  const signature = JSON.stringify([
    categories.map((category) => [category.id, category.column_index]),
    books.map((book) => [book.category_id, book.shelf_number]),
  ]);
  const layout = useMemo(() => computeHallLayout(categories, books), [signature]);

  // The performance preset also drops the panels' blur (docs/DESIGN.md 10.1).
  useEffect(() => {
    document.documentElement.dataset.preset = preset;
  }, [preset]);

  return (
    <div className="absolute inset-0 bg-ink" data-testid="hall">
      <HallCanvas key={preset} preset={preset} layout={layout} fadeRef={fadeRef} />
      <div ref={fadeRef} className="pointer-events-none absolute inset-0 bg-ink opacity-0" aria-hidden="true" />
      <HallReaderOverlay />
    </div>
  );
}
