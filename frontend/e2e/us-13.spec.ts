import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { Book, Bootstrap, Category } from "../src/lib/api";

// US-13: the Add book modal (two-phase import), and the Edit and Delete modals.
const SHOTS = "e2e/screenshots/us-13";
rmSync(`${SHOTS}/frames`, { recursive: true, force: true });
mkdirSync(`${SHOTS}/frames`, { recursive: true });
const LIBRARY = process.env.DAR_E2E_LIBRARY ?? join(tmpdir(), "dar-al-ilm-e2e-library");
const FIXTURES = join(tmpdir(), "dar-al-ilm-us13-fixtures");
const BACKEND = resolve("../backend");
// Page text differs on every run, so the files are new to the library (no false duplicates).
const STAMP = Date.now().toString(36);
const CLIENT = { "X-Dar-Client": "1" };

type Extra = Record<string, (...args: unknown[]) => unknown>;
const extra = <T,>(page: Page, key: string, ...args: unknown[]) =>
  page.evaluate(([k, a]) => (window.__DAR__!.extra as unknown as Extra)[k as string]!(...(a as unknown[])), [key, args] as const) as Promise<T>;

const FIXTURE_SCRIPT = String.raw`
import sys, pathlib
sys.path.insert(0, sys.argv[1])
import pymupdf
from tests.pdf_factory import damaged_pdf, encrypted_pdf, image_bytes, zero_page_pdf

out = pathlib.Path(sys.argv[2])
stamp = sys.argv[3]
out.mkdir(parents=True, exist_ok=True)

def book(path, title, pages, color, cover_text):
    doc = pymupdf.open()
    for number in range(pages):
        page = doc.new_page(width=420, height=595)
        if number == 0:
            page.draw_rect(page.rect, color=None, fill=color)
            page.draw_rect(pymupdf.Rect(30, 30, 390, 565), color=(0.85, 0.72, 0.48), width=1.5)
            if cover_text:
                page.insert_textbox(pymupdf.Rect(50, 210, 370, 330), cover_text, fontsize=28, color=(0.96, 0.95, 0.92), align=1)
        else:
            page.insert_text((48, 72), f"Page {number + 1} ({stamp})", fontsize=12)
    doc.set_metadata({"title": title})
    doc.save(path)

book(out / "quiet-reading.pdf", "The Art of Quiet Reading", 12, (0.13, 0.25, 0.33), "The Art of Quiet Reading")
book(out / "arabic.pdf", "فن القراءة الهادئة", 7, (0.45, 0.22, 0.15), None)
book(out / "light.pdf", "Notes on Light", 3, (0.22, 0.36, 0.30), "Notes on Light")
book(out / "edit-me.pdf", "A Book to Edit", 5, (0.35, 0.30, 0.45), "A Book to Edit")
book(out / "delete-me.pdf", "A Book to Delete", 4, (0.50, 0.42, 0.20), "A Book to Delete")
book(out / "arrival.pdf", "Arrival", 9, (0.55, 0.16, 0.20), "Arrival")
encrypted_pdf(out / "locked.pdf")
zero_page_pdf(out / "empty.pdf")
damaged_pdf(out / "damaged.pdf")
(out / "notes.pdf").write_bytes(b"These are plain text notes, not a PDF.\n" * 20)
(out / "cover.png").write_bytes(image_bytes("PNG", (600, 900), (44, 76, 156)))
`;

test.beforeAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  execFileSync(join(BACKEND, ".venv/bin/python"), ["-c", FIXTURE_SCRIPT, BACKEND, FIXTURES, STAMP], { stdio: "inherit" });
});

const fixture = (name: string) => join(FIXTURES, name);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

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

async function categoryNamed(page: Page, name: string): Promise<Category> {
  return (await bootstrap(page)).categories.find((category) => category.name === name)!;
}

async function setLanguage(page: Page, language: "en" | "ar"): Promise<void> {
  const response = await page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: language } });
  expect(response.ok()).toBe(true);
}

