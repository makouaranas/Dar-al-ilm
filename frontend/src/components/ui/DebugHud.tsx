"use client";

/**
 * Developer overlay, toggled with F2 (docs/ARCHITECTURE.md section 10.8): FPS and frame time
 * measured during motion, the renderer's counters, the pixel ratio and quality level. It is
 * the tool for checking real GPU performance on physical hardware. It polls plain objects
 * four times a second and never asks the canvas for a frame.
 */

import { useEffect, useState } from "react";

import { qualityStats } from "@/hooks/useAdaptiveQuality";
import { currentRenderInfo, frameCount } from "@/lib/testApi";

interface Snapshot {
  fps: number | null;
  medianMs: number | null;
  lastMs: number | null;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  dpr: number;
  level: string;
  preset: string;
  frames: number;
}

function snapshot(): Snapshot {
  const info = currentRenderInfo();
  return {
    fps: qualityStats.medianMs ? 1000 / qualityStats.medianMs : qualityStats.lastMs ? 1000 / qualityStats.lastMs : null,
    medianMs: qualityStats.medianMs,
    lastMs: qualityStats.lastMs,
    calls: info?.calls ?? 0,
    triangles: info?.triangles ?? 0,
    textures: info?.textures ?? 0,
    geometries: info?.geometries ?? 0,
    dpr: qualityStats.dpr,
    level: `${qualityStats.level + 1}/${qualityStats.levels}`,
    preset: qualityStats.preset,
    frames: frameCount(),
  };
}

const fixed = (value: number | null, digits = 1) => (value === null ? "–" : value.toFixed(digits));

export function DebugHud() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Snapshot | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setStats(snapshot());
    const timer = setInterval(() => setStats(snapshot()), 250);
    return () => clearInterval(timer);
  }, [open]);

  if (!open || !stats) return null;

  const rows: [string, string][] = [
    ["FPS (motion)", fixed(stats.fps, 0)],
    ["frame ms (median)", fixed(stats.medianMs)],
    ["frame ms (last)", fixed(stats.lastMs)],
    ["draw calls", String(stats.calls)],
    ["triangles", stats.triangles.toLocaleString("en-US")],
    ["textures", String(stats.textures)],
    ["geometries", String(stats.geometries)],
    ["dpr", stats.dpr.toFixed(2)],
    ["level", stats.level],
    ["preset", stats.preset],
    ["frames", String(stats.frames)],
  ];

  return (
    <div
      data-testid="debug-hud"
      dir="ltr"
      className="pointer-events-none absolute end-5 top-20 z-20 min-w-52 rounded-control bg-ink/80 px-3 py-2.5 font-mono text-12 leading-5 text-paper"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-6">
          <span className="text-limestone/70">{label}</span>
          <span className="tabular" data-stat={label}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
