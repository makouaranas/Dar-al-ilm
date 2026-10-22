import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Box } from "../src/lib/hallLayout";

// US-12: search, the camera flight to a book, and the hall-to-reader transition.
const SHOTS = "e2e/screenshots/us-12";
mkdirSync(`${SHOTS}/frames`, { recursive: true });

type Extra = Record<string, (...args: unknown[]) => unknown>;
const extra = <T,>(page: Page, key: string, ...args: unknown[]) =>
  page.evaluate(([k, a]) => (window.__DAR__!.extra as unknown as Extra)[k as string]!(...(a as unknown[])), [key, args] as const) as Promise<T>;

interface Flight {
  start: number;
  end: number | null;
  length: number;
  duration: number;
  frames: number[];
}
interface Transition {
  phase: string;
  bookId: number | null;
  hallVisible: boolean;
}

async function openHall(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    () => {
      const atlas = (window.__DAR__?.extra as unknown as Extra | undefined)?.atlas?.() as { resident: string[]; queued: number } | undefined;
      return atlas !== undefined && atlas.resident.length > 0 && atlas.queued === 0;
    },
    null,
    { timeout: 60_000 },
  );
}

async function setLanguage(page: Page, language: "en" | "ar"): Promise<void> {
  const response = await page.request.patch("/api/settings", { headers: { "X-Dar-Client": "1" }, data: { ui_language: language } });
  expect(response.ok()).toBe(true);
}

function distance(x: number, z: number, box: Box): number {
  return Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minZ - z, 0, z - box.maxZ));
}

async function flyVia(page: Page, query: string, downs = 0): Promise<{ flight: Flight; chosen: { id: number; at: number }; samples: { x: number; z: number }[] }> {
  await page.keyboard.press("/");
  await expect(page.getByTestId("search-input")).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  for (let i = 0; i < downs; i += 1) await page.keyboard.press("ArrowDown");
  // Sample the camera while it flies.
  await page.evaluate(() => {
    const w = window as unknown as { __samples: { x: number; z: number }[]; __on: boolean };
    w.__samples = [];
    w.__on = true;
    const tick = () => {
      if (!w.__on) return;
      const p = window.__DAR__!.extra.hall!.pose();
      w.__samples.push({ x: p.x, z: p.z });
      requestAnimationFrame(tick);
    };
    tick();
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 20_000 });
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __samples: { x: number; z: number }[]; __on: boolean };
    w.__on = false;
    return w.__samples;
  });
  const flight = (await page.evaluate(() => window.__DAR__!.extra.hall!.lastFlight())) as Flight;
  const search = await extra<{ lastChosen: { id: number; at: number } }>(page, "search");
  return { flight, chosen: search.lastChosen, samples };
}

test("search filters by title, author and category, with covers, and shows the empty state", async ({ page }) => {
  await openHall(page);
  await page.keyboard.press("/");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("histoire");
  const results = page.getByTestId("search-result");
  await expect(results.first()).toContainText("Histoire");
  expect(await results.count()).toBeLessThanOrEqual(8);
  // Ranked: titles starting with the query before books that only match by category.
  const matches = (await extra<{ results: { match: string }[] }>(page, "search")).results.map((r) => r.match);
  expect(matches[0]).toBe("title-start");
  expect(matches).toContain("category");
  const firstCover = results.first().locator("img");
  await expect.poll(() => firstCover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/search-results-en.png` });

  await input.fill("ecole");
  await input.fill("mediterranee");
  await expect(results.first()).toContainText("Méditerranée");
  await input.fill("zzzz");
  await expect(page.getByTestId("search-empty")).toHaveText('No books match "zzzz".');
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("search-results")).toHaveCount(0);
});

test("Arabic: diacritics and hamza forms are ignored; the UI is mirrored", async ({ page }) => {
  await setLanguage(page, "ar");
  try {
    await openHall(page);
    await page.keyboard.press("/");
    await page.keyboard.type("إبن");
    const results = page.getByTestId("search-result");
    await expect(results.first()).toContainText("ابن");
    await expect(page.getByTestId("search-input")).toHaveAttribute("placeholder", "ابحث بالعنوان أو المؤلف أو التصنيف");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/search-results-ar.png` });
    await page.getByTestId("search-input").fill("مُقَدِّمَة");
    await expect(results.first()).toContainText("مقدمة ابن خلدون");
    await page.getByTestId("search-input").fill("ققق");
    await expect(page.getByTestId("search-empty")).toHaveText("لا توجد كتب تطابق «ققق».");
  } finally {
    await setLanguage(page, "en");
  }
});

