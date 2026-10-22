# ARCHITECTURE.md — Dar al Ilm (دار العلم)

Spec version: **v1.2 (Spec Review Edition)**, October 21, 2026.
This file is the technical source of truth: runtime topology, pinned versions, repository
layout, storage, data model, API contract, security, PDF pipeline, shelving and hall layout,
3D performance rules, reader architecture, search, i18n, testing and the launcher.
Product requirements live in `docs/REQUIREMENTS.md`, look and feel in `docs/DESIGN.md`,
the agent contract in `AGENTS.md`, and the backlog in `docs/sprints/`.

Numbers marked *(tunable)* are initial values. They may be tuned during the story that
builds them; when a value changes, update this file in the same commit.

---

## 1. Runtime Topology

Dar al Ilm is a local, offline, single-user application. Nothing leaves the machine.

| Mode | Processes | URL opened | Purpose |
|---|---|---|---|
| Production (`./start.sh`) | One FastAPI/Uvicorn process on `127.0.0.1:8000`. It serves the REST API under `/api` **and** the static Next.js export from `frontend/out/` at `/`. | `http://127.0.0.1:8000` | Daily use. One process, one port, no CORS, no Node.js at runtime. |
| Development (`./start.sh --dev`) | Uvicorn with `--reload` on `127.0.0.1:8000` (API only) and `next dev` on `127.0.0.1:3000`. | `http://127.0.0.1:3000` | Hot reload while building. The frontend calls the API cross-origin; CORS allows only the dev origin. |
| End-to-end tests | Uvicorn on `127.0.0.1:8765` serving the API and `frontend/out/`, with a temporary seeded data directory. | `http://127.0.0.1:8765` | Playwright tests. A separate port never collides with the user's running app. |

- Both servers bind strictly to `127.0.0.1`. Never `0.0.0.0`.
- Next.js is used as a client-side application. WebGL cannot render on the server, so the
  app is built with `output: 'export'` (static HTML/JS/CSS). All 3D components are client
  components loaded with `next/dynamic` and `ssr: false`.
- Internet access is needed only once, for first-time setup (`pip install`, `npm ci`, font
  files committed to the repo). At runtime the app makes zero external requests.

---

## 2. Tech Stack and Pinned Versions

All versions were checked against npm and PyPI on **October 21, 2026** by running
`npm view` and the PyPI JSON API, not copied from another source. Versions are pinned
exactly (no `^` or `~`) and lockfiles (`package-lock.json`) are committed.

### 2.1 Runtime requirements

| Tool | Version | Notes |
|---|---|---|
| Python | ≥ 3.12 (developed on 3.13) | PyMuPDF 2.0 and Pillow 13 require ≥ 3.11. |
| Node.js | ≥ 20.9 (developed on 22) | Required by Next.js 16. Needed only to build the frontend. |
| Browser | Any Chromium-family browser (Chromium, Chrome, Brave, Edge) for the app window; Firefox works in a normal tab | WebGL2 required. |

### 2.2 Frontend

| Component | Package | Pinned version | Reason for choice | Alternative considered |
|---|---|---|---|---|
| Framework | `next` (App Router, static export) | 16.4.2 | Matches developer's skills; fast local builds; strong TypeScript checks for AI coding agents. | Vite + React SPA |
| UI library | `react`, `react-dom` | 19.3.1 | Required by Next.js 16 and R3F 9 (R3F 9.8.2 accepts React `>=19 <19.4`). | — |
| Language | `typescript` | 7.0.2 | Native (Go) compiler, much faster type checks. Verified: Next.js 16.4.2 builds with it and reports type errors correctly. | 6.0.3 (JavaScript-based); fallback if a tool needs the classic compiler API |
| Styling and RTL | `tailwindcss`, `@tailwindcss/postcss`, `postcss` | 4.3.3, 4.3.3, 8.5.31 | Native logical properties (`ms-*`, `me-*`, `dir="rtl"`) for English/Arabic UI switching. | CSS Modules |
| 3D engine | `three` | 0.186.1 | Industry-standard WebGL engine. | Babylon.js |
| React renderer for Three.js | `@react-three/fiber` | 9.8.2 | Declarative 3D scene graph, `frameloop="demand"`. | — |
| 3D helpers | `@react-three/drei` | 10.7.9 | `Html`, `Lightformer`/`Environment` (with local light formers only), `useTexture`, `Instances` helpers. `CameraControls` and `PerformanceMonitor` are **not** used (see §10). | — |
| 3D text on plaques and spines | HTML5 2D `<canvas>` + `THREE.CanvasTexture`, local Cairo and Inter fonts | Standard Web API | Zero 3D font geometry lag; native browser Arabic shaping offline. | `troika-three-text` |
| State management | `zustand` | 5.0.15 | Lightweight store for library data, camera target, reader state and UI language. | Redux Toolkit |
| Icons | `lucide-react` | 1.61.0 | Tree-shaken SVG icons, bundled locally, consistent 1.5 px stroke. | Hand-drawn SVG set |
| Types | `@types/three`, `@types/react`, `@types/react-dom`, `@types/node` | 0.186.0, 19.3.0, 19.3.0, 22.20.5 | Type definitions. | — |
| Unit tests | `vitest` | 5.0.5 | Fast tests for pure logic (spreads, layout, search, texture pool). | Jest |
| End-to-end and visual tests | `@playwright/test` | 1.64.1 | Drives a real Chromium with WebGL, takes screenshots and videos. | Manual testing only |

### 2.3 Backend

| Component | Package | Pinned version | Reason for choice | Alternative considered |
|---|---|---|---|---|
| API framework | `fastapi` | 0.159.1 | Fast async REST API with automatic Pydantic validation and an OpenAPI schema at `/openapi.json`. The `/docs` and `/redoc` pages are disabled because they load Swagger UI and ReDoc from a CDN (D64). | Flask |
| ASGI server | `uvicorn[standard]` | 0.54.0 | Standard FastAPI server. | Hypercorn |
| PDF engine | `pymupdf` | 2.0 | Page counts, page sizes, Page 1 covers and page rendering at C speed. Import as `import pymupdf` (the `fitz` name is deprecated in 2.0). Fallback: 1.28.2 if a 2.0 defect blocks a story. | Browser `pdfjs-dist` |
| Image encoding | `pillow` | 13.0.0 | WebP encoding (PyMuPDF cannot write WebP), cover re-encoding, dominant spine colour. | — |
| Multipart uploads | `python-multipart` | 0.0.32 | Required by FastAPI for `UploadFile` and form fields. | — |
| Database and ORM | SQLite (`sqlite3`) + `sqlmodel` | 0.0.48 (pydantic 2.14.1) | Zero-config single-file `library.db` with WAL crash safety and fast queries. | Plain JSON file |
| Tests | `pytest` | 9.1.1 | Fast terminal checks after every story. | — |
| Test HTTP client | `httpx2` | 2.16.0 | Used by FastAPI's `TestClient`. Plain `httpx` now triggers a Starlette deprecation warning. | `httpx` 0.28.1 |

`backend/requirements.txt` holds runtime packages; `backend/requirements-dev.txt` adds
`pytest` and `httpx2`. Adding any package not listed in this section requires asking first
(see `AGENTS.md`).

### 2.4 Tooling notes

- The Claude Code `typescript-lsp` plugin needs `tsserver.js`, which TypeScript 7 no longer
  ships. The cloud SessionStart hook (`.claude/hooks/session-start.sh`) installs TypeScript 6
  globally for the language server only. The project itself uses TypeScript 7.0.2.
