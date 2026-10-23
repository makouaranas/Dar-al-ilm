import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category } from "../src/lib/api";

// US-20: signage in three levels (section headers, range plates, the directory).
const SHOTS = "e2e/screenshots/us-20";
mkdirSync(SHOTS, { recursive: true });

interface HeaderInfo {
  categoryId: number;
  name: string;
  lines: string[];
  scale: number;
  truncated: boolean;
  script: string;
  direction: string;
  textureId: string;
  center: [number, number, number];
  normal: [number, number, number];
}
interface PlateInfo {
  categoryId: number;
  name: string;
  count: string;
  lines: string[];
  textureId: string;
  centers: [number, number, number][];
}
interface DirectoryInfo {
  title: string;
  lines: { categoryId: number | null; text: string; toward: "left" | "right"; truncated: boolean }[];
  textureId: string;
  hovered: number | null;
}
interface Signs {
  headers: HeaderInfo[];
  plates: PlateInfo[];
  directory: DirectoryInfo | null;
  disposed: { headers: number; plates: number; directory: number };
}
type Extra = { signs: () => Signs; directoryLineScreen: (id: number) => { x: number; y: number } | null };

const signs = (page: Page) => page.evaluate(() => (window.__DAR__!.extra as unknown as Extra).signs());
const lineScreen = (page: Page, id: number) => page.evaluate((categoryId) => (window.__DAR__!.extra as unknown as Extra).directoryLineScreen(categoryId), id);
const pose = (page: Page) => page.evaluate(() => window.__DAR__!.extra.hall!.pose());
const CLIENT = { "X-Dar-Client": "1" };

/** The demo library: four categories, ten books each, bays in column order. */
const DEMO_BAYS: Record<string, { side: -1 | 1; z: number }> = {
  Programming: { side: -1, z: 9.7 },
  Histoire: { side: 1, z: 9.7 },
  Novels: { side: -1, z: 13.1 },
  العربية: { side: 1, z: 13.1 },
};

async function openHall(page: Page, headers: number): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    (count) => {
      const extra = window.__DAR__?.extra as unknown as Partial<Extra> | undefined;
      const s = extra?.signs?.();
      return (window.__DAR__?.renderInfo()?.calls ?? 0) > 10 && s?.headers.length === count && s.plates.length === count && s.directory !== null;
    },
    headers,
    { timeout: 90_000 },
  );
}

async function look(page: Page, x: number, z: number, yaw: number, pitch: number): Promise<void> {
  await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, yaw, pitch]);
  await page.waitForTimeout(1500);
}

async function withBootstrap(page: Page, change: (data: Bootstrap) => Bootstrap): Promise<void> {
  const real = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
  const changed = change(structuredClone(real));
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: changed }));
}

const setLanguage = (page: Page, language: "en" | "ar") => page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: language } });

test("section headers: one per bay on the band over its opening, in its own script and direction", async ({ page }) => {
  await openHall(page, 4);
  const { headers } = await signs(page);
  const byName = Object.fromEntries(headers.map((h) => [h.name, h]));
  expect(Object.keys(byName).sort()).toEqual(Object.keys(DEMO_BAYS).sort());
  for (const [name, bay] of Object.entries(DEMO_BAYS)) {
    const header = byName[name]!;
    // On the plaster band between the beam (3.46 m) and the clerestory sill (4.1 m), 12 mm off
    // the wall on the arcade line, over the middle of the opening, facing the nave.
    expect(header.center[0]).toBeCloseTo(bay.side * (2.4 - 0.012), 6);
    expect(header.center[1]).toBeGreaterThan(3.46 + 0.25);
    expect(header.center[1]).toBeLessThan(4.1 - 0.25);
    expect(header.center[2]).toBeCloseTo(bay.z, 6);
    expect(header.normal).toEqual([-bay.side, 0, 0]);
    expect(header.truncated).toBe(false);
  }
  expect(byName["العربية"]).toMatchObject({ script: "arabic", direction: "rtl", lines: ["العربية"] });
  expect(byName["Programming"]).toMatchObject({ script: "latin", direction: "ltr", lines: ["Programming"], scale: 1 });

  // Read from across the nave, and from the entrance (about 9 m down the nave).
  await look(page, 1.6, 9.7, 90, 26);
  await page.screenshot({ path: `${SHOTS}/header-programming.png` });
  await look(page, -1.6, 13.1, -90, 26);
  await page.screenshot({ path: `${SHOTS}/header-arabic.png` });
  await look(page, 0, 0.7, 180, 6);
  await page.screenshot({ path: `${SHOTS}/nave-signs.png` });
});

