import { mkdirSync } from "node:fs";

import { expect, test, type Page, type Request } from "@playwright/test";

// US-08: single-page cursor zoom, pan lock, jump-to-page and the automatic bookmark.
const SHOTS = "e2e/screenshots/us-08";
mkdirSync(`${SHOTS}/frames`, { recursive: true });

const LTR_BOOK = 1; // Structure and Interpretation of Computer Programs, 657 pages
const RTL_BOOK = 31; // مقدمة ابن خلدون, 642 pages
const SCANNED_BOOK = 12; // La Méditerranée... (scanned), 1160 pages
const CLIENT = { "X-Dar-Client": "1" };

async function setBookmark(page: Page, bookId: number, lastReadPage: number): Promise<void> {
  const response = await page.request.patch(`/api/books/${bookId}`, { headers: CLIENT, data: { last_read_page: lastReadPage } });
  expect(response.ok()).toBe(true);
}

async function setLanguage(page: Page, language: "en" | "ar"): Promise<void> {
  const response = await page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: language } });
  expect(response.ok()).toBe(true);
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

async function waitForSpread(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (spread) => {
      const reader = window.__DAR__!.reader()!;
      return !reader.flipping && reader.queued === 0 && reader.spreadIndex === spread;
    },
    expected,
    { timeout: 30_000 },
  );
}

async function open(page: Page, bookId: number): Promise<number> {
  await page.goto(`/dev/reader/?book=${bookId}&test=1`);
  await waitForSharp(page);
  return page.evaluate(() => window.__DAR__!.reader()!.spreadIndex);
}

const spread = (page: Page) => page.evaluate(() => window.__DAR__!.reader()!.spreadIndex);
const zoomOf = (page: Page) => page.evaluate(() => window.__DAR__!.getState().reader.zoom);
const rectsOf = (page: Page) => page.evaluate(() => window.__DAR__!.getState().pageRects);

function bookPatches(page: Page, bookId: number): { body: Record<string, unknown>; at: number }[] {
  const patches: { body: Record<string, unknown>; at: number }[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === `/api/books/${bookId}`) {
      patches.push({ body: request.postDataJSON() as Record<string, unknown>, at: Date.now() });
    }
  });
  return patches;
}

test("wheel zoom toward the cursor, flips locked, drag pans within the page, Esc resets", async ({ page }) => {
  await setBookmark(page, SCANNED_BOOK, 40);
  const start = await open(page, SCANNED_BOOK);
  const rects = await rectsOf(page);
  const right = rects.right!;
  const px = right.width * 0.3;
  const py = right.height * 0.25;
  await page.mouse.move(right.x + px, right.y + py);

  // Frames for the zoom preview: 100 % to 400 % in eight wheel steps.
  let frame = 0;
  const shoot = async () => {
    await page.screenshot({ path: `${SHOTS}/frames/zoom-${String(frame).padStart(2, "0")}.png` });
    frame += 1;
  };
  await shoot();
  await page.mouse.wheel(0, -231); // x1.41
  await page.mouse.wheel(0, -231); // 200 %
  const overlay = page.getByTestId("zoom-overlay");
  await expect(overlay).toHaveAttribute("data-zoom", "2.00");
  await expect(overlay).toHaveAttribute("data-page", String(rects.rightPage));
  await expect(overlay).toHaveAttribute("data-sharp", "true", { timeout: 30_000 });

  // The overlay lies exactly over the 3D page, and the point under the cursor stayed put.
  const box = (await overlay.boundingBox())!;
  expect(Math.abs(box.x - right.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - right.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.width - right.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - right.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(Number(await overlay.getAttribute("data-tx")) + px)).toBeLessThanOrEqual(1);
  expect(Math.abs(Number(await overlay.getAttribute("data-ty")) + py)).toBeLessThanOrEqual(1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/zoom-200.png` });
  await shoot();

  // Page turning is locked while zoomed.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press(" ");
  await page.waitForTimeout(800);
  expect(await spread(page)).toBe(start);
  expect(await page.evaluate(() => window.__DAR__!.reader()!.flipping)).toBe(false);
  await expect(page.getByTestId("reader-next")).toBeDisabled();

  for (let i = 0; i < 2; i += 1) {
    await page.mouse.wheel(0, -231);
    await page.waitForTimeout(150);
    await shoot();
  }
  await expect(overlay).toHaveAttribute("data-zoom", "4.00");
  expect(await zoomOf(page)).toBeCloseTo(4, 2);

  // Drag pans, clamped to the page edges: the image never leaves the page rectangle.
  const drag = async (dx: number, dy: number, frames = 0) => {
    const x = right.x + right.width / 2;
    const y = right.y + right.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const steps = Math.max(1, frames);
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
      if (frames) await shoot();
    }
    await page.mouse.up();
  };
  await drag(2000, 2000);
  await expect(overlay).toHaveAttribute("data-tx", "0");
  await expect(overlay).toHaveAttribute("data-ty", "0");
  await drag(-3000, -3000);
  // Far edge: the translation is page size minus scaled size (zoom is 3.999..., hence +-1 px).
  expect(Math.abs(Number(await overlay.getAttribute("data-tx")) + 3 * right.width)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(Number(await overlay.getAttribute("data-ty")) + 3 * right.height)).toBeLessThanOrEqual(1.5);
  await drag(right.width * 1.6, right.height * 1.4, 6);
  await expect(overlay).toHaveAttribute("data-sharp", "true", { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/zoom-400-panned.png` });
  await shoot();

  // Esc resets to 100 % and unlocks turning; the book stays open.
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  expect(await zoomOf(page)).toBe(1);
  await expect(page.getByTestId("reader-stage")).toBeVisible();
  await shoot();
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 1);
});

