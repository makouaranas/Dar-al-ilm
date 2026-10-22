# REQUIREMENTS REPORT — 3D Personal Digital Library ("Bibliothèque Numérique 3D")

**Product name:** Dar al Ilm (دار العلم)
**Date:** October 21, 2026
**Version:** v1.2 (Spec Review Edition). Supersedes v1.1 (General Hardware Edition).

v1.2 keeps every requirement of v1.1 and applies the fixes agreed in the senior engineering
review of October 21, 2026. Each change is recorded in the Decision Log (§15, D32–D63).
Technical details referenced here live in:
- `docs/ARCHITECTURE.md` — tech stack and pinned versions, repository blueprint, data model,
  API contract, security details, PDF pipeline, hall layout, 3D performance rules, testing.
- `docs/DESIGN.md` — approved design direction (look and feel, copy, states).
- `AGENTS.md` — AI coding agent contract.
- `docs/sprints/` — the 4 sprints and 16 user stories.
- `PROGRESS.md` — live story status.

---

## 1. Executive Summary

The 3D Personal Digital Library is a local, single-user application that replaces disorganized
local OS book folders (Documents), flat 2D book-cover grids, and vertical PDF scrolling with an
architectural 3D public library hall and a realistic 3D page-flipping reader.

Users import PDF books (including scanned image-only PDFs and Arabic, French, or English texts)
into a managed, portable local storage directory (`./library_data/`). Each book is assigned to
a user-defined category, scaled in 3D spine width by its page count, and placed spine-out on
shelves in a category bay marked by a hanging plaque on its column. Users navigate with the
arrow keys (or WASD) and click-and-drag look, or jump directly to a book via a Search Bar,
resume their top 3 active books from an entrance "Currently Reading" desk, and read inside a 3D
curved-page book featuring progressive Level-of-Detail (soft while a page turns, sharp
high-resolution when settled) and single-page cursor zoom.

The hall is a neutral, modern library with Arabic design accents (daylight through mashrabiya
screens, brass plaques, a clean pointed entrance arch). The UI works in English and Arabic with
full right-to-left mirroring.

The project is structured into modular specification files, a root `AGENTS.md` contract, and 4
Scrum Sprints containing 16 atomic User Stories (US-01 to US-16) for reliable execution by AI
coding agents. Every story has a non-interactive verification command; every frontend story
also produces screenshots and videos for visual review.

---

## 2. Problem and Goals

### Problem Statement

- **Disorganized Local Storage:** storing downloaded PDF books in OS Documents or Downloads
  folders leads to cluttered files, missing categorization, and lost reading progress.
- **Lifeless 2D Browsing:** traditional e-book managers present flat 2D grids of rectangles that
  remove the spatial discovery of walking past categorized shelves in a real public library.
- **Fatiguing Vertical PDF Scrolling:** standard PDF viewers force vertical scrolling without
  physical page-turning, Right-to-Left (RTL) page flipping for Arabic books, or automatic
  bookmark resumption.
- **Unstructured AI Agent Execution:** feeding a full 3D + PDF application to an AI coding agent
  as a single monolithic prompt causes broken 3D math and untested code.

### Project Goals and Measurable Success Criteria