/** Imports a fixture through the API (both phases), for tests that start from a shelved book. */
async function importBook(page: Page, file: string, title: string, categoryId: number): Promise<Book> {
  const upload = await page.request.post("/api/uploads", {
    headers: CLIENT,
    multipart: { pdf_file: { name: file, mimeType: "application/pdf", buffer: readFileSync(fixture(file)) } },
  });
  expect(upload.status()).toBe(201);
  const { upload_id } = (await upload.json()) as { upload_id: string };
  const created = await page.request.post("/api/books", {
    headers: CLIENT,
    multipart: { upload_id, title, category_id: String(categoryId), reading_direction: "LTR" },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as Book;
}

async function deleteBook(page: Page, id: number): Promise<void> {
  await page.request.delete(`/api/books/${id}`, { headers: CLIENT });
}

/** Books these tests create, left behind by an interrupted run. */
const TEST_TITLES = ["The Art of Quiet Reading", "Notes on Light", "A Book to Edit", "Histoire de la lecture", "A Book to Delete", "Arrival"];

test.beforeEach(async ({ page }) => {
  for (const book of (await bootstrap(page)).books) if (TEST_TITLES.includes(book.title)) await deleteBook(page, book.id);
});

function stagedFiles(uploadId: string): string[] {
  const dir = join(LIBRARY, "staging");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(uploadId)) : [];
}

async function openAddModal(page: Page): Promise<void> {
  await page.getByTestId("topbar-add").click();
  await expect(page.getByTestId("add-modal")).toHaveAttribute("data-state", "open");
}

test("Add book opens an empty, focus-trapped modal from the top bar; Esc closes it", async ({ page }) => {
  await openHall(page);
  await openAddModal(page);
  const modal = page.getByTestId("add-modal");
  await expect(modal).toHaveAttribute("role", "dialog");
  await expect(modal).toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("add-choose")).toBeFocused();
  await expect(page.getByTestId("add-dropzone")).toHaveAttribute("data-phase", "empty");
  await expect(page.getByTestId("add-submit")).toBeDisabled();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/add-empty.png` });

  // Tab never leaves the modal.
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="add-modal"]') !== null)).toBe(true);
  }
  // The hall ignores the arrow keys while the modal is open.
  const before = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
  await page.getByTestId("add-choose").focus();
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowUp");
  expect((await page.evaluate(() => window.__DAR__!.extra.hall!.pose())).z).toBeCloseTo(before.z, 5);

  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("topbar-add")).toBeFocused();
});

test("a PDF uploads with progress, shows its Page 1 cover and page count; the three required fields gate Add book; the book lands on its shelf", async ({ page }) => {
  await openHall(page);
  const programming = await categoryNamed(page, "Programming");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  let created: number | null = null;
  try {
    await openAddModal(page);
    // Record the import phases as the UI shows them.
    await page.evaluate(() => {
      const w = window as unknown as { __phases: string[]; __on: boolean };
      w.__phases = [];
      w.__on = true;
      const tick = () => {
        if (!w.__on) return;
        const phase = ((window.__DAR__!.extra as unknown as Extra).addBook!() as { phase: string }).phase;
        if (w.__phases.at(-1) !== phase) w.__phases.push(phase);
        requestAnimationFrame(tick);
      };
      tick();
    });
    await page.getByTestId("add-file-input").setInputFiles(fixture("quiet-reading.pdf"));
    await expect(page.getByTestId("add-cover")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
    await page.waitForFunction(() => (window as unknown as { __phases: string[] }).__phases.at(-1) === "ready", null, { timeout: 10_000 });
    const phases = await page.evaluate(() => {
      const w = window as unknown as { __phases: string[]; __on: boolean };
      w.__on = false;
      return w.__phases;
    });
    expect(phases[0]).toBe("empty");
    expect(phases.some((phase) => phase === "uploading" || phase === "reading")).toBe(true);
    expect(phases.at(-1)).toBe("ready");
    expect(requests).toContain("POST /api/uploads");

    await expect(page.getByTestId("add-page-count")).toHaveText("12 pages");
    await expect(page.getByTestId("add-title")).toHaveValue("The Art of Quiet Reading");
    await expect(page.getByTestId("add-direction").locator('[aria-checked="true"]')).toHaveAttribute("data-value", "LTR");
    await expect(page.getByTestId("add-cover")).toHaveAttribute("data-custom", "false");
    // Category is still missing: inline message, Add book disabled.
    await expect(page.getByTestId("field-error")).toHaveText(["Choose a category."]);
    await expect(page.getByTestId("add-submit")).toBeDisabled();
    // Clearing the title adds its message.
    await page.getByTestId("add-title").fill("");
    await expect(page.getByTestId("field-error")).toHaveText(["Enter a title.", "Choose a category."]);
    await expect(page.getByTestId("add-title")).toHaveAttribute("aria-invalid", "true");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/add-required.png` });
    await page.getByTestId("add-title").fill("The Art of Quiet Reading");
    await page.getByTestId("add-category").selectOption({ label: "Programming" });
    await expect(page.getByTestId("field-error")).toHaveCount(0);
    await page.getByTestId("add-author").fill("Leila Haddad");
    await page.getByTestId("add-notes").fill("A calm, short book about reading slowly.");
    await expect(page.getByTestId("add-submit")).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/add-analyzed.png` });

    const uploadId = ((await extra<{ uploadId: string }>(page, "addBook")).uploadId)!;
    expect(stagedFiles(uploadId).length).toBe(3);
    // Sample the arrival (the slide out of the slot) on every browser frame from the click on.
    await page.evaluate(() => {
      const w = window as unknown as { __arrival: { waiting: boolean; slide: number | null }[]; __on: boolean };
      w.__arrival = [];
      w.__on = true;
      const tick = () => {
        if (!w.__on) return;
        const arrival = window.__DAR__!.getState().arrival;
        const spines = (window.__DAR__!.extra as unknown as Extra).spines!() as { arrival?: { slide: number } | null }[];
        const slide = spines.find((s) => s.arrival)?.arrival?.slide ?? null;
        if (arrival) w.__arrival.push({ waiting: arrival.at === null, slide });
        requestAnimationFrame(tick);
      };
      tick();
    });
    await page.getByTestId("add-submit").click();
    await expect(page.getByTestId("toast")).toHaveText("Book added");
    await expect(page.getByTestId("add-modal")).toHaveCount(0);

    // addBook appends the new book.
    const book = (await page.evaluate(() => window.__DAR__!.getState().books.at(-1)!))!;
    expect(book.title).toBe("The Art of Quiet Reading");
    created = book.id;
    expect(book).toMatchObject({ category_id: programming.id, author: "Leila Haddad", notes: "A calm, short book about reading slowly.", reading_direction: "LTR", page_count: 12 });
    // The staged files moved into the library (none left in staging/).
    expect(stagedFiles(uploadId)).toEqual([]);
    expect(existsSync(join(LIBRARY, "pdfs", `book_${book.id}.pdf`))).toBe(true);
    // Shelved at once in the first free slot, and counted in its category.
    const state = await page.evaluate(() => window.__DAR__!.getState());
    expect(state.categories.find((c) => c.id === programming.id)!.book_count).toBe(programming.book_count + 1);

    // The camera flew to it; it waited out in the aisle, then slid into its slot and glowed.
    await page.waitForFunction(() => window.__DAR__!.getState().arrival === null, null, { timeout: 20_000 });
    const samples = await page.evaluate(() => {
      const w = window as unknown as { __arrival: { waiting: boolean; slide: number | null }[]; __on: boolean };
      w.__on = false;
      return w.__arrival;
    });
    writeFileSync(`${SHOTS}/arrival.txt`, `${JSON.stringify(samples)}\n`);
    // Out in the aisle while the camera flies; the eased slide itself is checked frame by frame
    // in the frame-sequence test (software rendering draws too few frames to catch it here).
    expect(samples.some((sample) => sample.waiting && sample.slide !== null && Math.abs(sample.slide - 0.3) < 1e-6)).toBe(true);
    expect(samples.some((sample) => !sample.waiting)).toBe(true);
    await page.waitForFunction(() => window.__DAR__!.getState().arrival === null, null, { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/arrived.png` });
    expect(await page.evaluate(() => window.__DAR__!.getState().highlight?.bookId)).toBe(book.id);
    const target = await extra<{ categoryId: number }>(page, "bookTarget", book.id);
    expect(target.categoryId).toBe(programming.id);
    // The camera stands in front of it.
    const pose = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
    const spine = await extra<{ x: number; z: number }>(page, "bookTarget", book.id);
    expect(Math.hypot(pose.x - spine.x, pose.z - spine.z)).toBeCloseTo(1.3, 1);
  } finally {
    if (created !== null) await deleteBook(page, created);
  }
});

