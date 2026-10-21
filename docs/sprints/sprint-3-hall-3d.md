# Sprint 3 — 3D Library Hall, Plaques, Spine-Out Shelves & Search Flight

**Sprint goal:** build the walkable 3D public library hall, the Arabic/English column plaques,
spine-out books, the search flight, and the Currently Reading entrance desk.

**Read first:** `AGENTS.md`, `docs/DESIGN.md` (hall, lighting, materials), then
`docs/ARCHITECTURE.md` §9 (shelving and hall layout), §10 (3D performance rules), §11.6
(hall ↔ reader transition), §12 (search) and §14 (testing).

**Rules for this sprint**
- One camera owner: `PlayerControls.tsx`. drei `CameraControls` and pointer lock are not used.
- No drei `<Environment preset>` (CDN download). Lighting from `<Lightformer>`s and local files.
- Budgets from `docs/ARCHITECTURE.md` §10.4 are checked in e2e through `renderer.info`.
- Layout values marked *(tunable)* in `docs/ARCHITECTURE.md` §9 may be adjusted for the look;
  any change is written back to that file in the same commit.
- Running the app and visual evidence: as in Sprint 2.

---

## US-09 — 3D Architectural Hall, Arrow-Key Walking, Collision, Home Reset & Adaptive Quality

**Use case:** UC-03 (browsing by walking).

**Files (scope):**
- `frontend/src/components/3d/LibraryCanvas.tsx`, `frontend/src/components/3d/HallRoom.tsx`,
  `frontend/src/components/3d/PlayerControls.tsx`
- `frontend/src/lib/hallLayout.ts`, `frontend/src/lib/hallLayout.test.ts`
- `frontend/src/hooks/useAdaptiveQuality.ts`
- `frontend/src/components/ui/DebugHud.tsx`
- `frontend/src/app/page.tsx` (mount the hall), `frontend/src/lib/testApi.ts` (camera pose,
  frame counter, renderer info)
- `frontend/public/textures/` (local CC0 material textures, ≤ 1K, with a `LICENSES.md`; if a
  texture source is unreachable from the build environment, generate the texture procedurally
  instead — never hotlink)
- `frontend/e2e/us-09.spec.ts`

**Acceptance criteria:**
- **Given** the user is in the 3D hall, **When** pressing Arrow keys / WASD or dragging the
  mouse on empty space, **Then** the camera walks and looks per `docs/ARCHITECTURE.md` §9.5
  (speeds, acceleration, keys, drag-to-look without pointer lock, pitch clamp).
- `hallLayout.ts` computes the hall from categories and books (§9.3–§9.4): bays, bookcase
  positions, columns, desk, hall size and the collision boxes. Unit tests cover 0, 1, 2, 5
  categories and a category with 2,000 books.
- Collision: the player circle (radius 0.30 m) never enters a collision box and slides along
  walls; the e2e test walks into a bookcase and a wall for 3 s and asserts the camera stays
  outside every box.
- `Home` flies back to the Entrance Desk pose in ≤ 0.8 s (< 1 s, FR-02).
- The hall architecture, lighting and materials follow `docs/DESIGN.md` (entrance arch, nave,
  columns, mashrabiya light pattern on the floor, desk, pendants, tone mapping, exposure from
  `ambient_light`).
- With 0 categories the hall renders the entrance zone, the desk and one softly lit empty bay
  outline without errors.
- `frameloop="demand"`: the frame counter does not change during 2 s without input after
  walking stops (0 % GPU when keys are released).
- `useAdaptiveQuality` follows §10.2 (samples only during motion, ignores gaps > 100 ms, rolling
  median, hysteresis, max 3 changes, persisted level). drei `<PerformanceMonitor>` is not used.
  Presets apply §10.3 (Canvas remount on preset change).
- `F2` toggles `DebugHud` (FPS during motion, frame ms, draw calls, triangles, textures,
  geometries, dpr, level, preset).
