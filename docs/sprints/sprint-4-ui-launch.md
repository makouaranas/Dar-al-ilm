# Sprint 4 — Bilingual UI (EN/AR), Modals, Diagnostics & Launcher

**Sprint goal:** complete all management modals, English/Arabic UI mirroring, the WebGL
hardware check, empty and error states, and the one-click launcher.

**Read first:** `AGENTS.md`, `docs/DESIGN.md` (UI overlays, copy, states, RTL), then
`docs/ARCHITECTURE.md` §6 (API), §8.1 (two-phase import), §10.3 (presets), §13 (i18n),
§14 (testing) and §15 (launcher).

**Rules for this sprint**
- Every string goes through `t()` with English and Arabic entries; Arabic copy follows the
  glossary and tone in `docs/DESIGN.md`.
- Layout uses Tailwind logical properties only (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`,
  `end-*`); no `ml-*`/`mr-*`/`left-*`/`right-*` for direction-dependent spacing.
- Error and empty states use the exact copy in `docs/DESIGN.md`.
- Running the app and visual evidence: as in Sprint 2.

---

## US-13 — Add Book Modal (Required LTR/RTL, Page 1 Cover Default) & Edit/Delete Modals

**Use case:** UC-02 (import) and FR-10 (edit/delete), FR-06, FR-07.

**Files (scope):**
- `frontend/src/components/ui/Modal.tsx` (shared modal shell: focus trap, `Esc`, backdrop)
- `frontend/src/components/ui/AddBookModal.tsx`, `frontend/src/components/ui/EditBookModal.tsx`,
  `frontend/src/components/ui/DeleteBookDialog.tsx`
- `frontend/src/lib/api.ts` (upload progress, cover endpoints), `frontend/src/lib/i18n.ts`
- `frontend/src/store/useLibraryStore.ts` (book add/update/remove actions)
- `frontend/src/app/page.tsx` (top bar "Add book" button, modal mounting)
- `frontend/e2e/us-13.spec.ts`

**Acceptance criteria:**
- **Given** the user clicks **Add book** (top bar or a ghost slot), **When** they choose or drop
  a PDF, **Then** the modal uploads it with a progress bar (`POST /api/uploads`), shows the
  Page 1 cover preview and page count, and pre-fills Title (`suggested_title`) and Reading
  Direction (`suggested_direction`; Arabic titles pre-select RTL). A ghost slot pre-selects its
  category.
- **Required:** Title, Category and Reading Direction (LTR/RTL). The **Add book** button stays
  disabled and each missing field shows an inline message until all three are valid.
- **Optional:** Author, Notes (multiline), Custom Cover (PNG/JPEG/WebP preview; the automatic
  Page 1 snapshot is used by default).
- `duplicate_of` shows "Already in your library" with **Import anyway** and **Open existing**.
- Upload errors (`not_pdf`, `file_too_large`, `pdf_encrypted`, `pdf_empty`, `pdf_damaged`) show
  inline in the drop zone with the copy from `docs/DESIGN.md`, never as a toast.
- **Add book** (`POST /api/books`) closes the modal; the book appears on its shelf immediately in the
  first free slot with a short arrival animation, and a toast says "Book added".
- **Cancel** or closing the modal deletes the staged upload (`DELETE /api/uploads/{id}`).
- **Edit** modal: change title, author, notes, reading direction and category (the book moves to
  its new shelf immediately), replace the cover or revert to the Page 1 snapshot.
- **Delete** dialog names the book and states that its PDF and cover will be removed from the
  library folder; confirming removes it from the 3D shelf and the desk immediately.
- All three modals work in English and Arabic (mirrored layout, Arabic plurals for page counts).

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-13
```

**Visual evidence:** `us-13/add-empty.png`, `us-13/add-analyzed.png`,
`us-13/add-errors.png`, `us-13/add-duplicate.png`, `us-13/edit.png`, `us-13/delete.png`,
`us-13/add-ar.png`, `us-13/arrival.webm`.

**Browser check (physical machine):** add one of your own PDFs (an Arabic one too): the cover
and page count appear before you save; try saving without a category; save; watch the book land
on its shelf. Edit it into another category, then delete it, and check `library_data/pdfs/` no
longer contains it.

---

## US-14 — Settings Modal, Categories, Graphics Preset, Ambient Light & English/Arabic UI Switcher

**Use case:** UC-01 (settings and categories) and UC-05 (first launch).

**Files (scope):**
- `frontend/src/components/ui/SettingsModal.tsx`, `frontend/src/components/ui/CategoryManager.tsx`,
  `frontend/src/components/ui/WelcomeCard.tsx`
- `frontend/src/lib/i18n.ts` (complete Arabic translations for every string in the app)
- `frontend/src/components/3d/LibraryCanvas.tsx` (preset remount, exposure from ambient light)
- `frontend/src/store/useLibraryStore.ts`
- `frontend/e2e/us-14.spec.ts`

**Acceptance criteria:**
- **Given** the user switches UI language between English (`en`) and Arabic (`ar`) in
  Settings, **Then** all buttons, modals, toasts and overlays flip language and direction
  immediately (`<html lang dir>`), digits stay Western (0–9), and the choice persists.
- **Graphics preset** (Auto / Performance / High) applies `docs/ARCHITECTURE.md` §10.3 and
  remounts the canvas; the choice persists.
- **Ambient light** slider (0.4–1.5) changes the hall's exposure live and persists.
- **Default reading direction** (LTR/RTL) for new books persists.
- **Categories:** create, rename and delete. Category edits update 3D column plaques live.
  Deleting a non-empty category opens a dialog ("Move its books to:" with a category picker)
  and calls `DELETE /api/categories/{id}?move_to=…`; the books move to their new shelves and
  the hall closes the gap. Duplicate names show the `category_name_taken` message inline.
- **First launch (0 categories):** the `WelcomeCard` from `docs/DESIGN.md` appears over the
  hall with **Create your first category** and one-click suggestion chips (Programming,
  History, Novels, العربية). After the first category exists the card is replaced by a hint to
  add a book.
- Every UI string has an Arabic translation; the e2e test fails if any visible text in Arabic
  mode equals its English key or English text (except proper names and the app's Latin name).

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-14
```

**Visual evidence:** `us-14/settings-en.png`, `us-14/settings-ar.png`, `us-14/presets.png`,
`us-14/welcome.png`, `us-14/category-delete-move.png`, `us-14/language-switch.webm`.

**Browser check (physical machine):** switch to Arabic: everything mirrors instantly and reads
naturally; switch presets and compare smoothness with F2; drag the ambient light slider; delete
a category that has books and move them to another one.

---

## US-15 — WebGL Hardware Acceleration Check & API Connection Badge

**Use case:** R2 mitigation (software rendering) and API availability.

**Files (scope):**
- `frontend/src/components/ui/SystemStatusBanner.tsx`, `frontend/src/lib/webglCheck.ts`
- `frontend/src/app/page.tsx`, `frontend/src/lib/i18n.ts`
- `frontend/e2e/us-15.spec.ts`

**Acceptance criteria:**
- **Given** the app loads in any browser, **When** WebGL detects software rendering
  (`WEBGL_debug_renderer_info` renderer matching `/swiftshader|llvmpipe|software|basic render/i`;
  if the renderer string is masked, as in Firefox, the median of the first 30 frames > 33 ms),
  **Then** a non-intrusive amber banner explains that graphics acceleration is off and shows
  per-browser steps to enable it. It can be dismissed; the dismissal is remembered per device.
- No WebGL2 at all → a full-screen page with instructions (no 3D attempted).
- **When** `GET /api/health` is unreachable, **Then** a banner says the library service
  stopped, shows how to restart it (`./start.sh`), retries automatically with backoff (3 s, 6 s,
  12 s, max 30 s) and disappears when the API returns. Reading continues from already loaded
  pages.
- The top bar shows a small connection badge (connected / reconnecting).
- In the cloud container the e2e test expects the software-rendering banner (SwiftShader) and
  simulates an API outage with Playwright request interception (`page.route` aborting
  `/api/*`), then restores it and expects the banner to clear.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-15
```

**Visual evidence:** `us-15/software-banner.png`, `us-15/api-down.png`, `us-15/no-webgl.png`.

**Browser check (physical machine):** with hardware acceleration on, no banner appears. Turn it
off in browser settings and restart the browser: the amber banner appears. Stop the server:
the "service stopped" banner appears and clears when you restart it.

---

## US-16 — One-Click Launcher (`start.sh`) & End-to-End Smoke Test

**Use case:** FR-16 (one-click launcher), deployment.

**Files (scope):**
- `start.sh`, `scripts/setup.sh`
- `README.md` (quick start for the user)
- `PROGRESS.md`

**Acceptance criteria:**
- **Given** the project folder, **When** the user runs `./start.sh`, **Then** it runs setup if
  needed, builds the frontend if `frontend/out/` is missing or stale, ensures
  `library_data/{pdfs,covers,cache,staging}` exist, checks port 8000 is free, starts FastAPI on
  `127.0.0.1:8000` (serving API and frontend), waits for `/api/health`, opens the standalone app
  window, and shuts down cleanly when the window closes or on `Ctrl+C`
  (`docs/ARCHITECTURE.md` §15).
- Flags: `--dev`, `--no-browser`, `--smoke`. `--smoke` starts production mode, checks
  `/api/health` and `/`, stops, and exits 0 only if both succeed.
- A busy port prints a clear message and exits non-zero without killing anything.
- `README.md` explains first-time setup (needs internet once), daily start, where the library
  folder lives, and how to back it up.
- `PROGRESS.md` shows all 16 stories done, with the final full verification output summary.

**Verification command:**
```bash
bash -n start.sh && ./start.sh --smoke && cd backend && .venv/bin/pytest && cd ../frontend && npm run build && npm run test:e2e
```

**Browser check (physical machine):** run `./start.sh` from a fresh clone: setup runs once, the
app window opens on the hall, closing the window stops the server (`ss -ltn` shows port 8000
free).
