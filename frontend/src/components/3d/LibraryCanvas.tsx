"use client";

/**
 * The hall's canvas (docs/ARCHITECTURE.md section 10): renders on demand only, AgX tone
 * mapping with the Ambient light setting as exposure, the adaptive pixel ratio, and the
 * graphics preset's context options (changing the preset remounts the canvas).
 */

import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, memo, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";

import { FrameCounter } from "@/components/3d/CurvedBookReader";
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

interface HallCanvasProps {
  preset: GraphicsQuality;
  layout: HallLayout;
  fadeRef: RefObject<HTMLDivElement | null>;
}

const HallCanvas = memo(function HallCanvas({ preset, layout, fadeRef }: HallCanvasProps) {
  const quality = useAdaptiveQuality(preset);
  const shadows = useMemo(
    () => (preset === "performance" ? false : { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false }),
    [preset],
  );
  const gl = useMemo(() => ({ antialias: preset !== "performance", powerPreference: "high-performance" as const }), [preset]);
  const camera = useMemo(() => ({ fov: 55, near: 0.05, far: 150, position: SPAWN.position }), []);

  return (
    <Canvas
      frameloop="demand"
      dpr={quality.dpr}
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
        <HallRoom layout={layout} preset={preset} />
      </Suspense>
      <PlayerControls layout={layout} onMotionFrame={quality.sample} fadeRef={fadeRef} />
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

  return (
    <div className="absolute inset-0 bg-ink" data-testid="hall">
      <HallCanvas key={preset} preset={preset} layout={layout} fadeRef={fadeRef} />
      <div ref={fadeRef} className="pointer-events-none absolute inset-0 bg-ink opacity-0" aria-hidden="true" />
    </div>
  );
}
