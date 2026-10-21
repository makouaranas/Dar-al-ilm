# PROGRESS.md — Live Scrum Checklist

Spec version: v1.2 (Spec Review Edition), approved October 21, 2026.
Status: specs committed. **Next story: US-01**, waiting for the user's "go".

Protocol: `AGENTS.md` §2. One story per iteration; mark `[x]` only after its verification
command passes, then add a log row.

## Sprint 1 — Python Backend, SQLite Catalog & PyMuPDF Streaming Engine
File: `docs/sprints/sprint-1-backend.md`
- [ ] US-01 — Workspace Init, SQLite WAL Database & Models
- [ ] US-02 — Category & Settings CRUD Endpoints (+ Bootstrap)
- [ ] US-03 — Managed PDF Upload, Page Count, Page 1 Cover & Auto-Shelf Math
- [ ] US-04 — LoD Page Streaming (low/high/zoom), Cache & Book Edit/Delete

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
