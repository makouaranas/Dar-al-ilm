import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category } from "../src/lib/api";
import type { Box } from "../src/lib/hallLayout";

// US-19: the hall's architecture (arcade, clerestory, skylight wells, lattice windows).
const SHOTS = "e2e/screenshots/us-19";
mkdirSync(SHOTS, { recursive: true });

const RADIUS = 0.3;
const ARCADE_X = 2.4;

async function openHall(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    () => (window.__DAR__?.renderInfo()?.calls ?? 0) > 0 && window.__DAR__?.extra.hall !== undefined,
    null,
    { timeout: 60_000 },
  );
  // Textures load behind Suspense: wait until the room itself is drawn (more than a few calls).
  await page.waitForFunction(() => window.__DAR__!.renderInfo()!.calls >= 10, null, { timeout: 60_000 });
}

const pose = (page: Page) => page.evaluate(() => window.__DAR__!.extra.hall!.pose());
const colliders = (page: Page) => page.evaluate(() => window.__DAR__!.extra.hall!.colliders());

async function teleport(page: Page, x: number, z: number, yaw: number, pitch = 0): Promise<void> {
  await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, yaw, pitch]);
}

/**
 * Hold `key` until the camera passes `done` or stops moving (blocked), whatever the frame rate
 * (software rendering here draws a few frames per second).
 */
async function walkUntil(page: Page, key: string, done: (p: { x: number; z: number }) => boolean): Promise<void> {
  await page.keyboard.down(key);
  let last = await pose(page);
  let still = 0;
  for (let i = 0; i < 80 && still < 4; i += 1) {
    await page.waitForTimeout(300);
    const p = await pose(page);
    if (done(p)) break;
    still = Math.hypot(p.x - last.x, p.z - last.z) < 1e-4 ? still + 1 : 0;
    last = p;
  }
  await page.keyboard.up(key);
}

async function waitStill(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__DAR__!.extra.hall!.pose().moving && !window.__DAR__!.extra.hall!.pose().flying, null, {
    timeout: 20_000,
  });
}

function distance(x: number, z: number, box: Box): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dz = Math.max(box.minZ - z, 0, z - box.maxZ);
  return Math.hypot(dx, dz);
}

/** A large library (24 categories, 600 books) served in place of the demo's bootstrap. */
async function withLargeLibrary(page: Page): Promise<void> {
  const real = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
  const template = real.books[0]!;
  const names = ["Programming", "Histoire", "العربية", "Novels", "Poetry", "Philosophie", "التفسير", "Mathematics", "Sciences", "الفقه", "Art", "Music"];
  const categories: Category[] = Array.from({ length: 24 }, (_, i) => ({
    id: 1000 + i,
    name: `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`,
    column_index: i,
    book_count: 25,
    created_at: "2026-10-22T00:00:00Z",
  }));
  const colours = ["#7a3b2e", "#2f4b6e", "#4d6b3c", "#8a6a2c", "#5b3a5e", "#2e5d5a", "#a04a32", "#384052"];
  const books: Book[] = categories.flatMap((category, c) =>
    Array.from({ length: 25 }, (_, i) => ({
      ...template,
      id: 100_000 + c * 100 + i,
      title: `${category.name}: volume ${i + 1}`,
      author: "Test author",
      category_id: category.id,
      page_count: 120 + ((i * 97) % 900),
      spine_color: colours[(c + i) % colours.length]!,
      shelf_number: 0,
      slot_index: i,
    })),
  );
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...real, categories, books, currently_reading: [] } }));
}

