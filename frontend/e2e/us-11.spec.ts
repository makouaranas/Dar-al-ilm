import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category } from "../src/lib/api";

// US-11: page-count scaled spines with atlas labels, hover and present, the Entrance Desk.
const SHOTS = "e2e/screenshots/us-11";
mkdirSync(`${SHOTS}/frames`, { recursive: true });

interface AtlasInfo {
  resident: string[];
  layers: number;
  cell: [number, number];
  builds: number;
  releases: number;
  labelled: number;
  queued: number;
  format: string;
  size: [number, number, number];
}
interface SpineInfo {
  categoryId: number;
  bookcase: number;
  count: number;
  labelled: number;
  hovered: { id: number; slide: number } | null;
}
interface ShelfInfo {
  categoryId: number;
  books: { id: number; shelf: number; slot: number; min: number[]; max: number[] }[];
}
type Extra = {
  atlas: () => AtlasInfo;
  spines: () => SpineInfo[];
  shelves: () => ShelfInfo[];
  bookScreen: (id: number) => { x: number; y: number; world: number[] } | null;
  presenter: () => { id: number | null; phase: string; coverLoaded: boolean };
  desk: () => { slots: { position: number; bookId: number | null; x: number }[]; emptyLine: boolean };
};
const extra = <K extends keyof Extra>(page: Page, key: K, ...args: Parameters<Extra[K]>) =>
  page.evaluate(([k, a]) => ((window.__DAR__!.extra as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!)(...(a as unknown[])), [
    key,
    args,
  ] as const) as Promise<ReturnType<Extra[K]>>;

async function openHall(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    () => {
      const atlas = (window.__DAR__?.extra as unknown as Partial<Extra> | undefined)?.atlas?.();
      return atlas !== undefined && atlas.resident.length > 0 && atlas.queued === 0 && (window.__DAR__?.renderInfo()?.calls ?? 0) > 10;
    },
    null,
    { timeout: 60_000 },
  );
}

async function look(page: Page, x: number, z: number, yaw: number, pitch: number): Promise<void> {
  await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, yaw, pitch]);
  await page.waitForTimeout(800);
}

async function withBootstrap(page: Page, change: (data: Bootstrap) => Bootstrap): Promise<void> {
  const real = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
  const changed = change(structuredClone(real));
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: changed }));
}

/** Face the Programming bay's bookcase from its aisle, close to the first books. */
async function faceProgrammingShelf(page: Page): Promise<void> {
  await look(page, -3.1, 10.2, 30, -10);
}

const hovered = async (page: Page) => (await extra(page, "spines")).find((s) => s.hovered !== null)?.hovered ?? null;

test("each bookcase is one instanced mesh with R8 texture-array labels; 600 pages are thicker than 60", async ({ page }) => {
  await withBootstrap(page, (data) => {
    const programming = data.books.filter((b) => b.category_id === 1).sort((a, b) => a.slot_index - b.slot_index);
    programming[0]!.page_count = 60;
    programming[1]!.page_count = 600;
    return data;
  });
  await openHall(page);
  const atlas = await extra(page, "atlas");
  expect(atlas).toMatchObject({ format: "R8", size: [2048, 2048, 8], cell: [512, 64], layers: 8 });
  expect(atlas.resident.sort()).toEqual(["1:0", "2:0", "3:0", "4:0"]);
  expect(atlas.labelled).toBe(40);
  const spines = await extra(page, "spines");
  expect(spines).toHaveLength(4);
  await expect.poll(async () => (await extra(page, "spines")).every((s) => s.labelled === s.count)).toBe(true);

  const shelves = await extra(page, "shelves");
  const programming = shelves.find((s) => s.categoryId === 1)!.books.sort((a, b) => a.slot - b.slot);
  const width = (b: { min: number[]; max: number[] }) => b.max[0]! - b.min[0]!;
  expect(width(programming[0]!)).toBeCloseTo(0.015, 4);
  expect(width(programming[1]!)).toBeCloseTo(0.034, 4);

  await look(page, -4.95, 9.25, 0, -3);
  await page.screenshot({ path: `${SHOTS}/shelf-thickness.png` });
  await faceProgrammingShelf(page);
  await page.screenshot({ path: `${SHOTS}/shelf-labels.png` });
  // The Arabic bay (+X, second row): Arabic spines read in their own direction.
  await look(page, 3.05, 12.95, 0, -3);
  await page.screenshot({ path: `${SHOTS}/shelf-arabic.png` });
  const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
  expect(info.calls).toBeLessThan(150);
});