test("toolbar zoom buttons step by 25 % and 100 % resets", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  await open(page, LTR_BOOK);
  const rects = await rectsOf(page);
  const zoomIn = page.getByTestId("reader-zoom-in");
  const reset = page.getByTestId("reader-zoom-reset");
  await expect(reset).toHaveText("100%");
  await expect(page.getByTestId("reader-zoom-out")).toBeDisabled();
  await zoomIn.click();
  await expect(reset).toHaveText("125%");
  // No page hovered yet: the first page in reading order is zoomed.
  await expect(page.getByTestId("zoom-overlay")).toHaveAttribute(
    "data-page",
    String(Math.min(rects.leftPage ?? Infinity, rects.rightPage ?? Infinity)),
  );
  for (let i = 0; i < 3; i += 1) await zoomIn.click();
  await expect(reset).toHaveText("200%");
  await page.getByTestId("reader-zoom-out").click();
  await expect(reset).toHaveText("175%");
  for (let i = 0; i < 12; i += 1) await zoomIn.click({ force: true });
  await expect(reset).toHaveText("400%");
  await expect(zoomIn).toBeDisabled();
  await reset.click();
  await expect(reset).toHaveText("100%");
  await expect(page.getByTestId("zoom-overlay")).toHaveCount(0);
});

test("the page input jumps with a short riffle; the slider jumps on release", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  const start = await open(page, LTR_BOOK);
  expect(start).toBe(60);
  await expect(page.getByTestId("reader-pages")).toHaveText("120–121 / 657");

  await page.getByTestId("reader-pages").click();
  const input = page.getByTestId("reader-page-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("120");
  await input.fill("400");
  await input.press("Enter");

  // Sample the reader while it riffles: a few fast turns with low textures, then the landing.
  const samples = await page.evaluate(async () => {
    const out: { spread: number; flipping: boolean; queued: number; lowOnly: boolean }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 15_000) {
      const r = window.__DAR__!.reader()!;
      const turningPages = r.flipping ? r.visible : [];
      out.push({
        spread: r.spreadIndex,
        flipping: r.flipping,
        queued: r.queued,
        lowOnly: turningPages.every((p) => r.textures[p] !== "high"),
      });
      if (!r.flipping && r.queued === 0 && r.spreadIndex === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return out;
  });
  const turning = samples.filter((s) => s.flipping);
  expect(turning.length).toBeGreaterThan(0);
  expect(Math.max(...samples.map((s) => s.queued))).toBeGreaterThanOrEqual(1);
  expect(turning.every((s) => s.spread >= 197 && s.spread <= 200)).toBe(true);
  expect(turning.every((s) => s.lowOnly)).toBe(true);
  await waitForSpread(page, 200);
  await expect(page.getByTestId("reader-pages")).toHaveText("400–401 / 657");
  expect(await page.evaluate(() => window.__DAR__!.getState().reader.spreadIndex)).toBe(200);

  // Slider: drag the thumb, read the live tooltip, release to jump.
  const slider = page.getByTestId("reader-slider");
  const box = (await slider.boundingBox())!;
  const last = 328; // spreadCount(657) - 1
  const thumbX = (f: number) => box.x + 7 + f * (box.width - 14);
  await page.mouse.move(thumbX(200 / last), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbX(0.25), box.y + box.height / 2, { steps: 8 });
  const tooltip = page.getByTestId("reader-slider-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/^\d+–\d+$/);
  await page.screenshot({ path: `${SHOTS}/slider-tooltip.png` });
  const value = Number(await slider.inputValue());
  expect(Math.abs(value - 82)).toBeLessThanOrEqual(2);
  await expect(tooltip).toHaveText(`${2 * value}–${2 * value + 1}`);
  await page.mouse.up();
  await expect(tooltip).toHaveCount(0);
  await waitForSpread(page, value);

  // Keyboard on the slider: End jumps to the last spread (the arrows do not turn pages here).
  await slider.focus();
  await page.keyboard.press("End");
  await waitForSpread(page, last);
  await expect(page.getByTestId("reader-pages")).toHaveText("656–657 / 657");
});

test("the bookmark is saved once the page is stable for 600 ms and resumes after a reload", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  const patches = bookPatches(page, LTR_BOOK);
  const start = await open(page, LTR_BOOK);
  await expect.poll(() => patches.filter((p) => p.body.mark_opened === true).length).toBeGreaterThanOrEqual(1);

  // Five quick turns are debounced: one save of the final page. (With software rendering a
  // single slow turn can outlast 600 ms, so an intermediate save is tolerated, never five.)
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 5);
  await page.waitForTimeout(1200);
  const saves = () => patches.filter((p) => "last_read_page" in p.body).map((p) => p.body.last_read_page);
  expect(saves().length).toBeLessThan(5);
  expect(saves().at(-1)).toBe(2 * (start + 5));

  // One turn: nothing is sent while the page has been stable for less than 600 ms, then one save.
  const before = saves().length;
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 6);
  await page.waitForTimeout(300);
  expect(saves().length).toBe(before);
  await expect.poll(saves, { timeout: 3000 }).toEqual([...saves().slice(0, before), 2 * (start + 6)]);

  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  expect(bootstrap.currently_reading[0]).toBe(LTR_BOOK);

  await page.reload();
  await waitForSharp(page);
  expect(await spread(page)).toBe(start + 6);
});

