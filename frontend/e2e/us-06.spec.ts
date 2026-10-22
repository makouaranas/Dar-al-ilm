import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// US-06: 3D curved book mesh and LTR / RTL page turning.
const SHOTS = "e2e/screenshots/us-06";
mkdirSync(SHOTS, { recursive: true });

const LTR_BOOK = 1; // Structure and Interpretation of Computer Programs
const RTL_BOOK = 31; // مقدمة ابن خلدون

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
  await page.mouse.click(1050, 450); // right page: forward in LTR
  await settledOn(page, start + 1);
  await page.mouse.click(400, 450); // left page: back
  await settledOn(page, start);

  // Drag the right page's outer edge across: completes the turn.
  await page.mouse.move(1270, 500);
  await page.mouse.down();
  for (let x = 1240; x >= 260; x -= 70) await page.mouse.move(x, 480);
  await page.mouse.up();
  await settledOn(page, start + 1);

  // A short drag falls back.
  await page.mouse.move(1270, 500);
  await page.mouse.down();
  for (let x = 1260; x >= 1150; x -= 20) await page.mouse.move(x, 500);
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