- Playwright's own browser download is not used in the cloud container. The config reads
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (cloud value: `/opt/pw-browsers/chromium`, Chromium 141,
  verified to render WebGL2 through SwiftShader) and falls back to Playwright's default.

---

## 3. Repository Blueprint

```plaintext
dar-al-ilm/
├── AGENTS.md                         # Root AI coding agent contract (<150 lines)
├── CLAUDE.md                         # Claude Code entry point; imports AGENTS.md and docs/DESIGN.md
├── PROGRESS.md                       # Live Scrum checklist (US-01 to US-16 status) and log
├── README.md                         # User quick start (US-16)
├── start.sh                          # One-click Linux launcher (Windows start.bat deferred, D19/D25)
├── .gitignore
├── .claude/                          # Cloud session tooling (SessionStart hook, plugin settings)
├── scripts/
│   ├── setup.sh                      # Creates backend/.venv, installs Python and npm packages
│   └── e2e-server.sh                 # Seeds a temporary library and serves it on 127.0.0.1:8765
├── docs/
│   ├── REQUIREMENTS.md               # Goals, scenarios, FR/NFR, risks, decision log
│   ├── ARCHITECTURE.md               # This file
│   ├── DESIGN.md                     # Approved design direction (look and feel)
│   └── sprints/
│       ├── sprint-1-backend.md       # US-01 to US-04 (FastAPI, SQLite, PyMuPDF)
│       ├── sprint-2-reader-3d.md     # US-05 to US-08 (scaffold, 3D curved reader, zoom, LoD)
│       ├── sprint-3-hall-3d.md       # US-09 to US-12 (3D hall, shelves, search, desk)
│       └── sprint-4-ui-launch.md     # US-13 to US-16 (EN/AR UI, modals, diagnostics, launcher)
├── library_data/                     # Managed portable local storage (auto-created, git-ignored)
│   ├── library.db                    # SQLite database (relative paths only)
│   ├── pdfs/                         # book_{id}.pdf
│   ├── covers/                       # book_{id}.webp (automatic Page 1 snapshot or custom cover)
│   ├── cache/                        # book_{id}/{quality}/{page}.webp rendered pages
│   └── staging/                      # {upload_id}.pdf, .json, .webp (uploads not yet saved)
├── backend/                          # Python FastAPI server (127.0.0.1:8000)
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   ├── pytest.ini
│   ├── app/
│   │   ├── __init__.py
│   │   ├── config.py                 # Data directory resolution, environment variables, constants
│   │   ├── main.py                   # FastAPI app, middleware, routers, static frontend mount
│   │   ├── security.py               # Host, Origin and X-Dar-Client checks; API error envelope
│   │   ├── database.py               # SQLite WAL connection, folder init, migrations
│   │   ├── models.py                 # SQLModel schemas (Category, Book, AppSetting)
│   │   ├── schemas.py                # API request/response shapes and serializers
│   │   ├── shelving.py               # First-free-slot shelf allocation
│   │   ├── pdf_service.py            # PyMuPDF page count, sizes, covers, WebP page renderer
│   │   ├── render_pool.py            # Render worker processes, priority and prefetch queue
│   │   ├── cache.py                  # Page cache paths, LRU size limit, eviction
│   │   ├── maintenance.py            # Startup reconciliation of orphan and staging files
│   │   └── routers/                  # health.py, bootstrap.py, categories.py, settings.py,
│   │                                 # uploads.py, books.py
│   ├── scripts/
│   │   └── seed_demo.py              # Generates demo PDFs (EN/FR/AR, scanned) and imports them
│   └── tests/
│       ├── conftest.py               # Temporary data dir, TestClient with X-Dar-Client header
│       ├── pdf_factory.py            # Generates test PDFs (text, scanned, encrypted, damaged)
│       ├── test_api.py               # Story verification tests
│       └── test_perf.py              # Informational latency measurements (marker: perf)
└── frontend/                         # Next.js app (static export; dev server on 127.0.0.1:3000)
    ├── package.json
    ├── package-lock.json
    ├── next.config.ts
    ├── tsconfig.json
    ├── postcss.config.mjs
    ├── vitest.config.ts
    ├── playwright.config.ts
    ├── e2e/                          # us-XX.spec.ts end-to-end and visual tests
    ├── public/fonts/                 # Cairo and Inter variable .woff2 files + OFL licence texts
    └── src/
        ├── app/                      # layout.tsx, page.tsx, globals.css, fonts.ts, dev/reader/page.tsx
        ├── components/3d/            # LibraryCanvas, HallRoom, PlayerControls, CategoryColumn,
        │                             # Bookcase, BookSpine, BookPresenter, EntranceDesk,
        │                             # CurvedBookReader, pageCurl
        ├── components/ui/            # TopBarSearch, AddBookModal, EditBookModal, DeleteBookDialog,
        │                             # Modal, SettingsModal, CategoryManager, WelcomeCard,
        │                             # ReaderToolbar, ZoomOverlay, SystemStatusBanner, DebugHud
        ├── hooks/                    # useAdaptiveQuality.ts
        ├── lib/                      # api.ts, canvasText.ts, spineAtlas.ts, texturePool.ts,
        │                             # spreads.ts, hallLayout.ts, flightPath.ts, search.ts,
        │                             # bookmark.ts, webglCheck.ts, i18n.ts, testApi.ts
        └── store/                    # useLibraryStore.ts (Zustand state)
```

---

## 4. Storage Layout and Path Rules

- **Data directory:** `DAR_DATA_DIR` environment variable if set; otherwise
  `<repo root>/library_data`, resolved from `backend/app/config.py` with
  `Path(__file__).resolve().parents[2] / "library_data"`. It never depends on the current
  working directory.
- `init_db()` creates `pdfs/`, `covers/`, `cache/`, `staging/` and `library.db` if missing.
- The database stores **relative POSIX paths only** (`pdfs/book_12.pdf`,
  `covers/book_12.webp`), built with `pathlib.PurePosixPath`. Absolute paths are computed at
  runtime by joining with the data directory, so the folder can move between machines and
  operating systems.
- File names on disk are always generated from internal IDs. The user's original file name is
  used only to suggest a title; it never becomes a path.
- Writes are atomic: write to a temporary file in the same folder, then `os.replace`.
- Tests always use a temporary data directory (`tmp_path`) and never touch a real library.

### 4.1 Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DAR_DATA_DIR` | `<repo>/library_data` | Data directory. |
| `DAR_PORT` | `8000` | Port the backend binds to on `127.0.0.1`. |
| `DAR_RENDER_WORKERS` | `min(4, max(1, cpu_count - 1))` | Render worker processes. `0` renders inline in the request thread (used by tests). |
| `DAR_CACHE_LIMIT_MB` | `1024` | Page cache size limit. |
| `DAR_MAX_UPLOAD_MB` | `2048` | Maximum PDF upload size. |
| `DAR_DEV_ORIGIN` | `http://127.0.0.1:3000` | Extra allowed origin for `next dev`. Always allowed: it is a loopback origin (D65). Set it to an empty value to disable it. |
| `NEXT_PUBLIC_API_BASE` | empty (same origin) | Frontend API base URL; set to `http://127.0.0.1:8000` by `next dev`. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | unset | Chromium binary for Playwright (cloud: `/opt/pw-browsers/chromium`). |

---

## 5. Data Model

All data is stored in `library_data/library.db` (SQLite). Every connection runs
`PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys=ON;`. Timestamps are stored as UTC
ISO 8601 text (`2026-10-21T18:04:05Z`).

