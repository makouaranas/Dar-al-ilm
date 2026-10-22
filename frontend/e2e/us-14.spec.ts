import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category, Settings } from "../src/lib/api";
import { MESSAGES } from "../src/lib/i18n";

// US-14: Settings (language, graphics preset, ambient light, default direction), categories,
// the first-launch card, and a complete Arabic UI.
const SHOTS = "e2e/screenshots/us-14";
rmSync(`${SHOTS}/frames`, { recursive: true, force: true });
mkdirSync(`${SHOTS}/frames`, { recursive: true });
const FIXTURES = join(tmpdir(), "dar-al-ilm-us14-fixtures");
const BACKEND = resolve("../backend");
const STAMP = Date.now().toString(36);
const CLIENT = { "X-Dar-Client": "1" };
const DEFAULTS: Settings = { ui_language: "en", default_direction: "LTR", graphics_quality: "auto", ambient_light: 1 };

type Extra = Record<string, (...args: unknown[]) => unknown>;
const extra = <T,>(page: Page, key: string, ...args: unknown[]) =>
  page.evaluate(([k, a]) => (window.__DAR__!.extra as unknown as Extra)[k as string]!(...(a as unknown[])), [key, args] as const) as Promise<T>;

const FIXTURE_SCRIPT = String.raw`
import sys, pathlib
import pymupdf
out = pathlib.Path(sys.argv[1]); stamp = sys.argv[2]
out.mkdir(parents=True, exist_ok=True)
for name, title, pages in [("first.pdf", "Moving Book One", 6), ("second.pdf", "Moving Book Two", 9), ("latin.pdf", "A Latin Title", 2)]:
    doc = pymupdf.open()
    for number in range(pages):
        page = doc.new_page(width=420, height=595)
        page.insert_text((48, 72), f"{title} - {number + 1} ({stamp})", fontsize=12)
    doc.set_metadata({"title": title})
    doc.save(out / name)
`;

test.beforeAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  execFileSync(join(BACKEND, ".venv/bin/python"), ["-c", FIXTURE_SCRIPT, FIXTURES, STAMP], { stdio: "inherit" });
});

/** Every test starts from, and leaves, the default settings. */
test.beforeEach(async ({ page }) => {
  await page.request.patch("/api/settings", { headers: CLIENT, data: DEFAULTS });
});
test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { headers: CLIENT, data: DEFAULTS });
});

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