test("atlases build within 18 m, are released beyond 25 m, nearest first, up to the limit", async ({ page }) => {
  // A larger library: 12 categories of 20 books in 6 rows of bays.
  await withBootstrap(page, (data) => {
    const template = data.books[0]!;
    const categories: Category[] = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      name: `Shelf ${i + 1}`,
      column_index: i,
      book_count: 20,
      created_at: template.created_at,
    }));
    const books: Book[] = categories.flatMap((category, c) =>
      Array.from({ length: 20 }, (_, slot) => ({
        ...template,
        id: 1000 + c * 100 + slot,
        title: `Volume ${slot + 1} of ${category.name}`,
        category_id: category.id,
        shelf_number: 0,
        slot_index: slot,
      })),
    );
    return { ...data, categories, books, currently_reading: [] };
  });
  await openHall(page);
  const rowOf = (key: string) => Math.floor((Number(key.split(":")[0]) - 100) / 2);
  const atSpawn = await extra(page, "atlas");
  // From the entrance, rows 0-2 are within 18 m; row 3 is not.
  expect(atSpawn.resident.map(rowOf).sort()).toEqual([0, 0, 1, 1, 2, 2]);

  await look(page, 0, 28, 0, 0);
  await page.waitForFunction(
    () => {
      const atlas = (window.__DAR__!.extra as unknown as Extra).atlas();
      return atlas.queued === 0 && atlas.resident.length === 8;
    },
    null,
    { timeout: 30_000 },
  );
  const atEnd = await extra(page, "atlas");
  // Nearest first, at most 8 layers: rows 2-5; rows 0 and 1 were released.
  expect(atEnd.resident.map(rowOf).sort()).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
  expect(atEnd.releases).toBeGreaterThanOrEqual(4);
  const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
  expect(info.calls).toBeLessThan(150);
  expect(info.triangles).toBeLessThan(300_000);
});

test("hover slides a book out with a title tooltip; moving away puts it back", async ({ page }) => {
  await openHall(page);
  await faceProgrammingShelf(page);
  const target = (await extra(page, "bookScreen", 3))!;
  await page.mouse.move(target.x, target.y, { steps: 3 });
  await expect.poll(async () => (await hovered(page))?.id).toBe(3);
  await expect.poll(async () => (await hovered(page))?.slide ?? 0).toBeGreaterThan(0.0495);
  const tooltip = page.getByTestId("book-tooltip");
  await expect(tooltip).toHaveText("Clean Code");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/hover.png` });
  expect((await extra(page, "presenter")).phase).toBe("idle");

  await page.mouse.move(target.x + 600, target.y + 300, { steps: 3 });
  await expect.poll(async () => hovered(page)).toBeNull();
  await expect(tooltip).toHaveCount(0);
});

test("a click presents the book with its cover and Open / Edit / Delete; Esc and a click elsewhere put it back", async ({ page }) => {
  await openHall(page);
  await faceProgrammingShelf(page);
  const target = (await extra(page, "bookScreen", 3))!;
  await page.mouse.move(target.x, target.y);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await expect.poll(async () => (await extra(page, "presenter")).coverLoaded).toBe(true);
  const panel = page.getByTestId("present-panel");
  await expect(panel).toContainText("Clean Code");
  await expect(panel).toContainText("Robert C. Martin");
  await expect(panel).toContainText("464 pages");
  await expect(page.getByTestId("present-open")).toBeFocused();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/present.png` });

  // Walking is paused while a book is presented.
  const before = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.up("ArrowUp");
  expect((await page.evaluate(() => window.__DAR__!.extra.hall!.pose())).z).toBeCloseTo(before.z, 5);

  // Edit and Delete put the book back on its shelf and open their modals (US-13).
  await page.getByTestId("present-edit").click();
  expect(await page.evaluate(() => window.__DAR__!.getState().editBookFor)).toBe(3);
  await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("edit-modal")).toHaveCount(0);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await page.getByTestId("present-delete").click();
  expect(await page.evaluate(() => window.__DAR__!.getState().deleteBookFor)).toBe(3);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__DAR__!.getState().deleteBookFor)).toBeNull();

  // Esc puts a presented book back.
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });
  expect((await extra(page, "presenter")).phase).toBe("idle");

  // Present again, then click empty wall: it goes back.
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await page.mouse.click(1300, 150);
  await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });

  // Open asks the store to open the book (the reader joins the hall in US-12).
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await page.getByTestId("present-open").click();
  await expect.poll(() => page.evaluate(() => window.__DAR__!.getState().reader.activeBookId)).toBe(3);
  expect(await page.evaluate(() => window.__DAR__!.getState().presentedBookId)).toBeNull();
});

