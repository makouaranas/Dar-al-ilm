/**
 * Text for the 3D scene, drawn on 2D canvases (docs/ARCHITECTURE.md section 10.7).
 *
 * The browser's own text engine shapes Arabic (right to left, joined letters) and Latin text
 * offline with the bundled fonts; the canvas then becomes a texture. Text is drawn only after
 * `document.fonts.load()` has resolved, because text drawn with a fallback font would stay
 * baked into the texture. Arabic is never letter-spaced.
 */

export type Script = "arabic" | "latin";

/** First strong character decides: Arabic letters, or anything else (Latin, digits...). */
export function scriptOf(text: string): Script {
  for (const char of text) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(char)) return "arabic";
    if (/\p{L}/u.test(char)) return "latin";
  }
  return "latin";
}

const families = { inter: "Inter", cairo: "Cairo" };

/** The CSS font-family values next/font generated for the bundled Inter and Cairo. */
export function setCanvasFonts(inter: string, cairo: string): void {
  families.inter = inter;
  families.cairo = cairo;
  fontsLoading = null;
}

/** A canvas font string: Latin in Inter, Arabic in Cairo, each falling back to the other. */
export function canvasFont(script: Script, weight: number, size: number): string {
  const stack = script === "arabic" ? `${families.cairo}, ${families.inter}` : `${families.inter}, ${families.cairo}`;
  return `${weight} ${Math.round(size * 10) / 10}px ${stack}`;
}

let fontsLoading: Promise<void> | null = null;
let fontsLoaded = false;

/** Resolves once the weights used on canvases are loaded (plaques, spines, labels). */
export function ensureCanvasFonts(): Promise<void> {
  if (fontsLoading) return fontsLoading;
  if (typeof document === "undefined" || !document.fonts) {
    fontsLoaded = true;
    return Promise.resolve();
  }
  const faces = [
    canvasFont("latin", 600, 64),
    canvasFont("latin", 500, 64),
    canvasFont("arabic", 700, 64),
    canvasFont("arabic", 600, 64),
  ];
  fontsLoading = Promise.all(faces.map((font) => document.fonts.load(font, "Abc العربية 123")))
    .then(() => {
      fontsLoaded = true;
    })
    .catch(() => {
      // A failed load still lets the scene draw (with the fallback); never block the hall.
      fontsLoaded = true;
    });
  return fontsLoading;
}

export function canvasFontsReady(): boolean {
  return fontsLoaded;
}

// --- Layout: shrink to fit, wrap to two lines, then truncate --------------------------------

export interface TextLayout {
  lines: string[];
  /** Font size used, in pixels, and its ratio to the base size. */
  size: number;
  scale: number;
  truncated: boolean;
}

export interface LayoutOptions {
  maxWidth: number;
  baseSize: number;
  maxLines?: number;
  /** Smallest allowed size as a fraction of the base size (0.6 = 60 %). */
  minScale?: number;
  /** Width of `text` at font size `size` (pixels). */
  measure: (text: string, size: number) => number;
}

const ELLIPSIS = "…";
const STEPS = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5];

/** The longest prefix of `text` (whole code points) that fits with an ellipsis. */
function truncate(text: string, fits: (candidate: string) => boolean): string {
  const chars = Array.from(text.trimEnd());
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join("").trimEnd() + ELLIPSIS)) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").trimEnd() + ELLIPSIS;
}

/**
 * Lay out a label: one line, shrinking to 80 %; otherwise two balanced lines shrinking down
 * to `minScale`; otherwise two lines at `minScale` with the second truncated by an ellipsis.
 */