### 5.1 Table `category`

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique category ID. |
| `name` | TEXT | NOT NULL, 1–40 characters after trimming, stored in Unicode NFC | Category display title on the 3D column plaque (e.g., `Programming`, `العربية`). |
| `name_key` | TEXT | UNIQUE NOT NULL | `casefold(NFC(trim(name)))`. Enforces case-insensitive, accent-aware uniqueness (`History` = `history`). |
| `column_index` | INTEGER | NOT NULL, ≥ 0 | Architectural column/bay index (0, 1, 2…) in the 3D hall. Kept contiguous: new categories get `max + 1`; deleting a category shifts later indexes down by one in the same transaction. |
| `created_at` | DATETIME | NOT NULL DEFAULT CURRENT_TIMESTAMP | Creation timestamp. |

### 5.2 Table `book`

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique book ID. Never reused, so cached pages can be served as immutable. |
| `title` | TEXT | NOT NULL, 1–300 characters | Book title (required). |
| `category_id` | INTEGER | NOT NULL, FOREIGN KEY → `category.id` ON DELETE RESTRICT | Assigned category (required). |
| `reading_direction` | TEXT | NOT NULL DEFAULT `'LTR'`, CHECK IN (`'LTR'`, `'RTL'`) | `LTR` (English/French) or `RTL` (Arabic) (required). |
| `author` | TEXT | NULLABLE, ≤ 200 characters | Author name (optional). |
| `notes` | TEXT | NULLABLE, ≤ 5000 characters | User notes or description (optional). |
| `pdf_rel_path` | TEXT | NOT NULL | Relative path inside the data directory (`pdfs/book_1.pdf`). |
| `cover_rel_path` | TEXT | NOT NULL | Relative path inside the data directory (`covers/book_1.webp`). |
| `cover_is_custom` | BOOLEAN | NOT NULL DEFAULT 0 | 1 when the user uploaded a custom cover; 0 for the automatic Page 1 snapshot. |
| `page_count` | INTEGER | NOT NULL, CHECK > 0 | Total pages counted by PyMuPDF (scales spine width). |
| `page_width_pt` | REAL | NOT NULL, CHECK > 0 | Width of page 1 in PDF points (after rotation). Sets reader page aspect and book depth on the shelf. |
| `page_height_pt` | REAL | NOT NULL, CHECK > 0 | Height of page 1 in PDF points (after rotation). Sets reader page aspect and book height on the shelf. |
| `spine_color` | TEXT | NOT NULL, `#RRGGBB` | Dominant cover colour, computed with Pillow at import (and when the cover changes). |
| `file_sha256` | TEXT | NOT NULL, INDEX | SHA-256 of the PDF, computed while streaming the upload. Used for the duplicate warning. Not unique: the user may import a duplicate on purpose. |
| `file_size_bytes` | INTEGER | NOT NULL | Size of the stored PDF. |
| `last_read_page` | INTEGER | NOT NULL DEFAULT 1, CHECK ≥ 1 | Auto-saved page number (1-based) for bookmark resumption. The API also enforces ≤ `page_count`. |
| `last_opened_at` | DATETIME | NULLABLE, INDEX | Set when a book is opened and when it is closed; the 3 most recent rows populate the Currently Reading desk. |
| `shelf_number` | INTEGER | NOT NULL, ≥ 0 | Shelf (0, 1, 2…) within the category, allocated by first free slot (§9.1). |
| `slot_index` | INTEGER | NOT NULL, CHECK 0–29 | Slot position on that shelf. |
| `created_at` | DATETIME | NOT NULL DEFAULT CURRENT_TIMESTAMP | Upload timestamp. |
| `updated_at` | DATETIME | NOT NULL | Last metadata or cover change; used for cover cache busting. |

Additional constraints and indexes:
- `UNIQUE(category_id, shelf_number, slot_index)`: two books can never occupy the same slot.
- `INDEX(category_id)`.

`file_missing` is **not** stored. The API computes it at runtime by checking whether the PDF
file exists, so it is always current.

### 5.3 Table `app_setting`

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY, CHECK (`id` = 1) | Singleton settings row, created by `init_db()`. |
| `ui_language` | TEXT | NOT NULL DEFAULT `'en'`, CHECK IN (`'en'`, `'ar'`) | `en` (English, LTR) or `ar` (Arabic, RTL). |
| `default_direction` | TEXT | NOT NULL DEFAULT `'LTR'`, CHECK IN (`'LTR'`, `'RTL'`) | Default reading direction in the Add Book form. |
| `graphics_quality` | TEXT | NOT NULL DEFAULT `'auto'`, CHECK IN (`'auto'`, `'performance'`, `'high'`) | Graphics preset (§10.3). |
| `ambient_light` | REAL | NOT NULL DEFAULT 1.0, CHECK BETWEEN 0.4 AND 1.5 | 3D hall brightness; scales tone-mapping exposure. |

### 5.4 Schema versioning and migrations

- The schema version is stored in `PRAGMA user_version`. Version 1 is the schema above.
- `database.py` holds an ordered list of migration functions (`migrate_1_to_2`, …). On startup
  each pending migration runs inside a transaction, then `user_version` is bumped.
- Migrations must preserve user data. Dropping or recreating tables with data is forbidden.
- No Alembic: the schema is small and migrations are plain SQL.

---

## 6. Internal REST API Contract

Base URL: same origin (`http://127.0.0.1:8000` in production). All endpoints are under `/api`.
Request and response bodies are JSON unless stated otherwise. Page numbers are **1-based**
everywhere in the API (PyMuPDF is 0-based internally).

### 6.1 Conventions

- **Client header:** every mutating request (`POST`, `PATCH`, `PUT`, `DELETE`) must send
  `X-Dar-Client: 1`. Without it the API answers `403 forbidden_client`. The header forces a
  CORS preflight, which blocks other websites (see §7).
- **Errors:** domain errors return
  `{"detail": {"code": "<code>", "message": "<English text>", ...extra}}`. Request validation
  errors keep FastAPI's default `422` body. The frontend maps codes to translated messages.
- **Caching:** images are served with `ETag`. Page images and covers use versioned URLs and
  `Cache-Control: private, max-age=31536000, immutable`.

| Code | HTTP | Meaning |
|---|---|---|
| `forbidden_client` | 403 | Missing `X-Dar-Client` header on a mutating request. |
| `forbidden_origin` | 403 | `Origin` header present and not allowed. |
| `not_pdf` | 415 | File does not start with `%PDF-` within its first 1024 bytes. |
| `file_too_large` | 413 | Upload exceeds `DAR_MAX_UPLOAD_MB`. |
| `pdf_encrypted` | 422 | PDF needs a password. |
| `pdf_empty` | 422 | PDF has zero pages. |
| `pdf_damaged` | 422 | PyMuPDF cannot open or render the PDF. |
| `invalid_cover` | 415 | Cover is not PNG, JPEG or WebP, exceeds 10 MB, or fails to decode. |
| `upload_not_found` | 404 | Unknown or expired `upload_id`. |
| `category_not_found` | 404 | Unknown category ID (including `move_to`). |
| `category_name_taken` | 409 | Another category has the same `name_key`. |
| `category_not_empty` | 409 | Category still has books; body includes `book_count`. |
| `book_not_found` | 404 | Unknown book ID. |
| `page_out_of_range` | 404 | Page number < 1 or > `page_count`. |
| `pdf_missing` | 410 | The book's PDF file is missing from the data directory. |

### 6.2 Resource shapes

**Category**
```json
{"id": 3, "name": "العربية", "column_index": 2, "book_count": 41, "created_at": "2026-10-21T18:04:05Z"}
```

