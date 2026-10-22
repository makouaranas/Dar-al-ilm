import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// US-07: progressive low -> high page images and the 3-spread GPU window.
const SHOTS = "e2e/screenshots/us-07";
mkdirSync(SHOTS, { recursive: true });

const BOOK = 1;

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

async function open(page: Page): Promise<number> {
  await page.goto(`/dev/reader/?book=${BOOK}&test=1`);
  await waitForSharp(page);
  return page.evaluate(() => window.__DAR__!.reader()!.spreadIndex);
}

async function waitForSharp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const reader = window.__DAR__?.reader();
      return reader && !reader.flipping && reader.queued === 0 && reader.visible.every((p) => reader.textures[p] === "high");
    },
    null,
    { timeout: 60_000 },
  );
}

test("pages in motion show the low image; settled pages sharpen to high", async ({ page }) => {
  const start = await open(page);
  await page.evaluate(() => window.__DAR__!.extra.readerHold!(0.55, true));
  await page.waitForFunction(
    () => {
      const reader = window.__DAR__!.reader()!;
      const revealed = reader.visible.filter((p) => !(p in reader.textures) || reader.textures[p] === "low");
      return reader.flipping && revealed.length >= 1 && reader.visible.some((p) => reader.textures[p] === "low");
    },
    null,
    { timeout: 30_000 },
  );
  await page.screenshot({ path: `${SHOTS}/low-in-motion.png` });
  await page.evaluate(() => window.__DAR__!.extra.readerRelease!());
  await waitForSharp(page);
  expect(await page.evaluate(() => window.__DAR__!.reader()!.spreadIndex)).toBe(start + 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/high-settled.png` });
});

test("turning 30 pages keeps at most 6 pages on the GPU and memory flat", async ({ page }) => {
  const start = await open(page);
  await page.waitForTimeout(1500); // neighbours and prefetch finish loading
  const baseline = await page.evaluate(() => window.__DAR__!.renderInfo()!.textures);
  const lines = [`baseline textures: ${baseline}`];
  let maxGpuPages = 0;

  for (let turn = 1; turn <= 15; turn += 1) {
    await page.keyboard.press("ArrowRight");
    // Sample the pool while the leaf moves.
    for (let i = 0; i < 4; i += 1) {
      maxGpuPages = Math.max(maxGpuPages, await page.evaluate(() => window.__DAR__!.reader()!.gpuPages));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(
      (expected) => {
        const reader = window.__DAR__!.reader()!;
        return !reader.flipping && reader.queued === 0 && reader.spreadIndex === expected;
      },
      start + turn,
      { timeout: 30_000 },
    );
    if (turn % 5 === 0) {
      const info = await page.evaluate(() => ({ r: window.__DAR__!.reader()!, i: window.__DAR__!.renderInfo()! }));
      lines.push(`after ${turn * 2} pages: textures=${info.i.textures} gpuPages=${info.r.gpuPages} qualities=${JSON.stringify(info.r.textures)}`);
    }
  }
  await waitForSharp(page);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ textures: window.__DAR__!.renderInfo()!.textures, gpu: window.__DAR__!.reader()!.gpuPages }));
  lines.push(`final textures: ${after.textures} gpuPages=${after.gpu} maxGpuPagesDuringTurns=${maxGpuPages}`);
  writeFileSync(`${SHOTS}/texture-counts.txt`, `${lines.join("\n")}\n`);

  expect(maxGpuPages).toBeLessThanOrEqual(6);
  expect(after.gpu).toBeLessThanOrEqual(6);
  expect(after.textures).toBeLessThanOrEqual(baseline + 6);
});

test("the next spreads are decoded ahead in RAM", async ({ page }) => {
  const start = await open(page);
  await page.waitForFunction(
    (spread) => {
      const prefetched = window.__DAR__!.reader()!.prefetched;
      // Spreads start+2 .. start+4 show pages 2s and 2s+1.
      const wanted = [2, 3, 4].flatMap((i) => [2 * (spread + i), 2 * (spread + i) + 1]);
      return wanted.every((p) => prefetched.includes(p));
    },
    start,
    { timeout: 30_000 },
  );
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((expected) => window.__DAR__!.reader()!.spreadIndex === expected, start + 2, { timeout: 30_000 });
  // The pages of the new spread came from RAM: no low request for them.
  const lowRequests = requests.filter((url) => url.includes("quality=low"));
  const newSpread = [2 * (start + 2), 2 * (start + 2) + 1];
  expect(lowRequests.filter((url) => newSpread.some((p) => url.includes(`/page/${p}?`)))).toEqual([]);
});

test("pages without an image show paper, never a spinner, and still turn", async ({ page }) => {
  await page.route("**/api/books/*/page/**", (route) => route.abort());
  await page.goto(`/dev/reader/?book=${BOOK}&test=1`);
  await page.waitForFunction(() => window.__DAR__?.reader() != null, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const start = await page.evaluate(() => window.__DAR__!.reader()!.spreadIndex);
  expect(await page.evaluate(() => window.__DAR__!.reader()!.gpuPages)).toBe(0);
  await expect(page.locator("[role=progressbar], .spinner")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/placeholder.png` });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((expected) => window.__DAR__!.reader()!.spreadIndex === expected, start + 1, { timeout: 30_000 });
});
