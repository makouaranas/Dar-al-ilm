import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// US-06: 3D curved book mesh and LTR / RTL page turning.
const SHOTS = "e2e/screenshots/us-06";
mkdirSync(SHOTS, { recursive: true });

const LTR_BOOK = 1; // Structure and Interpretation of Computer Programs
const RTL_BOOK = 31; // مقدمة ابن خلدون

// Bookmarks are saved since US-08 and the demo library is reused between runs, so every test
// starts from the seeded pages.
test.beforeEach(async ({ request }) => {
  for (const [id, lastReadPage] of [
    [1, 120],
    [31, 57],
  ] as const) {
    const response = await request.patch(`/api/books/${id}`, { headers: { "X-Dar-Client": "1" }, data: { last_read_page: lastReadPage } });
    expect(response.ok()).toBe(true);
  }
});

async function openReader(page: Page, bookId: number): Promise<number> {
  await page.goto(`/dev/reader/?book=${bookId}&test=1`);
  await page.waitForFunction(() => Object.keys(window.__DAR__?.reader()?.textures ?? {}).length >= 4, null, {
    timeout: 30_000,
  });
  return page.evaluate(() => window.__DAR__!.reader()!.spreadIndex);
}

async function settledOn(page: Page, spread: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const reader = window.__DAR__?.reader();
      return reader && !reader.flipping && reader.queued === 0 && reader.spreadIndex === expected;
    },
    spread,
    { timeout: 20_000 },
  );
  expect(await page.evaluate(() => window.__DAR__!.getState().reader.spreadIndex)).toBe(spread);
}

test("LTR: ArrowRight turns forward, ArrowLeft turns back", async ({ page }) => {
  const start = await openReader(page, LTR_BOOK);
  await page.screenshot({ path: `${SHOTS}/ltr-spread.png` });
  await page.keyboard.press("ArrowRight");
  await settledOn(page, start + 1);
  await page.keyboard.press("ArrowLeft");
  await settledOn(page, start);
  await page.keyboard.press("Space");
  await settledOn(page, start + 1);
  await page.keyboard.press("Shift+Space");
  await settledOn(page, start);
});

test("RTL: ArrowLeft turns forward, ArrowRight turns back", async ({ page }) => {
  const start = await openReader(page, RTL_BOOK);
  await page.screenshot({ path: `${SHOTS}/rtl-spread.png` });
  await page.keyboard.press("ArrowLeft");
  await settledOn(page, start + 1);
  await page.keyboard.press("ArrowRight");
  await settledOn(page, start);
});

test("clicking a page turns it; dragging the corner turns it by hand", async ({ page }) => {
  const start = await openReader(page, LTR_BOOK);
  // Page rectangles on screen (the layout leaves room for the reader controls since US-08).
  const { left, right } = await page.evaluate(() => window.__DAR__!.getState().pageRects);
  const midY = right!.y + right!.height / 2;
  const outerRight = right!.x + right!.width - 12;
  await page.mouse.click(right!.x + right!.width * 0.6, midY); // right page: forward in LTR
  await settledOn(page, start + 1);
  await page.mouse.click(left!.x + left!.width * 0.4, midY); // left page: back
  await settledOn(page, start);

  // Drag the right page's outer edge across: completes the turn.
  await page.mouse.move(outerRight, midY + 50);
  await page.mouse.down();
  for (let x = outerRight - 30; x >= left!.x + 40; x -= 70) await page.mouse.move(x, midY + 30);
  await page.mouse.up();
  await settledOn(page, start + 1);

  // A short drag falls back.
  await page.mouse.move(outerRight, midY + 50);
  await page.mouse.down();
  for (let x = outerRight - 10; x >= outerRight - 120; x -= 20) await page.mouse.move(x, midY + 50);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await settledOn(page, start + 1);
});

test("the leaf curls mid-turn (held for the screenshot)", async ({ page }) => {
  const start = await openReader(page, LTR_BOOK);
  for (const progress of [0.3, 0.6]) {
    await page.evaluate((p) => window.__DAR__!.extra.readerHold!(p, true), progress);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/mid-flip-${progress}.png` });
  }
  expect(await page.evaluate(() => window.__DAR__!.reader()!.flipping)).toBe(true);
  await page.evaluate(() => window.__DAR__!.extra.readerRelease!());
  await settledOn(page, start + 1);
});

test("rapid key presses queue turns", async ({ page }) => {
  const start = await openReader(page, LTR_BOOK);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await settledOn(page, start + 3);
});

test("no frames are rendered while the book is idle", async ({ page }) => {
  const start = await openReader(page, LTR_BOOK);
  await page.keyboard.press("ArrowRight");
  await settledOn(page, start + 1);
  // Idle means after the settled pages have sharpened (the low -> high cross-fade draws frames;
  // with a cold page cache the high images can take longer than the 500 ms below).
  await page.waitForFunction(
    () => {
      const reader = window.__DAR__?.reader();
      return reader && reader.visible.every((p) => reader.textures[p] === "high");
    },
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.__DAR__!.frames());
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => window.__DAR__!.frames());
  expect(after - before).toBe(0);
});

test("frame sequence of a turn in each direction", async ({ page }) => {
  // Browser video needs a newer ffmpeg than the cloud container has, so the motion is captured
  // as frames with the leaf held at each step (assembled into an animation for review).
  mkdirSync(`${SHOTS}/frames`, { recursive: true });
  for (const [name, book] of [
    ["ltr", LTR_BOOK],
    ["rtl", RTL_BOOK],
  ] as const) {
    const start = await openReader(page, book);
    for (let step = 0; step <= 10; step += 1) {
      await page.evaluate((p) => window.__DAR__!.extra.readerHold!(p, true), step / 10);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/frames/${name}-${String(step).padStart(2, "0")}.png` });
    }
    await page.evaluate(() => window.__DAR__!.extra.readerRelease!());
    await settledOn(page, start + 1);
  }
});