test("upload errors show inline in the drop zone with the design copy, never as a toast", async ({ page }) => {
  await openHall(page);
  await openAddModal(page);
  const cases: [string, string][] = [
    ["notes.pdf", "This file isn't a PDF. Choose a .pdf file."],
    ["empty.pdf", "This PDF has no pages."],
    ["damaged.pdf", "This PDF is damaged and can't be opened."],
    ["locked.pdf", "This PDF is password-protected. Remove the password, then add it again."],
  ];
  for (const [file, message] of cases) {
    await page.getByTestId("add-file-input").setInputFiles(fixture(file));
    await expect(page.getByTestId("add-upload-error")).toHaveText(message, { timeout: 20_000 });
    await expect(page.getByTestId("add-dropzone")).toHaveAttribute("data-phase", "error");
    await expect(page.getByTestId("add-submit")).toBeDisabled();
    await expect(page.getByTestId("toast")).toHaveCount(0);
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/add-errors.png` });

  // file_too_large needs a file over 2 GB: the server's answer is simulated here.
  await page.route("**/api/uploads", (route) =>
    route.fulfill({ status: 413, json: { detail: { code: "file_too_large", message: "Upload exceeds the size limit." } } }),
  );
  await page.getByTestId("add-file-input").setInputFiles(fixture("light.pdf"));
  await expect(page.getByTestId("add-upload-error")).toHaveText("This PDF is larger than 2 GB.");
  await page.unroute("**/api/uploads");

  // A new file after an error works.
  await page.getByTestId("add-file-input").setInputFiles(fixture("light.pdf"));
  await expect(page.getByTestId("add-cover")).toBeVisible({ timeout: 20_000 });
  const uploadId = (await extra<{ uploadId: string }>(page, "addBook")).uploadId;
  await page.getByTestId("add-modal-close").click();
  await expect(page.getByTestId("add-modal")).toHaveCount(0);
  await expect.poll(() => stagedFiles(uploadId).length).toBe(0);
});

test("a duplicate offers Import anyway and Open existing; Cancel deletes the staged upload", async ({ page }) => {
  await openHall(page);
  const novels = await categoryNamed(page, "Novels");
  const existing = await importBook(page, "light.pdf", "Notes on Light", novels.id);
  try {
    await openHall(page);
    const deletes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url().includes("/api/uploads/")) deletes.push(new URL(request.url()).pathname);
    });

    await openAddModal(page);
    await page.getByTestId("add-file-input").setInputFiles(fixture("light.pdf"));
    await expect(page.getByTestId("add-duplicate")).toContainText('Already in your library: "Notes on Light".', { timeout: 20_000 });
    await page.getByTestId("add-category").selectOption({ label: "Novels" });
    await expect(page.getByTestId("add-submit")).toBeDisabled();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/add-duplicate.png` });
    await page.getByTestId("duplicate-import").click();
    await expect(page.getByTestId("add-duplicate")).toHaveCount(0);
    await expect(page.getByTestId("add-submit")).toBeEnabled();

    // Cancel: the staged upload is deleted.
    const firstUpload = (await extra<{ uploadId: string }>(page, "addBook")).uploadId;
    expect(stagedFiles(firstUpload).length).toBe(3);
    await page.getByTestId("add-cancel").click();
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
    await expect.poll(() => deletes).toContain(`/api/uploads/${firstUpload}`);
    await expect.poll(() => stagedFiles(firstUpload).length).toBe(0);

    // Open existing: the staged upload goes, the existing book opens in the reader.
    await openAddModal(page);
    await page.getByTestId("add-file-input").setInputFiles(fixture("light.pdf"));
    await expect(page.getByTestId("add-duplicate")).toBeVisible({ timeout: 20_000 });
    const secondUpload = (await extra<{ uploadId: string }>(page, "addBook")).uploadId;
    await page.getByTestId("duplicate-open").click();
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
    await expect.poll(() => stagedFiles(secondUpload).length).toBe(0);
    await page.waitForFunction(
      (id) => {
        const transition = (window.__DAR__!.extra as unknown as Extra).readerTransition!() as { phase: string; bookId: number | null };
        return transition.phase === "open" && transition.bookId === id;
      },
      existing.id,
      { timeout: 30_000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).readerTransition!() as { phase: string }).phase === "closed", null, {
      timeout: 30_000,
    });
  } finally {
    await deleteBook(page, existing.id);
  }
});