- Draw calls < 150 and triangles < 300 k in the seeded demo hall (asserted via
  `renderer.info`).

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-09
```

**Visual evidence:** `us-09/entrance.png`, `us-09/nave.png`, `us-09/empty-hall.png`,
`us-09/debug-hud.png`, `us-09/walk.webm`.

**Browser check (physical machine):** open `http://127.0.0.1:8000`, walk the nave with arrows
and WASD, drag to look, walk into shelves (you slide, never pass through), press `Home`.
F2 shows ~60 FPS while walking; stop moving and the frame counter freezes (0 % GPU). Try the
three graphics presets once Settings exist (US-14).

---

## US-10 — Columns, Hanging CanvasTexture Plaques & Auto-Expanding Shelves

**Use case:** UC-01 (category plaques), FR-04, FR-05.

**Files (scope):**
- `frontend/src/lib/canvasText.ts`
- `frontend/src/components/3d/CategoryColumn.tsx`, `frontend/src/components/3d/Bookcase.tsx`
- `frontend/src/components/3d/HallRoom.tsx` (compose columns and bookcases)
- `frontend/e2e/us-10.spec.ts`

**Acceptance criteria:**
- **Given** user categories in English, French and Arabic, **When** columns render, **Then**
  `canvasText.ts` draws each category plaque onto a 2D `<canvas>` (`ctx.direction = 'rtl'` for
  Arabic) as a `THREE.CanvasTexture`, after `document.fonts.load()` resolves for the fonts used
  (`docs/ARCHITECTURE.md` §10.7).
- Plaques follow `docs/DESIGN.md`: brushed brass blade signs, double-sided (each face drawn
  separately so both read correctly), sentence-case names, Arabic in Cairo with no letter
  spacing, Latin in Inter; long names shrink to fit (min 60 %) then truncate with an ellipsis.
- Bookcases and shelf tiers are created from `shelf_number` per §9.3: shelf `n` → bookcase
  `n // 5`, tier `[3, 2, 4, 1, 0][n % 5]`. A category with `shelf_number > 0` books shows the
  extra tiers/bookcases; a category with 31 books shows its 31st book on shelf 1 slot 0 without
  overlapping geometry.
- An empty category shows one bookcase, its plaque and a ghost "Add book" slot; clicking it
  calls the store action `openAddBook(categoryId)` (the modal arrives in US-13).
- Renaming a category in the store redraws its plaque texture and disposes the old one.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-10
```

**Visual evidence:** close-ups `us-10/plaque-programming.png`, `us-10/plaque-histoire.png`,
`us-10/plaque-arabic.png` (both faces), `us-10/bay-31-books.png`, `us-10/empty-category.png`.
Claude checks that Arabic letters are connected and correctly ordered on both faces.

**Browser check (physical machine):** walk to each bay; plaques are readable from the nave,
Arabic plaques read right-to-left with joined letters on both sides of the blade.

---

## US-11 — Page-Count Scaled Spines, Hover & Present, Entrance Desk (Top 3)

**Use case:** UC-03 (inspecting books), FR-08, FR-09, FR-11.

**Files (scope):**
- `frontend/src/components/3d/BookSpine.tsx` (instanced books per bookcase),
  `frontend/src/lib/spineAtlas.ts`
- `frontend/src/components/3d/BookPresenter.tsx`, `frontend/src/components/3d/EntranceDesk.tsx`
- `frontend/src/components/3d/Bookcase.tsx`, `frontend/src/components/3d/HallRoom.tsx`
- `frontend/e2e/us-11.spec.ts`

**Acceptance criteria:**
- **Given** books on a shelf, **When** rendered, **Then** spine thickness, height and depth follow
  `docs/ARCHITECTURE.md` §9.2 (a 600-page book is visibly thicker than a 60-page book), books are
  packed in slot order with a brass bookend after the last one, and spine colours come from
  `spine_color` (desaturated 15 %).
- Each bookcase's books render as one `InstancedMesh` (one draw call) with spine labels from
  single-channel atlases; atlases build only for bays within 18 m and dispose beyond 25 m, up
  to the preset's resident limit (§10.5).
- **Hover (stage 1):** the hovered book slides out 5 cm in 180 ms with a warm rim highlight and a
  title tooltip; moving away retracts it in 220 ms. Walking never triggers presentation.
- **Present (stage 2):** clicking a book lifts it out and turns its cover toward the camera at
  arm's length in 450 ms, loading the cover texture, with **Open**, **Edit** and **Delete**
  buttons (drei `<Html>`, styled per `docs/DESIGN.md`). `Esc` or clicking elsewhere returns it.
  Open/Edit/Delete call store actions (`openBook`, `openEditBook`, `openDeleteBook`).
- **Entrance Desk:** displays the top 3 `currently_reading` books, ordered 1st (latest), 2nd and
  3rd from the UI's start side, each standing on a stand with its cover visible. Empty stands
  show an embossed 1, 2 or 3; with zero books the desk shows the empty-state line from
  `docs/DESIGN.md`. Clicking a desk book presents it.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run build && npm run test:e2e -- us-11
```