async function bootstrap(page: Page): Promise<Bootstrap> {
  return (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("topbar-settings").click();
  await expect(page.getByTestId("settings-modal")).toHaveAttribute("data-state", "open");
}

async function importBook(page: Page, file: string, title: string, categoryId: number): Promise<Book> {
  const upload = await page.request.post("/api/uploads", {
    headers: CLIENT,
    multipart: { pdf_file: { name: file, mimeType: "application/pdf", buffer: readFileSync(join(FIXTURES, file)) } },
  });
  expect(upload.status()).toBe(201);
  const { upload_id } = (await upload.json()) as { upload_id: string };
  const created = await page.request.post("/api/books", { headers: CLIENT, multipart: { upload_id, title, category_id: String(categoryId), reading_direction: "LTR" } });
  expect(created.status()).toBe(201);
  return (await created.json()) as Book;
}

async function deleteCategoriesNamed(page: Page, prefix: string): Promise<void> {
  for (const category of (await bootstrap(page)).categories) {
    if (category.name.startsWith(prefix)) await page.request.delete(`/api/categories/${category.id}`, { headers: CLIENT });
  }
}

test("Settings: switching to Arabic flips every overlay's language and direction at once and persists", async ({ page }) => {
  await openHall(page);
  await openSettings(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/settings-en.png` });
  await page.screenshot({ path: `${SHOTS}/frames/language-00.png` });

  await page.getByTestId("settings-language").getByRole("radio", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("settings-modal").getByRole("heading", { level: 2 })).toHaveText("الإعدادات");
  await expect(page.getByTestId("topbar-add")).toHaveText("إضافة كتاب");
  await expect(page.getByTestId("search-input")).toHaveAttribute("placeholder", "ابحث بالعنوان أو المؤلف أو التصنيف");
  await expect(page.getByTestId("api-detail")).toHaveText(/^[0-9]+ كتابًا في [0-9] تصنيفات$/);
  // Digits stay Western.
  expect(await page.evaluate(() => /[٠-٩۰-۹]/.test(document.body.innerText))).toBe(false);
  // The logo puts the Arabic name first; the search pill moved to mirrored layout.
  const logo = (await page.getByTestId("logo").boundingBox())!;
  expect(logo.x).toBeGreaterThan(700);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/settings-ar.png` });
  await page.screenshot({ path: `${SHOTS}/frames/language-01.png` });

  // Saved: the service, the start-up language key, and a reload.
  await expect.poll(async () => (await bootstrap(page)).settings.ui_language).toBe("ar");
  expect(await page.evaluate(() => localStorage.getItem("dar.lang"))).toBe("ar");
  await openHall(page);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("topbar-settings")).toHaveAttribute("aria-label", "الإعدادات");

  // And back.
  await openSettings(page);
  await page.getByTestId("settings-language").getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("settings-modal").getByRole("heading", { level: 2 })).toHaveText("Settings");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/frames/language-02.png` });
  await expect.poll(async () => (await bootstrap(page)).settings.ui_language).toBe("en");
});

test("graphics presets remount the canvas with each preset's options and persist", async ({ page }) => {
  await openHall(page);
  const expected = {
    performance: { antialias: false, shadows: false, maxDpr: 1 },
    high: { antialias: true, shadows: true, maxDpr: 2 },
    auto: { antialias: true, shadows: true, maxDpr: 2 },
  } as const;
  for (const preset of ["performance", "high", "auto"] as const) {
    // Mark the current canvas element: a remount replaces it.
    await page.evaluate(() => document.querySelector("canvas")!.setAttribute("data-old", "1"));
    await openSettings(page);
    const label = { performance: "Performance", high: "High", auto: "Auto" }[preset];
    await page.getByTestId("settings-graphics").getByRole("radio", { name: label }).click();
    await page.waitForFunction((p) => ((window.__DAR__!.extra as unknown as Extra).canvas?.() as { preset: string } | undefined)?.preset === p, preset, { timeout: 30_000 });
    await expect(page.locator("canvas[data-old]")).toHaveCount(0);
    const info = await extra<{ antialias: boolean; shadows: boolean; dpr: number }>(page, "canvas");
    expect(info.antialias).toBe(expected[preset].antialias);
    expect(info.shadows).toBe(expected[preset].shadows);
    expect(info.dpr).toBeLessThanOrEqual(expected[preset].maxDpr);
    // Performance: panels are solid paper without blur (docs/DESIGN.md 10.1).
    const panel = await page.getByTestId("settings-modal").evaluate((element) => {
      const style = getComputedStyle(element);
      return { blur: style.backdropFilter, background: style.backgroundColor };
    });
    if (preset === "performance") expect(panel).toEqual({ blur: "none", background: "rgb(246, 245, 242)" });
    else expect(panel.blur).toContain("blur");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/preset-${preset}.png` });
    await expect.poll(async () => (await bootstrap(page)).settings.graphics_quality).toBe(preset);
  }
  // The three presets side by side, for the review.
  execFileSync(join(BACKEND, ".venv/bin/python"), [
    "-c",
    String.raw`
import sys
from PIL import Image
shots = [Image.open(path).convert("RGB").resize((720, 450)) for path in sys.argv[2:]]
sheet = Image.new("RGB", (720 * len(shots), 450), "white")
for index, shot in enumerate(shots):
    sheet.paste(shot, (720 * index, 0))
sheet.save(sys.argv[1])
`,
    `${SHOTS}/presets.png`,
    `${SHOTS}/preset-performance.png`,
    `${SHOTS}/preset-auto.png`,
    `${SHOTS}/preset-high.png`,
  ]);
});

test("ambient light changes the exposure live and persists; the default direction pre-selects new uploads", async ({ page }) => {
  await openHall(page);
  await openSettings(page);
  const slider = page.getByTestId("settings-ambient");
  await slider.focus();
  await expect(page.getByTestId("settings-ambient-value")).toHaveText("100%");
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("settings-ambient-value")).toHaveText("70%");
  // Live: the renderer's exposure follows before anything is saved.
  await expect.poll(async () => (await extra<{ exposure: number }>(page, "canvas")).exposure).toBeCloseTo(0.7, 5);
  await expect.poll(async () => (await bootstrap(page)).settings.ambient_light).toBeCloseTo(0.7, 5);
  // The range is 0.4-1.5.
  await page.keyboard.press("Home");
  await expect(page.getByTestId("settings-ambient-value")).toHaveText("40%");
  await page.keyboard.press("End");
  await expect(page.getByTestId("settings-ambient-value")).toHaveText("150%");
  await expect.poll(async () => (await extra<{ exposure: number }>(page, "canvas")).exposure).toBeCloseTo(1.5, 5);
  await expect.poll(async () => (await bootstrap(page)).settings.ambient_light).toBeCloseTo(1.5, 5);

  // Default reading direction for new books.
  await page.getByTestId("settings-direction").getByRole("radio", { name: "Right to left" }).click();
  await expect.poll(async () => (await bootstrap(page)).settings.default_direction).toBe("RTL");
  await page.keyboard.press("Escape");
  await page.getByTestId("topbar-add").click();
  await page.getByTestId("add-file-input").setInputFiles(join(FIXTURES, "latin.pdf"));
  await expect(page.getByTestId("add-direction").locator('[aria-checked="true"]')).toHaveAttribute("data-value", "RTL", { timeout: 20_000 });
  await page.getByTestId("add-cancel").click();
  await expect(page.getByTestId("add-modal")).toHaveCount(0);
});

