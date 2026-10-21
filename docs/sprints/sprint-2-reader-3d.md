# Sprint 2 — 3D Curved Book Reader & Adaptive Performance

**Sprint goal:** build and verify the standalone 3D curved page-flipping reader before
building the surrounding 3D hall.

**Read first:** `AGENTS.md`, `docs/DESIGN.md`, then `docs/ARCHITECTURE.md` §1 (topology),
§2.2 (frontend versions), §10 (3D performance rules), §11 (reader), §13 (i18n) and §14
(testing).

**Rules for this sprint**
- Packages exactly as pinned in `docs/ARCHITECTURE.md` §2.2; `package-lock.json` committed.
- `<Canvas frameloop="demand">`; `invalidate()` only while something moves.
- The hall does not exist yet. The reader is developed and tested on the dev route
  `/dev/reader?book={id}` against the seeded demo library.
- **Running the app before US-16:** `./scripts/e2e-server.sh --port 8000 --data-dir /tmp/dar-demo`
  seeds a demo library (first run) and serves API + static frontend on
  `http://127.0.0.1:8000`. Rebuild the frontend first with `cd frontend && npm run build`.
- Every frontend story produces screenshots (and a video for motion) under
  `frontend/e2e/screenshots/us-XX/`. Claude reviews them before marking the story done and
  sends them to the user at review.

---

## US-05 — Next.js Scaffold, Offline Fonts, Zustand Store, API Client & i18n Skeleton

**Use case:** foundation for every UI story.

**Files (scope):**
- `frontend/package.json` (scripts: `dev` = `next dev -H 127.0.0.1 -p 3000`, `build`,
  `typecheck` = `tsc --noEmit`, `test:unit` = `vitest run`, `test:e2e` = `playwright test`),
  `frontend/package-lock.json`
- `frontend/next.config.ts` (`output: 'export'`, `images.unoptimized: true`),
  `frontend/tsconfig.json`, `frontend/postcss.config.mjs`, `frontend/vitest.config.ts`,
  `frontend/playwright.config.ts`
- `frontend/public/fonts/` (Cairo and Inter variable `.woff2` + `OFL.txt` licence files)
- `frontend/src/app/layout.tsx`, `frontend/src/app/page.tsx`, `frontend/src/app/globals.css`,
  `frontend/src/app/fonts.ts`
- `frontend/src/store/useLibraryStore.ts`, `frontend/src/lib/api.ts`,
  `frontend/src/lib/i18n.ts`, `frontend/src/lib/i18n.test.ts`, `frontend/src/lib/testApi.ts`
- `frontend/e2e/us-05.spec.ts`
- `scripts/e2e-server.sh`, `scripts/setup.sh` (`--frontend` support)
- `backend/app/main.py` (mount `frontend/out/` at `/` when it exists, with `index.html`
  fallback for non-`/api` paths)

**Acceptance criteria:**
- **Given** the app is built and served offline, **When** the page loads and
  `fetchBootstrap()` runs, **Then** local Cairo and Inter fonts load (`document.fonts.check`
  is true for both) with **zero external network requests** (Playwright records every request;
  all hosts are `127.0.0.1`).
- Fonts are loaded with `next/font/local` from `public/fonts/`; no Google Fonts or CDN URLs
  exist anywhere in the source.
- Zustand stores `categories`, `books`, `currentlyReading` (top 3), `settings`, and reader
  state (`activeBookId`, `spreadIndex`, `zoom`, `flipLocked`).
- `api.ts` provides typed functions for every endpoint in `docs/ARCHITECTURE.md` §6.3, sends
  `X-Dar-Client: 1` on mutating requests, uses `NEXT_PUBLIC_API_BASE` or same origin, maps
  error `code` values to typed errors, and uploads with progress events (XMLHttpRequest).
- `i18n.ts` has English and Arabic dictionaries (skeleton keys for strings used so far),
  `t(key, vars)`, Arabic plural forms through `Intl.PluralRules`, Western digits, and
  `applyLanguage()` setting `<html lang dir>`. Unit tests cover plural selection for
  `ar` counts 0, 1, 2, 3, 11, 100.
