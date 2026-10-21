# Sprint 1 — Python Backend, SQLite Catalog & PyMuPDF Streaming Engine

**Sprint goal:** build and verify the local Python API, the SQLite database, and the
high-speed PDF cover and page renderer.

**Read first:** `AGENTS.md`, then `docs/ARCHITECTURE.md` §2 (versions), §4 (storage), §5 (data
model), §6 (API), §7 (security), §8 (PDF pipeline) and §9.1 (shelf allocation).

**Rules for this sprint**
- Python ≥ 3.12; packages exactly as pinned in `docs/ARCHITECTURE.md` §2.3.
- Import PyMuPDF as `import pymupdf` (not `fitz`).
- Tests never touch a real library: `conftest.py` points `DAR_DATA_DIR` at `tmp_path` and sets
  `DAR_RENDER_WORKERS=0`.
- Test PDFs are generated at test time by `tests/pdf_factory.py`. No copyrighted files.

---

## US-01 — Workspace Init, SQLite WAL Database & Models

**Use case:** foundation for UC-01 to UC-04.

**Files (scope):**
- `.gitignore` (`library_data/`, `backend/.venv/`, `__pycache__/`, `.pytest_cache/`,
  `frontend/node_modules/`, `frontend/.next/`, `frontend/out/`, `frontend/test-results/`,
  `frontend/playwright-report/`, `frontend/e2e/screenshots/`)
- `scripts/setup.sh`
- `backend/requirements.txt`, `backend/requirements-dev.txt`, `backend/pytest.ini`
- `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/main.py`,
  `backend/app/security.py`, `backend/app/database.py`, `backend/app/models.py`,
  `backend/app/routers/__init__.py`, `backend/app/routers/health.py`
- `backend/tests/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_api.py`

**Acceptance criteria:**
- **Given** the backend starts, **When** `init_db()` runs, **Then**
  `{DAR_DATA_DIR}/{pdfs,covers,cache,staging}` and `{DAR_DATA_DIR}/library.db` are created.
- The data directory resolves from `DAR_DATA_DIR` or `<repo>/library_data`, independent of
  the current working directory (`docs/ARCHITECTURE.md` §4).
- Every connection reports `PRAGMA journal_mode` = `wal` and `PRAGMA foreign_keys` = `1`.
- Tables `category`, `book` and `app_setting` exist with every column and constraint from
  `docs/ARCHITECTURE.md` §5, including `UNIQUE(category_id, shelf_number, slot_index)`, the
  `CHECK` constraints and `ON DELETE RESTRICT`.
- The singleton `app_setting` row (`id = 1`) exists with defaults `en`, `LTR`, `auto`, `1.0`.
- `PRAGMA user_version` = 1, and the migration runner exists (empty list of migrations).
- `GET /api/health` returns `200 {"status": "ok", "api_version": 1}`.
- A request with `Host: evil.example` returns `400` (TrustedHost).
- `security.py` implements the `X-Dar-Client` and `Origin` checks for mutating methods
  (exercised by US-02 tests).
- `scripts/setup.sh --backend` creates `backend/.venv` and installs both requirements files;
  it is idempotent.

**Verification command:**
```bash
./scripts/setup.sh --backend && cd backend && .venv/bin/pytest tests/test_api.py -k test_health_and_db
```

---

## US-02 — Category & Settings CRUD Endpoints (+ Bootstrap)

**Use case:** UC-01 (categories and preferences).

**Files (scope):**
- `backend/app/routers/categories.py`, `backend/app/routers/settings.py`,
  `backend/app/routers/bootstrap.py`
- `backend/app/main.py` (router registration), `backend/app/security.py` (if adjustments are
  needed)
- `backend/tests/test_api.py`

**Acceptance criteria:**
- **Given** English, French or Arabic category names (e.g., `Programming`, `Histoire`,
  `العربية`), **When** `POST /api/categories` is called, **Then** categories receive
  sequential `column_index` values (0, 1, 2…), names are stored trimmed in NFC, and the
  response is `201 Category` with `book_count = 0`.
