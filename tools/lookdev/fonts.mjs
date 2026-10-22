// @font-face rules with the fonts embedded as data URLs. Pages built with setContent() run on
// about:blank, where Chromium refuses file:// font URLs (the text would silently fall back to
// a system font).
import { readFileSync } from "node:fs";

const APP_FONTS = new URL("../../frontend/public/fonts/", import.meta.url).pathname;

export function fontFace(family, file, weight = "100 900") {
  const data = readFileSync(file).toString("base64");
  return `@font-face { font-family: ${family}; src: url(data:font/woff2;base64,${data}) format("woff2"); font-weight: ${weight}; }`;
}

/** Inter and Cairo, the app's own fonts (variable). */
export function appFonts() {
  return [fontFace("Inter", `${APP_FONTS}inter/InterVariable.woff2`), fontFace("Cairo", `${APP_FONTS}cairo/CairoVariable.woff2`)].join("\n");
}

/**
 * Fails loudly when a face the page uses could not load, instead of rendering with a fallback
 * font. (Faces the page never uses stay "unloaded", which is fine.)
 */
export async function assertFontsLoaded(page) {
  const failed = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "error").map((f) => `${f.family} ${f.weight}: ${f.status}`);
  });
  if (failed.length) throw new Error(`fonts not loaded: ${failed.join(", ")}`);
}