**Book**
```json
{
  "id": 12, "title": "مقدمة ابن خلدون", "author": "ابن خلدون", "notes": null,
  "category_id": 3, "reading_direction": "RTL",
  "page_count": 642, "page_width_pt": 419.5, "page_height_pt": 595.3,
  "spine_color": "#6B3F2A", "cover_url": "/api/books/12/cover?v=1761069845",
  "cover_is_custom": false, "file_size_bytes": 48211234, "file_missing": false,
  "last_read_page": 57, "last_opened_at": "2026-10-21T18:04:05Z",
  "shelf_number": 1, "slot_index": 4,
  "created_at": "2026-10-20T09:12:00Z", "updated_at": "2026-10-21T18:04:05Z"
}
```
`cover_url` carries `v=<updated_at as Unix seconds>` for cache busting.

**Settings**
```json
{"ui_language": "ar", "default_direction": "RTL", "graphics_quality": "auto", "ambient_light": 1.0}
```

### 6.3 Endpoints

| Method and path | Body / parameters | Success | Notes |
|---|---|---|---|
| `GET /api/health` | — | `200 {"status": "ok", "api_version": 1}` | UI connection badge and launcher check. |
| `GET /api/bootstrap` | — | `200 {categories, books, currently_reading, settings, api_version}` | One payload on startup. `currently_reading` = up to 3 book IDs ordered by `last_opened_at` descending (1st = latest). Books with `last_opened_at = null` are excluded. |
| `POST /api/categories` | `{"name"}` | `201 Category` | `column_index = max + 1` (0 for the first). `409 category_name_taken` on duplicates. |
| `PATCH /api/categories/{id}` | `{"name"}` | `200 Category` | Rename. Same uniqueness rule. |
| `DELETE /api/categories/{id}` | optional query `move_to={category_id}` | `204` | Empty category: deleted. Non-empty without `move_to`: `409 category_not_empty` with `book_count`. With `move_to`: all books move to the target category using first-free-slot (in `id` order), then the category is deleted. Later `column_index` values shift down by one. Never deletes books or files. |
| `PATCH /api/settings` | any of `ui_language`, `default_direction`, `graphics_quality`, `ambient_light` | `200 Settings` | Invalid values → `422`. |
| `POST /api/uploads` | `multipart/form-data`: `pdf_file` | `201 Upload` | Phase 1 of import (§8.1). Streams to `staging/`, validates, counts pages, renders a cover preview. |
| `GET /api/uploads/{upload_id}/cover` | — | `200 image/webp` | Cover preview for the Add Book form. |
| `DELETE /api/uploads/{upload_id}` | — | `204` | Cancel: deletes the staged files. |
| `POST /api/books` | `multipart/form-data`: `upload_id`, `title`, `category_id`, `reading_direction`; optional `author`, `notes`, `cover_file` | `201 Book` | Phase 2 of import. Missing required field → `422`. Moves the staged PDF to `pdfs/book_{id}.pdf`, stores the automatic cover (or the re-encoded custom cover), allocates the first free slot. |
| `PATCH /api/books/{id}` | any of `title`, `author`, `notes`, `category_id`, `reading_direction`, `last_read_page`, `mark_opened` | `200 Book` | `author`/`notes` may be `null` to clear. `last_read_page` must be 1…`page_count`. `category_id` change → first free slot in the new category (the old slot frees). `mark_opened: true` sets `last_opened_at` to the server's current UTC time. |
| `DELETE /api/books/{id}` | — | `204` | Deletes the row, `pdfs/book_{id}.pdf`, `covers/book_{id}.webp` and `cache/book_{id}/`. Leaves zero files for that book. |
| `GET /api/books/{id}/cover` | query `v` (ignored, cache busting) | `200 image/webp` | Current cover. |
| `PUT /api/books/{id}/cover` | `multipart/form-data`: `cover_file` | `200 Book` | Replace with a custom cover; recomputes `spine_color`. |
| `DELETE /api/books/{id}/cover` | — | `200 Book` | Revert to the automatic Page 1 snapshot (regenerated from the PDF). |
| `GET /api/books/{id}/page/{page_num}` | query `quality=low\|high\|zoom` | `200 image/webp` | Renders the page (§8.2) and schedules prefetch of the following pages. `404 page_out_of_range`, `410 pdf_missing`, `422` for an invalid `quality`. |
| `GET /` and static assets | — | `200` | Production only: the static Next.js export from `frontend/out/` (mounted when that folder exists). Unknown non-`/api` paths return `index.html`. |

**Upload** (response of `POST /api/uploads`)
```json
{
  "upload_id": "2f6c…", "original_filename": "ibn-khaldun.pdf", "file_size_bytes": 48211234,
  "page_count": 642, "page_width_pt": 419.5, "page_height_pt": 595.3,
  "suggested_title": "مقدمة ابن خلدون", "suggested_direction": "RTL",
  "cover_preview_url": "/api/uploads/2f6c…/cover",
  "duplicate_of": {"id": 7, "title": "Muqaddimah"}, "expires_at": "2026-10-22T18:04:05Z"
}
```
- `suggested_title`: the PDF metadata title if present and meaningful, otherwise the file name
  stem with `_`/`-` replaced by spaces.
- `suggested_direction`: `RTL` when `suggested_title` contains Arabic script
  (U+0600–U+06FF, U+0750–U+077F, U+08A0–U+08FF, U+FB50–U+FDFF, U+FE70–U+FEFF); otherwise the
  `default_direction` setting.
- `duplicate_of`: the first existing book with the same `file_sha256`, or `null`.

---

## 7. Security and Privacy

- **Loopback only:** Uvicorn binds `127.0.0.1`; `next dev` runs with `-H 127.0.0.1`.
- **DNS rebinding:** `TrustedHostMiddleware` accepts only `Host` values `127.0.0.1` and
  `localhost` (any port). Other hosts get `400`.
- **Cross-site requests:** mutating requests require `X-Dar-Client: 1` (forces a CORS
  preflight). If an `Origin` header is present it must be `http://127.0.0.1:{DAR_PORT}`,
  `http://localhost:{DAR_PORT}`, or `DAR_DEV_ORIGIN` (always allowed, loopback only); otherwise
  `403 forbidden_origin`. CORS is enabled only for `DAR_DEV_ORIGIN`.
- **PDF upload validation:** streamed to disk in 1 MB chunks (never fully loaded in RAM),
  size-capped by `DAR_MAX_UPLOAD_MB`, `%PDF-` magic bytes within the first 1024 bytes,
  rejected if encrypted, empty or unopenable.
- **Cover validation:** PNG, JPEG or WebP magic bytes, ≤ 10 MB, decoded and re-encoded by
  Pillow to WebP (long side ≤ 1024 px). Pillow's decompression-bomb protection stays on.