- Duplicate names by `name_key` (e.g., `History` vs ` history `) return
  `409 category_name_taken`. Empty or > 40-character names return `422`.
- `PATCH /api/categories/{id}` renames with the same rules; unknown IDs return
  `404 category_not_found`.
- `DELETE /api/categories/{id}`:
  - empty category → `204`, and later categories' `column_index` values shift down by one;
  - category with books and no `move_to` → `409 category_not_empty` with `book_count`;
  - with `move_to` → books move to the target category using first-free-slot, then `204`;
  - unknown `move_to` → `404 category_not_found`; `move_to` equal to the category being
    deleted → `422`.
  (Tests insert `book` rows directly through the database session, because uploads arrive in
  US-03.)
- **When** `PATCH /api/settings` is called, **Then** settings persist `ui_language` (`en`/`ar`),
  `default_direction` (`LTR`/`RTL`), `graphics_quality` (`auto`/`performance`/`high`) and
  `ambient_light` (0.4–1.5); invalid values return `422`.
- `GET /api/bootstrap` returns `categories`, `books` (empty for now), `currently_reading`
  (empty), `settings` and `api_version`.
- Mutating requests without `X-Dar-Client: 1` return `403 forbidden_client`; with a foreign
  `Origin` (`https://evil.example`) return `403 forbidden_origin`.

**Verification command:**
```bash
cd backend && .venv/bin/pytest tests/test_api.py -k test_categories_and_settings
```

---

## US-03 — Managed PDF Upload, Page Count, Page 1 Cover & Auto-Shelf Math

**Use case:** UC-02 (importing a PDF book).

**Files (scope):**
- `backend/app/pdf_service.py`, `backend/app/shelving.py`
- `backend/app/routers/uploads.py`, `backend/app/routers/books.py`
- `backend/app/main.py` (router registration)
- `backend/tests/pdf_factory.py`, `backend/tests/test_api.py`

**Acceptance criteria:**
- **Given** a `.pdf` file, **When** `POST /api/uploads` runs, **Then** the file is streamed to
  `staging/{upload_id}.pdf` in 1 MB chunks while its SHA-256 is computed, PyMuPDF counts the
  pages and reads page 1's size, page 1 is rendered to `staging/{upload_id}.webp`, and the
  response contains every `Upload` field from `docs/ARCHITECTURE.md` §6.3.
- `suggested_title` comes from PDF metadata, else the cleaned file name stem.
  `suggested_direction` is `RTL` for a title in Arabic script (fixture with metadata title
  `مقدمة ابن خلدون`), else the `default_direction` setting.
- Rejections: non-PDF → `415 not_pdf`; oversized (test with a lowered `DAR_MAX_UPLOAD_MB`) →
  `413 file_too_large`; encrypted → `422 pdf_encrypted`; zero pages → `422 pdf_empty`;
  damaged → `422 pdf_damaged`. Rejected uploads leave no staged files.
- `GET /api/uploads/{upload_id}/cover` returns the WebP preview; `DELETE` removes the 3 staged
  files.
- **Given** a staged upload with required `title`, `category_id` and `reading_direction`,
  **When** `POST /api/books` runs, **Then** the PDF is moved to `pdfs/book_{id}.pdf`, the
  automatic Page 1 cover to `covers/book_{id}.webp` (or a custom `cover_file` is validated and
  re-encoded), `spine_color`, `file_sha256`, `file_size_bytes`, `page_width_pt` and
  `page_height_pt` are stored, and the response is `201 Book`.
- Missing required fields → `422`; unknown `upload_id` → `404 upload_not_found`; unknown
  category → `404 category_not_found`; invalid custom cover → `415 invalid_cover`.
- The original source file can be deleted after upload: the test deletes it and the book's
  cover and page count remain available.
- A second upload of the same file reports `duplicate_of` with the first book.
- **Shelf math (first free slot, `docs/ARCHITECTURE.md` §9.1):**
  - 30 books in one category fill shelf 0 slots 0–29; the 31st gets `shelf_number = 1`,
    `slot_index = 0` (FR-05).
  - Unit test on `shelving.allocate`: with slot (0, 7) free and shelf 1 partly used, the next
    allocation is (0, 7).