test("a ghost slot pre-selects its category", async ({ page }) => {
  const created = await page.request.post("/api/categories", { headers: CLIENT, data: { name: `Poetry ${STAMP}` } });
  expect(created.status()).toBe(201);
  const poetry = (await created.json()) as Category;
  try {
    await openHall(page);
    const shelves = await extra<{ categoryId: number; ghost: boolean }[]>(page, "shelves");
    expect(shelves.find((s) => s.categoryId === poetry.id)?.ghost).toBe(true);
    // The fifth bay (column 4) is on the -X side; its ghost label is on the eye-level shelf.
    expect(poetry.column_index).toBe(4);
    const labelZ = 8 + 2 * 3.4 + 0.27 + 0.154;
    await page.evaluate(([x, z, pitch]) => window.__DAR__!.extra.hall!.teleport(x!, z!, 0, pitch), [-4.35, labelZ + 1.5, (Math.atan2(1.59 - 1.62, 1.5) * 180) / Math.PI]);
    await page.waitForTimeout(900);
    await page.mouse.click(720, 450);
    await expect(page.getByTestId("add-modal")).toHaveAttribute("data-state", "open");
    await expect(page.getByTestId("add-category")).toHaveValue(String(poetry.id));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/categories/${poetry.id}`, { headers: CLIENT });
  }
});

test("Edit changes the details, moves the book to another category, replaces the cover and reverts it", async ({ page }) => {
  await openHall(page);
  const programming = await categoryNamed(page, "Programming");
  const histoire = await categoryNamed(page, "Histoire");
  const book = await importBook(page, "edit-me.pdf", "A Book to Edit", programming.id);
  try {
    await openHall(page);
    await page.evaluate((id) => window.__DAR__!.getState().presentBook(id), book.id);
    await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).presenter!() as { phase: string }).phase === "shown", null, { timeout: 20_000 });
    await page.getByTestId("present-edit").click();
    const modal = page.getByTestId("edit-modal");
    await expect(modal).toHaveAttribute("data-state", "open");
    await expect(page.getByTestId("edit-title")).toBeFocused();
    await expect(page.getByTestId("edit-title")).toHaveValue("A Book to Edit");
    await expect(page.getByTestId("edit-submit")).toBeDisabled();
    // The presented book went back to its shelf.
    await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });

    await page.getByTestId("edit-title").fill("Histoire de la lecture");
    await page.getByTestId("edit-author").fill("Alberto Manguel");
    await page.getByTestId("edit-notes").fill("Moved to the history shelf.");
    await page.getByTestId("edit-category").selectOption({ label: "Histoire" });
    await page.getByTestId("edit-direction").getByRole("radio", { name: "Right to left" }).click();
    await page.getByTestId("edit-cover-input").setInputFiles(fixture("cover.png"));
    await expect(page.getByTestId("edit-cover")).toHaveAttribute("data-custom", "true");
    await expect(page.getByTestId("edit-cover")).toHaveAttribute("data-loaded", "true");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/edit.png` });
    await page.getByTestId("edit-submit").click();
    // Two requests (details, then the cover the server re-encodes) before the modal closes and
    // the toast shows. The toast lasts 4 s while the modal's exit can take longer than that under
    // software rendering, so the toast is checked first.
    await expect(page.getByTestId("toast")).toHaveText("Changes saved");
    await expect(modal).toHaveCount(0);

    const saved = (await page.evaluate((id) => window.__DAR__!.getState().books.find((b) => b.id === id)!, book.id))!;
    expect(saved).toMatchObject({
      title: "Histoire de la lecture",
      author: "Alberto Manguel",
      notes: "Moved to the history shelf.",
      category_id: histoire.id,
      reading_direction: "RTL",
      cover_is_custom: true,
    });
    // It moved to the Histoire bay at once.
    await expect.poll(async () => (await extra<{ categoryId: number } | null>(page, "bookTarget", book.id))?.categoryId).toBe(histoire.id);
    const counts = (await page.evaluate(() => window.__DAR__!.getState().categories)).map((c) => [c.id, c.book_count]);
    expect(counts).toContainEqual([histoire.id, histoire.book_count + 1]);
    expect(counts).toContainEqual([programming.id, programming.book_count]);

    // Revert to the Page 1 snapshot.
    await page.evaluate((id) => window.__DAR__!.getState().openEditBook(id), book.id);
    await expect(page.getByTestId("edit-cover")).toHaveAttribute("data-custom", "true");
    await page.getByTestId("edit-cover-revert").click();
    await expect(page.getByTestId("edit-cover")).toHaveAttribute("data-custom", "false");
    await page.getByTestId("edit-submit").click();
    await expect(page.getByTestId("edit-modal")).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => page.evaluate((id) => window.__DAR__!.getState().books.find((b) => b.id === id)!.cover_is_custom, book.id)).toBe(false);

    // An empty title is refused inline.
    await page.evaluate((id) => window.__DAR__!.getState().openEditBook(id), book.id);
    await page.getByTestId("edit-title").fill("   ");
    await expect(page.getByTestId("field-error")).toHaveText("Enter a title.");
    await expect(page.getByTestId("edit-submit")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("edit-modal")).toHaveCount(0);
  } finally {
    await deleteBook(page, book.id);
  }
});