export function layoutText(text: string, options: LayoutOptions): TextLayout {
  const { maxWidth, baseSize, measure } = options;
  const maxLines = options.maxLines ?? 2;
  const minScale = options.minScale ?? 0.6;
  const clean = text.trim().replace(/\s+/g, " ");
  const scales = STEPS.filter((s) => s >= minScale - 1e-9);
  const singleScales = maxLines > 1 ? scales.filter((s) => s >= 0.8 - 1e-9) : scales;

  for (const scale of singleScales) {
    if (measure(clean, baseSize * scale) <= maxWidth) return { lines: [clean], size: baseSize * scale, scale, truncated: false };
  }
  const words = clean.split(" ");
  if (maxLines > 1 && words.length > 1) {
    for (const scale of scales.filter((s) => s <= 0.85 + 1e-9)) {
      const size = baseSize * scale;
      let best: { lines: string[]; width: number } | null = null;
      for (let i = 1; i < words.length; i += 1) {
        const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
        const width = Math.max(...lines.map((line) => measure(line, size)));
        if (!best || width < best.width) best = { lines, width };
      }
      if (best && best.width <= maxWidth) return { lines: best.lines, size, scale, truncated: false };
    }
  }
  // Too long even at the smallest size: fill the first line, truncate the last one.
  const size = baseSize * minScale;
  const fits = (candidate: string) => measure(candidate, size) <= maxWidth;
  if (maxLines > 1 && words.length > 1) {
    let count = 0;
    while (count < words.length - 1 && fits(words.slice(0, count + 1).join(" "))) count += 1;
    if (count > 0) {
      const rest = words.slice(count).join(" ");
      return { lines: [words.slice(0, count).join(" "), fits(rest) ? rest : truncate(rest, fits)], size, scale: minScale, truncated: !fits(rest) };
    }
  }
  return { lines: [fits(clean) ? clean : truncate(clean, fits)], size, scale: minScale, truncated: !fits(clean) };
}

// --- Plaques -------------------------------------------------------------------------------

/** Plaque canvas: two faces stacked (front on top, back below), 1.1 x 0.42 m each. */
export const PLAQUE_FACE = { width: 768, height: 294 } as const;
export const PLAQUE_SIZE = { width: 1.1, height: 0.42 } as const;

export interface PlaqueDrawing {
  layout: TextLayout;
  script: Script;
  direction: "ltr" | "rtl";
}

function measurer(ctx: CanvasRenderingContext2D, script: Script, weight: number) {
  return (text: string, size: number) => {
    ctx.font = canvasFont(script, weight, size);
    return ctx.measureText(text).width;
  };
}

