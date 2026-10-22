# AGENTS.md — AI Coding Agent Operational Contract

Spec version: v1.2 (Spec Review Edition), October 21, 2026.

## 1. Project Overview & General 3D Architecture Rules
- **App:** Dar al Ilm (دار العلم), a 3D Personal Digital Library: single-user, 100 % offline,
  cross-platform storage via Python `pathlib`. Next.js + React Three Fiber frontend, FastAPI +
  PyMuPDF + SQLite backend, all on `127.0.0.1`.
- **Source of truth:** `docs/ARCHITECTURE.md` (versions, data model, API, layout, performance,
  testing), `docs/DESIGN.md` (look and feel, copy), `docs/REQUIREMENTS.md` (goals, FR/NFR,
  decisions), `docs/sprints/` (stories), `PROGRESS.md` (status).
- **Mandatory 3D Performance & Text Rules:**
  1. Use `<Canvas frameloop="demand">` with the custom `useAdaptiveQuality` hook
     (`docs/ARCHITECTURE.md` §10.2) so the app runs at 60 FPS on integrated and dedicated GPUs
     while rendering zero frames when stationary. Call `invalidate()` only during active motion.
     Do not use drei `<PerformanceMonitor>` (it misreads idle gaps as low FPS).
  2. Never use 3D font geometry (`Text3D` / `troika-three-text`) for plaques or spines. Always
     use HTML5 2D `<canvas>` wrapped in `THREE.CanvasTexture`, drawn only after
     `document.fonts.load()` resolves, so Arabic (RTL), French and English (LTR) shape
     accurately offline. Never letter-space Arabic.
  3. Dispose Three.js page textures (`texture.dispose()`) outside the active 3-spread window
     (`prev`, `current`, `next`).
  4. One camera owner: `PlayerControls`. No drei `CameraControls`, no pointer lock.
  5. No network assets: no drei `<Environment preset>` (downloads HDRs), no CDN fonts, icons,
     textures or HDRs. Use `<Lightformer>`s and files committed under `frontend/public/`.
  6. Respect the budgets in `docs/ARCHITECTURE.md` §10.4 (draw calls, triangles, GPU memory).
  7. No looping idle animation in the 3D scene.

## 2. Scrum Execution Protocol (STRICT: ONE STORY PER ITERATION)
- **Never implement multiple User Stories in one turn.** Start a story only when the user says go.
- For each iteration:
  1. Read `PROGRESS.md` to find the next unchecked story (`[ ] US-##`).
  2. Read ONLY the corresponding sprint file in `docs/sprints/` plus the `docs/ARCHITECTURE.md`
     and `docs/DESIGN.md` sections it names.
  3. Modify ONLY the files listed under that story's scope. If another file must change, stop
     and ask first.
  4. Run the story's **Verification command** and fix errors until it passes 100 %.
  5. Frontend stories: review the screenshots and videos in `frontend/e2e/screenshots/us-XX/`
     against `docs/DESIGN.md`; fix what looks wrong; then send them to the user.
  6. Mark `[x] US-##` in `PROGRESS.md` and add a log row (date, story, commit, notes).
  7. Commit (message starts with `US-##:`) and push to the working branch. During long stories,
     also commit and push checkpoints (`US-##: checkpoint - <what works>`) whenever a meaningful
     part works, so no work is lost if the session ends. Never leave finished work unpushed.
  8. Stop for human Scrum review with the report in §5.
- **Honesty rules:**
  - Never say something works unless you ran the command that proves it in this session.
  - Report anything skipped, stubbed, mocked, or uncertain, explicitly.
  - If the spec is wrong or contradicts reality while building, stop and tell the user. Do not
    quietly work around it. Spec changes are made in the spec files and recorded as decisions in
    `docs/REQUIREMENTS.md` §15.

## 3. Executable Commands
- **Setup:** `./scripts/setup.sh` (`--backend` or `--frontend` for one side)
- **Backend Tests:** `cd backend && .venv/bin/pytest -v`
- **Backend Compile Check:** `cd backend && .venv/bin/python -m compileall app`
- **Backend Latency Report:** `cd backend && .venv/bin/pytest tests/test_perf.py -m perf -s`
- **Frontend Typecheck:** `cd frontend && npm run typecheck`
- **Frontend Unit Tests:** `cd frontend && npm run test:unit`
- **Frontend Build Check:** `cd frontend && npm run build`
- **Frontend E2E (one story):** `cd frontend && npm run test:e2e -- us-XX`
- **Run the app (before US-16):** `./scripts/e2e-server.sh --port 8000 --data-dir /tmp/dar-demo`
- **Run the app (from US-16):** `./start.sh` (`--dev`, `--no-browser`, `--smoke`)
- In the cloud container, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`.
  Its WebGL is software-rendered (SwiftShader): never report FPS measured there as real.

## 4. Three-Tier Boundaries
- **ALWAYS:**
  - Bind servers to `127.0.0.1`; store relative paths in SQLite via `pathlib`.
  - Run verification commands before marking a story done.
  - Use exactly the pinned versions in `docs/ARCHITECTURE.md` §2; commit lockfiles.
  - Route every UI string through `t()` with English and Arabic entries; use Tailwind logical
    properties for direction-dependent layout.
  - Follow `docs/DESIGN.md` for colours, type, motion, copy and states.
  - Write all files (code, comments, docs, commit messages) in normal, complete English
    (Arabic only for Arabic UI strings and test data).
  - Use temporary data directories in tests; never touch a real `library_data/`.
- **ASK FIRST:**
  - Adding any npm or PyPI dependency not listed in `docs/ARCHITECTURE.md` §2.
  - Changing the SQLite schema (it also needs a migration, `docs/ARCHITECTURE.md` §5.4).
  - Changing an API contract, a layout constant not marked *(tunable)*, or a design token.
  - Modifying files outside the current story's scope.
- **NEVER:**
  - Use external CDN links (Google Fonts, remote HDRs/textures) or any runtime network request
    outside `127.0.0.1`.
  - Delete, skip or weaken failing tests to make a check pass.
  - Implement future sprint stories early.
  - Commit `library_data/`, secrets, copyrighted PDFs, or generated screenshots.
  - Use user-supplied file names in filesystem paths.
  - Claim visual or performance results that were not observed.

## 5. Story Review Report (end of every story)
1. **Done:** what was built, files changed.
2. **Verification:** the exact command(s) run and their result (pass counts, failures fixed).
3. **Visual evidence (frontend):** screenshots/videos sent, and what Claude checked in them.
4. **Browser check:** the story's "Browser check" steps for the user, adapted to what exists.
5. **Not done / uncertain:** skipped items, stubs, mocks, assumptions, known limits
   (for example, FPS not measurable in the cloud container).
6. **Spec issues:** anything in the spec that turned out wrong, and the proposed fix.
