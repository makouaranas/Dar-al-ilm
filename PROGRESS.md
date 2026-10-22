# PROGRESS.md — Live Scrum Checklist

Spec version: v1.2 (Spec Review Edition), approved October 21, 2026.
Status: Sprint 1 done. Sprint 2 done. Sprint 3 done. Sprint 4 in progress. **Next story: US-13** (user asked to continue through the backlog).

Protocol: `AGENTS.md` §2. One story per iteration; mark `[x]` only after its verification
command passes, then add a log row.

## Sprint 1 — Python Backend, SQLite Catalog & PyMuPDF Streaming Engine
File: `docs/sprints/sprint-1-backend.md`
- [x] US-01 — Workspace Init, SQLite WAL Database & Models
- [x] US-02 — Category & Settings CRUD Endpoints (+ Bootstrap)
- [x] US-03 — Managed PDF Upload, Page Count, Page 1 Cover & Auto-Shelf Math
- [x] US-04 — LoD Page Streaming (low/high/zoom), Cache & Book Edit/Delete

## Sprint 2 — 3D Curved Book Reader & Adaptive Performance
File: `docs/sprints/sprint-2-reader-3d.md`
- [x] US-05 — Next.js Scaffold, Offline Fonts, Zustand Store, API Client & i18n Skeleton
- [x] US-06 — 3D Curved Book Mesh & LTR / RTL Page-Turn Animation
- [x] US-07 — Progressive Blur-to-Sharp LoD Streaming & 3-Spread Memory Disposal
- [x] US-08 — Single-Page Cursor Zoom, Pan Lock, Jump-to-Page & Auto-Bookmark

## Sprint 3 — 3D Library Hall, Plaques, Spine-Out Shelves & Search Flight
File: `docs/sprints/sprint-3-hall-3d.md`
- [x] US-09 — 3D Architectural Hall, Arrow-Key Walking, Collision, Home Reset & Adaptive Quality
- [x] US-10 — Columns, Hanging CanvasTexture Plaques & Auto-Expanding Shelves
- [x] US-11 — Page-Count Scaled Spines, Hover & Present, Entrance Desk (Top 3)
- [x] US-12 — Search Bar Camera Flight & Seamless Hall-to-Reader Transition

## Sprint 4 — Bilingual UI (EN/AR), Modals, Diagnostics & Launcher
File: `docs/sprints/sprint-4-ui-launch.md`
- [ ] US-13 — Add Book Modal (Required LTR/RTL, Page 1 Cover Default) & Edit/Delete Modals
- [ ] US-14 — Settings Modal, Categories, Graphics Preset, Ambient Light & English/Arabic UI Switcher
- [ ] US-15 — WebGL Hardware Acceleration Check & API Connection Badge
- [ ] US-16 — One-Click Launcher (`start.sh`) & End-to-End Smoke Test

## Log

