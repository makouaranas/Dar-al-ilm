import { mkdirSync } from "node:fs";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// US-05: scaffold, offline fonts, store, API client, i18n skeleton.
const SHOTS = "e2e/screenshots/us-05";
mkdirSync(SHOTS, { recursive: true });

function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function external(urls: string[]): string[] {
  return urls.filter((url) => {
    const { protocol, hostname } = new URL(url);
    return !(protocol === "data:" || protocol === "blob:" || hostname === "127.0.0.1");
  });
}

async function setLanguage(request: APIRequestContext, language: "en" | "ar"): Promise<void> {
  const response = await request.patch("/api/settings", {
    data: { ui_language: language },
    headers: { "X-Dar-Client": "1" },
  });
  expect(response.ok()).toBe(true);
}

/** First family name of a CSS font-family value such as "'inter', 'inter Fallback'". */
function firstFamily(value: string): string {
  return value.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
}

test.afterEach(async ({ request }) => {
  await setLanguage(request, "en");
});

test("home loads offline in English with the bundled fonts", async ({ page, request }) => {
  await setLanguage(request, "en");
  const urls = recordRequests(page);
  await page.goto("/?test=1");

  const status = page.getByTestId("api-status");
  await expect(status).toHaveAttribute("data-state", "connected");
  await expect(status).toContainText("Library service connected");
  await expect(page.getByTestId("api-detail")).toHaveText("40 books in 4 categories");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dar al Ilm");

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family);
    const heading = getComputedStyle(document.querySelector("h1")!).fontFamily;
    return { declared: window.__DAR__!.fonts, loaded, heading };
  });
  const inter = firstFamily(fonts.declared.inter);
  const cairo = firstFamily(fonts.declared.cairo);
  expect(fonts.loaded.map((family) => family.replace(/['"]/g, ""))).toEqual(
    expect.arrayContaining([inter, cairo]),
  );
  expect(firstFamily(fonts.heading)).toBe(inter);

  const fontFiles = urls.filter((url) => url.endsWith(".woff2"));
  expect(fontFiles.length).toBeGreaterThanOrEqual(2);
  expect(external(urls)).toEqual([]);

  await page.screenshot({ path: `${SHOTS}/home-en.png` });
});

test("Arabic UI mirrors right-to-left with Arabic plurals", async ({ page, request }) => {
  await setLanguage(request, "ar");
  const urls = recordRequests(page);
  await page.goto("/?test=1");

  await expect(page.getByTestId("api-status")).toHaveAttribute("data-state", "connected");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("دار العلم");
  await expect(page.getByTestId("api-status")).toContainText("خدمة المكتبة متصلة");
  await expect(page.getByTestId("api-detail")).toHaveText("40 كتابًا في 4 تصنيفات");
  // Latin text keeps Inter in the Arabic UI; Arabic headings use Cairo.
  const families = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      declared: window.__DAR__!.fonts,
      heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
      latin: getComputedStyle(document.querySelector('[lang="en"]')!).fontFamily,
    };
  });
  expect(firstFamily(families.heading)).toBe(firstFamily(families.declared.cairo));
  expect(firstFamily(families.latin)).toBe(firstFamily(families.declared.inter));
  expect(external(urls)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/home-ar.png` });

  // The remembered language applies before React runs: no left-to-right flash on reload.
  await page.route("**/api/bootstrap", (route) => route.abort());
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("shows the service as not connected when the API is unreachable", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  const status = page.getByTestId("api-status");
  await expect(status).toHaveAttribute("data-state", "disconnected");
  await expect(status).toContainText("Library service not connected");
  await expect(page.getByTestId("api-detail")).toHaveText("Run ./start.sh to restart it.");
  await page.screenshot({ path: `${SHOTS}/home-disconnected.png` });
});

test("the store holds the bootstrap data; the test API needs ?test=1", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("api-status")).toHaveAttribute("data-state", "connected");
  expect(await page.evaluate(() => window.__DAR__ === undefined)).toBe(true);

  await page.goto("/?test=1");
  await expect(page.getByTestId("api-status")).toHaveAttribute("data-state", "connected");
  const state = await page.evaluate(() => {
    const s = window.__DAR__!.getState();
    return {
      categories: s.categories.map((c) => c.name),
      books: s.books.length,
      currentlyReading: s.currentlyReading.length,
      settings: s.settings,
      reader: s.reader,
    };
  });
  expect(state.categories).toEqual(["Programming", "Histoire", "Novels", "العربية"]);
  expect(state.books).toBe(40);
  expect(state.currentlyReading).toBe(3);
  expect(state.settings.ui_language).toBe("en");
  expect(state.reader).toEqual({ activeBookId: null, spreadIndex: 0, zoom: 1, flipLocked: false });
});