- **Path safety:** file names on disk come from internal IDs (`book_{id}.pdf`) or random
  upload IDs (`uuid4().hex`). User-supplied names are never used in paths; `..`, `/` and `\`
  never reach the filesystem.
- **Render limits:** any rendered page is capped at 4096 px on its long side and 16.8
  megapixels, protecting against PDFs with absurd page sizes.
- **Privacy:** zero telemetry, zero external font downloads, zero cloud syncing, zero CDN
  requests. `NEXT_TELEMETRY_DISABLED=1` is set for all Next.js commands.

---

## 8. PDF Pipeline

### 8.1 Two-phase import

1. **`POST /api/uploads`** (when the user selects a file):
   stream to `staging/{upload_id}.pdf` while computing SHA-256 → check magic bytes and size →
   open with PyMuPDF → reject encrypted/empty/damaged → read `page_count` and page 1 size
   (after rotation) → render page 1 to `staging/{upload_id}.webp` (long side 1024 px, WebP
   quality 82) → write `staging/{upload_id}.json` with the metadata → return `Upload`.
2. **`POST /api/books`** (when the user clicks **Add book**):
   validate fields → in one `BEGIN IMMEDIATE` transaction insert the row with the first free
   slot (§9.1) → move the staged PDF to `pdfs/book_{id}.pdf` → move the staged cover (or
   re-encode the custom cover) to `covers/book_{id}.webp` → compute `spine_color` → commit.
   On any failure the transaction rolls back and files written in this step are removed.
3. **Cancel:** `DELETE /api/uploads/{upload_id}` removes the three staged files.
4. Staged uploads expire after 24 hours and are purged at startup (§8.5).

The original file in the user's Documents folder is never referenced again after the upload
and can be deleted safely.

**Spine colour:** downscale the cover to 64 × 64, quantize to 5 colours with Pillow, pick the
most frequent colour that is not near-white or near-black (fallback: the most frequent),
then store it as `#RRGGBB`. The 3D layer desaturates it by 15 % (see `docs/DESIGN.md`).

### 8.2 Page qualities

Quality is defined by the **long side of the rendered image in pixels**, not by DPI, so memory
and latency are predictable for any page size (pocket book, A4, A3 scan).

| `quality` | Long side | Use | WebP settings |
|---|---|---|---|
| `low` | 768 px | Pages in motion during a flip; first image shown on arrival. | quality 80, method 0 |
| `high` | 2048 px | Settled reading. | quality 80, method 0 |
| `zoom` | 4096 px (hard cap) | Zoom overlay up to 400 %. | quality 80, method 0 |

Rendering: `scale = target_long_side / max(page.rect.width, page.rect.height)`,
`page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)`, then
`PIL.Image.frombytes("RGB", ...)` and `save(..., "WEBP", quality=80, method=0)`.
Pillow's WebP `method=0` is about 3× faster than the default `method=4` for a small size cost.

### 8.3 Render workers, priority and prefetch

PyMuPDF `Document` objects are not thread-safe. Rendering therefore runs in worker
**processes** (`concurrent.futures.ProcessPoolExecutor`, `DAR_RENDER_WORKERS` workers). Each
worker keeps an LRU of up to 6 open documents keyed by book ID and file modification time.

- **Foreground requests** (a page the UI asked for) are submitted to the pool immediately and
  are never queued behind prefetch jobs.
- **Prefetch:** after serving page `n`, the backend enqueues `low` for pages `n+1 … n+6` and
  `high` for pages `n+1 … n+2` (page numbers grow in reading order for both LTR and RTL
  books). Prefetch jobs run one at a time and only while no foreground job is running.
- **Cancellation:** a foreground request for a page more than 6 pages away from the queued
  window clears that book's pending prefetch jobs (the user jumped).
- With `DAR_RENDER_WORKERS=0` (tests), rendering runs inline with a per-book lock.

### 8.4 Page cache

- Path: `cache/book_{id}/{quality}/{page}.webp`. Written atomically.
- Hits are served directly with `FileResponse`; the file's modification time is touched so
  eviction is least-recently-used.
- Total size is tracked in memory (computed at startup). When it exceeds
  `DAR_CACHE_LIMIT_MB`, the oldest files are deleted until the cache is at 90 % of the limit.
- Deleting a book deletes `cache/book_{id}/` entirely.

### 8.5 Startup reconciliation

Run once at startup, after migrations:
1. Delete staged uploads older than 24 hours.
2. Delete files in `pdfs/` and `covers/` whose book ID does not exist in the database.
3. Delete `cache/book_{id}/` folders whose book ID does not exist.
4. Books whose PDF file is missing stay in the database; the API reports `file_missing: true`
   and the UI offers "Remove from library".
5. Log how many files were removed.

### 8.6 Latency: measured baseline and targets

Measured on October 21, 2026 in the 4-core cloud container with PyMuPDF 2.0 and Pillow 13,
using a synthetic 400-page A4 scanned PDF (20 MB, full-page 300 DPI JPEG scans), WebP
`method=0`, MuPDF caches cleared between pages:

| Operation | Measured median |
|---|---|
| Import: copy + open + page count + page 1 cover | 90 ms |
| Render + encode, 72 DPI (595 × 842) | 26 ms |
| Render + encode, long side 768 px | 28 ms |
| Render + encode, 150 DPI (1240 × 1755) | 143 ms |
| Render + encode, long side 2048 px | 183 ms |
| Render + encode, 300 DPI (2480 × 3509) | 278 ms |

On scanned pages, decoding the full-resolution embedded JPEG costs about 80 ms before any
scaling, so the v1.1 targets (72 DPI < 20 ms, 150–300 DPI < 80 ms) cannot be met on a cache
miss. Revised targets (server-side time, excluding network):

| Case | Target |
|---|---|
| Any quality, cache hit | < 10 ms |
| `low`, cache miss | < 50 ms |
| `high`, cache miss | < 250 ms |
| `zoom`, cache miss | < 500 ms |
| Import phase 1 (`POST /api/uploads` server work) for the 400-page scanned fixture | < 1.5 s |

Measured through the API in US-04 (`tests/test_perf.py`, same container, realistic 20 MB scan
with 40 distinct page images, in-process rendering, MuPDF caches cleared before each cold render):

| Case | Median | Max |
|---|---|---|
| Import phase 1 (server work) | 105 ms | 123 ms |
| Cache hit | 1.5 ms | 3.1 ms |
| `low` cache miss | 29 ms | 33 ms |
| `high` cache miss | 165 ms | 195 ms |
| `zoom` cache miss | 448 ms | 665 ms |

All medians meet the targets; single `zoom` renders can exceed 500 ms on this CPU, which the
2D zoom overlay masks by showing the `high` image first.

Prefetch (§8.3) and the client's progressive display (§11.3) hide cache misses during normal
reading. `tests/test_perf.py` (marker `perf`) prints these numbers; it reports, it does not
gate, because timings depend on the machine.

---

## 9. Shelving and Hall Layout Contract

Units are metres. The hall's floor is the XZ plane; +Y is up; the entrance is at `z = 0` and
the hall extends toward +Z. Values marked *(tunable)* may be adjusted in US-09/US-10.

### 9.1 Shelf allocation: first free slot

```
allocate(category_id):
    occupied = {(shelf_number, slot_index) for books in category_id}
    for shelf in 0, 1, 2, ...:
        for slot in 0..29:
            if (shelf, slot) not in occupied: return (shelf, slot)
```
- Runs inside a `BEGIN IMMEDIATE` transaction together with the insert or update, so two
  concurrent imports cannot take the same slot. The `UNIQUE(category_id, shelf_number,
  slot_index)` constraint is the final guard.
- Gaps left by deleted or moved books are filled first. Other books never move.
- FR-05 holds: a category whose shelf 0 is full places the 31st book at `shelf_number = 1`,
  `slot_index = 0`.

### 9.2 Book dimensions

| Dimension | Formula | Examples |
|---|---|---|
| Spine thickness `t` | `clamp(0.004 + 0.00005 × page_count, 0.015, 0.08)` (≈ 0.1 mm per leaf + boards) | 60 p → 0.015; 600 p → 0.034; 1500 p → 0.079 |
| Height `h` | `clamp(page_height_pt × 0.0254 / 72 + 0.006, 0.15, 0.40)` | A4 (842 pt) → 0.303 |
| Depth `d` | `clamp(page_width_pt × 0.0254 / 72 + 0.004, 0.10, 0.30)` | A4 (595 pt) → 0.214 |

### 9.3 Bookcases and shelves *(tunable)*