test("choosing a result flies along the aisles to the book in under 1.5 s and it glows", async ({ page }) => {
  await openHall(page);
  const colliders = (await page.evaluate(() => window.__DAR__!.extra.hall!.colliders())) as Box[];
  const { flight, chosen, samples } = await flyVia(page, "ابن", 1);
  // Search + flight under 2 s (G3): the flight starts at once and lasts at most 1.5 s.
  expect(flight.start - chosen.at).toBeLessThan(100);
  expect(flight.duration).toBeLessThanOrEqual(1500);
  const due = flight.start + flight.duration;
  expect(flight.end).toBe(flight.frames.at(-1));
  expect(flight.frames.slice(0, -1).every((time) => time < due)).toBe(true);
  // Never through a shelf.
  expect(samples.length).toBeGreaterThan(2);
  for (const sample of samples) for (const box of colliders) expect(distance(sample.x, sample.z, box)).toBeGreaterThanOrEqual(0.09);

  // Arrived 1.3 m in front of the book, facing it (the book is at the centre of the view).
  const target = (await extra<{ x: number; z: number }>(page, "bookTarget", chosen.id))!;
  const pose = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
  expect(Math.hypot(pose.x - target.x, pose.z - target.z)).toBeCloseTo(1.3, 2);
  const onScreen = (await extra<{ x: number; y: number }>(page, "bookScreen", chosen.id))!;
  expect(Math.abs(onScreen.x - 720)).toBeLessThan(40);

  // The rim pulses twice (0.8 s), then holds until 3.8 s; nothing renders during the hold.
  await page.waitForFunction(
    (id) => {
      const lit = ((window.__DAR__!.extra as unknown as Extra).spines!() as { highlight?: { id: number; glow: number } | null }[]).find((s) => s.highlight)?.highlight;
      return lit?.id === id && lit.glow > 0.99;
    },
    chosen.id,
    { timeout: 5_000 },
  );
  const arrivedAt = flight.end!;
  await page.waitForFunction((t) => performance.now() > t + 1000, arrivedAt);
  const before = await page.evaluate(() => window.__DAR__!.frames());
  await page.waitForFunction((t) => performance.now() > t + 2400, arrivedAt, { polling: 100 });
  expect(await page.evaluate(() => window.__DAR__!.frames())).toBe(before);
  await page.screenshot({ path: `${SHOTS}/arrived-highlight.png` });
  writeFileSync(`${SHOTS}/flight.txt`, `${JSON.stringify({ ...flight, chosen })}\n`);
});

test("reduced motion: the search flight is a 300 ms fade cut", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHall(page);
  const { flight } = await flyVia(page, "Clean");
  expect(flight.duration).toBe(300);
});

test("Open enters the reader in the same canvas; closing returns the book and puts it first on the desk", async ({ page }) => {
  test.setTimeout(180_000);
  await openHall(page);
  const { chosen } = await flyVia(page, "Clean Code");
  const at = (await extra<{ x: number; y: number }>(page, "bookScreen", chosen.id))!;
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).presenter!() as { phase: string }).phase === "shown", null, { timeout: 20_000 });

  // Frames of the opening, held at fixed points of the 700 ms transition.
  await extra(page, "readerTransitionHold", 0);
  await page.getByTestId("present-open").click();
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as Transition).phase === "opening", null, { timeout: 10_000 });
  let frame = 0;
  for (const fraction of [0, 0.15, 0.3, 0.45, 0.6, 0.71, 0.8, 0.9, 0.97]) {
    await extra(page, "readerTransitionHold", fraction);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${SHOTS}/frames/open-${String(frame++).padStart(2, "0")}.png` });
  }
  await extra(page, "readerTransitionHold", null);
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as Transition).phase === "open", null, { timeout: 10_000 });
  const open = await extra<Transition>(page, "readerTransition");
  expect(open).toMatchObject({ bookId: chosen.id, hallVisible: false });
  await page.waitForFunction(
    () => {
      const reader = window.__DAR__!.reader();
      return reader !== null && !reader.flipping && reader.visible.every((p) => reader.textures[p] === "high");
    },
    null,
    { timeout: 30_000 },
  );
  await page.mouse.move(700, 450);
  await expect(page.getByTestId("reader-toolbar")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/reader-in-hall.png` });
  await page.screenshot({ path: `${SHOTS}/frames/open-${String(frame++).padStart(2, "0")}.png` });

  // Read on: a page turn inside the hall's canvas.
  const start = (await page.evaluate(() => window.__DAR__!.reader()!.spreadIndex)) as number;
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((s) => { const r = window.__DAR__!.reader(); return r !== null && !r.flipping && r.queued === 0 && r.spreadIndex === s + 1; }, start, { timeout: 20_000 });

  // Close (Esc at 100 %): the reverse transition, then the hall and the desk.
  await extra(page, "readerTransitionHold", 0);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as Transition).phase === "closing", null, { timeout: 10_000 });
  for (const fraction of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
    await extra(page, "readerTransitionHold", fraction);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${SHOTS}/frames/close-${String(frame++).padStart(2, "0")}.png` });
  }
  await extra(page, "readerTransitionHold", null);
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as Transition).phase === "closed", null, { timeout: 10_000 });
  expect(await extra<Transition>(page, "readerTransition")).toMatchObject({ hallVisible: true, bookId: null });
  expect(await page.evaluate(() => window.__DAR__!.getState().reader.activeBookId)).toBeNull();

  // The bookmark was saved and the desk shows the book in position 1.
  await expect.poll(() => page.evaluate(() => window.__DAR__!.getState().currentlyReading[0])).toBe(chosen.id);
  const desk = await extra<{ slots: { bookId: number | null }[] }>(page, "desk");
  expect(desk.slots[0]!.bookId).toBe(chosen.id);
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  expect(bootstrap.currently_reading[0]).toBe(chosen.id);
  const saved = bootstrap.books.find((b: { id: number }) => b.id === chosen.id).last_read_page;
  expect(saved).toBe(2 * (start + 1));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/closed-back-on-shelf.png` });
});

test("frame sequence of a search flight", async ({ page }) => {
  await openHall(page);
  await page.keyboard.press("/");
  await page.keyboard.type("Fluent");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await page.keyboard.press("Enter");
  // Record poses along the flight, then replay them as still frames.
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 20_000 });
  const end = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
  const startPose = { x: 0, z: 0.7, yaw: 180, pitch: (Math.atan2(1.0 - 1.62, 6.5 - 0.7) * 180) / Math.PI };
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    // A straight-line preview between the start and the arrival pose (the real path curves).
    const x = startPose.x + (end.x - startPose.x) * e;
    const z = startPose.z + (end.z - startPose.z) * e;
    await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, startPose.yaw + (end.yaw - startPose.yaw) * e, startPose.pitch + (end.pitch - startPose.pitch) * e]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/frames/flight-${String(i).padStart(2, "0")}.png` });
  }
});