test("Delete names the book, removes it from the shelf and the desk, and leaves no files", async ({ page }) => {
  await openHall(page);
  const novels = await categoryNamed(page, "Novels");
  const book = await importBook(page, "delete-me.pdf", "A Book to Delete", novels.id);
  let deleted = false;
  try {
    // Opened once, so it is first on the Entrance Desk.
    await page.request.patch(`/api/books/${book.id}`, { headers: CLIENT, data: { mark_opened: true } });
    await openHall(page);
    expect((await page.evaluate(() => window.__DAR__!.getState().currentlyReading))[0]).toBe(book.id);
    await page.evaluate((id) => window.__DAR__!.getState().presentBook(id), book.id);
    await page.waitForFunction(() => ((window.__DAR__!.extra as unknown as Extra).presenter!() as { phase: string }).phase === "shown", null, { timeout: 20_000 });
    await page.getByTestId("present-delete").click();
    const dialog = page.getByTestId("delete-dialog");
    await expect(dialog).toHaveAttribute("data-state", "open");
    await expect(dialog).toHaveAttribute("role", "alertdialog");
    await expect(page.getByTestId("delete-name")).toHaveText('Delete "A Book to Delete"?');
    await expect(dialog).toContainText("Its PDF and cover will be removed from the library folder.");
    await expect(page.getByTestId("delete-cancel")).toBeFocused();
    await page.waitForFunction(() => window.__DAR__!.getState().presentedBookId === null, null, { timeout: 20_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/delete.png` });
    expect(existsSync(join(LIBRARY, "pdfs", `book_${book.id}.pdf`))).toBe(true);

    await page.getByTestId("delete-confirm").click();
    await expect(dialog).toHaveCount(0);
    deleted = true;
    await expect(page.getByTestId("toast")).toHaveText("Book deleted");
    const state = await page.evaluate(() => window.__DAR__!.getState());
    expect(state.books.some((b) => b.id === book.id)).toBe(false);
    expect(state.currentlyReading).not.toContain(book.id);
    expect(await extra(page, "bookTarget", book.id)).toBeNull();
    expect(state.categories.find((c) => c.id === novels.id)!.book_count).toBe(novels.book_count);
    expect(existsSync(join(LIBRARY, "pdfs", `book_${book.id}.pdf`))).toBe(false);
    expect(existsSync(join(LIBRARY, "covers", `book_${book.id}.webp`))).toBe(false);
  } finally {
    if (!deleted) await deleteBook(page, book.id);
  }
});

test("Arabic: the modal is mirrored, an Arabic title pre-selects RTL, and page counts use Arabic plurals", async ({ page }) => {
  await setLanguage(page, "ar");
  try {
    await openHall(page);
    await expect(page.getByTestId("topbar-add")).toHaveText("إضافة كتاب");
    await openAddModal(page);
    await expect(page.getByTestId("add-modal").getByRole("heading")).toHaveText("إضافة كتاب");
    await page.getByTestId("add-file-input").setInputFiles(fixture("arabic.pdf"));
    await expect(page.getByTestId("add-cover")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
    await expect(page.getByTestId("add-title")).toHaveValue("فن القراءة الهادئة");
    await expect(page.getByTestId("add-direction").locator('[aria-checked="true"]')).toHaveAttribute("data-value", "RTL");
    await expect(page.getByTestId("add-page-count")).toHaveText("7 صفحات");
    await expect(page.getByTestId("field-error")).toHaveText(["اختر تصنيفًا."]);
    // Mirrored: the cover column is on the right, the fields on the left.
    const cover = (await page.getByTestId("add-cover").boundingBox())!;
    const title = (await page.getByTestId("add-title").boundingBox())!;
    expect(cover.x).toBeGreaterThan(title.x + title.width);
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/add-ar.png` });
    const uploadId = (await extra<{ uploadId: string }>(page, "addBook")).uploadId;
    await page.getByTestId("add-cancel").click();
    await expect.poll(() => stagedFiles(uploadId).length).toBe(0);
  } finally {
    await setLanguage(page, "en");
  }
});