test("the desk shows the 3 latest books from the UI's start side; a desk book presents", async ({ page }) => {
  await openHall(page);
  const order = await page.evaluate(() => window.__DAR__!.getState().currentlyReading);
  const desk = await extra(page, "desk");
  expect(desk.emptyLine).toBe(false);
  // English: 1st on the left as seen from the entrance (+X), then the middle, then the right.
  expect(desk.slots.map((s) => s.bookId)).toEqual(order.slice(0, 3));
  expect(desk.slots.map((s) => s.x)).toEqual([0.58, 0, -0.58]);
  await look(page, 0, 3.0, 180, -24);
  await page.screenshot({ path: `${SHOTS}/desk-3.png` });

  // Click the middle desk book.
  const middle = (await page.evaluate((id) => (window.__DAR__!.extra as unknown as { bookScreen: (id: number, kind: string) => { x: number; y: number } }).bookScreen(id, "desk"), order[1]!))!;
  await page.mouse.click(middle.x, middle.y);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  expect((await extra(page, "presenter")).id).toBe(order[1]);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });
});

test("Arabic UI: the 1st desk book stands on the right", async ({ page }) => {
  const set = (language: "en" | "ar") => page.request.patch("/api/settings", { headers: { "X-Dar-Client": "1" }, data: { ui_language: language } });
  await set("ar");
  try {
    await openHall(page);
    const desk = await extra(page, "desk");
    expect(desk.slots.map((s) => s.x)).toEqual([-0.58, 0, 0.58]);
    await look(page, 0, 3.0, 180, -24);
    await page.screenshot({ path: `${SHOTS}/desk-3-ar.png` });
  } finally {
    await set("en");
  }
});

test("with no books opened yet the desk shows numbered stands and its empty-state line", async ({ page }) => {
  await withBootstrap(page, (data) => ({ ...data, currently_reading: [] }));
  await openHall(page);
  const desk = await extra(page, "desk");
  expect(desk.emptyLine).toBe(true);
  expect(desk.slots.every((slot) => slot.bookId === null)).toBe(true);
  await look(page, 0, 2.9, 180, -20);
  await page.screenshot({ path: `${SHOTS}/desk-empty.png` });
});

test("frame sequence: hover, present and return", async ({ page }) => {
  // Browser video needs a newer ffmpeg than the cloud container has (D68): frames instead.
  await openHall(page);
  await faceProgrammingShelf(page);
  const target = (await extra(page, "bookScreen", 3))!;
  let frame = 0;
  const shoot = async (count: number, gap: number) => {
    for (let i = 0; i < count; i += 1) {
      await page.screenshot({ path: `${SHOTS}/frames/present-${String(frame++).padStart(2, "0")}.png` });
      await page.waitForTimeout(gap);
    }
  };
  await shoot(1, 0);
  await page.mouse.move(target.x, target.y);
  await shoot(3, 60);
  await page.mouse.click(target.x, target.y);
  await shoot(6, 60);
  await page.waitForFunction(() => (window.__DAR__!.extra as unknown as Extra).presenter().phase === "shown", null, { timeout: 20_000 });
  await shoot(2, 200);
  await page.keyboard.press("Escape");
  await shoot(6, 60);
});
