// Spine label atlas drawn by Chromium: 8 columns x 32 rows of 512 x 64 cells, white text on
// transparent. Each cell is one spine label laid out horizontally; Blender rotates it onto the spine.
import { appFonts, assertFontsLoaded } from "./fonts.mjs";
const { chromium } = await import(new URL("../../frontend/node_modules/@playwright/test/index.mjs", import.meta.url));
const OUT = process.argv[2];
const BOOKS = [
  ["Pride and Prejudice", "Austen"], ["Moby-Dick", "Melville"], ["Middlemarch", "George Eliot"],
  ["Great Expectations", "Dickens"], ["The Odyssey", "Homer"], ["War and Peace", "Tolstoy"],
  ["Walden", "Thoreau"], ["Leaves of Grass", "Whitman"], ["Dracula", "Stoker"], ["Jane Eyre", "Brontë"],
  ["Frankenstein", "Shelley"], ["Bleak House", "Dickens"], ["The Republic", "Plato"],
  ["Meditations", "Marcus Aurelius"], ["On the Origin of Species", "Darwin"], ["The Wealth of Nations", "Smith"],
  ["Algorithms", "Volume I"], ["Compilers", "Principles"], ["Operating Systems", "Concepts"],
  ["Data Structures", "Second edition"], ["Linear Algebra", "Strang"], ["Discrete Mathematics", "Rosen"],
  ["Computer Networks", "Fifth edition"], ["Database Systems", "Volume II"], ["Distributed Systems", "Notes"],
  ["Graph Theory", "Diestel"], ["Calculus", "Spivak"], ["The C Programming Language", "Second edition"],
  ["Type Systems", "Lecture notes"], ["Information Theory", "Shannon"], ["Cryptography", "Handbook"],
  ["Numerical Recipes", "Third edition"],
  ["Les Misérables", "Hugo"], ["Madame Bovary", "Flaubert"], ["Le Rouge et le Noir", "Stendhal"],
  ["Candide", "Voltaire"], ["Notre-Dame de Paris", "Hugo"], ["Germinal", "Zola"], ["Le Père Goriot", "Balzac"],
  ["Les Fleurs du mal", "Baudelaire"], ["Histoire de France", "Michelet"], ["Essais", "Montaigne"],
  ["Pensées", "Pascal"], ["De la démocratie en Amérique", "Tocqueville"], ["Histoire romaine", "Mommsen"],
  ["Le Moyen Âge", "Tome II"], ["Les Croisades", "Grousset"], ["Al-Andalus", "Histoire"],
  ["المقدمة", "ابن خلدون"], ["كليلة ودمنة", "ابن المقفع"], ["ألف ليلة وليلة", "الجزء الأول"],
  ["رسالة الغفران", "المعري"], ["البيان والتبيين", "الجاحظ"], ["الأغاني", "الأصفهاني"],
  ["طوق الحمامة", "ابن حزم"], ["حي بن يقظان", "ابن طفيل"], ["مروج الذهب", "المسعودي"],
  ["الكامل في التاريخ", "ابن الأثير"], ["تاريخ الطبري", "الطبري"], ["الكتاب", "سيبويه"],
  ["لسان العرب", "ابن منظور"], ["رحلة ابن بطوطة", "ابن بطوطة"], ["الأيام", "طه حسين"],
  ["زقاق المدق", "نجيب محفوظ"],
];
const arabic = (s) => /[؀-ۿ]/.test(s);
const cells = [];
for (let variant = 0; variant < 4; variant++) {
  for (const [title, author] of BOOKS) cells.push({ title, author, variant });
}
const cellHtml = cells
  .map(({ title, author, variant }) => {
    const ar = arabic(title);
    const dir = ar ? "rtl" : "ltr";
    const font = ar ? "Cairo" : "Inter";
    const tw = ar ? 600 : 500;
    const ts = ar ? [34, 30, 34, 38][variant] : [28, 26, 28, 32][variant];
    const as = ar ? 22 : 19;
    const t = `<span class="t" style="font-size:${ts}px;font-weight:${variant === 3 ? tw + 100 : tw}">${title}</span>`;
    const a = `<span class="a" style="font-size:${as}px">${author}</span>`;
    const body = variant === 0 ? t + a : variant === 1 ? t : variant === 2 ? a + t : t;
    const justify = variant === 1 || variant === 3 ? "center" : "space-between";
    return `<div class="c" dir="${dir}" style="font-family:${font};justify-content:${justify}">${body}</div>`;
  })
  .join("");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 4096, height: 2048 });
await page.setContent(`<html><head><style>
${appFonts()}
html, body { margin: 0; background: transparent; }
.g { display: grid; grid-template-columns: repeat(8, 512px); grid-auto-rows: 64px; }
.c { box-sizing: border-box; display: flex; align-items: center; gap: 18px; padding: 0 34px; color: white;
  white-space: nowrap; overflow: hidden; line-height: 1; }
.a { font-weight: 400; opacity: 0.9; }
</style></head><body><div class="g">${cellHtml}</div></body></html>`);
await assertFontsLoaded(page);
// Shrink any title that overflows its cell.
await page.evaluate(() => {
  for (const c of document.querySelectorAll(".c")) {
    const t = c.querySelector(".t");
    let size = parseFloat(t.style.fontSize);
    while (c.scrollWidth > c.clientWidth && size > 14) {
      size -= 1;
      t.style.fontSize = `${size}px`;
    }
  }
});
await page.screenshot({ path: `${OUT}/spine-atlas.png`, omitBackground: true });
await browser.close();
console.log("ok", cells.length);