test("frame sequence of a new book's flight and arrival", async ({ page }) => {
  await openHall(page);
  let created: number | null = null;
  try {
    await openAddModal(page);
    await page.getByTestId("add-file-input").setInputFiles(fixture("arrival.pdf"));
    await expect(page.getByTestId("add-cover")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
    await page.getByTestId("add-category").selectOption({ label: "Novels" });
    // Hold the slide at its start so the camera's arrival and the slide can be captured apart.
    await extra(page, "arrivalHold", 0);
    await page.getByTestId("add-submit").click();
    let shot = 0;
    const frame = () => page.screenshot({ path: `${SHOTS}/frames/arrival-${String(shot++).padStart(2, "0")}.png` });
    for (let i = 0; i < 12; i += 1) {
      await frame();
      if (await page.evaluate(() => window.__DAR__!.getState().arrival?.at != null)) break;
    }
    await page.waitForFunction(() => window.__DAR__!.getState().arrival?.at != null, null, { timeout: 20_000 });
    await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 20_000 });
    // An eased slide (easeOutCubic over 650 ms) from 30 cm out into the slot.
    for (const progress of [0, 0.1, 0.2, 0.3, 0.42, 0.55, 0.7, 0.85, 1]) {
      await extra(page, "arrivalHold", progress);
      await page.waitForTimeout(500);
      const spines = await extra<{ arrival?: { slide: number } | null }[]>(page, "spines");
      const slide = spines.find((s) => s.arrival)!.arrival!.slide;
      expect(slide).toBeCloseTo(0.3 * (1 - easeOutCubic(progress)), 5);
      await frame();
    }
    await extra(page, "arrivalHold", null);
    await page.waitForFunction(() => window.__DAR__!.getState().arrival === null, null, { timeout: 20_000 });
    created = (await page.evaluate(() => window.__DAR__!.getState().books.at(-1)!.id))!;
  } finally {
    await extra(page, "arrivalHold", null).catch(() => undefined);
    if (created !== null) await deleteBook(page, created);
  }
});