test("categories: create, rename (the plaque follows), a duplicate name is refused inline, delete an empty one", async ({ page }) => {
  await deleteCategoriesNamed(page, "Poe");
  await openHall(page);
  try {
    await openSettings(page);
    const before = (await bootstrap(page)).categories.length;
    await page.getByTestId("category-new-name").fill(`Poetry ${STAMP}`);
    await page.getByTestId("category-create").click();
    await expect(page.getByTestId("category-name").filter({ hasText: `Poetry ${STAMP}` })).toBeVisible();
    await expect(page.getByTestId("toast")).toHaveText("Category created");
    await expect.poll(async () => (await extra<{ plaques: { name: string }[] }>(page, "plaques")).plaques.map((p) => p.name)).toContain(`Poetry ${STAMP}`);
    expect((await bootstrap(page)).categories.length).toBe(before + 1);

    // Duplicate name (case and accents fold on the server).
    await page.getByTestId("category-new-name").fill("programming");
    await page.getByTestId("category-create").click();
    await expect(page.getByTestId("category-manager").getByTestId("field-error")).toHaveText("A category with this name already exists.");
    await page.getByTestId("category-new-name").fill("");
    await page.getByTestId("category-create").click();
    await expect(page.getByTestId("category-manager").getByTestId("field-error")).toHaveText("Enter a name.");

    // Rename: Esc cancels only the rename, Enter saves; the plaque redraws.
    const row = page.getByTestId("category-row").filter({ hasText: `Poetry ${STAMP}` });
    await row.getByTestId("category-rename").click();
    await expect(page.getByTestId("category-rename-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("category-rename-input")).toHaveCount(0);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await row.getByTestId("category-rename").click();
    await page.getByTestId("category-rename-input").fill(`Poems ${STAMP}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("category-name").filter({ hasText: `Poems ${STAMP}` })).toBeVisible();
    await expect.poll(async () => (await extra<{ plaques: { name: string }[] }>(page, "plaques")).plaques.map((p) => p.name)).toContain(`Poems ${STAMP}`);
    // A duplicate rename is refused inline too.
    const renamed = page.getByTestId("category-row").filter({ hasText: `Poems ${STAMP}` });
    await renamed.getByTestId("category-rename").click();
    await page.getByTestId("category-rename-input").fill("Novels");
    await page.keyboard.press("Enter");
    await expect(renamed.getByTestId("field-error")).toHaveText("A category with this name already exists.");
    await page.keyboard.press("Escape");

    // Delete the empty category.
    await renamed.getByTestId("category-delete").click();
    const dialog = page.getByTestId("category-delete-dialog");
    await expect(dialog).toContainText(`Delete "Poems ${STAMP}"?`);
    await expect(page.getByTestId("category-delete-cancel")).toBeFocused();
    await page.getByTestId("category-delete-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("category-name").filter({ hasText: `Poems ${STAMP}` })).toHaveCount(0);
    await expect.poll(async () => (await extra<{ plaques: { name: string }[] }>(page, "plaques")).plaques.map((p) => p.name)).not.toContain(`Poems ${STAMP}`);
    expect((await bootstrap(page)).categories.length).toBe(before);
    // The Settings modal stayed open behind the dialog.
    await expect(page.getByTestId("settings-modal")).toHaveAttribute("data-state", "open");
  } finally {
    await deleteCategoriesNamed(page, "Poe");
  }
});

test("deleting a category with books asks where to move them; the books move and the hall closes the gap", async ({ page }) => {
  await deleteCategoriesNamed(page, "Temporary");
  const created = await page.request.post("/api/categories", { headers: CLIENT, data: { name: `Temporary ${STAMP}` } });
  const temp = (await created.json()) as Category;
  const books = [await importBook(page, "first.pdf", "Moving Book One", temp.id), await importBook(page, "second.pdf", "Moving Book Two", temp.id)];
  try {
    await openHall(page);
    const novels = (await bootstrap(page)).categories.find((c) => c.name === "Novels")!;
    const baysBefore = (await extra<{ categoryId: number }[]>(page, "shelves")).map((s) => s.categoryId);
    expect(baysBefore).toContain(temp.id);
    await openSettings(page);
    await page.getByTestId("category-row").filter({ hasText: `Temporary ${STAMP}` }).getByTestId("category-delete").click();
    const dialog = page.getByTestId("category-delete-dialog");
    await expect(page.getByTestId("category-not-empty")).toHaveText(`"Temporary ${STAMP}" has 2 books. Move them to another category to delete it.`);
    await expect(dialog).toContainText("Move its books to:");
    await page.getByTestId("category-move-to").selectOption({ label: "Novels" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/category-delete-move.png` });
    await page.getByTestId("category-delete-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("toast")).toHaveText("Category deleted");

    const state = await page.evaluate(() => window.__DAR__!.getState());
    expect(state.categories.some((c) => c.id === temp.id)).toBe(false);
    for (const book of books) expect(state.books.find((b) => b.id === book.id)!.category_id).toBe(novels.id);
    expect(state.categories.find((c) => c.id === novels.id)!.book_count).toBe(novels.book_count + 2);
    // Column indexes stay contiguous and the bay is gone.
    expect(state.categories.map((c) => c.column_index)).toEqual(state.categories.map((_, i) => i));
    await expect.poll(async () => (await extra<{ categoryId: number }[]>(page, "shelves")).map((s) => s.categoryId)).not.toContain(temp.id);
    await expect.poll(async () => (await extra<{ categoryId: number } | null>(page, "bookTarget", books[0]!.id))?.categoryId).toBe(novels.id);
  } finally {
    for (const book of books) await page.request.delete(`/api/books/${book.id}`, { headers: CLIENT });
    await deleteCategoriesNamed(page, "Temporary");
  }
});

test("first launch: the welcome card creates the first category, then a hint points to Add book", async ({ page }) => {
  await deleteCategoriesNamed(page, "History");
  const real = await bootstrap(page);
  // An empty library, as on first launch (the real one is the shared demo library).
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...real, categories: [], books: [], currently_reading: [] } }));
  try {
    await page.goto("/?test=1");
    const card = page.getByTestId("welcome-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("heading")).toHaveText("Welcome to Dar al Ilm");
    await expect(card).toContainText("Create a category, then add your first book.");
    await expect(page.getByTestId("welcome-create")).toHaveText("Create your first category");
    await expect(page.getByTestId("welcome-chip")).toHaveText(["Programming", "History", "Novels", "العربية"]);
    await expect(page.getByTestId("topbar-add")).toBeDisabled();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/welcome.png` });
    await page.getByTestId("welcome-create").click();
    await expect(card.getByTestId("field-error")).toHaveText("Enter a name.");

    await page.getByTestId("welcome-chip").filter({ hasText: "History" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("add-first-hint")).toContainText("Now add your first book");
    await expect(page.getByTestId("topbar-add")).toBeEnabled();
    await expect.poll(async () => (await extra<{ plaques: { name: string }[] }>(page, "plaques")).plaques.map((p) => p.name)).toEqual(["History"]);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/welcome-hint.png` });
    await page.getByTestId("add-first-button").click();
    await expect(page.getByTestId("add-modal")).toHaveAttribute("data-state", "open");
  } finally {
    await page.unroute("**/api/bootstrap");
    await deleteCategoriesNamed(page, "History");
  }
});