- One **bookcase** holds 5 shelves; one shelf holds up to 30 books.
- Shelf inner length 2.40 m (30 × the maximum 0.08 m spine), shelf depth 0.32 m, bookcase
  outer length 2.60 m, depth 0.36 m, height 2.45 m.
- Shelf board heights (top surface) by tier: `[0.12, 0.57, 1.02, 1.47, 1.92]` (pitch 0.45 m,
  clearance 0.425 m ≥ the tallest 0.40 m book).
- `shelf_number n` → bookcase `n // 5`, tier `TIER_ORDER[n % 5]` with
  `TIER_ORDER = [3, 2, 4, 1, 0]`: the first books land near eye level.
- Books stand on the shelf, spines facing out, 0.01 m behind the shelf's front edge, packed
  from the start of the shelf in `slot_index` order with a 0.002 m gap. Empty slots do not
  leave holes. A brass bookend follows the last book.

### 9.4 Hall layout *(tunable)*

- **Nave:** central aisle, `x ∈ [-2.0, 2.0]`, running along +Z.
- **Entrance zone:** `z ∈ [0, 8]`. Entrance arch at `z = 0`. Currently Reading desk centred at
  `(0, 0, 4.6)`, footprint 1.8 × 0.7 m, height 0.95 m, with 3 book stands. The lapis medallion
  (radius 0.85 m) lies at `z = 3.0`, between the entrance and the desk (tuned in US-09, D73).
- **Spawn / Home pose:** camera at `(0, 1.62, 0.7)` looking at `(0, 1.0, 6.5)`: the medallion,
  the desk and the nave are all in the first view (tuned in US-09, D73).
- **Section:** the nave (`|x| < 2.4`) rises to the 6 m ceiling; the side aisles (bays and the
  entrance lobby beside the nave) have a 3.4 m ceiling, with a clerestory wall above the bay
  openings. Bays are separated by 0.12 m plaster partitions, 3.4 m high. Skylight slots
  (1.4 × 2.6 m) sit on the nave axis every 3.4 m from `z = 2.9` (tuned in US-09, D73).
- **Bays:** category with `column_index i` → side `i % 2` (0 = −X, 1 = +X), row `r = i // 2`,
  bay spans `z ∈ [8 + 3.4 r, 8 + 3.4 (r + 1)]`. A bay is a side aisle perpendicular to the
  nave, starting at `|x| = 2.4`. Its bookcases line the bay's two side walls, facing each
  other across a 2.5 m inner aisle: bookcase `k` → wall `k % 2`, position `k // 2` along the
  bay (each 2.7 m including a 0.1 m gap). Bay depth = `0.2 + ceil(max(cases, 1) / 2) × 2.7 + 0.6`.
- **Columns and plaques:** a slim column stands at the nave edge (`|x| = 2.2`) at each bay's
  centre. Its category plaque hangs perpendicular to the nave like a blade sign, double-sided
  (each face drawn separately so Arabic reads correctly on both sides), lower edge at 2.6 m.
- **Hall size:** width = `4.0 + 2 × (0.4 + deepest bay)`; length =
  `8 + 3.4 × ceil(categories / 2) + 2.0`; ceiling 6.0 m. With 0 categories the hall still has
  the entrance zone, the desk and one empty, softly lit bay outline.
- **Empty category:** its bay shows one bookcase with the plaque and a ghost "Add book" slot.

### 9.5 Collision and movement

- The player is a circle of radius 0.30 m in the XZ plane. Collision boxes (AABBs) are
  generated from the layout: walls, bookcases, columns, the desk.
- Movement resolves X and Z separately so the player slides along walls instead of stopping.
- Eye height 1.62 m, vertical field of view 55°.
- Walk speed 1.4 m/s (Shift: 2.8 m/s), reaching full speed in 250 ms and stopping in 200 ms.
- Keys: `ArrowUp`/`W` forward, `ArrowDown`/`S` back, `ArrowLeft`/`ArrowRight` turn
  (90°/s), `A`/`D` strafe, `Home` return to the desk, `/` focus search, `Esc` close the top
  layer. Keys are ignored while a text field or modal has focus.
- Look: **no pointer lock.** Click and drag on empty space rotates the view
  (0.25°/px, pitch clamped to ±35°). The cursor always stays free for hovering and clicking.

### 9.6 Camera flights

- Search selection and `Home` fly the camera along a path: current position → nearest nave
  point → nave point at the target bay → bay entrance → stand point 1.3 m in front of the
  target book, facing it, eye height 1.62 m, looking at the book's height.
- Path: centripetal Catmull–Rom spline through the waypoints; progress eased with
  `easeInOutCubic` along arc length. Duration `clamp(0.6 + distance / 25, 0.6, 1.5)` s
  (`Home` ≤ 0.8 s).
- The flight never passes through bookcases because every waypoint lies in walkable space.
- With `prefers-reduced-motion`, a flight becomes a 300 ms fade-out / cut / fade-in.

---

## 10. 3D Performance Rules

### 10.1 Render loop

- `<Canvas frameloop="demand">`. Frames render only when `invalidate()` is called.
- Anything that moves (walking, turning, flights, page flips, hover/present transitions, the
  boot reveal) calls `invalidate()` every frame while it is active and stops when it settles.
- When nothing moves, **zero frames** are rendered (0 % GPU). This is tested: the frame counter
  must not change during 2 seconds without input.
- No idle animation in the 3D scene: no flickering flames, drifting dust or looping effects.
- Keep `<Canvas>` out of re-renders caused by store updates that do not change the scene
  (memoize the canvas subtree): React Three Fiber invalidates its root on every `<Canvas>`
  render and on every change to its own store, so a saved bookmark would otherwise draw a frame.

### 10.2 Adaptive quality: `useAdaptiveQuality` (replaces drei `<PerformanceMonitor>`)

drei's `PerformanceMonitor` (checked in 10.7.9) computes FPS as frames divided by wall-clock
time. With `frameloop="demand"`, idle gaps read as ~1 FPS and trigger false quality drops.
Our own hook:
- Samples frame time (`delta`) only while an "active motion" flag is set, and ignores any delta
  above 100 ms (a gap, not a slow frame).
- Keeps the rolling median of the last 60 samples. The target frame time is derived from the
  measured display refresh rate (16.7 ms at 60 Hz).
- **Step down** one level when the median exceeds 1.2 × target for two consecutive windows of
  60 samples. **Step up** one level when the median stays below 0.8 × target for four
  consecutive windows. At most 3 level changes per session (prevents oscillation).
- Persists the chosen level per device in `localStorage` (`dar.quality.level`) so the next
  launch starts at the right level.
- Levels change only the device pixel ratio (`dpr`): `[min(devicePixelRatio, 2.0), 1.5, 1.25,
  1.0, 0.85]`, capped at the device's ratio. Changing antialiasing or shadows at runtime would
  force a context recreation or shader recompiles, so those are fixed per preset.

### 10.3 Graphics presets (`graphics_quality`)

| Setting | `performance` | `auto` | `high` |
|---|---|---|---|
| Pixel ratio (`dpr`) | ≤ 1.0, fixed | adaptive (§10.2), starts at 1.25 | up to 2.0, adaptive downward only |
| Antialiasing (MSAA) | off | on | on |
| Shadows | off | one directional shadow map 1024², rendered once | one directional shadow map 2048², PCF with a wider filter radius, rendered once (three.js 0.186 removed `PCFSoftShadowMap`, D74) |
| Texture anisotropy | 2 | 4 | 8 |
| Spine label atlases resident | 4 | 8 | 12 |
| Spine label cell size | 256 × 32 | 512 × 64 | 512 × 64 |
| Floor light pattern | static texture | static texture | static texture + higher-resolution variant |