- `globals.css` defines the design tokens from `docs/DESIGN.md` (colours, radii, spacing,
  motion) as CSS variables and Tailwind theme values.
- The home page shows a placeholder with the app name in both scripts and the API status
  (connected / not connected).
- `testApi.ts` exposes `window.__DAR__` only when the URL contains `?test=1`.
- `scripts/e2e-server.sh [--port N] [--data-dir PATH]` seeds a demo library with
  `backend/scripts/seed_demo.py` (when the directory is empty) and serves it with Uvicorn on
  `127.0.0.1`; the Playwright `webServer` uses it on port 8765.
- `playwright.config.ts` uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when set, viewport 1440 × 900.

**Verification command:**
```bash
./scripts/setup.sh --frontend && cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-05
```

**Visual evidence:** `us-05/home-en.png`, `us-05/home-ar.png` (with `ui_language` = `ar`).

**Browser check (physical machine):** open `http://127.0.0.1:8000`; the placeholder shows
"Dar al Ilm" and "دار العلم" in the correct fonts; DevTools → Network shows only
`127.0.0.1` requests.

---

## US-06 — 3D Curved Book Mesh & LTR / RTL Page-Turn Animation

**Use case:** UC-04 (reading and flipping).

**Files (scope):**
- `frontend/src/components/3d/CurvedBookReader.tsx`, `frontend/src/components/3d/pageCurl.ts`
- `frontend/src/lib/spreads.ts`, `frontend/src/lib/spreads.test.ts`
- `frontend/src/app/dev/reader/page.tsx` (dev harness: its own `<Canvas frameloop="demand">`)
- `frontend/src/lib/testApi.ts` (reader helpers)
- `frontend/e2e/us-06.spec.ts`

**Acceptance criteria:**
- **Given** an open book in `<Canvas frameloop="demand">`, **When** the user clicks a page's
  outer half or presses the arrow key, **Then** the subdivided page mesh curls and turns
  left-to-right for LTR or right-to-left for RTL books in 550 ms (`easeInOutCubic`).
- The spread model follows `docs/ARCHITECTURE.md` §11.1 (page 1 alone on the right for LTR,
  on the left for RTL); unit tests cover spreads for page counts 1, 2, 3, 10 and 11 in both
  directions, and the page-to-spread mapping used by `last_read_page`.
- Arrow keys follow the physical side (§11.2): LTR `ArrowRight` = next; RTL `ArrowLeft` = next.
  `Space` = next, `Shift+Space` = previous.
- Dragging a page corner makes the page follow the pointer; release past 50 % or with a flick
  completes the turn, otherwise it falls back.
- Rapid key presses queue flips at 280 ms intervals.
- The page mesh uses the book's page aspect (`page_width_pt / page_height_pt`). Page images use
  `quality=high` in this story (progressive loading arrives in US-07).
- Book look per `docs/DESIGN.md` (paper colour, gutter shading, cover boards, ink backdrop).
- `invalidate()` runs only during flips and drags: the e2e test asserts the frame counter does
  not change for 2 s after a flip completes.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-06
```

**Visual evidence:** `us-06/ltr-spread.png`, `us-06/rtl-spread.png`, `us-06/mid-flip.png`,
`us-06/flip.webm` (video of 3 flips in each direction).

**Browser check (physical machine):** open `http://127.0.0.1:8000/dev/reader?book=1` (an
English demo book) and `?book=<id of an Arabic demo book>`. Flip with arrows, clicks and
corner drags: the page curls smoothly, RTL books turn the other way, the F2 overlay shows
~60 FPS during flips and the frame counter stops when idle.

---

## US-07 — Progressive Blur-to-Sharp LoD Streaming & 3-Spread Memory Disposal

**Use case:** UC-04 (smooth reading of large scanned books).

**Files (scope):**
- `frontend/src/components/3d/CurvedBookReader.tsx`
- `frontend/src/lib/texturePool.ts`, `frontend/src/lib/texturePool.test.ts`
- `frontend/src/lib/testApi.ts` (texture counters)
- `frontend/e2e/us-07.spec.ts`

