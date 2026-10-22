// Mashrabiya tile mask drawn by Chromium (white bars on transparent, 1024 x 1024, one tile).
// An eight-point star tied to the square frame by eight spokes, so every bar is supported; the
// frame is a half bar on each edge, so neighbouring tiles join into full bars.
// Usage: node lattice.mjs <out dir>
import { writeFileSync } from "node:fs";
const { chromium } = await import(new URL("../../frontend/node_modules/@playwright/test/index.mjs", import.meta.url));
const OUT = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage();
const dataUrl = await page.evaluate(() => {
  const N = 1024;
  const bar = N * 0.055;
  const c = N / 2;
  const r = N * 0.4;
  const ri = (r * Math.cos(Math.PI / 4)) / Math.cos(Math.PI / 8);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const g = canvas.getContext("2d");
  g.fillStyle = g.strokeStyle = "white";
  g.lineWidth = bar;
  g.lineJoin = g.lineCap = "round";
  // Frame: a half bar along each edge.
  g.fillRect(0, 0, N, bar / 2);
  g.fillRect(0, N - bar / 2, N, bar / 2);
  g.fillRect(0, 0, bar / 2, N);
  g.fillRect(N - bar / 2, 0, bar / 2, N);
  // Star outline: 16 vertices alternating between the outer and inner radius.
  const star = [];
  for (let k = 0; k < 16; k++) {
    const rad = k % 2 === 0 ? r : ri;
    const a = (k * Math.PI) / 8;
    star.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]);
  }
  g.beginPath();
  star.forEach(([x, y], k) => (k === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.stroke();
  // Spokes: the points on the axes go to the edge midpoints, the diagonal points to the corners.
  for (let k = 0; k < 8; k++) {
    const [x, y] = star[2 * k];
    const a = (k * Math.PI) / 4;
    const tx = k % 2 === 0 ? c + c * Math.round(Math.cos(a)) : Math.cos(a) < 0 ? 0 : N;
    const ty = k % 2 === 0 ? c + c * Math.round(Math.sin(a)) : Math.sin(a) < 0 ? 0 : N;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(tx, ty);
    g.stroke();
  }
  return canvas.toDataURL("image/png");
});
writeFileSync(`${OUT}/lattice.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
await browser.close();
console.log("ok");