test("Esc at 100 % closes the book and saves at once; reopening resumes; pagehide saves", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  const patches = bookPatches(page, LTR_BOOK);
  const start = await open(page, LTR_BOOK);
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reader-closed")).toBeVisible();
  // The close flushed the bookmark without waiting for the debounce, then marked the book opened.
  await expect.poll(() => patches.filter((p) => p.body.last_read_page === 2 * (start + 1)).length).toBe(1);
  await expect.poll(() => patches.filter((p) => p.body.mark_opened === true).length).toBe(2);

  await page.getByTestId("reader-reopen").click();
  await waitForSharp(page);
  expect(await spread(page)).toBe(start + 1);

  // Leaving the page right after a turn still saves (keepalive request on pagehide).
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 2);
  await page.goto("about:blank");
  await expect
    .poll(
      async () => {
        const data = await (await page.request.get("/api/bootstrap")).json();
        return data.books.find((b: { id: number }) => b.id === LTR_BOOK).last_read_page;
      },
      { timeout: 10_000 },
    )
    .toBe(2 * (start + 2));
});

test("the toolbar hides after 2.5 s without mouse movement and returns on movement", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  await open(page, LTR_BOOK);
  await page.mouse.move(700, 450);
  const toolbar = page.getByTestId("reader-toolbar");
  await expect(toolbar).toHaveAttribute("data-visible", "true");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/toolbar-en.png` });
  await page.getByTestId("reader-toolbar").screenshot({ path: `${SHOTS}/toolbar-en-pill.png` });

  await page.mouse.move(700, 300);
  await page.waitForTimeout(3000);
  await expect(toolbar).toHaveAttribute("data-visible", "false");
  await expect(toolbar).toHaveCSS("opacity", "0");
  await expect(page.getByTestId("reader-topbar")).toHaveCSS("opacity", "0");
  await page.screenshot({ path: `${SHOTS}/toolbar-hidden.png` });
  await page.mouse.move(720, 320);
  await expect(toolbar).toHaveAttribute("data-visible", "true");
  await expect(toolbar).toHaveCSS("opacity", "1");
});

test("Arabic toolbar: mirrored UI, navigation in the book's direction", async ({ page }) => {
  await setLanguage(page, "ar");
  try {
    await setBookmark(page, RTL_BOOK, 57);
    await open(page, RTL_BOOK);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.mouse.move(700, 450);
    const previous = (await page.getByTestId("reader-previous").boundingBox())!;
    const next = (await page.getByTestId("reader-next").boundingBox())!;
    // RTL book: earlier pages lie to the right, so "previous" sits on the right.
    expect(previous.x).toBeGreaterThan(next.x);
    // Mirrored UI: the zoom controls sit at the inline end, on the left.
    const zoom = (await page.getByTestId("reader-zoom").boundingBox())!;
    expect(zoom.x).toBeLessThan(next.x);
    await expect(page.getByTestId("reader-close")).toHaveAttribute("aria-label", "إغلاق الكتاب");
    await expect(page.getByTestId("reader-pages")).toHaveText("56–57 / 642");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/toolbar-ar.png` });
    await page.getByTestId("reader-toolbar").screenshot({ path: `${SHOTS}/toolbar-ar-pill.png` });

    // The left button turns forward in an RTL book, like ArrowLeft.
    const start = await spread(page);
    await page.getByTestId("reader-next").click();
    await waitForSpread(page, start + 1);
  } finally {
    await setLanguage(page, "en");
  }
});