test("range plates: on each nave-facing bookcase end at eye level, with the name and the book count", async ({ page }) => {
  await openHall(page, 4);
  const before = await signs(page);
  for (const plate of before.plates) {
    const bay = DEMO_BAYS[plate.name]!;
    expect(plate.count).toBe("10 books");
    // Ten books fill one bookcase: one nave-facing end, at 1.5 m, on the bookcase's end panel.
    expect(plate.centers).toHaveLength(1);
    const [x, y] = plate.centers[0]!;
    expect(y).toBeCloseTo(1.5, 6);
    expect(Math.abs(x)).toBeGreaterThan(2.74);
    expect(Math.abs(x)).toBeLessThan(2.75);
    expect(Math.sign(x)).toBe(bay.side);
  }
  // Header letters are at least three times the plate's (the sign grid's hierarchy).
  await look(page, 1.9, 8.5, -90, -2);
  await page.screenshot({ path: `${SHOTS}/plate.png` });

  // Adding a book redraws only that category's plate; moving one redraws both plates.
  const histoire = before.plates.find((p) => p.name === "Histoire")!;
  const programming = before.plates.find((p) => p.name === "Programming")!;
  await page.evaluate((categoryId) => {
    const state = window.__DAR__!.getState();
    const own = state.books.filter((b) => b.category_id === categoryId);
    const template = own[0]!;
    state.upsertBook({ ...template, id: 990_001, title: "One more", slot_index: own.length });
  }, histoire.categoryId);
  await expect.poll(async () => (await signs(page)).plates.find((p) => p.categoryId === histoire.categoryId)?.count).toBe("11 books");
  const added = await signs(page);
  expect(added.disposed.plates).toBe(before.disposed.plates + 1);
  expect(added.disposed.headers).toBe(before.disposed.headers);
  expect(added.disposed.directory).toBe(before.disposed.directory);
  expect(added.plates.find((p) => p.categoryId === programming.categoryId)!.textureId).toBe(programming.textureId);

  await page.evaluate(([bookId, categoryId]) => {
    const state = window.__DAR__!.getState();
    const book = state.books.find((b) => b.id === bookId)!;
    state.upsertBook({ ...book, category_id: categoryId!, slot_index: 10 });
  }, [990_001, programming.categoryId]);
  await expect.poll(async () => (await signs(page)).plates.find((p) => p.categoryId === programming.categoryId)?.count).toBe("11 books");
  const moved = await signs(page);
  expect(moved.plates.find((p) => p.categoryId === histoire.categoryId)!.count).toBe("10 books");
  expect(moved.disposed.plates).toBe(added.disposed.plates + 2);
  expect(moved.disposed.headers).toBe(before.disposed.headers);
});

test("Arabic UI: plate counts use the Arabic plural forms; the directory's title is Arabic", async ({ page }) => {
  // The language first: the bootstrap served below is a copy taken after it is saved.
  await setLanguage(page, "ar");
  // One category with two books, one with eleven, the others as they are.
  await withBootstrap(page, (data) => {
    const first = data.categories.find((c) => c.column_index === 0)!.id;
    const second = data.categories.find((c) => c.column_index === 1)!.id;
    const fromFirst = data.books.filter((b) => b.category_id === first);
    const keep = new Set(fromFirst.slice(0, 2).map((b) => b.id));
    const books = data.books.filter((b) => b.category_id !== first || keep.has(b.id));
    const template = data.books.find((b) => b.category_id === second)!;
    books.push({ ...template, id: 990_002, title: "Eleventh", slot_index: 10 } as Book);
    return { ...data, books };
  });
  try {
    await openHall(page, 4);
    const { plates, directory } = await signs(page);
    const counts = Object.fromEntries(plates.map((p) => [p.name, p.count]));
    expect(counts["Programming"]).toBe("كتابان");
    expect(counts["Histoire"]).toBe("11 كتابًا");
    expect(counts["Novels"]).toBe("10 كتب");
    expect(directory!.title).toBe("التصنيفات");
    await look(page, 1.9, 11.9, -90, -2);
    await page.screenshot({ path: `${SHOTS}/plate-ar.png` });
    await look(page, 1.5, 3.0, -147, -12);
    await page.screenshot({ path: `${SHOTS}/directory-ar.png` });
  } finally {
    await setLanguage(page, "en");
  }
});

