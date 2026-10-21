# PROGRESS.md — Live Scrum Checklist

Spec version: v1.2 (Spec Review Edition), approved October 21, 2026.
Status: Sprint 1 in progress. Sprint 1 complete. **Next story: US-05** (first frontend story), waiting for the user's "go".

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
- [ ] US-05 — Next.js Scaffold, Offline Fonts, Zustand Store, API Client & i18n Skeleton
- [ ] US-06 — 3D Curved Book Mesh & LTR / RTL Page-Turn Animation
- [ ] US-07 — Progressive Blur-to-Sharp LoD Streaming & 3-Spread Memory Disposal
- [ ] US-08 — Single-Page Cursor Zoom, Pan Lock, Jump-to-Page & Auto-Bookmark

## Sprint 3 — 3D Library Hall, Plaques, Spine-Out Shelves & Search Flight
File: `docs/sprints/sprint-3-hall-3d.md`
- [ ] US-09 — 3D Architectural Hall, Arrow-Key Walking, Collision, Home Reset & Adaptive Quality
- [ ] US-10 — Columns, Hanging CanvasTexture Plaques & Auto-Expanding Shelves
- [ ] US-11 — Page-Count Scaled Spines, Hover & Present, Entrance Desk (Top 3)
- [ ] US-12 — Search Bar Camera Flight & Seamless Hall-to-Reader Transition

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
