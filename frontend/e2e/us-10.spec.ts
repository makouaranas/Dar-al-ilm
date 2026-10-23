import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category } from "../src/lib/api";

// US-10: category names drawn on canvas textures (since US-20, the section headers over the
// bays) and shelves that grow with the books.
const SHOTS = "e2e/screenshots/us-10";
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

interface ShelfInfo {
  categoryId: number;
  bookcases: number;
  ghost: boolean;
  books: { id: number; shelf: number; slot: number; bookcase: number; tier: number; min: number[]; max: number[] }[];
}

type Extra = { signs: () => { headers: HeaderInfo[]; disposed: { headers: number } }; shelves: () => ShelfInfo[] };
const headers = (page: Page) => page.evaluate(() => (window.__DAR__!.extra as unknown as Extra).signs());
const shelves = (page: Page) => page.evaluate(() => (window.__DAR__!.extra as unknown as Extra).shelves());

async function openHall(page: Page, headerCount: number): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    (count) => {
      const extra = window.__DAR__?.extra as unknown as Partial<Extra> | undefined;
      return (window.__DAR__?.renderInfo()?.calls ?? 0) > 10 && extra?.signs?.().headers.length === count;
    },
    headerCount,
    { timeout: 60_000 },
  );
}

async function look(page: Page, x: number, z: number, yaw: number, pitch: number): Promise<void> {
  await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, yaw, pitch]);
  await page.waitForTimeout(900);
}

/** Look at a section header from the other side of the nave. */
async function lookAtHeader(page: Page, header: HeaderInfo): Promise<void> {
  const [x, y, z] = header.center;
  const from = -Math.sign(x) * 1.6;
  const pitch = (Math.atan2(y - 1.62, Math.abs(x - from)) * 180) / Math.PI;
  await look(page, from, z, x > 0 ? -90 : 90, pitch);
}

async function withBootstrap(page: Page, change: (data: Bootstrap) => Bootstrap): Promise<Bootstrap> {
  const real = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
  const changed = change(structuredClone(real));
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: changed }));
  return changed;
}

function overlaps(a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }): boolean {
  return [0, 1, 2].every((i) => a.min[i]! < b.max[i]! - 1e-6 && b.min[i]! < a.max[i]! - 1e-6);
}

test("category names are drawn after the fonts load, in the right script and direction", async ({ page }) => {
  await openHall(page, 4);
  const fontsReady = await page.evaluate(() => {
    // The bundled faces themselves (next/font also lists a local fallback face).
    const first = (family: string) => family.split(",")[0]!.trim();
    const { inter, cairo } = window.__DAR__!.fonts;
    return document.fonts.check(`600 64px ${first(inter)}`) && document.fonts.check(`700 64px ${first(cairo)}`, "العربية");
  });
  expect(fontsReady).toBe(true);

  const { headers: list } = await headers(page);
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  expect(Object.keys(byName).sort()).toEqual(["Histoire", "Novels", "Programming", "العربية"].sort());
  expect(byName["العربية"]).toMatchObject({ script: "arabic", direction: "rtl", lines: ["العربية"], truncated: false });
  expect(byName["Programming"]).toMatchObject({ script: "latin", direction: "ltr", lines: ["Programming"], scale: 1 });

  // Each header is on the plaster band over its bay's opening (arcade line), facing the nave.
  for (const header of list) {
    expect(Math.abs(header.center[0])).toBeCloseTo(2.4 - 0.012, 6);
    expect(header.center[1]).toBeGreaterThan(3.46);
    expect(header.normal[0]).toBe(-Math.sign(header.center[0]));
  }

  await lookAtHeader(page, byName["Programming"]!);
  await page.screenshot({ path: `${SHOTS}/header-programming.png` });
  await lookAtHeader(page, byName["Histoire"]!);
  await page.screenshot({ path: `${SHOTS}/header-histoire.png` });
  await lookAtHeader(page, byName["العربية"]!);
  await page.screenshot({ path: `${SHOTS}/header-arabic.png` });
  await look(page, 0, 6.2, 180, 4);
  await page.screenshot({ path: `${SHOTS}/nave-headers.png` });
});

test("long names shrink to fit, wrap onto two lines, and truncate with an ellipsis at 60 %", async ({ page }) => {
  const long = "Histoire de la Méditerranée et du monde méditerranéen à l'époque de Philippe II";
  await withBootstrap(page, (data) => {
    data.categories[0]!.name = "Programming languages";
    data.categories[1]!.name = long;
    data.categories[3]!.name = "الأدب العربي الحديث والمعاصر";
    return data;
  });
  await openHall(page, 4);
  const { headers: list } = await headers(page);
  const byId = Object.fromEntries(list.map((p) => [p.categoryId, p]));
  const two = byId[1]!;
  expect(two.truncated).toBe(false);
  expect(two.lines.join(" ")).toBe("Programming languages");
  const truncated = byId[2]!;
  expect(truncated.truncated).toBe(true);
  expect(truncated.scale).toBeCloseTo(0.6, 5);
  expect(truncated.lines).toHaveLength(2);
  expect(truncated.lines[1]!.endsWith("…")).toBe(true);
  const arabic = byId[4]!;
  expect(arabic.direction).toBe("rtl");
  expect(arabic.scale).toBeGreaterThanOrEqual(0.6);
  await lookAtHeader(page, truncated);
  await page.screenshot({ path: `${SHOTS}/header-long.png` });
  await lookAtHeader(page, arabic);
  await page.screenshot({ path: `${SHOTS}/header-arabic-long.png` });
});