- `GET /api/books/{id}/cover` returns the cover WebP.
- **Timing:** for the 400-page synthetic scanned fixture, the server-side time of
  `POST /api/uploads` is < 1.5 s (G2/FR-07), measured in the test with a generous margin.

**Verification command:**
```bash
cd backend && .venv/bin/pytest tests/test_api.py -k test_book_upload_and_shelf_overflow
```

---

## US-04 — LoD Page Streaming (low/high/zoom), Cache & Book Edit/Delete

**Use case:** UC-04 (reading) and FR-10 (edit and delete).

**Files (scope):**
- `backend/app/pdf_service.py`, `backend/app/render_pool.py`, `backend/app/cache.py`,
  `backend/app/maintenance.py`
- `backend/app/routers/books.py`, `backend/app/main.py` (startup hooks)
- `backend/scripts/seed_demo.py`
- `backend/tests/test_api.py`, `backend/tests/test_perf.py`

**Acceptance criteria:**
- **Given** an uploaded book, **When** `GET /api/books/{id}/page/{n}?quality=low|high|zoom` is
  called, **Then** the API returns `200 image/webp` whose long side is 768, 2048 or 4096 px
  respectively (`docs/ARCHITECTURE.md` §8.2).
- Pages are 1-based: `n = 0` or `n > page_count` → `404 page_out_of_range`; an invalid
  `quality` → `422`; a missing PDF file → `410 pdf_missing`.
- The first request writes `cache/book_{id}/{quality}/{n}.webp`; a second identical request is
  served from the cache with identical bytes and an `ETag`.
- After serving page `n`, prefetch jobs for `low` `n+1…n+6` and `high` `n+1…n+2` are scheduled
  (`docs/ARCHITECTURE.md` §8.3). With `DAR_RENDER_WORKERS=0` the test can drain the prefetch
  queue and assert the cached files exist.
- The cache honours `DAR_CACHE_LIMIT_MB`: with a tiny limit, the least recently used files are
  evicted down to 90 % of the limit.
- **Edit:** `PATCH /api/books/{id}` updates `title`, `author` (nullable), `notes` (nullable),
  `reading_direction`, `last_read_page` (1…`page_count`, else `422`) and `mark_opened`
  (sets `last_opened_at` to now, UTC). Changing `category_id` moves the book to the first free
  slot of the new category and frees the old slot.
- `GET /api/bootstrap` now lists books, and `currently_reading` holds up to 3 IDs ordered by
  `last_opened_at` descending.
- **Cover:** `PUT /api/books/{id}/cover` replaces the cover and recomputes `spine_color`;
  `DELETE /api/books/{id}/cover` regenerates the automatic Page 1 snapshot. `cover_url`'s `v`
  changes after either.
- **Delete:** `DELETE /api/books/{id}` removes the row, the PDF, the cover and
  `cache/book_{id}/`. The test asserts zero files containing `book_{id}` remain anywhere under
  the data directory (FR-10).
- **Startup reconciliation** (`docs/ARCHITECTURE.md` §8.5): orphan PDFs, covers and cache folders
  are removed; staged uploads older than 24 hours are removed; a book whose PDF was deleted by
  hand reports `file_missing: true` in bootstrap.
- `backend/scripts/seed_demo.py --data-dir <path>` creates 4 categories (`Programming`,
  `Histoire`, `Novels`, `العربية`) and about 40 generated demo books (English, French and
  Arabic metadata titles; text pages and scanned-style pages; varied page counts and page
  sizes), with `last_opened_at` set on 3 of them. It is idempotent on an empty directory and
  refuses to run on a non-empty one without `--force`.
- `tests/test_perf.py` prints cold and cached render times per quality and the import time for
  the 400-page fixture (informational; compare against `docs/ARCHITECTURE.md` §8.6).

**Verification command:**
```bash
cd backend && .venv/bin/pytest tests/test_api.py -k "test_page_streaming or test_book_edit_and_delete or test_startup_reconcile" && .venv/bin/pytest tests/test_perf.py -m perf -s
```