**Visual evidence:** `us-11/shelf-thickness.png` (60 vs 600 pages side by side),
`us-11/hover.png`, `us-11/present.png`, `us-11/desk-3.png`, `us-11/desk-empty.png`,
`us-11/hover-present.webm`.

**Browser check (physical machine):** hover along a shelf: books slide out smoothly one at a
time; click one: it turns to show its cover with Open / Edit / Delete; the desk shows your 3
most recent books in order.

---

## US-12 — Search Bar Camera Flight & Seamless Hall-to-Reader Transition

**Use case:** UC-03 (search) and UC-04 (open and close), FR-03, FR-11, FR-15.

**Files (scope):**
- `frontend/src/components/ui/TopBarSearch.tsx`
- `frontend/src/lib/search.ts`, `frontend/src/lib/search.test.ts`
- `frontend/src/lib/flightPath.ts`, `frontend/src/lib/flightPath.test.ts`
- `frontend/src/components/3d/LibraryCanvas.tsx`, `frontend/src/components/3d/PlayerControls.tsx`,
  `frontend/src/components/3d/CurvedBookReader.tsx` (mounted inside the hall canvas)
- `frontend/src/app/page.tsx`, `frontend/src/lib/i18n.ts` (search strings)
- `frontend/e2e/us-12.spec.ts`

**Acceptance criteria:**
- **Given** the user presses `/` or clicks the search field and types, **Then** results filter in
  real time by title, author and category using the normalization and ranking in
  `docs/ARCHITECTURE.md` §12 (unit tests: `ابن` matches `إبن`, `histoire` matches `Histoire`,
  `ecole` matches `École`, tashkeel is ignored), showing up to 8 results with cover thumbnail,
  title, author and category; no results shows the empty state from `docs/DESIGN.md`.
- **When** a result is chosen (click or `Enter`), **Then** the camera flies along the aisle path
  (§9.6) and arrives facing the book within 1.5 s (FR-03), and the book is highlighted (gilt rim
  pulse) for 3 s. Search + flight completes in < 2.0 s (G3). Unit tests check that every
  waypoint is outside collision boxes.
- With `prefers-reduced-motion`, the flight becomes a 300 ms fade cut.
- Clicking **Open** enters `CurvedBookReader` inside the same canvas with the 700 ms open
  transition (§11.6); the hall stays mounted but hidden.
- Closing returns the book to its shelf slot with the reverse transition, saves the bookmark, and
  the Entrance Desk shows it in position #1.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-12
```

**Visual evidence:** `us-12/search-results-en.png`, `us-12/search-results-ar.png`,
`us-12/arrived-highlight.png`, `us-12/flight.webm`, `us-12/open-close.webm`.

**Browser check (physical machine):** press `/`, type part of an Arabic title without diacritics,
press Enter: the camera glides down the aisle (never through shelves) and stops facing the
glowing book. Open it, read, close: the book flies back to its shelf and sits first on the desk.