/** Brushed brass grain: a near-white base the material's brass colour shows through. */
function brushed(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number) {
  ctx.fillStyle = "#f4f2ee";
  ctx.fillRect(x, y, w, h);
  let state = seed * 9301 + 49297;
  const random = () => ((state = (state * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < h * 1.4; i += 1) {
    const yy = y + random() * h;
    ctx.fillStyle = random() > 0.5 ? `rgba(255,255,255,${0.05 + random() * 0.12})` : `rgba(60,45,20,${0.02 + random() * 0.05})`;
    ctx.fillRect(x + random() * w * 0.3, yy, w * (0.4 + random() * 0.6), 1);
  }
}

/** The etched border: two fine rules with an interlaced cord between them, stars at corners. */
function etchedBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const ink = "rgba(43, 33, 22, 0.85)";
  const outer = 12;
  const inner = 26;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(x + outer, y + outer, w - 2 * outer, h - 2 * outer);
  ctx.strokeRect(x + inner, y + inner, w - 2 * inner, h - 2 * inner);
  // Interlaced cord: two waves of opposite phase along the band's centre line.
  const mid = (outer + inner) / 2;
  const amplitude = (inner - outer) / 2 - 2.5;
  const period = 22;
  ctx.lineWidth = 1.3;
  const edges: [number, number, number, number][] = [
    [x + inner, y + mid, x + w - inner, y + mid],
    [x + inner, y + h - mid, x + w - inner, y + h - mid],
    [x + mid, y + inner, x + mid, y + h - inner],
    [x + w - mid, y + inner, x + w - mid, y + h - inner],
  ];
  for (const [x0, y0, x1, y1] of edges) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const [ux, uy] = [(x1 - x0) / length, (y1 - y0) / length];
    for (const phase of [0, Math.PI]) {
      ctx.beginPath();
      for (let s = 0; s <= length; s += 2) {
        const offset = amplitude * Math.sin((2 * Math.PI * s) / period + phase);
        const px = x0 + ux * s - uy * offset;
        const py = y0 + uy * s + ux * offset;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
  // An eight-point star (two squares) in each corner of the band.
  const r = (inner - outer) / 2 + 1;
  for (const [cx, cy] of [
    [x + mid, y + mid],
    [x + w - mid, y + mid],
    [x + mid, y + h - mid],
    [x + w - mid, y + h - mid],
  ] as const) {
    for (const rotation of [0, Math.PI / 4]) {
      ctx.beginPath();
      for (let k = 0; k < 4; k += 1) {
        const a = rotation + Math.PI / 4 + (k * Math.PI) / 2;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** One face: brushed brass, the etched border and the engraved, ink-filled category name. */
function drawFace(ctx: CanvasRenderingContext2D, y0: number, text: string, seed: number): PlaqueDrawing {
  const { width: w, height: h } = PLAQUE_FACE;
  brushed(ctx, 0, y0, w, h, seed);
  etchedBorder(ctx, 0, y0, w, h);

  const script = scriptOf(text);
  const weight = script === "arabic" ? 700 : 600;
  const padding = 52;
  const layout = layoutText(text, {
    maxWidth: w - 2 * padding,
    baseSize: script === "arabic" ? 92 : 100,
    minScale: 0.6,
    measure: measurer(ctx, script, weight),
  });
  const direction = script === "arabic" ? "rtl" : "ltr";
  ctx.save();
  ctx.direction = direction;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = canvasFont(script, weight, layout.size);
  // Line boxes from the font's own metrics, so Arabic and Latin both centre optically.
  const metrics = layout.lines.map((line) => ctx.measureText(line));
  const ascent = Math.max(...metrics.map((m) => m.actualBoundingBoxAscent));
  const descent = Math.max(...metrics.map((m) => m.actualBoundingBoxDescent));
  const lineHeight = layout.size * (script === "arabic" ? 1.18 : 1.08);
  const block = ascent + descent + lineHeight * (layout.lines.length - 1);
  let baseline = y0 + h / 2 - block / 2 + ascent;
  for (const line of layout.lines) {
    // Engraved: a light lip under the cut, then the ink fill.
    ctx.fillStyle = "rgba(255, 246, 225, 0.55)";
    ctx.fillText(line, w / 2, baseline + 1.6);
    ctx.fillStyle = "#2b2116";
    ctx.fillText(line, w / 2, baseline);
    baseline += lineHeight;
  }
  ctx.restore();
  return { layout, script, direction };
}

/** Draw both faces of a plaque onto `canvas` (resized to 768 x 588). */
export function drawPlaque(canvas: HTMLCanvasElement | OffscreenCanvas, text: string, seed = 1): PlaqueDrawing {
  canvas.width = PLAQUE_FACE.width;
  canvas.height = PLAQUE_FACE.height * 2;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.letterSpacing = "0px";
  const front = drawFace(ctx, 0, text, seed);
  drawFace(ctx, PLAQUE_FACE.height, text, seed + 7);
  return front;
}

/** A small label (the ghost "Add book" slot): ink text on paper with a plus sign. */
export function drawLabel(canvas: HTMLCanvasElement, text: string, width = 512, height = 128): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const script = scriptOf(text);
  ctx.clearRect(0, 0, width, height);
  const r = height / 2;
  ctx.fillStyle = "rgba(246, 245, 242, 0.92)";
  ctx.beginPath();
  ctx.roundRect(2, 2, width - 4, height - 4, r - 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(44, 76, 156, 0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.direction = script === "arabic" ? "rtl" : "ltr";
  ctx.font = canvasFont(script, script === "arabic" ? 600 : 500, height * 0.36);
  ctx.fillStyle = "#2c4c9c";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`+  ${text}`, width / 2, height / 2 + 2);
}