**Acceptance criteria:**
- **Given** a page flip starts, **When** the page is in motion, **Then** it displays the
  `quality=low` (768 px) texture and, once settled, cross-fades to `quality=high` (2048 px) in
  150 ms.
- Images are decoded with `createImageBitmap(blob, { imageOrientation: 'flipY' })`, textures use
  `flipY = false`, `SRGBColorSpace`, mipmaps and the preset's anisotropy.
- GPU textures exist only for the previous, current and next spreads (≤ 6 pages). Any spread more
  than 1 turn away calls `texture.dispose()` and `imageBitmap.close()`.
- Decoded `low` bitmaps for the next 3 spreads in reading direction are prefetched in RAM.
- If no image is ready, the page shows a paper-coloured placeholder with faint lines, never a
  spinner.
- Unit tests cover the pool: window computation, reference counting, disposal on window moves,
  no double dispose.
- **Memory check (replaces the manual DevTools step):** the e2e test reads
  `renderer.info.memory.textures` through `window.__DAR__`, flips 30 pages, and asserts the
  count returns to ≤ baseline + 6 and that the pool's live page-texture count never exceeds 6.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-07
```

**Visual evidence:** `us-07/low-in-motion.png`, `us-07/high-settled.png`,
`us-07/texture-counts.txt` (counts after every 5 flips).

**Browser check (physical machine):** open a scanned demo book in `/dev/reader`, hold
`ArrowRight` for 50+ pages: no stutter, pages appear soft while moving and sharpen when
stopped; DevTools → Memory stays flat; F2 shows the texture count staying small.

---

## US-08 — Single-Page Cursor Zoom, Pan Lock, Jump-to-Page & Auto-Bookmark

**Use case:** UC-04 (inspecting tables, jumping, resuming).

**Files (scope):**
- `frontend/src/components/ui/ReaderToolbar.tsx`, `frontend/src/components/ui/ZoomOverlay.tsx`
- `frontend/src/components/3d/CurvedBookReader.tsx`
- `frontend/src/lib/bookmark.ts`, `frontend/src/lib/i18n.ts` (toolbar strings)
- `frontend/e2e/us-08.spec.ts`

**Acceptance criteria:**
- **Given** an open page, **When** the user scrolls the mouse wheel or clicks `+`
  (100 %–400 %, 25 % steps on the toolbar), **Then** the view zooms toward the cursor using the
  `ZoomOverlay` with the `quality=zoom` (4096 px) image, aligned exactly over the 3D page
  (`docs/ARCHITECTURE.md` §11.4).
- While zoom > 100 %, page flipping is locked and click-drag pans (clamped to the page edges).
- `Esc` or `100%` resets zoom and unlocks flipping; `Esc` at 100 % closes the book.
- The toolbar (per `docs/DESIGN.md`) shows previous/next, a page slider with a live page-number
  tooltip, a page input, the current pages and total (`12–13 / 340`), zoom controls and close.
  It hides after 2.5 s without mouse movement and reappears on movement.
- Jumping more than one spread plays the 3-flip riffle with `low` textures, then lands.
- Opening a book sends `mark_opened: true`. Page changes save `last_read_page` after 600 ms of
  stability; close, `pagehide` and `visibilitychange` flush immediately with `keepalive`.
- Reopening a book (also after a full page reload) resumes at the exact last-read spread.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-08
```
(This replaces v1.1's undefined "Validation Test 2".)

**Visual evidence:** `us-08/zoom-200.png`, `us-08/zoom-400-panned.png`, `us-08/toolbar-en.png`,
`us-08/toolbar-ar.png`, `us-08/zoom.webm`.

**Browser check (physical machine):** open a scanned demo book with a table; wheel-zoom into
the table: text is crisp at 400 %, arrows do nothing while zoomed, dragging pans, `Esc` resets.
Jump to page 200 with the slider, close with `Esc`, reload the page, reopen: it resumes at
page 200.