/**
 * Visible text (and placeholders and labels) of the page, minus the library's own data (titles,
 * authors, category names), the app's Latin name, and names that are never translated.
 */
async function englishLeftovers(page: Page, data: Bootstrap): Promise<string[]> {
  const allowed = [
    ...data.categories.map((c) => c.name),
    ...data.books.flatMap((b) => [b.title, b.author ?? ""]),
    "Dar al Ilm",
    "English",
    "Home",
    "PDF",
  ].filter(Boolean);
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0 && element.closest('[aria-hidden="true"]') === null;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (text && parent && visible(parent) && !parent.closest("script, style, [data-testid='debug-hud']")) out.push(text);
    }
    for (const element of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
      if (!visible(element)) continue;
      for (const name of ["placeholder", "aria-label", "title"]) {
        const value = element.getAttribute(name)?.trim();
        if (value) out.push(value);
      }
    }
    return out;
  });
  const englishValues = new Set(
    Object.values(MESSAGES.en)
      .flatMap((message) => (typeof message === "string" ? [message] : Object.values(message)))
      .map((message) => message.replace(/\{\w+\}/g, "").trim()),
  );
  const keys = new Set(Object.keys(MESSAGES.en));
  return texts.filter((text) => {
    if (keys.has(text) || englishValues.has(text)) return true;
    let rest = text;
    for (const name of allowed.sort((a, b) => b.length - a.length)) rest = rest.split(name).join(" ");
    return /[A-Za-z]{2,}/.test(rest);
  });
}

