import { mkdirSync } from "node:fs";

import { expect, test, type Page, type Request } from "@playwright/test";

// US-08: cursor zoom (since US-17: the 3D book zooms about the cursor), pan, flip lock,
// jump-to-page and the automatic bookmark.
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

const zoomState = (page: Page) => page.evaluate(() => window.__DAR__!.reader()!.zoom);
const bookPoint = (page: Page, x: number, y: number) =>
  page.evaluate(([cx, cy]) => window.__DAR__!.extra.readerBookPoint!(cx!, cy!), [x, y]);

/** Waits until the zoom animation has reached `scale`. */
async function waitForZoom(page: Page, scale: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const zoom = window.__DAR__?.reader()?.zoom;
      return zoom && Math.abs(zoom.target - expected) < 0.01 && Math.abs(zoom.scale - zoom.target) < 1e-3;
    },
    scale,
    { timeout: 30_000 },
  );
}

/** Waits until every visible page shows its 4096 px zoom image. */
async function waitForZoomTextures(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const reader = window.__DAR__?.reader();
      return reader && reader.visible.every((p) => reader.textures[p] === "zoom");
    },
    null,
    { timeout: 60_000 },
  );
}

test("the wheel brings the book closer around the cursor; flips locked, drag pans, Esc resets", async ({ page }) => {
  await setBookmark(page, SCANNED_BOOK, 40);
  const start = await open(page, SCANNED_BOOK);
  const before = await rectsOf(page);
  const right = before.right!;
  const cursor = { x: right.x + right.width * 0.3, y: right.y + right.height * 0.25 };
  await page.mouse.move(cursor.x, cursor.y);
  const under = (await bookPoint(page, cursor.x, cursor.y))!;

  // Frames for the zoom preview: 100 % to 400 % in four wheel steps, then a pan.
  let frame = 0;
  const shoot = async () => {
    await page.screenshot({ path: `${SHOTS}/frames/zoom-${String(frame).padStart(2, "0")}.png` });
    frame += 1;
  };
  await shoot();
  await page.mouse.wheel(0, -231); // x1.41
  await page.mouse.wheel(0, -231); // 200 %
  await waitForZoom(page, 2);
  expect(await zoomOf(page)).toBeCloseTo(2, 2);

  // The 3D book itself grew to twice its size around the cursor: the same book point is still
  // under the cursor (page height is 1 book unit). There is no flat 2D overlay any more.
  const after = (await bookPoint(page, cursor.x, cursor.y))!;
  expect(Math.hypot(after.x - under.x, after.y - under.y)).toBeLessThan(0.002);
  // (The page rectangles are screen bounding boxes of a slightly tilted page in perspective,
  // so their ratio is close to, not exactly, the scale.)
  expect((await zoomState(page)).scale).toBeCloseTo(2, 3);
  const zoomed = await rectsOf(page);
  for (const ratio of [zoomed.right!.height / right.height, zoomed.right!.width / right.width]) {
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.15);
  }
  await expect(page.getByTestId("zoom-overlay")).toHaveCount(0);
  // Both visible pages sharpen to their 4096 px images.
  await waitForZoomTextures(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/zoom-200.png` });
  await shoot();

  // Page turning is locked while zoomed; the toolbar shows the level.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press(" ");
  await page.waitForTimeout(800);
  expect(await spread(page)).toBe(start);
  expect(await page.evaluate(() => window.__DAR__!.reader()!.flipping)).toBe(false);
  await expect(page.getByTestId("reader-next")).toBeDisabled();
  await expect(page.getByTestId("reader-zoom-reset")).toHaveText("200%");

  await page.mouse.wheel(0, -231);
  await page.mouse.wheel(0, -231);
  await waitForZoom(page, 4);
  const at400 = (await bookPoint(page, cursor.x, cursor.y))!;
  expect(Math.hypot(at400.x - under.x, at400.y - under.y)).toBeLessThan(0.004);
  await shoot();

  // Drag pans, clamped: the book never uncovers more of the screen than at 100 %.
  const drag = async (dx: number, dy: number, frames = 0) => {
    const x = before.right!.x;
    const y = before.right!.y + before.right!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const steps = Math.max(1, frames);
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
      if (frames) await shoot();
    }
    await page.mouse.up();
  };
  await drag(3000, 3000);
  const corner = await zoomState(page);
  expect(corner.x).toBeGreaterThan(0);
  expect(corner.y).toBeLessThan(0); // screen down is -y in the reading plane
  await drag(500, 500);
  const still = await zoomState(page);
  expect(still.x).toBeCloseTo(corner.x, 6);
  expect(still.y).toBeCloseTo(corner.y, 6);
  await drag(-6000, -6000);
  const opposite = await zoomState(page);
  expect(opposite.x).toBeCloseTo(-corner.x, 6);
  expect(opposite.y).toBeCloseTo(-corner.y, 6);
  await drag(400, 300, 6);
  await waitForZoomTextures(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/zoom-400-panned.png` });
  await shoot();

  // Esc returns to 100 % (the book is centred again) and unlocks turning; the book stays open.
  await page.keyboard.press("Escape");
  await waitForZoom(page, 1);
  expect(await zoomOf(page)).toBe(1);
  expect(await zoomState(page)).toMatchObject({ scale: 1, x: 0, y: 0 });
  const reset = await rectsOf(page);
  expect(Math.abs(reset.right!.x - right.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(reset.right!.width - right.width)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("reader-stage")).toBeVisible();
  await expect(page.getByTestId("reader-zoom")).toHaveCount(0);
  await shoot();
  // Back at 100 %, the zoom images are released.
  await waitForSharp(page);
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 1);
});

