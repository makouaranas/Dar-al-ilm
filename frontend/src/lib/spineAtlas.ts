/**
 * Spine label atlases (docs/ARCHITECTURE.md section 10.5).
 *
 * Every book's title and author are drawn into a cell of a 2048 x 2048 atlas, stored as one
 * single-channel (R8) layer of a texture array: 4 MB per layer instead of 16 MB for RGBA. The
 * spine shader mixes the label colour over the cloth by that mask. Layers are built only for
 * bays within 18 m of the camera and released beyond 25 m, nearest first, up to the preset's
 * limit; far bays show plain coloured spines.
 */

import * as THREE from "three";

import type { GraphicsQuality } from "@/lib/api";
import { canvasFont, layoutText, scriptOf } from "@/lib/canvasText";

export const ATLAS_SIZE = 2048;
export const BUILD_DISTANCE = 18;
export const RELEASE_DISTANCE = 25;

export interface AtlasConfig {
  cellWidth: number;
  cellHeight: number;
  /** Atlas layers resident on the GPU at most. */
  layers: number;
}

export const ATLAS_CONFIG: Record<GraphicsQuality, AtlasConfig> = {
  performance: { cellWidth: 256, cellHeight: 32, layers: 4 },
  auto: { cellWidth: 512, cellHeight: 64, layers: 8 },
  high: { cellWidth: 512, cellHeight: 64, layers: 12 },
};

export function cellsPerLayer(config: AtlasConfig): number {
  return Math.floor(ATLAS_SIZE / config.cellWidth) * Math.floor(ATLAS_SIZE / config.cellHeight);
}

export interface SpineLabel {
  id: number;
  title: string;
  author: string | null;
  /** Spine thickness and height in metres (its aspect ratio decides the label region). */
  thickness: number;
  height: number;
}

/**
 * The label region inside a cell, keeping the spine's aspect ratio (height along the cell's
 * width, thickness across), so text is never stretched.
 */
export function labelRegion(label: Pick<SpineLabel, "thickness" | "height">, config: AtlasConfig): { width: number; height: number } {
  const aspect = label.height / label.thickness;
  if (aspect * config.cellHeight <= config.cellWidth) {
    return { width: Math.floor(aspect * config.cellHeight), height: config.cellHeight };
  }
  return { width: config.cellWidth, height: Math.max(8, Math.floor(config.cellWidth / aspect)) };
}

// --- Colour ------------------------------------------------------------------------------

export const GILT = "#D8B77A";
export const INK = "#1E2230";

function luminance(color: THREE.Color): number {
  // The colour's components are linear already (three.js colour management).
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Gilt on dark spines, ink on light ones: whichever contrasts more (DESIGN.md section 5). */
export function labelInk(cloth: THREE.Color): "gilt" | "ink" {
  const l = luminance(cloth);
  return contrast(l, luminance(new THREE.Color(GILT))) >= contrast(l, luminance(new THREE.Color(INK))) ? "gilt" : "ink";
}

// --- Planning which bays get atlas pages ----------------------------------------------------

export interface AtlasBay {
  key: string;
  /** Nearest point of the bay to measure the camera distance from. */
  x: number;
  z: number;
  labels: SpineLabel[];
}

export interface AtlasPage {
  /** `${bay key}:${chunk}`. */
  key: string;
  bay: string;
  labels: SpineLabel[];
  distance: number;
}

/** Split each bay's labels into pages of one layer each. */
export function atlasPages(bays: readonly AtlasBay[], camera: { x: number; z: number }, config: AtlasConfig): AtlasPage[] {
  const perLayer = cellsPerLayer(config);
  const pages: AtlasPage[] = [];
  for (const bay of bays) {
    const distance = Math.hypot(bay.x - camera.x, bay.z - camera.z);
    for (let start = 0, chunk = 0; start < bay.labels.length; start += perLayer, chunk += 1) {
      pages.push({ key: `${bay.key}:${chunk}`, bay: bay.key, labels: bay.labels.slice(start, start + perLayer), distance });
    }
  }
  return pages;
}

/**
 * Which pages should be resident: within 18 m (or already resident and within 25 m), nearest
 * first, at most `config.layers`.
 */
export function planResident(pages: readonly AtlasPage[], resident: ReadonlySet<string>, config: AtlasConfig): string[] {
  return pages
    .filter((page) => page.distance <= BUILD_DISTANCE || (resident.has(page.key) && page.distance <= RELEASE_DISTANCE))
    .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
    .slice(0, config.layers)
    .map((page) => page.key);
}

// --- Drawing --------------------------------------------------------------------------------

/**
 * Draw one spine label (white on black) in the region (x, y, w, h): the title at the start,
 * the author smaller at the end, each script in its own direction. On the spine the region is
 * turned 90 degrees clockwise, so the shelf shares one orientation.
 */
export function drawSpineLabel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: SpineLabel): void {
  const pad = Math.max(3, h * 0.18);
  const titleScript = scriptOf(label.title);
  const author = label.author?.trim() ?? "";
  const authorScript = scriptOf(author || label.title);
  const usable = w - 2 * pad;
  const authorShare = author ? 0.32 : 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";

  const titleWeight = titleScript === "arabic" ? 600 : 500;
  const titleLayout = layoutText(label.title, {
    maxWidth: usable * (1 - authorShare) - (author ? pad : 0),
    baseSize: h * 0.52,
    maxLines: 1,
    minScale: 0.55,
    measure: (text, size) => {
      ctx.font = canvasFont(titleScript, titleWeight, size);
      return ctx.measureText(text).width;
    },
  });
  ctx.font = canvasFont(titleScript, titleWeight, titleLayout.size);
  ctx.direction = titleScript === "arabic" ? "rtl" : "ltr";
  // "start" is the left edge for Latin and the right edge for Arabic.
  ctx.textAlign = "start";
  ctx.fillText(titleLayout.lines[0] ?? "", titleScript === "arabic" ? x + w - pad : x + pad, y + h / 2 + 1);

  if (author) {
    const authorWeight = authorScript === "arabic" ? 600 : 500;
    const authorLayout = layoutText(author, {
      maxWidth: usable * authorShare,
      baseSize: h * 0.36,
      maxLines: 1,
      minScale: 0.6,
      measure: (text, size) => {
        ctx.font = canvasFont(authorScript, authorWeight, size);
        return ctx.measureText(text).width;
      },
    });
    ctx.font = canvasFont(authorScript, authorWeight, authorLayout.size);
    ctx.direction = titleScript === "arabic" ? "rtl" : "ltr";
    ctx.textAlign = "end";
    ctx.globalAlpha = 0.85;
    ctx.fillText(authorLayout.lines[0] ?? "", titleScript === "arabic" ? x + pad : x + w - pad, y + h / 2 + 1);
  }
  ctx.restore();
}