test("the directory lists every bay by side; hovering lights a line; a click flies to that bay's opening", async ({ page }) => {
  await openHall(page, 4);
  const { directory } = await signs(page);
  expect(directory!.title).toBe("Categories");
  // Someone reading it faces into the hall: the +X bays are on their left.
  for (const line of directory!.lines) {
    const bay = DEMO_BAYS[line.text]!;
    expect(line.toward).toBe(bay.side > 0 ? "left" : "right");
  }
  expect(directory!.lines.filter((l) => l.toward === "left").map((l) => l.text)).toEqual(["Histoire", "العربية"]);
  expect(directory!.lines.filter((l) => l.toward === "right").map((l) => l.text)).toEqual(["Programming", "Novels"]);

  await look(page, 1.5, 3.0, -147, -12);
  await page.screenshot({ path: `${SHOTS}/directory.png` });
  const novels = directory!.lines.find((l) => l.text === "Novels")!.categoryId!;
  const point = (await lineScreen(page, novels))!;
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await expect.poll(async () => (await signs(page)).directory!.hovered).toBe(novels);
  expect(await page.evaluate(() => document.querySelector("canvas")!.style.cursor)).toBe("pointer");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/directory-hover.png` });

  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 30_000 });
  const flight = (await page.evaluate(() => window.__DAR__!.extra.hall!.lastFlight()))!;
  expect(flight.duration).toBeLessThanOrEqual(1500);
  const end = await pose(page);
  // In front of the middle of the Novels bay's opening (-X side, z 13.1), looking into it.
  expect(end.x).toBeCloseTo(-(2.4 - 0.35), 3);
  expect(end.z).toBeCloseTo(13.1, 3);
  expect(end.yaw).toBeCloseTo(90, 3);
  expect(end.pitch).toBeCloseTo(0, 3);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/directory-arrived.png` });
});

test("reduced motion: the directory's flight is a 300 ms fade cut", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHall(page, 4);
  const { directory } = await signs(page);
  const histoire = directory!.lines.find((l) => l.text === "Histoire")!.categoryId!;
  await look(page, 1.5, 3.0, -147, -12);
  const point = (await lineScreen(page, histoire))!;
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 30_000 });
  const flight = (await page.evaluate(() => window.__DAR__!.extra.hall!.lastFlight()))!;
  expect(flight.duration).toBe(300);
  const end = await pose(page);
  expect(end.x).toBeCloseTo(2.4 - 0.35, 3);
  expect(end.z).toBeCloseTo(9.7, 3);
});

test("many categories: each directory column ends with \"and n more\"; long names shrink then truncate", async ({ page }) => {
  const long = "Histoire de la Méditerranée et du monde méditerranéen à l'époque de Philippe II";
  await withBootstrap(page, (data) => {
    const extra: Category[] = Array.from({ length: 26 }, (_, i) => ({
      id: 500 + i,
      name: i === 0 ? long : `Section ${i + 1}`,
      column_index: 4 + i,
      book_count: 0,
      created_at: "2026-10-23T00:00:00Z",
    }));
    return { ...data, categories: [...data.categories, ...extra] };
  });
  await openHall(page, 30);
  const { directory, headers } = await signs(page);
  const left = directory!.lines.filter((l) => l.toward === "left");
  const right = directory!.lines.filter((l) => l.toward === "right");
  // 15 bays on each side: 12 names, then "and 3 more".
  expect(left).toHaveLength(13);
  expect(right).toHaveLength(13);
  expect(left.at(-1)).toMatchObject({ categoryId: null, text: "and 3 more" });
  expect(right.at(-1)).toMatchObject({ categoryId: null, text: "and 3 more" });
  const header = headers.find((h) => h.categoryId === 500)!;
  expect(header.lines).toHaveLength(2);
  expect(header.scale).toBeCloseTo(0.6, 5);
  expect(header.truncated).toBe(true);
  expect(header.lines[1]!.endsWith("…")).toBe(true);
  await look(page, 1.5, 3.0, -147, -12);
  await page.screenshot({ path: `${SHOTS}/directory-many.png` });
  const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
  writeFileSync(`${SHOTS}/budget.txt`, `directory view, 30 categories: calls=${info.calls} triangles=${info.triangles}\n`);
  expect(info.calls).toBeLessThan(150);
});

test("renaming a category redraws its header, its plates and the directory, and disposes the old textures", async ({ page }) => {
  await openHall(page, 4);
  const before = await signs(page);
  const oldHeader = before.headers.find((h) => h.name === "Novels")!;
  await page.evaluate((id) => {
    const state = window.__DAR__!.getState();
    const category = state.categories.find((c) => c.id === id)!;
    state.upsertCategory({ ...category, name: "Romans" });
  }, oldHeader.categoryId);
  await expect.poll(async () => (await signs(page)).headers.find((h) => h.categoryId === oldHeader.categoryId)?.name).toBe("Romans");
  await expect.poll(async () => (await signs(page)).directory?.lines.some((l) => l.text === "Romans")).toBe(true);
  const after = await signs(page);
  expect(after.plates.find((p) => p.categoryId === oldHeader.categoryId)!.name).toBe("Romans");
  expect(after.headers.find((h) => h.categoryId === oldHeader.categoryId)!.textureId).not.toBe(oldHeader.textureId);
  expect(after.disposed).toEqual({ headers: before.disposed.headers + 1, plates: before.disposed.plates + 1, directory: before.disposed.directory + 1 });
  expect(after.headers).toHaveLength(4);
});