test("no zoom buttons: + and - keys zoom around the middle, the level chip resets to 100 %", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  await open(page, LTR_BOOK);
  await expect(page.getByTestId("reader-zoom-in")).toHaveCount(0);
  await expect(page.getByTestId("reader-zoom-out")).toHaveCount(0);
  // At 100 % the toolbar shows no zoom control at all, and scrolling out does nothing.
  await expect(page.getByTestId("reader-zoom")).toHaveCount(0);
  const rects = await rectsOf(page);
  await page.mouse.move(rects.right!.x + 40, rects.right!.y + 40);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  expect(await zoomOf(page)).toBe(1);

  await page.keyboard.press("+");
  await waitForZoom(page, 1.25);
  const chip = page.getByTestId("reader-zoom-reset");
  await expect(chip).toHaveText("125%");
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await waitForZoom(page, 1.25 ** 3);
  await expect(chip).toHaveText("195%");
  await page.keyboard.press("-");
  await waitForZoom(page, 1.25 ** 2);
  await expect(chip).toHaveText("156%");
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("+");
  await waitForZoom(page, 4);
  await expect(chip).toHaveText("400%");
  // Moving the mouse wakes the auto-hidden toolbar, as it does for anyone reaching for it.
  await page.mouse.move(700, 600);
  await chip.click();
  await waitForZoom(page, 1);
  await expect(page.getByTestId("reader-zoom")).toHaveCount(0);
  await page.keyboard.press("+");
  await waitForZoom(page, 1.25);
  await page.keyboard.press("0");
  await waitForZoom(page, 1);
});

test("the page input jumps with a short riffle; the slider jumps on release", async ({ page }) => {
  await setBookmark(page, LTR_BOOK, 120);
  const start = await open(page, LTR_BOOK);
  expect(start).toBe(60);
  await expect(page.getByTestId("reader-pages")).toHaveText("120–121 / 657");

  // The toolbar may have auto-hidden while the pages loaded: reaching for it wakes it.
  await page.mouse.move(700, 600);
  await page.getByTestId("reader-pages").click();
  const input = page.getByTestId("reader-page-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("120");
  await input.fill("400");
  await input.press("Enter");

  // Sample the reader while it riffles: a few fast turns with low textures, then the landing.
  const samples = await page.evaluate(async () => {
    const out: { spread: number; flipping: boolean; queued: number; lowOnly: boolean; textures: Record<number, string | undefined> }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 15_000) {
      const r = window.__DAR__!.reader()!;
      const turningPages = r.flipping ? r.visible : [];
      out.push({
        spread: r.spreadIndex,
        flipping: r.flipping,
        queued: r.queued,
        lowOnly: turningPages.every((p) => r.textures[p] !== "high"),
        textures: Object.fromEntries(turningPages.map((p) => [p, r.textures[p]])),
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
  // (Listing the offending samples, if any, says which page was sharp while it turned.)
  expect(turning.filter((s) => !s.lowOnly)).toEqual([]);
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
  // Timed inside the page from the key press: the turn takes at least 550 ms, so the save may
  // not leave before 550 + 600 ms. (Timing it from when the test notices the new spread raced
  // with slow software-rendered frames.)
  const before = saves().length;
  await page.evaluate(() => {
    const w = window as unknown as { __saveTimes: number[]; __keyAt: number };
    w.__saveTimes = [];
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(init.body ?? "").includes("last_read_page")) w.__saveTimes.push(performance.now());
      return original(input, init);
    };
    window.addEventListener("keydown", () => (w.__keyAt = performance.now()), { capture: true, once: true });
  });
  await page.keyboard.press("ArrowRight");
  await waitForSpread(page, start + 6);
  await expect.poll(saves, { timeout: 4000 }).toEqual([...saves().slice(0, before), 2 * (start + 6)]);
  const timing = await page.evaluate(() => {
    const w = window as unknown as { __saveTimes: number[]; __keyAt: number };
    return { keyAt: w.__keyAt, saves: w.__saveTimes };
  });
  expect(timing.saves).toHaveLength(1);
  expect(timing.saves[0]! - timing.keyAt).toBeGreaterThanOrEqual(550 + 600 - 20);

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
    await expect(page.getByTestId("reader-close")).toHaveAttribute("aria-label", "إغلاق الكتاب");
    await expect(page.getByTestId("reader-pages")).toHaveText("56–57 / 642");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/toolbar-ar.png` });
    await page.getByTestId("reader-toolbar").screenshot({ path: `${SHOTS}/toolbar-ar-pill.png` });

    // The left button turns forward in an RTL book, like ArrowLeft.
    const start = await spread(page);
    await page.getByTestId("reader-next").click();
    await waitForSpread(page, start + 1);

    // Mirrored UI: while zoomed, the zoom level sits at the inline end, on the left.
    await page.keyboard.press("+");
    const zoom = (await page.getByTestId("reader-zoom").boundingBox())!;
    const nextNow = (await page.getByTestId("reader-next").boundingBox())!;
    expect(zoom.x).toBeLessThan(nextNow.x);
    await expect(page.getByTestId("reader-zoom-reset")).toHaveAttribute("aria-label", "إعادة التكبير إلى 100%");
    await page.keyboard.press("Escape");
  } finally {
    await setLanguage(page, "en");
  }
});