Changing the preset remounts the `<Canvas>` (antialiasing is a context-creation attribute).
Lamp glow uses emissive materials plus additive halo sprites; there is no post-processing
pass and no `@react-three/postprocessing` dependency.

### 10.4 Budgets

| Budget | Limit |
|---|---|
| Draw calls in view (hall) | < 150 |
| Triangles in view (hall) | < 300 k |
| GPU texture memory, total | < 400 MB (NFR-03) |
| — reader page textures (3-spread window) | ≤ 6 pages × 2048 px ≈ 95 MB |
| — spine label atlases | ≤ 12 × R8 2048² ≈ 68 MB |
| — architecture and material textures | ≤ 64 MB (1K textures, mipmapped) |
| — covers and miscellaneous | ≤ 40 MB |

### 10.5 Books at scale (NFR-04)

- **One draw call per bookcase:** each bookcase's books are one `InstancedMesh` with a custom
  book geometry whose vertices carry a `faceKind` attribute (spine, cover, page edge, top).
  Per-instance attributes: transform (dimensions from §9.2), base colour (`spine_color`
  desaturated 15 %), label text colour (gilt or ink, by contrast), atlas index and UV rect.
- **Spine label atlases:** each book's title and author are drawn with `canvasText.ts` into a
  cell of a 2048 × 2048 atlas. Atlases are uploaded as single-channel (`RedFormat`, R8) masks:
  4 MB each instead of 16 MB for RGBA. The shader mixes the label colour over the spine colour.
- **Level of detail:** atlases are built only for bays within 18 m of the camera and disposed
  beyond 25 m (hysteresis), up to the preset's resident limit (nearest first). Far bays show
  plain coloured spines. Bookcases outside the view frustum are culled.
- Covers are not textured on the shelf (spines face out); the cover texture loads only when a
  book is presented (click-to-present, FR-09) or shown on the desk.

### 10.6 Lighting and environment without CDNs

- drei `<Environment preset="…">` downloads HDR files from `raw.githack.com` (checked in
  drei 10.7.9 source). **Forbidden.** Use `<Environment>` with `<Lightformer>` children
  (procedural, no files) or an HDR/KTX2 file committed under `frontend/public/`.
- Tone mapping: `THREE.AgXToneMapping`. Exposure = `ambient_light` setting (0.4–1.5).
- The patterned daylight on the floor is a static texture (light map), not a real-time light.
  `floor-light.webp` holds one 4.0 × 3.4 m tile per skylight; the nave floor under the skylights
  carries it as `lightMap` (UV channel 0, its own texture transform), so the stars land 0.3 m
  past each slot, as if cast by a high sun from the entrance side.
- Material textures are generated procedurally by `scripts/generate_textures.py` and committed
  under `frontend/public/textures/` (CC0, listed in `LICENSES.md`), so nothing is downloaded at
  build or run time (D75). Contact darkening under furniture is a multiplied decal, so it also
  shows in the performance preset without shadows.
- The single shadow map (auto/high) renders once after layout changes
  (`shadowMap.autoUpdate = false`, `needsUpdate = true` on change).

### 10.7 Text on canvas

- Never use 3D font geometry (`Text3D`, `troika-three-text`) for plaques or spines.
- Before drawing, `await document.fonts.load('700 64px Cairo')` and
  `await document.fonts.load('600 64px Inter')` (and the weights used). Text drawn before the
  font loads is baked with a fallback font permanently.
- Arabic text: `ctx.direction = 'rtl'`, `ctx.textAlign` by logical side, **no letter
  spacing** (it breaks letter connections). Mixed-script text uses the font stack
  `Inter, Cairo` and the browser's bidi algorithm.
- Long text shrinks to fit (minimum 60 % of the base size), then truncates with an ellipsis.

### 10.8 Debug overlay

`F2` toggles `DebugHud`: FPS and median frame time (measured during motion), draw calls,
triangles, textures, geometries, current `dpr` and quality level, preset. It is the tool for
checking real GPU performance on physical hardware.

---

## 11. Reader Architecture

### 11.1 Spread model

- **LTR books:** page 1 alone on the right (recto); then spreads (2,3), (4,5), …; the last page
  alone if needed.
- **RTL books:** mirrored: page 1 alone on the left; then (2,3) with page 2 on the right and
  page 3 on the left, and so on.
- `last_read_page` = the lowest page number visible in the current spread.
- Page aspect comes from `page_width_pt / page_height_pt` (page 1). Pages with a different size
  are fitted inside that frame (contain) on a paper-coloured background.

### 11.2 Page turning

- Each page is a subdivided plane (48 × 8 segments). `pageCurl.ts` deforms the turning leaf on
  the CPU: each row is integrated along the paper from the spine with a bend angle that lags at
  the outer edge, which keeps the paper's exact length (unit-tested). With 441 vertices this costs
  a fraction of a millisecond per frame (D67). Pages use a small shader material that shows the
  image as is (no tone mapping), shaded by vertex colours (curl light, gutter shadow).
- Flip duration 550 ms (`easeInOutCubic`). Rapid key presses queue flips at 280 ms intervals.
- Click on a page's outer half or press the arrow key to flip. Dragging a page corner makes the
  page follow the pointer; release past 50 % or with a flick (velocity > 0.6 page widths/s)
  completes the turn, otherwise it falls back.
- **Arrow keys follow the physical side:** `ArrowRight` turns toward the right. LTR: `ArrowRight`
  = next, `ArrowLeft` = previous. RTL: `ArrowLeft` = next, `ArrowRight` = previous. `Space` =
  next, `Shift+Space` = previous in both.
- Jumps of more than one spread (slider or input) play a short riffle (3 fast flips of 120 ms
  with `low` textures), then land.
- `invalidate()` runs only during flips, drags and transitions.

### 11.3 Progressive textures and the 3-spread window

- `texturePool.ts` owns all page textures with reference counting.
- Images are fetched as blobs and decoded off the main thread with
  `createImageBitmap(blob, { imageOrientation: 'flipY' })`; textures use `flipY = false`,
  `colorSpace = SRGBColorSpace`, mipmaps on, preset anisotropy.
- A page shows `low` first (fast, slightly soft) and cross-fades to `high` in 150 ms once
  `high` is decoded and the page is settled. No new `high` texture is created while a leaf
  moves: pages revealed by a turn show `low`; a page that already had `high` keeps it.
- A texture is disposed only after no material references it: disposing a bound texture makes
  three.js upload it again on the next frame, and that copy would leak (found and fixed in US-07).
- **GPU window:** textures exist only for the previous, current and next spreads (≤ 6 pages).
  Anything else is released with `texture.dispose()` and `imageBitmap.close()`.
- **RAM prefetch:** decoded `low` bitmaps for the next 3 spreads in reading direction are kept
  in RAM (not on the GPU) so fast flipping never waits.
- If no image is ready, the page shows a paper-coloured blank with faint line placeholders —
  never a spinner.

### 11.4 Zoom, pan and flip lock

- Above 100 % the reader switches to `ZoomOverlay`: an HTML `<img>` with the `zoom` quality
  image, positioned exactly over the projected screen rectangle of the zoomed page, then
  scaled with CSS transforms (GPU-composited). This keeps zoom sharp and avoids uploading a
  ~12-megapixel texture to the GPU (a visible stall on integrated graphics).
- Zoom range 100 %–400 %. Mouse wheel zooms toward the cursor; toolbar `−`, `100%`, `+` step
  by 25 %. Drag pans, clamped to the page edges.