| Goal ID | Goal Description | Measurable Success Criterion |
|---|---|---|
| G1 | Eliminate Local Folder Clutter | 100 % of imported PDFs are copied into `./library_data/pdfs/` with relative SQLite paths, allowing safe deletion of original files from Documents. |
| G2 | Fast Categorized Book Import | Importing a 400-page scanned PDF, counting its pages, and generating a Page 1 cover snapshot completes in < 1.5 seconds of server-side processing (measured from upload received to response; the browser's file transfer time is excluded). Measured baseline: 90 ms. |
| G3 | Instant Spatial and Search Discovery | Searching by Title, Author, or Category and flying the 3D camera to the target book completes in < 2.0 seconds. |
| G4 | Smooth General 3D Performance | 3D hall navigation and page-flip animations run at 60 FPS on standard laptops and desktops (integrated or dedicated GPUs), dropping to 0 % GPU load when stationary. The 0 % idle rule is verified automatically (zero frames rendered without input); 60 FPS is verified on physical hardware with the F2 debug overlay, because the cloud container renders WebGL in software. |
| G5 | Verifiable Scrum Execution | 100 % of the 16 Scrum User Stories (US-01 to US-16) pass their automated terminal verification check (pytest, vitest, Playwright, typecheck, build) before proceeding to the next story. |

---

## 3. Users and Key Scenarios

### Target User and System Profile

- **Primary User:** any individual reader, student, developer, or researcher using a standard
  laptop or desktop PC with keyboard and mouse/touchpad.
- **Collection Profile:** 50 to 2,000+ PDF books across custom categories (such as Programming,
  History, Novels, العربية) in English (LTR), French (LTR), and Arabic (RTL), including scanned
  image-only PDFs with tables and small text.
- **Platform:** Ubuntu Linux with a Chromium-family browser for the app window (Windows
  launcher deferred to post-MVP).

### Scenario 1: Managing Categories and Preferences in Settings (UC-01)

1. User opens the Settings modal and selects the UI language (English `en` LTR or Arabic `ar`
   RTL), the graphics preset (Auto, Performance, or High), the ambient light level, and the
   default reading direction for new books (LTR or RTL).
2. User creates, renames, or deletes book categories (for example: Programming, History,
   Novels, العربية). Names are unique regardless of letter case.
3. Deleting a category that still has books asks the user to choose another category to move
   them to; books are never deleted with their category.
4. The 3D library hall immediately updates the hanging plaques on its architectural columns
   using browser-native 2D `CanvasTexture` rendering, and closes any gap left by a deleted
   category.

### Scenario 2: Importing a PDF Book (UC-02)

1. User clicks **Add book** (top bar, or the ghost slot on an empty category's shelf) and selects
   or drops a `.pdf` file from their computer.
2. The Python backend receives the file into a staging area, validates it, counts total pages,
   reads the page size, and snapshots Page 1 as a `.webp` cover preview. The modal shows the
   cover and page count, and pre-fills the title (from PDF metadata or the file name) and the
   reading direction (RTL when the title is in Arabic). If the same file is already in the
   library, the modal says so and offers **Import anyway** or **Open existing**.
3. User fills in **Required Fields:**
   - Title (text input)
   - Category (dropdown of user categories)
   - Reading Direction (LTR pre-selected by default for English/French; RTL selectable for
     Arabic, and pre-selected for Arabic titles)
4. User optionally fills in **Optional Fields:**
   - Author (text input)
   - Notes / Description (multiline text)
   - Custom Cover Image (defaults to the automatic Page 1 snapshot unless a custom cover image is
     uploaded)
5. User clicks **Add book**. The backend moves the PDF into `./library_data/pdfs/` and the cover
   into `./library_data/covers/`. The book is placed spine-out on its category's shelf in the
   first free slot, with its 3D spine width scaled by `page_count`. If that category's shelves
   are full (30 books per shelf), the system automatically allocates the next shelf. Cancelling
   discards the staged file.

### Scenario 3: Browsing, Searching, and Inspecting Books (UC-03)

1. Upon opening the app, the user starts in front of the "Currently Reading" Entrance Desk,
   which displays the 3 most recently read books ordered 1st (latest), 2nd, and 3rd.
2. To browse other books, the user either:
   - walks through the 3D hall using the Arrow Keys (or WASD) and click-and-drag mouse look (the
     cursor stays free), prevented from walking through shelves by collision boundaries, with the
     Home key returning to the Entrance Desk; or
   - clicks the Search Bar (or presses `/`), types a Title, Author, or Category, and selects a
     match — smoothly flying the 3D camera along the aisle to that book, which is highlighted.
3. Hovering the mouse over a spine-out book slides it out slightly and shows its full title.
   Clicking it lifts it out and turns its front cover toward the user, with Open, Edit, and
   Delete buttons.

### Scenario 4: Reading, Flipping, Zooming, and Auto-Bookmarking (UC-04)

1. Clicking **Open** transitions to the 3D Curved Mesh Book Reader at the saved `last_read_page`
   (or Page 1 if new).
2. Clicking a page, dragging a page corner, or pressing the Left/Right Arrow flips the page in
   3D (LTR or RTL; the arrow keys follow the physical side, so in an Arabic book Left Arrow turns
   to the next page).
3. While the page is in motion, it displays a lightweight lower-resolution texture (768 px long
   side) for smooth 60 FPS animation; once the page lands, it cross-fades to a crisp
   high-resolution texture (2048 px long side).
4. To inspect a table or small text, the user scrolls the mouse wheel (or clicks `+` on the
   bottom toolbar) to zoom (100 % to 400 %) toward the cursor. While zoomed (> 100 %),
   page-flipping is locked, the backend streams a 4096 px image, and clicking-and-dragging pans
   across the page. Pressing Esc or clicking 100 % resets zoom and unlocks flipping.
5. User can jump directly to any page via the bottom Jump-to-Page slider/input.
6. Closing the book saves `last_read_page`, automatically returns the book to its shelf, and
   promotes the book to position #1 on the Currently Reading desk.

### Scenario 5: First Launch (UC-05)

1. On first launch there are zero books and zero categories. The hall shows its entrance, the
   desk and one softly lit empty bay.
2. A welcome card offers **Create your first category** and one-click suggestions
   (Programming, History, Novels, العربية).
3. After the first category exists, its bay shows an empty bookcase with a ghost "Add book"
   slot, and the desk explains that opened books will appear there.

---

## 4. Functional Requirements

| Req ID | Priority | Functional Requirement and Acceptance Criteria |
|---|---|---|
| FR-01 | Must (MVP) | **3D Library Hall Environment:** render an architectural 3D library hall (neutral modern hall with Arabic design accents per `docs/DESIGN.md`) with an entrance desk, columns, category bays with multi-tier bookcases, and adaptive performance scaling. **AC:** scene loads offline in < 3 seconds, maintains 60 FPS during movement, and pauses rendering (`frameloop="demand"`) when idle (zero frames without input). |
| FR-02 | Must (MVP) | **Arrow-Key Walking and Shelf Collision:** first-person walking with Arrow Keys / WASD and click-and-drag mouse look (no pointer lock), 2D bounding-box collision around shelves/walls/columns/desk with wall sliding, and a Home key reset to the Entrance Desk. **AC:** camera cannot clip through shelves; pressing Home returns to the Entrance Desk in < 1 second. |
| FR-03 | Must (MVP) | **Search Bar and Camera Flight:** filter books in real time by Title, Author, or Category (shortcut `/`) with Arabic- and French-aware normalization, and smoothly fly the 3D camera along the aisle to the selected book. **AC:** camera arrives facing the target book within 1.5 seconds, never passes through bookcases, and highlights the book. |
| FR-04 | Must (MVP) | **Category Settings and 2D CanvasTexture Plaques:** create, rename, and delete categories in Settings, rendered on 3D column plaques via HTML5 2D `<canvas>` (`THREE.CanvasTexture`). Deleting a non-empty category requires moving its books to another category. **AC:** Arabic (RTL), French, and English plaques display connected letters accurately offline, on both faces of each plaque. |
| FR-05 | Must (MVP) | **Auto-Shelf Expansion (first free slot):** each book takes the lowest free (shelf, slot) in its category; a new shelf is used when all existing shelves hold 30 books. **AC:** importing a 31st book into a category with a full shelf 0 places it at `shelf_number = 1`, `slot_index = 0` without overlapping geometry; after a book is deleted or moved, the next import fills the freed slot; two books never share a slot. |
| FR-06 | Must (MVP) | **Managed PDF Upload and Metadata Validation:** two-phase import (stage and analyze, then save). Copy uploaded `.pdf` files into `./library_data/pdfs/`. Require Title, Category, and Reading Direction (LTR/RTL); allow optional Author, Notes, and Custom Cover Image. Warn about duplicates (same file hash). **AC:** blocks submission if required fields are missing; rejects non-PDF, encrypted, empty and damaged files with clear messages; the original file in Documents can be safely deleted after upload. |
| FR-07 | Must (MVP) | **Page 1 Cover Snapshot and Page Count:** automatically count PDF pages, read the page size, and render Page 1 as a `.webp` cover image in `./library_data/covers/` when no custom cover is uploaded. **AC:** completes in < 1.5 seconds even on 100 % scanned image PDFs (server-side). |
| FR-08 | Must (MVP) | **Page-Count Spine Thickness:** scale each 3D book's spine width on the shelf by `page_count` (`clamp(0.004 + 0.00005 × page_count, 0.015, 0.08)` m); book height and depth follow the PDF's page size. **AC:** a 600-page book is visibly thicker on the shelf than a 60-page book. |
| FR-09 | Must (MVP) | **Spine-Out Shelving, Hover and Present:** render books spine-out with spine titles drawn on 2D canvas into texture atlases. Hovering slides the book out 5 cm and shows its full title; clicking lifts it out, turns its front cover toward the user, and displays Open, Edit, and Delete controls. **AC:** hover transition runs smoothly in 180 ms and retracts in 220 ms when the cursor leaves; the present transition runs in 450 ms; Esc or clicking elsewhere returns the book. |
| FR-10 | Must (MVP) | **Edit and Delete Book:** edit metadata, reading direction, category (moving the book to the first free slot of the new category) and cover (replace or revert to Page 1); delete a book (removing the SQLite row, PDF file, cover file, and cached pages). **AC:** deleting a book leaves zero orphan files inside `./library_data/`; startup reconciliation removes orphans left by crashes; a book whose PDF was removed by hand is flagged "File missing" with a Remove action. |
| FR-11 | Must (MVP) | **"Currently Reading" Entrance Desk (Top 3):** display the 3 most recently opened books on the entrance desk ordered 1st (latest), 2nd, and 3rd. **AC:** opening and closing any book updates `last_opened_at`; closing places it at position #1 on the desk; empty positions show numbered empty stands. |
| FR-12 | Must (MVP) | **3D Curved Mesh Page-Flipping Reader (LTR and RTL):** render the open book as a 3D curved mesh inside React Three Fiber, flipping left-to-right for LTR books and right-to-left for RTL (Arabic) books, with the spread layout mirrored for RTL. **AC:** mouse click/drag and Left/Right Arrow keys turn pages in the book's `reading_direction`; arrows follow the physical side. |
| FR-13 | Must (MVP) | **Progressive Low-to-High Streaming and 3-Spread Memory Window:** display a 768 px texture during page-turn motion and cross-fade to a 2048 px texture once settled; dispose (`texture.dispose()`) all Three.js page textures outside the active 3-spread window (prev, current, next). **AC:** flipping 50+ pages continuously produces no stalls waiting for images, and GPU/system memory stays flat (automated texture-count check after 30 flips). |
| FR-14 | Must (MVP) | **Single-Page Cursor Zoom, Pan and Flip Lock:** zoom (100 % to 400 %) toward the mouse cursor via scroll wheel or toolbar (−, 100 %, +), using a 4096 px page image in a 2D overlay aligned over the 3D page; lock page-flipping whenever zoom > 100 %; enable click-drag panning. **AC:** scrolling into a table locks page-turning and enables panning; pressing Esc or 100 % resets zoom and unlocks flipping. |
| FR-15 | Must (MVP) | **Auto-Bookmark, Jump-to-Page and Auto-Reshelve:** Jump-to-Page slider/input on the reader toolbar; automatically save `last_read_page` after every page change (debounced 600 ms, flushed on close and when the window is hidden); return the book to its shelf on close. **AC:** reopening a book always resumes at the exact last-read page, also after a reload. |
| FR-16 | Must (MVP) | **English/Arabic UI and One-Click Launcher:** English (`en`, LTR) / Arabic (`ar`, RTL) UI toggle in Settings with Western digits and correct Arabic plurals, a WebGL hardware-acceleration check banner, an API connection badge, and a one-click startup script (`start.sh` for Linux; Windows `start.bat` deferred). **AC:** switching language mirrors the UI layout immediately; running the startup script launches the app (one FastAPI process serving the API and the built frontend on `127.0.0.1:8000`) and opens the app window; closing the window stops it. |
| FR-17 | Must (MVP) | **Empty, Loading and Error States:** every state in `docs/DESIGN.md` §12 exists with its exact English and Arabic copy: first-launch welcome card, empty category, empty desk, no search results, boot loading, import progress, reader placeholders (never spinners), upload errors, missing file, page render failure, API unreachable, software rendering, no WebGL. **AC:** each state is reachable in an e2e test and captured in a screenshot. |

---

## 5. Non-Functional Requirements

| Req ID | Category | Non-Functional Requirement |
|---|---|---|
| NFR-01 | Adaptive 3D Performance | Maintain 60 FPS across standard integrated and dedicated GPUs using React Three Fiber `frameloop="demand"` (0 % GPU usage when idle) and the custom `useAdaptiveQuality` hook, which samples frame times only during motion and scales the pixel ratio (`dpr`) with hysteresis (`docs/ARCHITECTURE.md` §10.2). drei `<PerformanceMonitor>` is not used because it misreads idle gaps as low FPS. Graphics presets per `docs/ARCHITECTURE.md` §10.3. |
| NFR-02 | PDF Streaming Latency | Python PyMuPDF serves page images with: cache hit < 10 ms; `low` (768 px) cache miss < 50 ms; `high` (2048 px) cache miss < 250 ms; `zoom` (4096 px) cache miss < 500 ms; using background prefetch of adjacent pages into `./library_data/cache/` so normal reading rarely waits. Targets are based on measurements (`docs/ARCHITECTURE.md` §8.6). |
| NFR-03 | Memory Management | Browser GPU texture memory stays under 400 MB during extended reading and walking sessions (budget breakdown in `docs/ARCHITECTURE.md` §10.4), by disposing Three.js page textures outside the active 3-spread window and limiting resident spine-label atlases. |
| NFR-04 | Catalog Scalability | Support 500 to 2,000+ books without frame drops using one instanced draw call per bookcase, single-channel spine-label atlases built only for nearby bays, and frustum culling (`docs/ARCHITECTURE.md` §10.5). |
| NFR-05 | 100 % Offline Operation | Bundle all fonts (Cairo for Arabic, Inter for English/French, variable `.woff2`), icons, and textures locally inside `frontend/public/` with zero external CDN requests at runtime. drei `<Environment preset>` (which downloads HDRs) is forbidden. Internet is needed only once, for first-time setup (`pip install`, `npm ci`). |
| NFR-06 | Portable Storage Format | Store only relative file paths (`pdfs/...`, `covers/...`) via Python `pathlib` in `./library_data/library.db` so the data folder works across operating systems. The data folder location is independent of the current working directory and can be overridden with `DAR_DATA_DIR`. |
| NFR-07 | Localhost Security | Bind FastAPI (`127.0.0.1:8000`) and the Next.js dev server (`127.0.0.1:3000`, development only) strictly to loopback; reject foreign `Host` headers (DNS rebinding); require the `X-Dar-Client` header and an allowed `Origin` on mutating requests (cross-site requests); validate `%PDF-` magic bytes on upload; never use user file names in paths; cap upload size and render size (`docs/ARCHITECTURE.md` §7). |
| NFR-08 | Bilingual and RTL Accuracy | Use Tailwind CSS logical properties (`ms-*`, `me-*`, `dir="rtl"`) for instant layout switching between English and Arabic; Arabic plurals via `Intl.PluralRules`; Western digits in both languages; Arabic copy follows the glossary in `docs/DESIGN.md`. |
| NFR-09 | Database Crash Safety | Configure SQLite with `PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys=ON;` to prevent corruption on unexpected shutdown. Schema changes go through versioned migrations (`PRAGMA user_version`) that preserve user data. |
| NFR-10 | AI Agent Verifiability | Every Scrum User Story must be verifiable via a non-interactive terminal command (pytest, vitest, Playwright, curl, `npm run typecheck`, `npm run build`) defined in its sprint file. Frontend stories also produce screenshots and videos that are reviewed before the story is marked done. |
| NFR-11 | Accessibility and Motion | Visible keyboard focus, complete keyboard paths, labelled icon buttons, text contrast ≥ 4.5:1, and `prefers-reduced-motion` support (flights and transitions become short fades) per `docs/DESIGN.md` §11 and §15. |

---

## 6. Platform Decision

### Options Considered

- **Option A — Local Next.js Web App + Local Python FastAPI Server (Selected):** runs a local
  Python API and a Next.js frontend opened in a standalone browser app window. In production the
  Next.js app is built as a static export and served by FastAPI on `127.0.0.1:8000` (one
  process, one port). In development, `next dev` runs on `127.0.0.1:3000` for hot reload.
- **Option B — Electron Desktop App:** bundles Chromium and Node.js into a desktop binary.
- **Option C — Tauri v2 Desktop App:** bundles a Rust webview wrapper around the frontend.

### Why Option A Won

- **General Hardware Efficiency:** avoids running a duplicate Electron Chromium binary, saving
  150–250 MB of RAM on standard laptops. Serving the static export from FastAPI also removes the
  Node.js server at runtime (about 200 MB more).
- **Highest AI Agent Success Rate:** AI coding agents write, test, and verify pure FastAPI +
  Next.js files without failing on desktop installer bundlers.
- **Native File and PDF Speed:** running Python locally gives PyMuPDF direct disk access to
  `./library_data/` and C-speed rendering off the browser's WebGL thread.

PWA packaging (manifest, service worker) is not used; the Chromium `--app` window provides the
standalone feel.

---

## 7. Architecture, Tech Stack and Multi-File AI Agent Structure

The tech stack (with versions verified against npm and PyPI on October 21, 2026, reasons for
choice and alternatives considered) and the multi-file repository and Scrum spec blueprint are in
`docs/ARCHITECTURE.md` §2 and §3. The v1.1 version list was replaced after verification (D32).

## 8. Data Model

See `docs/ARCHITECTURE.md` §5 (tables `category`, `book`, `app_setting`, constraints, schema
versioning).

## 9. Integrations and Internal API Contract

- **External Cloud Services:** none. Zero calls to external servers or paid APIs.
- **Internal REST API Contract:** see `docs/ARCHITECTURE.md` §6 (all endpoints, request and
  response shapes, error codes, headers).

---

## 10. Security and Privacy

- **Loopback Isolation (127.0.0.1):** the FastAPI server (and the Next.js dev server in
  development) binds strictly to `127.0.0.1`, so no other device on shared Wi-Fi can access the
  library.
- **Browser-Based Attacks on Localhost:** other websites open in the user's browser cannot use
  the API: foreign `Host` headers are rejected (DNS rebinding) and mutating requests require the
  `X-Dar-Client` header and an allowed `Origin` (cross-site request forgery).
- **Upload Validation:** FastAPI verifies `%PDF-` magic bytes, rejects encrypted, empty and
  damaged PDFs, streams uploads to disk with a size cap, never uses user-supplied file names in
  paths (so `..`, `/` and `\` never reach the filesystem), and writes files using safe internal
  IDs (`book_{id}.pdf`). Custom covers are validated and re-encoded.
- **100 % Local Privacy:** zero telemetry (including `NEXT_TELEMETRY_DISABLED=1`), zero
  external font downloads, and zero cloud syncing.

Details: `docs/ARCHITECTURE.md` §7.

---

## 11. Hosting, Deployment and Estimated Costs

- **Deployment Target:** local execution on the user's computer via `./start.sh` on Ubuntu Linux
  (portable to `start.bat` on Windows later, deferred per D19/D25).
- **Startup Workflow:** runs first-time setup if needed (needs internet once), builds the
  frontend if needed, ensures `./library_data/{pdfs,covers,cache,staging}` exist, checks the
  port, launches FastAPI on `127.0.0.1:8000` (serving the API and the built frontend), waits for
  `/api/health`, opens the standalone app window (`--app=http://127.0.0.1:8000` with a dedicated
  browser profile), and stops the server when the window closes or on Ctrl+C. Flags: `--dev`,
  `--no-browser`, `--smoke`. Details: `docs/ARCHITECTURE.md` §15.
- **Development environment:** the project is developed in Claude Code cloud sessions on the
  GitHub repository. A SessionStart hook installs the Claude Code tooling. Visual review happens
  through screenshots and videos produced by Playwright in the cloud container.
- **Estimated Costs:** $0.00 build cost and $0.00/month running cost.

---

## 12. Risks and Mitigations

| Risk ID | Risk Description | Likelihood | Impact | Concrete Mitigation Strategy |
|---|---|---|---|---|
| R1 | GPU Memory Overload or Lag on Integrated/Standard Graphics | Medium | High | `frameloop="demand"` (0 % idle GPU load), `useAdaptiveQuality` pixel-ratio scaling, graphics presets, texture budgets (`docs/ARCHITECTURE.md` §10.4), instanced books, and disposal of Three.js textures outside the active 3-spread window. |
| R2 | Browser Hardware Acceleration Disabled in OS/Browser Flags | Medium | High | Startup WebGL check (US-15) that warns the user if the browser falls back to slow software rendering, with a frame-time fallback when the renderer name is hidden. |
| R3 | Disconnected Arabic Letters on 3D Plaques and Book Spines | High (with 3D mesh fonts) | Medium | Render all plaques and spines onto an HTML5 2D `<canvas>` (`ctx.direction = 'rtl'`) wrapped in a `THREE.CanvasTexture`, only after the fonts have loaded, with no letter-spacing on Arabic. |
| R4 | AI Coding Agent Context Rot Across Multiple Files | High (with giant prompts) | High | Enforce the `AGENTS.md` One-Story-Per-Iteration Scrum Protocol: the agent implements one US-## story at a time and must pass its verification before proceeding. |
| R5 | Camera Clips Inside Bookshelves While Walking | Low | Low | 2D (x, z) bounding-box collision with wall sliding, flights along walkable waypoints, and a Home key shortcut back to the Entrance Desk. |
| R6 | Fresh Releases (PyMuPDF 2.0 two days old, FastAPI 0.159.1 released the same day) | Medium | Medium | Exact pins; full test suite per story; documented fallback to PyMuPDF 1.28.2 / previous FastAPI if a defect blocks a story. |
| R7 | TypeScript 7 Ecosystem Gaps (no classic compiler API, no `tsserver.js`) | Medium | Low | Verified Next.js 16.4.2 builds and type-checks with TS 7; the editor language server uses a global TypeScript 6; fallback to TS 6.0.3 if a required tool breaks. |
| R8 | Real GPU Performance Cannot Be Measured in the Cloud Container | High | Medium | The container renders WebGL with SwiftShader (CPU). Automated checks cover idle frames, texture counts, draw calls and collision; real FPS is checked on physical hardware with the F2 overlay before calling performance done. |
| R9 | Slow Page Rendering on Scanned PDFs (full-resolution JPEG decode ≈ 80 ms) | High | Medium | Pixel-based qualities, WebP `method=0`, disk cache, prefetch of following pages, worker processes, low-first progressive display. |
| R10 | Websites Attacking the Local API (DNS rebinding, cross-site requests) | Low | High | TrustedHost middleware, `X-Dar-Client` header, Origin checks, loopback binding. |
| R11 | GPU Memory Growth with 2,000+ Books (one texture per spine) | High (naive approach) | High | Single-channel label atlases, distance-based building and disposal, resident limits per preset. |
| R12 | Playwright Version vs Preinstalled Chromium in the Container | Low | Medium | `PLAYWRIGHT_CHROMIUM_EXECUTABLE` points Playwright at the preinstalled Chromium 141 (verified with Playwright 1.64 rendering WebGL2). |
| R13 | Material Texture Sources Unreachable from the Build Environment | Medium | Low | Commit CC0 textures to the repo; generate textures procedurally when a source cannot be downloaded; never hotlink. |

---

## 13. MVP Scope, Scrum Sprint Backlog and AGENTS.md Protocol

- **Part A — AGENTS.md:** the AI coding agent contract is `AGENTS.md` at the repository root.
- **Part B — Product Backlog:** 4 Sprints, 16 atomic User Stories:

| Sprint | File | Stories |
|---|---|---|
| Sprint 1: Python Backend, SQLite Catalog and PyMuPDF Streaming Engine | `docs/sprints/sprint-1-backend.md` | US-01 to US-04 |
| Sprint 2: 3D Curved Book Reader and Adaptive Performance | `docs/sprints/sprint-2-reader-3d.md` | US-05 to US-08 |
| Sprint 3: 3D Library Hall, Plaques, Spine-Out Shelves and Search Flight | `docs/sprints/sprint-3-hall-3d.md` | US-09 to US-12 |
| Sprint 4: Bilingual UI (EN/AR), Modals, Diagnostics and Launcher | `docs/sprints/sprint-4-ui-launch.md` | US-13 to US-16 |

---

## 14. Assumptions and Open Questions

### Assumptions

- A1: The user runs Ubuntu Linux with Python ≥ 3.12, Node.js ≥ 20.9 and a Chromium-family
  browser when running the app on their own machine.
- A2: Internet access is available once for first-time setup; the app runs offline afterwards.
- A3: Individual PDFs are ≤ 2 GB (configurable).
- A4: Development happens in Claude Code cloud sessions; the user reviews frontend stories
  through screenshots and videos. Real-GPU performance (60 FPS, 0 % idle GPU) is confirmed when
  the app first runs on physical hardware.
- A5: One user, one library folder; no concurrent use from multiple devices.

### Open Questions

- None blocking. Hall layout constants and material values marked *(tunable)* in
  `docs/ARCHITECTURE.md` §9 will be tuned visually during Sprint 3; any change is recorded there.

---

## 15. Decision Log

| ID | Status | Decision and Reason |
|---|---|---|
| D1–D25 | Active | Core 3D personal library concept, single-user scope, hybrid arrow-key + Search Bar teleport, categorized PDF upload into `./library_data/`, auto-bookmarking/reshelving, progressive blur-to-sharp flip rendering, Top-3 Currently Reading desk, hanging category plaques, spine-out hover preview, required LTR/RTL reading direction, page-count spine thickness, Next.js + React Three Fiber + Python FastAPI + PyMuPDF + SQLite stack, mouse-wheel zoom with flip lock, and English/Arabic UI. (D19 Windows launcher deferred to post-MVP per D25.) |
| D26–D28 | Generalized by D31 | Approved 3-spread GPU texture cleanup, `frameloop="demand"`, offline bundled fonts, 127.0.0.1 security, HTML5 2D CanvasTexture for Arabic/English 3D plaques and spines, shelf collision walls, Home key reset, early validation tests, and 4-Sprint roadmap. |
| D29 | Active | Final Requirements Report written in English for AI coding agent accuracy. |
| D30 | Active | Spec-Driven Scrum and Multi-File AI Agent Architecture adopted: 4 Sprints, 16 atomic User Stories (US-01 to US-16), `AGENTS.md` contract, and `PROGRESS.md` state tracker. |
| D31 | Active (Updates D26–D28) | Hardware target is general-purpose across all standard laptops and desktop PCs (supporting both integrated and dedicated GPUs via adaptive quality and Auto / Performance / High graphics presets), removing all device-specific references. |
| D32 | Active | Package versions re-verified on npm/PyPI on Oct 21, 2026 and pinned exactly; supersedes the v1.1 version table (React 19.3.1, R3F 9.8.2, Zustand 5.0.15, TypeScript 7.0.2, FastAPI 0.159.1, PyMuPDF 2.0, pytest 9.1.1, among others). |
| D33 | Active | Added dependencies: Pillow, python-multipart, httpx2 (backend); `@tailwindcss/postcss`, `postcss`, `@types/three`, `@types/react`, `@types/react-dom`, `@types/node`, `lucide-react`, `vitest`, `@playwright/test` (frontend). |
| D34 | Active | TypeScript 7.0.2 for the project (verified with Next.js 16.4.2); TypeScript 6 only as the global fallback for the editor language server. |
| D35 | Active | PyMuPDF 2.0 imported as `pymupdf`; fallback 1.28.2. |
| D36 | Active (supersedes `count // 30` and `count % 30` in v1.1) | First-free-slot shelf allocation in a transaction, guarded by `UNIQUE(category_id, shelf_number, slot_index)`. |
| D37 | Active | Deleting a non-empty category is blocked unless its books are moved (`move_to`); `column_index` stays contiguous. |
| D38 | Active (supersedes the single multipart `POST /api/books` with `pdf_file`) | Two-phase import: `POST /api/uploads` (stage and analyze), then `POST /api/books` with `upload_id`; cancel deletes the staged files. |
| D39 | Active | Schema additions: `category.name_key`; `book.cover_is_custom`, `page_width_pt`, `page_height_pt`, `spine_color`, `file_sha256`, `file_size_bytes`, `updated_at`; CHECK constraints, indexes, `ON DELETE RESTRICT`; `PRAGMA user_version` migrations. |
| D40 | Active (supersedes 72/150/300 DPI) | Page quality defined by long side in pixels: `low` 768, `high` 2048, `zoom` 4096. |
| D41 | Active (updates NFR-02) | Latency targets revised from measurements: cache hit < 10 ms; cold low < 50 ms, high < 250 ms, zoom < 500 ms. |
| D42 | Active | Rendering in worker processes (PyMuPDF is not thread-safe), foreground requests before prefetch, cancellable prefetch, 1 GB LRU page cache. |
| D43 | Active (supersedes drei `<PerformanceMonitor>` in NFR-01 and AGENTS.md) | Custom `useAdaptiveQuality` hook that measures only during motion. |
| D44 | Active | One camera owner (`PlayerControls`); drei `CameraControls` not used; flights follow aisle waypoints. |
| D45 | Active | No pointer lock; click-and-drag to look, so the cursor stays free for hovering and clicking. |
| D46 | Active (supersedes 10 cm pull-out and rotate on hover in 200 ms) | Two-stage interaction: hover slides out 5 cm (180 ms); click presents the cover with Open / Edit / Delete (450 ms). |
| D47 | Active | Zoom above 100 % uses a 2D image overlay aligned over the 3D page. |
| D48 | Active (updates FR-16, NFR-07, §6, §11) | Production runs one FastAPI process serving the API and the static Next.js export on `127.0.0.1:8000`; development keeps `next dev` on `127.0.0.1:3000`. |
| D49 | Active | Security layer: TrustedHost, `X-Dar-Client` header, Origin checks, upload and render limits. |
| D50 | Active | Offline: drei Environment presets forbidden (they download HDRs); Lightformers instead; variable `.woff2` fonts via `next/font/local`; canvas text drawn only after fonts load. |
| D51 | Active | Books instanced per bookcase with single-channel spine-label atlases and distance-based level of detail; hall layout contract in `docs/ARCHITECTURE.md` §9. |
| D52 | Active (updates the PATCH contract) | Bookmark saves debounced (600 ms) and flushed with `keepalive`; `mark_opened` sets `last_opened_at` on the server clock (replaces client-sent `last_opened_at`). |
| D53 | Active | Spread model and 1-based page numbers everywhere in the API; arrow keys follow the physical side. |
| D54 | Active (updates NFR-10) | Verification adds vitest unit tests, Playwright e2e tests with a `?test=1` test API, idle-frame and texture-count assertions, and screenshots/videos reviewed per frontend story; latency tests are informational. Replaces US-07's manual DevTools step and US-08's undefined "Validation Test 2". |
| D55 | Active | Data directory resolved from the repository root (or `DAR_DATA_DIR`); tests use temporary directories. |
| D56 | Active | Startup reconciliation removes orphan and expired staged files; missing PDFs are flagged, not deleted. |
| D57 | Active | Client-side search with Arabic and French normalization and ranking. |
| D58 | Active | Accessibility and reduced-motion requirement added (NFR-11). |
| D59 | Active | Design direction: neutral modern library with Arabic design accents (`docs/DESIGN.md`); Western digits in Arabic UI; Cairo + Inter only. |
| D60 | Active | Story scope fixes: `GET /api/bootstrap` built in US-02; i18n skeleton in US-05; `/dev/reader` route for Sprint 2; `seed_demo.py` in US-04; complete file lists per story. |
| D61 | Active | No PWA; Chromium-family `--app` window with a dedicated profile; closing the window stops the server. |
| D62 | Active | Graphics presets defined (`docs/ARCHITECTURE.md` §10.3); ambient light slider added to US-14; no post-processing dependency. |
| D63 | Active | Empty, loading and error states added as FR-17, and the first-launch scenario added as UC-05. |
| D64 | Active (user decision, US-01 review) | FastAPI's `/docs` and `/redoc` pages stay disabled because they load Swagger UI and ReDoc from `cdn.jsdelivr.net`; the OpenAPI schema remains at `/openapi.json`. |
| D65 | Active (user decision, US-01 review) | `DAR_DEV_ORIGIN` is always allowed (it is a loopback origin); no separate development-mode switch. |
| D67 | Active (US-06) | The page curl is computed on the CPU (length-preserving row integration, unit-tested) instead of in a vertex shader; 441 vertices cost a fraction of a millisecond per frame. |
| D68 | Active (US-06) | Motion evidence in the cloud is a frame sequence assembled into an animated WebP: Playwright 1.64 video needs ffmpeg-1013 (VP9/Matroska), the container only has ffmpeg-1011. |
| D69 | Active (US-06) | `tsconfig.json` uses `incremental: false`: TypeScript 7's incremental cache reported stale errors after a type change. |
| D66 | Active (scope fix before US-02) | `shelving.py` (first-free-slot) and a new `schemas.py` (shared request/response shapes) are created in US-02, because US-02's `move_to` and bootstrap criteria need them; `GET /api/bootstrap` is complete in US-02 (books and `currently_reading`), so US-04 only verifies it. |
| D70 | Active (US-08) | The reader's page navigation (previous, slider, next) follows the open book's reading direction, not the UI language, so it always matches the arrow keys and the side of the page that turns. The rest of the toolbar mirrors with the UI. |
| D71 | Active (US-08) | The reader `<Canvas>` is memoized against store updates that do not change the scene (bookmark saves, toolbar state): React Three Fiber invalidates its root whenever `<Canvas>` renders, which broke the zero-idle-frames rule. |
| D72 | Active (US-08) | The demo library has no tables, so the US-08 browser check zooms into body text of a scanned demo book instead. The reader fits the book between the top bar and the toolbar (72 px and 92 px kept clear) so the toolbar never covers a page. |
| D73 | Active (US-09, tunable values) | Hall composition tuned from the renders: spawn `(0, 1.62, 0.7)` looking at `(0, 1.0, 6.5)`, desk at `z = 4.6`, medallion at `z = 3.0`, a basilica section (6 m nave, 3.4 m side aisles with plaster partitions between bays), skylights every 3.4 m from `z = 2.9`. Written back to `docs/ARCHITECTURE.md` §9.4. |
| D74 | Active (US-09) | three.js 0.186 removed `PCFSoftShadowMap` (it falls back to `PCFShadowMap` with a warning), so the high preset uses `PCFShadowMap` with a wider `shadow.radius` and a 2048² map. |
| D75 | Active (US-09) | The hall's textures are generated procedurally by `scripts/generate_textures.py` (Pillow + NumPy from the backend venv) and committed as small WebP files with a CC0 `LICENSES.md`; no texture source has to be reachable. |
| D76 | Active (US-10) | `CategoryColumn` renders each plaque assembly (brass arm, rods, blade and the two canvas faces, about 5 small draw calls); the columns' limestone stays merged into the hall's geometry so 20 categories do not cost 20 extra draw calls. Plaque canvases are 768 x 588 (both faces), about 2.4 MB each with mipmaps. |
| D77 | Active (US-10) | Book placement (§9.2-9.3 sizes, slot packing, tiers) is pure code in `hallLayout.ts` with unit tests. In US-10 each bookcase's books are one instanced mesh of plain cloth-coloured volumes; US-11 turns them into labelled spines with hover and present. |