test("arcade columns stand at every bay boundary, the openings are clear and the seats collide", async ({ page }) => {
  test.setTimeout(180_000);
  await openHall(page);
  const boxes = await colliders(page);
  const columns = boxes.filter((box) => box.kind === "column");
  const partitions = [...new Set(boxes.filter((box) => box.kind === "partition").map((box) => (box.minZ + box.maxZ) / 2))].sort((a, b) => a - b);
  const columnZs = [...new Set(columns.map((box) => +((box.minZ + box.maxZ) / 2).toFixed(4)))].sort((a, b) => a - b);
  // Two in the entrance zone, then one at every partition, on both sides of the nave.
  expect(columnZs).toEqual([8 / 3, 16 / 3, ...partitions].map((z) => expect.closeTo(z, 3)));
  expect(columns).toHaveLength(2 * columnZs.length);
  for (const box of columns) expect(Math.abs((box.minX + box.maxX) / 2)).toBeCloseTo(ARCADE_X, 6);

  // Walking straight into a bay through the middle of its opening is never blocked.
  const bayZ = (partitions[0]! + partitions[1]!) / 2;
  await teleport(page, -1.2, bayZ, 90);
  await walkUntil(page, "ArrowUp", (p) => p.x < -ARCADE_X - 0.8);
  await waitStill(page);
  const inside = await pose(page);
  expect(inside.x).toBeLessThan(-ARCADE_X - 0.6);
  expect(inside.z).toBeCloseTo(bayZ, 3);

  // Walking into a column stops at its radius.
  await teleport(page, -1.2, partitions[1]!, 90);
  await walkUntil(page, "ArrowUp", () => false);
  await waitStill(page);
  const stopped = await pose(page);
  for (const box of columns) expect(distance(stopped.x, stopped.z, box)).toBeGreaterThanOrEqual(RADIUS - 1e-3);
  expect(stopped.x).toBeGreaterThan(-ARCADE_X);

  // The entrance zone's window seat is solid.
  const seat = boxes.find((box) => box.kind === "seat" && box.maxX > 0)!;
  await teleport(page, seat.minX - 1.0, 4.0, -90);
  await walkUntil(page, "ArrowUp", () => false);
  await waitStill(page);
  const atSeat = await pose(page);
  expect(atSeat.x).toBeCloseTo(seat.minX - RADIUS, 2);
});

test("evidence: entrance, nave, bay opening, ceiling and the Arabic entrance view", async ({ page }) => {
  test.setTimeout(180_000);
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await openHall(page);
  const views: [string, number, number, number, number][] = [
    ["entrance", 0, 0.7, 180, -4],
    ["nave", 0.4, 7.2, 180, 6],
    ["bay-opening", 1.0, 8.2, 125, 2],
    ["ceiling", 0, 5.0, 180, 34],
    ["aisle", -4.6, 1.3, 180, 6],
  ];
  for (const [name, x, z, yaw, pitch] of views) {
    await teleport(page, x, z, yaw, pitch);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
  // Nothing renders while the view is still.
  const before = await page.evaluate(() => window.__DAR__!.frames());
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__DAR__!.frames())).toBe(before);
  // The new materials are local files; nothing comes from the network.
  for (const name of ["walnut", "plaster", "mashrabiya"]) expect(urls.some((url) => url.includes(`/textures/${name}.webp`))).toBe(true);
  expect(urls.filter((url) => !/^(data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(url))).toEqual([]);

  const set = (language: "en" | "ar") => page.request.patch("/api/settings", { headers: { "X-Dar-Client": "1" }, data: { ui_language: language } });
  await set("ar");
  try {
    await openHall(page);
    await teleport(page, 0, 0.7, 180, -4);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/entrance-ar.png` });
  } finally {
    await set("en");
  }
});

test("a 24-category, 600-book hall stays within the draw-call and triangle budgets", async ({ page }) => {
  // Software rendering draws this hall at well under one frame per second.
  test.setTimeout(300_000);
  await withLargeLibrary(page);
  await openHall(page);
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.colliders().filter((box) => box.kind === "bookcase").length === 24, null, { timeout: 30_000 });
  const views: [string, number, number, number, number][] = [
    ["entrance", 0, 0.7, 180, -4],
    ["nave", 0, 12, 180, 4],
    ["bay", 1.2, 9.7, -90, 0],
    ["ceiling", 0, 20, 180, 34],
    ["back", 0, 40, 0, 4],
  ];
  const lines: string[] = [];
  for (const [name, x, z, yaw, pitch] of views) {
    await teleport(page, x, z, yaw, pitch);
    await page.waitForTimeout(700);
    const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
    lines.push(`${name}: calls=${info.calls} triangles=${info.triangles} textures=${info.textures} geometries=${info.geometries}`);
    expect(info.calls).toBeLessThan(150);
    expect(info.triangles).toBeLessThan(300_000);
  }
  await page.screenshot({ path: `${SHOTS}/large-library-back.png` });
  writeFileSync(`${SHOTS}/budget.txt`, `${lines.join("\n")}\n`);
});
