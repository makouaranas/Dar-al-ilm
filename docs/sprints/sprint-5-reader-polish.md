# Sprint 5 — Premium Reader: 3D Cursor Zoom, Sharp Text & Blender Book Opening

**Sprint goal:** make opening and reading a book feel current: the book itself comes closer
when zooming, text stays crisp at every size, and the opening is a crafted animation built in
Blender.

**Read first:** `AGENTS.md`, `docs/DESIGN.md` §6 (the reader), §10.2 (reader layout), §11
(motion), §15 (accessibility), then `docs/ARCHITECTURE.md` §8.2 (page qualities), §10.4
(budgets), §11.3 (textures), §11.4 (zoom) and §11.6 (hall ↔ reader transition).

**Rules for this sprint**
- Zoom is driven by the mouse wheel (and trackpad pinch) over the book; there are no zoom
  buttons. Keyboard zoom stays for accessibility (DESIGN §15).
- Blender is used offline to author assets and look-development renders only; the app ships
  plain files under `frontend/public/` and never needs Blender at runtime.

---

## US-17 — 3D Cursor Zoom, Pan and Sharp Reader Text

**Use case:** UC-04 (reading small print and tables). Replaces the 2D zoom overlay of US-08.

**Files (scope):**
- `frontend/src/components/3d/CurvedBookReader.tsx`, `frontend/src/components/3d/pageCurl.ts`
- `frontend/src/components/3d/LibraryCanvas.tsx` (reader pixel ratio)
- `frontend/src/components/ui/ReaderToolbar.tsx`; `frontend/src/components/ui/ZoomOverlay.tsx`
  (removed)
- `frontend/src/lib/bookZoom.ts` (+ test), `frontend/src/lib/texturePool.ts` (+ test),
  `frontend/src/lib/webglCheck.ts`, `frontend/src/lib/testApi.ts`, `frontend/src/lib/i18n.ts`
- `frontend/e2e/us-08.spec.ts`
- `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/REQUIREMENTS.md`, `PROGRESS.md`

**Acceptance criteria:**
- **Given** an open book, **When** the user scrolls the mouse wheel over it, **Then** the 3D
  book grows toward the reader (100 %–400 %) about the point under the cursor: that point stays
  under the cursor. No flat overlay is drawn; both pages of the spread zoom together.
- Zooming eases (time constant 70 ms); a trackpad pinch zooms the same way.
- While zoomed, the visible pages switch to their `zoom` (4096 px) images with a 150 ms
  cross-fade; the images are released when the zoom returns to 100 %.
- While zoomed, dragging pans the book (it follows the hand). The book never uncovers more of
  the screen than it covered at 100 %.
- Page turning is locked while zoomed. `Esc` returns to 100 % (the book is centred again);
  `Esc` at 100 % closes the book.
- The toolbar has no zoom buttons. While zoomed it shows the zoom level (`200%`); clicking it
  returns to 100 %. Keyboard: `+` and `-` zoom by 25 % around the middle of the view, `0`
  resets.
- Text is crisper at 100 %: with a GPU, the open book renders at the screen's full pixel ratio
  (1.5 on standard screens, supersampled), and the page shader samples a slightly sharper mip
  level. Software rendering and the performance preset skip the supersampling.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e
```

**Visual evidence:** `us-08/frames/zoom-*.png`, `us-08/zoom-200.png`,
`us-08/zoom-400-panned.png`.

**Browser check (physical machine):** open a scanned book; scroll the wheel over a word in the
lower right of the right page: the book comes closer and that word stays under the cursor.
Scroll to 400 %: the print is sharp. Drag to pan; arrows do nothing; `Esc` returns to 100 %.
Pinch on a trackpad zooms too. Compare the text at 100 % with the previous version.

---

## US-18 — Realistic 3D Book and Its Opening (Blender Reference)

**Use case:** UC-03 (opening a book from the shelf or the desk), UC-04 (reading).

**Files (scope):**
- `tools/lookdev/` (book scene and opening animation; look-development video for approval)
- `frontend/src/components/3d/bookModel.ts` (+ test), `frontend/src/components/3d/Hardcover.tsx`,
  `frontend/src/components/3d/pageCurl.ts` (+ test)
- `frontend/src/components/3d/CurvedBookReader.tsx` (open book body, `ClosedBook`,
  `HallReaderScene`), `frontend/src/components/3d/BookPresenter.tsx`,
  `frontend/src/components/3d/EntranceDesk.tsx`, `frontend/src/lib/testApi.ts`
- `frontend/e2e/us-06.spec.ts`, `frontend/e2e/us-08.spec.ts`, `frontend/e2e/us-12.spec.ts`
- `docs/ARCHITECTURE.md` §11.6–11.7, `docs/DESIGN.md` §5–6, `docs/REQUIREMENTS.md`, `PROGRESS.md`

**Acceptance criteria (realism, added after the user's review of the reader):**
- The open book's pages rise out of the gutter in a soft arc and settle toward the fore-edge;
  a turning leaf starts and lands exactly on that curve (unit-tested); page blocks with fine
  paper edges follow the pages down to cloth boards that overhang them; the book leans back
  like a book on a desk.
- Every closed book seen up close (presented, on the desk, flying open) has real volume: boards
  with thickness overhanging the page block, a rounded spine with gilt bands, the cover image
  on the front board, endpapers inside; the presented book is turned 15° so the volume shows.

**Acceptance criteria (opening):**
- A look-development video (Blender, Cycles) shows the opening: a hardcover with rounded spine,
  headbands, board overhang and a real paper block lifts from the shelf, turns its cover toward
  the reader and opens; the cover swings on its hinge, the first leaves follow with a slight
  delay, and the pages settle into the reading spread with crisp text. The user approves the
  motion before it is built into the app. *(Dropped at the user's request on 2026-10-22: no
  video; the scene stays in `tools/lookdev/book_open.py`. The user accepted the story on the
  in-app result.)*
- The app's opening uses the procedural hardcover, its front board swinging on the spine
  (D87: every book has its own size and thickness, so no fixed model file); cover image, cloth
  colour, size and page images come from the book at runtime.
- The opening still lasts about 700 ms (`easeInOutCubic`), reduced motion keeps the 200 ms
  cross-fade, and closing plays the motion in reverse.

**Verification command:**
```bash
cd frontend && npm run typecheck && npm run test:unit && npm run build && npm run test:e2e -- us-12
```

**Browser check (physical machine):** open a book from a shelf and from the desk: the cover
swings open, the leaves follow and the spread settles without a jump to the reader; close it:
the motion runs in reverse and the book returns to its slot.