| Date | Story | Commit | Verification | Notes |
|---|---|---|---|---|
| 2026-10-21 | Spec v1.2 | (spec commit) | n/a (documents only) | Specs created from Requirements Report v1.1 plus the agreed review fixes (D32–D63). |
| 2026-10-21 | US-01 | (US-01 commit) | `pytest tests/test_api.py -k test_health_and_db`: 37 passed (also clean with `-W error`); real Uvicorn smoke test passed | `/docs` and `/redoc` disabled because they load Swagger UI/ReDoc from a CDN (spec issue raised). |
| 2026-10-21 | US-02 | (US-02 commit) | `pytest tests/test_api.py -k test_categories_and_settings`: 28 passed; full suite 65 passed (also with `-W error`) | Scope per D66: `shelving.py` and `schemas.py` created here; bootstrap complete (books, desk order). |
| 2026-10-21 | US-03 | (US-03 commit) | `pytest tests/test_api.py -k test_book_upload_and_shelf_overflow`: 35 passed; full suite 100 passed (also with `-W error`); 400-page scanned import 100 ms server-side | Truncated PDFs are repaired by MuPDF and accepted; only unrecoverable files are `pdf_damaged`. `Server-Timing` header reports import time. |
| 2026-10-21 | US-04 | (US-04 commit) | `pytest tests/test_api.py -k "test_page_streaming or test_book_edit_and_delete or test_startup_reconcile"`: 25 passed; full suite 125 passed (also with `-W error`); `test_perf.py`: all medians within targets (zoom max 665 ms) | `seed_demo.py` seeds 40 EN/FR/AR books in about 28 s. All in-process PyMuPDF use now holds one lock (also fixes concurrent uploads from US-03). |
| 2026-10-22 | US-05 | (US-05 commit) | `./scripts/setup.sh --frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-05`: unit 15 passed, e2e 4 passed; backend 126 passed | Fonts subset from Google Fonts sources (Cairo 61 KB, Inter 200 KB). Inter-first font stack in both languages. `next-env.d.ts` git-ignored (it imports build output). Backend tests run without the static frontend mount. |
| 2026-10-22 | US-06 | (US-06 commit) | typecheck; unit 37 passed; build; e2e us-06 7 passed (LTR/RTL keys, click, drag and fall-back, queued turns, zero idle frames, frame sequences) | Curl on the CPU (D67); motion evidence as frame sequences because cloud ffmpeg is too old for Playwright video (D68); TS incremental off (D69). |
| 2026-10-22 | US-07 | (US-07 commit) | typecheck; unit 45 passed; build; e2e us-07 4 passed + us-06 7 passed | The memory test caught a texture leak (disposing a bound texture made three.js re-upload it); fixed with deferred disposal. Textures stay flat at 4 over 30 pages. |
| 2026-10-22 | US-08 | (US-08 commit) | typecheck; unit 50 passed; build; e2e us-08 7 passed; full e2e 22 passed (us-05..us-08) | Zoom overlay (wheel toward cursor, 25 % toolbar steps, clamped pan, flip lock, Esc), toolbar with slider tooltip, page input riffle, auto-hide; debounced bookmark with keepalive flush; book fitted above the toolbar (D72); page navigation follows the book's direction (D70); canvas memoized to keep zero idle frames (D71). Outside the listed scope: the store (page rects, `upsertBook`), the dev reader page (close/reopen), and us-06/us-07 specs (bookmark reset, coordinates from page rects). |
| 2026-10-22 | US-09 | (US-09 commit) | typecheck; unit 73 passed (hallLayout 14, adaptive quality 9); build; e2e us-09 10 passed; us-05 4 passed | Hall with basilica section, star light map, medallion, desk, niche; walking/turning/drag-look, collision with sliding, Home flight (0.8 s, clear route), reduced-motion cut; useAdaptiveQuality; F2 HUD; ~20 draw calls, ~6.8k triangles. Textures generated procedurally (D75). Spawn/desk tuned (D73); PCFSoft removed in three 0.186 (D74). FPS not measurable here (SwiftShader ~2-3 FPS). Outside the listed scope: `i18n.ts` (key hint strings), `scripts/generate_textures.py`, `useAdaptiveQuality.test.ts`. |
| 2026-10-22 | US-10 | (US-10 commit) | typecheck; unit 84 passed (canvasText 7, book placement 4 new); build; e2e us-10 5 passed + us-09 10 passed | Brushed brass blade plaques with etched interlace border and engraved names (Inter SemiBold / Cairo Bold, RTL for Arabic), drawn after `document.fonts.load()`, both faces readable; shrink to 80 %, two lines to 60 %, then ellipsis; renaming redraws and disposes. Bookcases with walnut shelf edges and mashrabiya end inserts; books instanced per bookcase from shelf/slot; ghost Add book slot calls `openAddBook`. Home flight check made frame-exact. Outside the listed scope: store (`upsertCategory`, `openAddBook`), `i18n.ts`, `hallLayout.ts` (book placement), `page.tsx` (canvas fonts), `PlayerControls.tsx` (flight frame log), `canvasText.test.ts`. |
| 2026-10-22 | US-11 | (US-11 commit) | typecheck; unit 89 passed (spineAtlas 5 new); build; e2e us-11 8 passed + us-10 5 + us-09 10 | One instanced mesh per bookcase with a patched MeshStandardMaterial (face kinds: cloth spine/covers, paper edges, boards framing the top), gilt/ink labels from an R8 texture-array atlas built within 18 m and released beyond 25 m (nearest first, 8 layers on auto), 200 ms label fade; hover slide 5 cm with gilt rim and tooltip (critically damped); present with cover, Open/Edit/Delete panel, Esc/click-away; brass bookends; desk with the 3 latest books (start side by UI language), embossed 1-2-3 and the empty-state line. Outside the listed scope: store (presentation and modal requests), `i18n.ts`, `CategoryColumn.tsx` (brass merged into the hall), `LibraryCanvas.tsx` (controls paused while presenting). |
| 2026-10-22 | US-12 | (US-12 commit) | typecheck; unit 101 passed (search 5, flight path 7 new); build; full e2e 50 of 51 passed, the one failure (Home yaw read -180° instead of 180° from a negative zero) fixed and us-09 + us-12 re-run: 16 passed | Accent- and diacritic-insensitive search (NFKC, Arabic alef/yaa/taa marbuta folding, tatweel) over title, author and category with ranked results, 40 × 56 covers and the empty state; `/` focuses, arrows and Enter choose. Flights along the nave lanes on a centripetal Catmull-Rom spline, eased on arc length, 0.6–1.5 s, clear of every box; the book glows gilt, pulses twice and holds 3 s; reduced motion: 300 ms fade cut. Open from the shelf or the desk flies the book to reading distance in the same canvas while the hall dims behind an ink vignette and the cover swings open (700 ms), then the reader takes over (D80); closing reverses it, saves the bookmark and the book becomes desk #1. Outside the listed scope: store (highlight), `i18n.ts`, `EntranceDesk.tsx`, `BookPresenter.tsx`, `BookSpine.tsx` (glow), `LibraryCanvas.tsx`, `page.tsx`, `us-11.spec.ts`, new `readerTransition.ts`. FPS not measurable here (SwiftShader). |