export interface AtlasEntry {
  layer: number;
  /** u0, v0, du, dv in texture coordinates (v0 is the region's top row). */
  rect: [number, number, number, number];
}

/**
 * The atlas texture array plus the canvas used to draw a layer. `build` draws a page into a
 * free layer and uploads only that layer.
 */
export class SpineAtlas {
  readonly config: AtlasConfig;
  readonly texture: THREE.DataArrayTexture;
  readonly entries = new Map<number, AtlasEntry>();
  /** Page key -> layer. */
  readonly pages = new Map<string, number>();
  private readonly data: Uint8Array;
  private canvas: HTMLCanvasElement | null = null;
  private listeners = new Set<() => void>();
  builds = 0;
  releases = 0;

  constructor(config: AtlasConfig) {
    this.config = config;
    this.data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * config.layers);
    this.texture = new THREE.DataArrayTexture(this.data, ATLAS_SIZE, ATLAS_SIZE, config.layers);
    this.texture.format = THREE.RedFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.texture.needsUpdate = true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  freeLayer(): number | null {
    const used = new Set(this.pages.values());
    for (let layer = 0; layer < this.config.layers; layer += 1) if (!used.has(layer)) return layer;
    return null;
  }

  /** Draw `page` into a free layer and upload it. Returns false if no layer is free. */
  build(page: AtlasPage): boolean {
    if (this.pages.has(page.key)) return true;
    const layer = this.freeLayer();
    if (layer === null) return false;
    const { cellWidth, cellHeight } = this.config;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = ATLAS_SIZE;
      this.canvas.height = ATLAS_SIZE;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.letterSpacing = "0px";
    const columns = Math.floor(ATLAS_SIZE / cellWidth);
    const placed: [number, AtlasEntry][] = [];
    page.labels.forEach((label, index) => {
      const x = (index % columns) * cellWidth;
      const y = Math.floor(index / columns) * cellHeight;
      const region = labelRegion(label, this.config);
      const ry = y + Math.floor((cellHeight - region.height) / 2);
      drawSpineLabel(ctx, x, ry, region.width, region.height, label);
      placed.push([
        label.id,
        { layer, rect: [x / ATLAS_SIZE, ry / ATLAS_SIZE, region.width / ATLAS_SIZE, region.height / ATLAS_SIZE] },
      ]);
    });
    const pixels = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
    const offset = layer * ATLAS_SIZE * ATLAS_SIZE;
    for (let i = 0, j = 0; i < ATLAS_SIZE * ATLAS_SIZE; i += 1, j += 4) this.data[offset + i] = pixels[j]!;
    this.texture.addLayerUpdate(layer);
    this.texture.needsUpdate = true;
    this.pages.set(page.key, layer);
    for (const [id, entry] of placed) this.entries.set(id, entry);
    this.builds += 1;
    this.emit();
    return true;
  }

  /** Free a page's layer; its books go back to plain spines. */
  release(key: string): void {
    const layer = this.pages.get(key);
    if (layer === undefined) return;
    this.pages.delete(key);
    for (const [id, entry] of this.entries) if (entry.layer === layer) this.entries.delete(id);
    this.releases += 1;
    this.emit();
  }

  dispose(): void {
    this.texture.dispose();
    this.listeners.clear();
    this.canvas = null;
  }
}
