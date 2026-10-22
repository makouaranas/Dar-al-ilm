#!/usr/bin/env bash
# Renders the book-opening look-development video (book_open.py) to renders/book/opening.mp4.
#
#   ./tools/lookdev/render_book.sh                         1280 px, 32 samples, all frames
#   ./tools/lookdev/render_book.sh --res 640 --samples 8   a quick preview
#
# First use: creates tools/lookdev/.venv (bpy) and fetches the Amiri font (OFL) with npm into
# tex/fonts; both need internet once. Frames already rendered are kept, so an interrupted run
# resumes. Needs ffmpeg for the MP4.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3.13}"
VENV="$HERE/.venv"
TEX="$HERE/tex"
OUT="$HERE/renders/book"
AMIRI="$TEX/fonts/amiri/package/files"

log() { echo "[lookdev] $*"; }

if [ ! -x "$VENV/bin/python" ]; then
  log "Creating $VENV (bpy needs Python 3.13)"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r "$HERE/requirements.txt"
fi

if [ ! -f "$AMIRI/amiri-arabic-400-normal.woff2" ]; then
  log "Fetching the Amiri font (@fontsource/amiri 5.3.0, SIL OFL)"
  mkdir -p "$TEX/fonts/amiri"
  (cd "$TEX/fonts" && npm pack --silent @fontsource/amiri@5.3.0 >/dev/null && tar -xzf fontsource-amiri-5.3.0.tgz -C amiri)
fi

mkdir -p "$TEX/book" "$OUT"
log "Typesetting the pages, cover and spine"
node "$HERE/book_pages.mjs" "$TEX/book" "$AMIRI"

log "Rendering frames into $OUT"
"$VENV/bin/python" "$HERE/book_open.py" --outdir "$OUT" "$@" | grep -E '^done'

if [ ! -f "$OUT/0001.png" ]; then
  log "Done (no frame sequence to encode)."
elif command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -loglevel error -y -framerate 24 -i "$OUT/%04d.png" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
    -movflags +faststart "$OUT/opening.mp4"
  log "Video: $OUT/opening.mp4"
else
  log "ffmpeg not found: the frames are in $OUT"
fi
