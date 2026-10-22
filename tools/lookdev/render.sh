#!/usr/bin/env bash
# Renders the look-development stills of the premium hall.
#
#   ./tools/lookdev/render.sh                                  all five shots, 1600 px, 48 samples
#   ./tools/lookdev/render.sh --shot nave --res 960 --samples 16   any hall.py options
#
# Creates tools/lookdev/.venv (Blender as a Python module) on first use, draws the text and
# lattice masks with the frontend's Playwright Chromium, runs the shelf collision check, then
# renders into tools/lookdev/renders/. Needs the frontend packages (./scripts/setup.sh --frontend).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3.13}"
VENV="$HERE/.venv"
TEX="$HERE/tex"

log() { echo "[lookdev] $*"; }

if [ ! -x "$VENV/bin/python" ]; then
  log "Creating $VENV (bpy needs Python 3.13)"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r "$HERE/requirements.txt"
fi

mkdir -p "$TEX"
log "Drawing text and lattice masks"
node "$HERE/lattice.mjs" "$TEX"
node "$HERE/spine_atlas.mjs" "$TEX"
node "$HERE/covers.mjs" "$TEX"
node "$HERE/signs.mjs" "$TEX"   # first pass without counts: the scene needs the files to build
"$VENV/bin/python" "$HERE/hall.py" --counts "$TEX/counts.json" | grep '^counts'
node "$HERE/signs.mjs" "$TEX" "$TEX/counts.json"

log "Checking every shelf book for overlaps and support"
"$VENV/bin/python" "$HERE/hall.py" --check | grep -E '^check|^   '

if [ "$#" -eq 0 ]; then
  set -- --shot entrance,nave,bayview,desk,bay --res 1600 --samples 48
fi
log "Rendering"
"$VENV/bin/python" "$HERE/hall.py" --outdir "$HERE/renders" "$@" | grep -E '^scene|^done'