test("Arabic mode: no English text is left in the hall, the modals, the toasts, the reader or the welcome card", async ({ page }) => {
  test.setTimeout(240_000);
  await page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: "ar" } });
  const data = await bootstrap(page);
  const findings: string[] = [];
  const check = async (where: string) => {
    for (const text of await englishLeftovers(page, data)) findings.push(`${where}: ${text}`);
  };

  await openHall(page);
  await check("hall");
  // Search with no result.
  await page.keyboard.press("/");
  await page.keyboard.type("zzzz");
  await expect(page.getByTestId("search-empty")).toBeVisible();
  await check("search");
  await page.keyboard.press("Escape");

  // Present panel, then Edit and Delete.
  const book = data.books[0]!;
  await page.evaluate((id) => window.__DAR__!.getState().presentBook(id), book.id);
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).presenter!() as { phase: string }).phase === "shown", null, { timeout: 20_000 });
  await check("present panel");
  await page.getByTestId("present-edit").click();
  await expect(page.getByTestId("edit-modal")).toHaveAttribute("data-state", "open");
  await page.getByTestId("edit-title").fill("");
  await check("edit modal");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("edit-modal")).toHaveCount(0);
  await page.evaluate((id) => window.__DAR__!.getState().openDeleteBook(id), book.id);
  await expect(page.getByTestId("delete-dialog")).toHaveAttribute("data-state", "open");
  await check("delete dialog");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);

  // Add book: empty, then an upload error.
  await page.getByTestId("topbar-add").click();
  await expect(page.getByTestId("add-modal")).toHaveAttribute("data-state", "open");
  await check("add modal");
  await page.getByTestId("add-file-input").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf at all\n".repeat(10)) });
  await expect(page.getByTestId("add-upload-error")).toBeVisible({ timeout: 20_000 });
  await check("add modal error");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-modal")).toHaveCount(0);

  // Settings, a category delete dialog with books, and a toast.
  await openSettings(page);
  await page.getByTestId("category-new-name").fill(data.categories[0]!.name);
  await page.getByTestId("category-create").click();
  await expect(page.getByTestId("category-manager").getByTestId("field-error")).toBeVisible();
  await check("settings");
  await page.getByTestId("category-delete").first().click();
  await expect(page.getByTestId("category-delete-dialog")).toHaveAttribute("data-state", "open");
  await check("category delete dialog");
  await page.keyboard.press("Escape");
  await page.getByTestId("category-new-name").fill(`شعر ${STAMP}`);
  await page.getByTestId("category-create").click();
  await expect(page.getByTestId("toast")).toBeVisible();
  await check("toast");
  await page.request.delete(`/api/categories/${(await bootstrap(page)).categories.find((c) => c.name === `شعر ${STAMP}`)!.id}`, { headers: CLIENT });
  await page.keyboard.press("Escape");

  // The reader inside the hall.
  await page.evaluate((id) => window.__DAR__!.getState().openBook(id), book.id);
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as { phase: string }).phase === "open", null, { timeout: 30_000 });
  await page.mouse.move(700, 500);
  await expect(page.getByTestId("reader-toolbar")).toBeVisible();
  await check("reader");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as { phase: string }).phase === "closed", null, { timeout: 30_000 });

  // First launch, in Arabic.
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...data, categories: [], books: [], currently_reading: [] } }));
  await page.goto("/?test=1");
  await expect(page.getByTestId("welcome-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("welcome-chip")).toHaveText(["البرمجة", "التاريخ", "الروايات", "العربية"]);
  await check("welcome card");
  await page.unroute("**/api/bootstrap");

  expect(findings).toEqual([]);
});
