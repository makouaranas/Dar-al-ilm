// Gilt cover designs for the desk books (white on transparent, used as a foil mask), 510 x 720.
import { appFonts, assertFontsLoaded } from "./fonts.mjs";
const { chromium } = await import(new URL("../../frontend/node_modules/@playwright/test/index.mjs", import.meta.url));
const OUT = process.argv[2];
const covers = [
  ["cover-muqaddimah", "The Muqaddimah", "An introduction to history", "Ibn Khaldun", "ltr"],
  ["cover-kalila", "كليلة ودمنة", "حكايات الحكمة", "ابن المقفع", "rtl"],
  ["cover-miserables", "Les Misérables", "Roman", "Victor Hugo", "ltr"],
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 510, height: 720 });
for (const [file, title, sub, author, dir] of covers) {
  const ar = dir === "rtl";
  const font = ar ? "Cairo" : "Inter";
  await page.setContent(`<html><head><style>
${appFonts()}
html, body { margin: 0; background: transparent; }
.f { position: absolute; inset: 26px; border: 3px solid white; }
.f2 { position: absolute; inset: 36px; border: 1px solid white; }
.c { position: absolute; inset: 36px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; color: white; font-family: ${font}; padding: 0 34px; }
.t { font-size: ${ar ? 62 : 50}px; font-weight: ${ar ? 700 : 600}; line-height: ${ar ? 1.5 : 1.15}; }
.r { width: 90px; height: 2px; background: white; margin: 30px 0 22px; }
.s { font-size: ${ar ? 26 : 21}px; font-weight: 400; opacity: 0.95; }
.a { position: absolute; bottom: 70px; left: 0; right: 0; text-align: center; font-size: ${ar ? 30 : 24}px; font-weight: 500; }
</style></head><body><div class="f"></div><div class="f2"></div>
<div class="c" dir="${dir}"><div class="t">${title}</div><div class="r"></div><div class="s">${sub}</div><div class="a">${author}</div></div>
</body></html>`);
  await assertFontsLoaded(page);
  await page.screenshot({ path: `${OUT}/${file}.png`, omitBackground: true });
}
await browser.close();
console.log("ok");
