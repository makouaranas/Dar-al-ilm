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

/** Resolves once the weights used on canvases are loaded (signs, spines, labels). */
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

// --- Signage (US-20): one sign grid for section headers, range plates and the directory ------

/**
 * The signs' physical size (metres) and canvas size (pixels). Every sign is drawn as a mask:
 * white where letters, rules and borders are cut, black elsewhere; the material supplies the
 * metal (dark bronze letters on the plaster band, engraved lines on brass).
 */
export const SIGN = {
  header: { width: 2.2, height: 0.5, canvasWidth: 1024, canvasHeight: 232 },
  plate: { width: 0.3, height: 0.2, canvasWidth: 600, canvasHeight: 400 },
} as const;

/**
 * The directory panel: a fixed width, and a height that fits its rows (the title block, one
 * 46 mm row per line of the longer column, at least three, then the bottom margin).
 */
export const DIRECTORY_PANEL = { width: 0.44, pixelsPerMetre: 1600, head: 0.095, row: 0.046, foot: 0.025, minRows: 3 } as const;

/**
 * The shared grid, in metres: one border, one margin, one rule and one type scale for every
 * sign, so the three levels read as one family. Header letters are seven times the plate's.
 */
export const SIGN_GRID = {
  /** Font size (em) of the category name on each level, and of secondary lines. */
  headerName: 0.3,
  plateName: 0.042,
  directoryName: 0.03,
  title: 0.036,
  secondary: 0.024,
  /** The etched border band (plates and directory) and the margin inside it. */
  borderOuter: 0.006,
  borderInner: 0.013,
  margin: 0.012,
  rule: 0.0016,
  /** Header letters keep this much plaster around them. */
  headerMargin: 0.08,
} as const;

/** Arabic is set slightly smaller in em than Latin: Cairo's letters are larger at one size. */
const ARABIC_EM = 0.92;

