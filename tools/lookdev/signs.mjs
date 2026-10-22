// Signage masks drawn by Chromium (white on transparent): section headers, range plates and the
// entrance directory. Usage: node signs.mjs <out dir> [counts.json]
import { readFileSync, existsSync } from "node:fs";
const { chromium } = await import(new URL("../../frontend/node_modules/@playwright/test/index.mjs", import.meta.url));
const OUT = process.argv[2];
const counts = process.argv[3] && existsSync(process.argv[3]) ? JSON.parse(readFileSync(process.argv[3], "utf8")) : {};
const FONTS = new URL("../../frontend/public/fonts", import.meta.url).pathname;
// key, name, side (-1 left of the nave, 1 right), order from the entrance
const SECTIONS = [
  ["programming", "Programming", -1, 1],
  ["histoire", "Histoire", 1, 1],
  ["novels", "Novels", -1, 2],
  ["arabic", "العربية", 1, 2],
];
const isArabic = (s) => /[؀-ۿ]/.test(s);
const css = `
@font-face { font-family: Inter; src: url(file://${FONTS}/inter/InterVariable.woff2); font-weight: 100 900; }
@font-face { font-family: Cairo; src: url(file://${FONTS}/cairo/CairoVariable.woff2); font-weight: 100 900; }
html, body { margin: 0; background: transparent; color: white; }
* { box-sizing: border-box; }
.n { white-space: nowrap; }
`;
const nameSpan = (name, latinPx, weight = 600) => {
  const ar = isArabic(name);
  return `<bdi class="n" dir="${ar ? "rtl" : "ltr"}" style="font-family:${ar ? "Cairo" : "Inter"};font-weight:${ar ? 700 : weight};font-size:${ar ? Math.round(latinPx * 1.12) : latinPx}px">${name}</bdi>`;
};
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function shot(width, height, body, file) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><head><style>${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  // Shrink any name that overflows its box.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-fit]")) {
      const n = el.querySelector(".n");
      let size = parseFloat(n.style.fontSize);
      while (n.getBoundingClientRect().width > el.clientWidth && size > 12) {
        size -= 2;
        n.style.fontSize = `${size}px`;
      }
    }
  });
  await page.screenshot({ path: `${OUT}/${file}`, omitBackground: true });
}

for (const [key, name] of SECTIONS) {
  // Section header: cut letters above the arcade beam, 2048 x 466 (2.2 m x 0.5 m).
  await shot(2048, 466, `<div data-fit style="width:2048px;height:466px;padding:0 60px;display:flex;align-items:center;justify-content:center;line-height:1">${nameSpan(name, 236)}</div>`, `sign-header-${key}.png`);
  // Range plate: 640 x 640 (0.26 m x 0.26 m) — name, rule, book count, inside a fine engraved frame.
  const n = counts[key];
  const count = n === undefined ? "" : `${n} ${n === 1 ? "book" : "books"}`;
  await shot(640, 640, `
    <div style="position:absolute;inset:34px;border:4px solid white"></div>
    <div style="position:absolute;inset:48px;border:1.5px solid white"></div>
    <div style="position:absolute;inset:48px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 40px">
      <div data-fit style="width:100%;display:flex;justify-content:center;line-height:1.25">${nameSpan(name, 84)}</div>
      <div style="width:96px;height:4px;background:white;margin:34px 0 30px"></div>
      <div style="font-family:Inter;font-weight:500;font-size:40px;font-variant-numeric:tabular-nums">${count}</div>
    </div>`, `sign-range-${key}.png`);
}

// Entrance directory: 840 x 1100 (0.42 m x 0.55 m), sections in order from the entrance.
const rows = [...SECTIONS]
  .sort((a, b) => a[3] - b[3] || a[2] - b[2])
  .map(([, name, side]) => `
    <div style="display:flex;align-items:center;gap:30px;height:150px;border-bottom:2px solid white">
      <div style="width:64px;font-family:Inter;font-weight:500;font-size:60px;text-align:center">${side < 0 ? "←" : "→"}</div>
      <div data-fit style="flex:1;line-height:1.2">${nameSpan(name, 58, 500)}</div>
    </div>`)
  .join("");
await shot(840, 1100, `
  <div style="position:absolute;inset:34px;border:4px solid white"></div>
  <div style="position:absolute;inset:48px;border:1.5px solid white"></div>
  <div style="position:absolute;inset:48px;padding:80px 70px 0">
    <div style="font-family:Inter;font-weight:600;font-size:72px;line-height:1">Sections</div>
    <div style="height:4px;background:white;margin:46px 0 10px"></div>
    ${rows}
  </div>`, "sign-directory.png");
await browser.close();
console.log("ok");