test("31 books: the 31st stands on shelf 1 slot 0 without overlaps; shelf 5 adds a bookcase", async ({ page }) => {
  let nextId = 1000;
  await withBootstrap(page, (data) => {
    const source = data.books.filter((b) => b.category_id === 1);
    const extra: Book[] = [];
    for (let slot = source.length; slot < 31; slot += 1) {
      const template = source[slot % source.length]!;
      const shelf = slot < 30 ? 0 : 1;
      extra.push({ ...template, id: nextId++, shelf_number: shelf, slot_index: shelf === 0 ? slot : 0, title: `${template.title} (${slot})` });
    }
    // Histoire also gets a book on shelf 5: bookcase 1.
    const histoire = data.books.find((b) => b.category_id === 2)!;
    extra.push({ ...histoire, id: nextId++, shelf_number: 5, slot_index: 0 });
    data.books.push(...extra);
    data.categories[0]!.book_count = 31;
    return data;
  });
  await openHall(page, 4);
  const all = await shelves(page);
  const programming = all.find((s) => s.categoryId === 1)!;
  expect(programming.books).toHaveLength(31);
  const thirtyFirst = programming.books.find((b) => b.shelf === 1)!;
  expect(thirtyFirst).toMatchObject({ slot: 0, bookcase: 0, tier: 2 });
  // Tier 2 is the shelf below eye level, its board top at 1.02 m.
  expect(thirtyFirst.min[1]).toBeCloseTo(1.02, 5);
  for (let i = 0; i < programming.books.length; i += 1) {
    for (let j = i + 1; j < programming.books.length; j += 1) {
      expect(overlaps(programming.books[i]!, programming.books[j]!)).toBe(false);
    }
  }
  // Eye-level shelf 0 holds the first 30, packed in slot order from one end.
  const shelf0 = programming.books.filter((b) => b.shelf === 0).sort((a, b) => a.slot - b.slot);
  expect(shelf0).toHaveLength(30);
  expect(shelf0.every((b) => b.tier === 3)).toBe(true);

  const histoire = all.find((s) => s.categoryId === 2)!;
  expect(histoire.bookcases).toBe(2);
  expect(histoire.books.find((b) => b.shelf === 5)).toMatchObject({ bookcase: 1, tier: 3 });
  const colliders = await page.evaluate(() => window.__DAR__!.extra.hall!.colliders());
  expect(colliders.filter((c) => c.kind === "bookcase")).toHaveLength(5);

  // Look into the Programming bay at its bookcase.
  const box = thirtyFirst;
  await look(page, (box.min[0]! + box.max[0]!) / 2 + 0.2, box.max[2]! + 1.7, 0, -8);
  await page.screenshot({ path: `${SHOTS}/bay-31-books.png` });
  const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
  expect(info.calls).toBeLessThan(150);
});

test("an empty category shows one bookcase, its header and a ghost Add book slot", async ({ page }) => {
  const poetry: Category = { id: 99, name: "Poetry", column_index: 4, book_count: 0, created_at: "2026-10-22T00:00:00Z" };
  await withBootstrap(page, (data) => ({ ...data, categories: [...data.categories, poetry] }));
  await openHall(page, 5);
  const empty = (await shelves(page)).find((s) => s.categoryId === 99)!;
  expect(empty).toMatchObject({ bookcases: 1, ghost: true, books: [] });
  // The ghost label sits on the eye-level shelf of the bay's first bookcase (side -X, row 2).
  const labelZ = 8 + 2 * 3.4 + 0.27 + 0.154;
  await look(page, -4.35, labelZ + 1.5, 0, (Math.atan2(1.59 - 1.62, 1.5) * 180) / Math.PI);
  await page.screenshot({ path: `${SHOTS}/empty-category.png` });
  expect(await page.evaluate(() => window.__DAR__!.getState().addBookFor)).toBeNull();
  await page.mouse.click(720, 450);
  await expect.poll(() => page.evaluate(() => window.__DAR__!.getState().addBookFor)).toBe(99);
});

test("renaming a category redraws its header and disposes the old texture", async ({ page }) => {
  await openHall(page, 4);
  const before = await headers(page);
  const old = before.headers.find((p) => p.categoryId === 3)!;
  await page.evaluate(() => {
    const state = window.__DAR__!.getState();
    const category = state.categories.find((c) => c.id === 3)!;
    state.upsertCategory({ ...category, name: "Romans" });
  });
  await expect
    .poll(async () => (await headers(page)).headers.find((p) => p.categoryId === 3)?.name)
    .toBe("Romans");
  const after = await headers(page);
  const renamed = after.headers.find((p) => p.categoryId === 3)!;
  expect(renamed.textureId).not.toBe(old.textureId);
  expect(after.disposed.headers).toBe(before.disposed.headers + 1);
  expect(after.headers).toHaveLength(4);
});