export interface SignText {
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

function signContext(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): CanvasRenderingContext2D {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.letterSpacing = "0px";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

/** A category name laid out to fit `maxWidth`, in its own script, weight and direction. */
function nameLayout(ctx: CanvasRenderingContext2D, name: string, em: number, maxWidth: number, maxLines: number): SignText {
  const script = scriptOf(name);
  const weight = script === "arabic" ? 700 : 600;
  const layout = layoutText(name, {
    maxWidth,
    baseSize: script === "arabic" ? em * ARABIC_EM : em,
    maxLines,
    minScale: 0.6,
    measure: measurer(ctx, script, weight),
  });
  return { layout, script, direction: script === "arabic" ? "rtl" : "ltr" };
}

/** Draw laid-out lines centred on `centerX`, the block centred on `centerY`; returns its height. */
function drawLines(ctx: CanvasRenderingContext2D, text: SignText, centerX: number, centerY: number, fill = "#fff"): number {
  const { layout, script, direction } = text;
  const weight = script === "arabic" ? 700 : 600;
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
  let baseline = centerY - block / 2 + ascent;
  ctx.fillStyle = fill;
  for (const line of layout.lines) {
    ctx.fillText(line, centerX, baseline);
    baseline += lineHeight;
  }
  ctx.restore();
  return block;
}

/**
 * Level 1: the section header over a bay's opening. Cut letters only (the plaster shows
 * between them), with a soft shadow below as if they stood 12 mm off the wall.
 */
export function drawHeaderMask(canvas: HTMLCanvasElement | OffscreenCanvas, name: string): SignText {
  const { canvasWidth: w, canvasHeight: h, width } = SIGN.header;
  const k = w / width;
  const ctx = signContext(canvas, w, h);
  const text = nameLayout(ctx, name, SIGN_GRID.headerName * k, w - 2 * SIGN_GRID.headerMargin * k, 2);
  ctx.save();
  ctx.shadowColor = "rgba(255, 255, 255, 0.32)";
  ctx.shadowOffsetY = 0.008 * k;
  ctx.shadowBlur = 0.01 * k;
  drawLines(ctx, text, w / 2, h / 2);
  ctx.restore();
  return text;
}

/** The etched border: two fine rules with an interlaced cord between them, stars at corners. */
function etchedBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number) {
  const outer = SIGN_GRID.borderOuter * k;
  const inner = SIGN_GRID.borderInner * k;
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = SIGN_GRID.rule * k;
  ctx.strokeRect(x + outer, y + outer, w - 2 * outer, h - 2 * outer);
  ctx.strokeRect(x + inner, y + inner, w - 2 * inner, h - 2 * inner);
  // Interlaced cord: two waves of opposite phase along the band's centre line.
  const mid = (outer + inner) / 2;
  const amplitude = (inner - outer) / 2 - SIGN_GRID.rule * k * 1.5;
  const period = (inner - outer) * 3;
  ctx.lineWidth = SIGN_GRID.rule * k * 0.8;
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
      for (let n = 0; n < 4; n += 1) {
        const a = rotation + Math.PI / 4 + (n * Math.PI) / 2;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        if (n === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A line of secondary text (counts, the directory's title and "more" line), centred. */
function drawSecondary(ctx: CanvasRenderingContext2D, text: string, size: number, centerX: number, baseline: number, weight = 500) {
  const script = scriptOf(text);
  ctx.save();
  ctx.direction = script === "arabic" ? "rtl" : "ltr";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = canvasFont(script, script === "arabic" ? weight + 100 : weight, script === "arabic" ? size * ARABIC_EM : size);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, centerX, baseline);
  ctx.restore();
}

/**
 * Level 2: a range plate on a bookcase end: the etched border, the category name (up to two
 * lines), a fine rule and the book count.
 */
export function drawPlateMask(canvas: HTMLCanvasElement | OffscreenCanvas, name: string, count: string): SignText {
  const { canvasWidth: w, canvasHeight: h, width } = SIGN.plate;
  const k = w / width;
  const ctx = signContext(canvas, w, h);
  etchedBorder(ctx, 0, 0, w, h, k);
  const inset = (SIGN_GRID.borderInner + SIGN_GRID.margin) * k;
  const text = nameLayout(ctx, name, SIGN_GRID.plateName * k, w - 2 * inset, 2);
  // Name in the upper part, the count below a short rule.
  const ruleY = h * 0.66;
  drawLines(ctx, text, w / 2, (inset + ruleY) / 2);
  ctx.fillStyle = "#fff";
  ctx.fillRect(w / 2 - 0.03 * k, ruleY - (SIGN_GRID.rule * k) / 2, 0.06 * k, SIGN_GRID.rule * k);
  drawSecondary(ctx, count, SIGN_GRID.secondary * k, w / 2, ruleY + (h - inset - ruleY) * 0.5 + SIGN_GRID.secondary * k * 0.35);
  return text;
}

// --- The directory --------------------------------------------------------------------------

export interface DirectoryEntry {
  categoryId: number;
  name: string;
  /** Which way the bay lies for someone reading the directory. */
  toward: "left" | "right";
}

export interface DirectoryLine {
  categoryId: number | null;
  text: string;
  toward: "left" | "right";
  truncated: boolean;
  /** Its rectangle on the canvas (pixels, y down): what a click on the panel hits. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface DirectoryPlan {
  /** Entries shown in each column (left: bays to the reader's left, right: to the right). */
  left: DirectoryEntry[];
  right: DirectoryEntry[];
  /** Entries left out of each column (shown as "and {n} more"). */
  moreLeft: number;
  moreRight: number;
}

/** Lines that fit in one directory column. */
export const DIRECTORY_ROWS = 13;

/** Rows the directory shows for this many bays on the reader's left and right. */
export function directoryRows(left: number, right: number): number {
  return Math.max(DIRECTORY_PANEL.minRows, Math.min(DIRECTORY_ROWS, Math.max(left, right)));
}

/** The directory panel's size in metres and pixels for `rows` rows. */
export function directorySize(rows: number): { width: number; height: number; canvasWidth: number; canvasHeight: number } {
  const { width, pixelsPerMetre: k, head, row, foot } = DIRECTORY_PANEL;
  const height = head + rows * row + foot;
  return { width, height, canvasWidth: Math.round(width * k), canvasHeight: Math.round((height * k) / 4) * 4 };
}

/**
 * The directory's two columns: the bays on the reader's left (arrows pointing left) and on the
 * right, each nearest first. A column with more bays than rows shows the first rows minus one,
 * then "and {n} more".
 */
export function planDirectory(entries: readonly DirectoryEntry[], rows: number = DIRECTORY_ROWS): DirectoryPlan {
  const fit = (list: DirectoryEntry[]) => (list.length <= rows ? { shown: list, more: 0 } : { shown: list.slice(0, rows - 1), more: list.length - (rows - 1) });
  const left = fit(entries.filter((entry) => entry.toward === "left"));
  const right = fit(entries.filter((entry) => entry.toward === "right"));
  return { left: left.shown, right: right.shown, moreLeft: left.more, moreRight: right.more };
}

/** A small engraved arrow pointing left or right, centred on (x, y). */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, toward: "left" | "right") {
  const s = toward === "left" ? -1 : 1;
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = size * 0.12;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - s * size * 0.5, y);
  ctx.lineTo(x + s * size * 0.5, y);
  ctx.moveTo(x + s * size * 0.15, y - size * 0.32);
  ctx.lineTo(x + s * size * 0.5, y);
  ctx.lineTo(x + s * size * 0.15, y + size * 0.32);
  ctx.stroke();
  ctx.restore();
}

/**
 * Level 3: the directory panel. The title, a rule, then two columns: names to the reader's left
 * start with a left arrow at the panel's left edge; names to the right end with a right arrow
 * at its right edge. Returns every line with its rectangle, for hit testing.
 */
export function drawDirectoryMask(canvas: HTMLCanvasElement | OffscreenCanvas, title: string, plan: DirectoryPlan, more: (count: number) => string): DirectoryLine[] {
  const rows = directoryRows(plan.left.length + (plan.moreLeft > 0 ? 1 : 0), plan.right.length + (plan.moreRight > 0 ? 1 : 0));
  const { canvasWidth: w, canvasHeight: h } = directorySize(rows);
  const k = DIRECTORY_PANEL.pixelsPerMetre;
  const ctx = signContext(canvas, w, h);
  etchedBorder(ctx, 0, 0, w, h, k);
  const inset = (SIGN_GRID.borderInner + SIGN_GRID.margin) * k;
  const titleSize = SIGN_GRID.title * k;
  const titleBaseline = inset + titleSize * 1.05;
  drawSecondary(ctx, title, titleSize, w / 2, titleBaseline, 600);
  const ruleY = titleBaseline + titleSize * 0.55;
  ctx.fillStyle = "#fff";
  ctx.fillRect(inset, ruleY, w - 2 * inset, SIGN_GRID.rule * k);

  const top = DIRECTORY_PANEL.head * k;
  const rowHeight = DIRECTORY_PANEL.row * k;
  const gutter = SIGN_GRID.margin * k;
  const columnWidth = (w - 2 * inset - gutter) / 2;
  const arrowSize = SIGN_GRID.directoryName * k * 0.7;
  const lines: DirectoryLine[] = [];
  for (const toward of ["left", "right"] as const) {
    const shown = toward === "left" ? plan.left : plan.right;
    const extra = toward === "left" ? plan.moreLeft : plan.moreRight;
    const x0 = toward === "left" ? inset : inset + columnWidth + gutter;
    const texts: { categoryId: number | null; text: string }[] = shown.map((entry) => ({ categoryId: entry.categoryId, text: entry.name }));
    if (extra > 0) texts.push({ categoryId: null, text: more(extra) });
    texts.forEach((item, row) => {
      const y = top + row * rowHeight;
      const centerY = y + rowHeight / 2;
      // The arrow sits at the column's outer edge, the name next to it.
      const arrowX = toward === "left" ? x0 + arrowSize * 0.5 : x0 + columnWidth - arrowSize * 0.5;
      if (item.categoryId !== null) arrow(ctx, arrowX, centerY, arrowSize, toward);
      const textWidth = columnWidth - arrowSize * 1.6;
      const script = scriptOf(item.text);
      const weight = item.categoryId === null ? 500 : script === "arabic" ? 700 : 600;
      const em = SIGN_GRID.directoryName * k * (item.categoryId === null ? 0.8 : 1);
      const layout = layoutText(item.text, {
        maxWidth: textWidth,
        baseSize: script === "arabic" ? em * ARABIC_EM : em,
        maxLines: 1,
        minScale: 0.6,
        measure: measurer(ctx, script, weight),
      });
      ctx.save();
      ctx.direction = script === "arabic" ? "rtl" : "ltr";
      ctx.textBaseline = "middle";
      ctx.font = canvasFont(script, weight, layout.size);
      ctx.fillStyle = "#fff";
      // Names lean toward their arrow: left column aligned left, right column aligned right.
      if (toward === "left") {
        ctx.textAlign = "left";
        ctx.fillText(layout.lines[0]!, x0 + arrowSize * 1.6, centerY);
      } else {
        ctx.textAlign = "right";
        ctx.fillText(layout.lines[0]!, x0 + columnWidth - arrowSize * 1.6, centerY);
      }
      ctx.restore();
      lines.push({ categoryId: item.categoryId, text: layout.lines[0]!, toward, truncated: layout.truncated, rect: { x: x0, y, width: columnWidth, height: rowHeight } });
    });
  }
  return lines;
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