- The zoomed page is the page under the cursor (toolbar: the last hovered page, default the
  first page in reading order).
- While zoom > 100 %, page flipping is locked. `Esc` or `100%` resets zoom and unlocks
  flipping. `Esc` at 100 % closes the book.

### 11.5 Bookmarking and Currently Reading

- On open: `PATCH /api/books/{id}` with `mark_opened: true`.
- On every page change, `last_read_page` is saved after the page has been stable for 600 ms
  (debounce), and immediately on close, `pagehide` and `visibilitychange` (hidden) using
  `fetch(..., { keepalive: true })`.
- On close: save, `mark_opened: true` again, return the book to its shelf, and the desk shows it
  in position #1.

### 11.6 Hall ↔ reader transition

- One `<Canvas>`. The hall stays mounted but hidden (`visible = false`) while reading, so
  closing a book is instant.
- **Open (700 ms):** the book lifts from its shelf or desk stand, travels to the reading
  position in front of the camera and opens; the hall fades behind an ink vignette.
- **Close:** the reverse; the book returns to its slot.

---

## 12. Search

- Runs in the browser over the bootstrap data (instant for 2,000+ books).
- **Normalization** (applied to the query and to titles, authors and category names):
  Unicode NFKC → casefold → strip Latin diacritics (é → e, ç → c) → strip Arabic diacritics
  (U+064B–U+065F, U+0670) and tatweel (U+0640) → unify alef forms (أ إ آ ٱ → ا) → ى → ي →
  ة → ه → collapse whitespace.
- **Ranking:** title starts with query > a title word starts with query > title contains >
  author match > category match. Ties: most recently opened first.
- Up to 8 results, each with cover thumbnail, title, author and category.
- `/` focuses the search field (unless typing elsewhere); `↑`/`↓` move; `Enter` flies to the
  book; `Esc` clears and closes.

---

## 13. Internationalization and RTL

- `i18n.ts` holds English and Arabic dictionaries and `t(key, vars)`. Every UI string goes
  through `t()` from US-05 onward.
- **Plurals:** `Intl.PluralRules` (`ar` has zero/one/two/few/many/other forms). Dictionary
  entries can provide all forms (e.g., كتاب واحد، كتابان، ٣ كتب، ١١ كتابًا).
- **Numerals:** Western digits (0–9) in both languages
  (`Intl.NumberFormat(locale, { numberingSystem: 'latn' })`).
- Switching language sets `<html lang dir>` immediately and persists `ui_language`.
- Layout uses Tailwind logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`,
  `end-*`) and `rtl:` variants. Direction-dependent icons (arrows, chevrons) are mirrored;
  numbers, media-style controls and the 3D scene are not.
- The book's own reading direction (LTR/RTL) is independent of the UI language.

---

## 14. Verification and Testing Strategy

Typecheck and build prove the code compiles, not that the 3D looks or behaves right. Every
story is verified by non-interactive commands, and every frontend story also produces visual
evidence.

### 14.1 Backend

- `pytest` with a temporary data directory, `DAR_RENDER_WORKERS=0`, and a `TestClient` that
  sends `X-Dar-Client: 1` by default.
- `tests/pdf_factory.py` generates fixtures at test time: text PDFs (English, French), PDFs
  with Arabic metadata titles, a 400-page synthetic scan, an encrypted PDF, a zero-byte file,
  a damaged PDF, a non-PDF file. No copyrighted PDFs are committed.
- `tests/test_perf.py` (marker `perf`) prints latency numbers; it does not fail the build.

### 14.2 Frontend unit tests

`vitest` for pure modules: `spreads.ts`, `hallLayout.ts` (positions, collision boxes),
`flightPath.ts`, `search.ts` (normalization and ranking), `texturePool.ts` (window and
disposal logic with mocks), `i18n.ts` (plurals).

### 14.3 End-to-end and visual tests (Playwright)

- `frontend/e2e/us-XX.spec.ts` per frontend story. The Playwright `webServer` runs
  `scripts/e2e-server.sh`: a temporary data directory seeded by `backend/scripts/seed_demo.py`,
  served with the static export on `127.0.0.1:8765`.
- **Test API:** when the URL contains `?test=1`, `testApi.ts` exposes `window.__DAR__` with
  read access to the store, the frame counter, `renderer.info` (draw calls, triangles,
  textures), the camera pose, and helper actions (open a book, flip to a page, set zoom).
- **Standard assertions:**
  - zero external requests (every request host is `127.0.0.1`);
  - zero frames rendered during 2 seconds without input (`frameloop="demand"` works);
  - texture count returns to the window budget after flipping 30 pages (replaces the manual
    DevTools check);
  - the camera never enters a collision box while walking into shelves;
  - the story's behaviour (keys, clicks, state changes).
- **Visual evidence:** each spec saves screenshots to `frontend/e2e/screenshots/us-XX/`. Motion is
  captured as frame sequences (test hooks hold an animation at fixed steps) and assembled into
  animated WebP previews for review: Playwright's video recording needs an ffmpeg build the cloud
  container does not have (D68). On a physical machine, Playwright video works normally. These files are git-ignored; Claude reviews them and sends
  them to the user at story review. Strict screenshot comparison (`toHaveScreenshot`) is used
  only for 2D overlays; 3D frames are checked structurally because software rendering varies.
- **Limit:** the cloud container renders WebGL with SwiftShader (CPU). Its FPS numbers are
  meaningless. Real performance (60 FPS, 0 % idle GPU) is checked on physical hardware with
  the `F2` debug overlay and the "Browser check" list in each frontend story.

### 14.4 Commands

| Purpose | Command |
|---|---|
| Setup | `./scripts/setup.sh` (`--backend` or `--frontend` for one side) |
| Backend tests | `cd backend && .venv/bin/pytest -v` |
| Backend compile check | `cd backend && .venv/bin/python -m compileall app` |
| Backend latency report | `cd backend && .venv/bin/pytest tests/test_perf.py -m perf -s` |
| Frontend typecheck | `cd frontend && npm run typecheck` |
| Frontend unit tests | `cd frontend && npm run test:unit` |
| Frontend build check | `cd frontend && npm run build` |
| Frontend e2e (one story) | `cd frontend && npm run test:e2e -- us-09` |

---

## 15. Launcher (`start.sh`)

- **Default (production):** run `scripts/setup.sh` if `backend/.venv` or
  `frontend/node_modules` is missing → build the frontend if `frontend/out/` is missing or
  older than `frontend/src/` → ensure `library_data/{pdfs,covers,cache,staging}` exist → check
  that port 8000 is free (clear message if not) → start Uvicorn on `127.0.0.1:8000` → wait for
  `GET /api/health` (timeout 30 s) → open the app window.
- **App window:** the first available of `chromium`, `chromium-browser`, `google-chrome`,
  `google-chrome-stable`, `brave-browser`, `microsoft-edge`, launched with
  `--app=http://127.0.0.1:8000` and a dedicated profile
  `--user-data-dir=library_data/.browser-profile`. The script waits for that browser process;
  closing the window stops the server. Fallback: `xdg-open` in a normal tab, and the script
  waits for `Ctrl+C`.
- **Flags:** `--dev` (Uvicorn `--reload` + `next dev -H 127.0.0.1 -p 3000`), `--no-browser`,
  `--smoke` (start production, check `/api/health` and `/`, stop, exit 0 on success).
- `trap` on `EXIT`, `INT` and `TERM` stops every child process.
- No PWA (no manifest or service worker); the `--app` window provides the standalone feel.
- Windows `start.bat` is deferred to post-MVP (D19, D25).
