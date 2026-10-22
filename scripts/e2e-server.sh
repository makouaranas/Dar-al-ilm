#!/usr/bin/env bash
# Serves a seeded demo library with the built frontend on 127.0.0.1.
# Used by the Playwright tests (port 8765) and for manual checks before start.sh exists.
#
#   ./scripts/e2e-server.sh [--port N] [--data-dir PATH]
#
# The demo library is seeded (backend/scripts/seed_demo.py) only when the data directory
# has no library yet. Build the frontend first: cd frontend && npm run build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8765
DATA_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "e2e-server.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$(mktemp -d -t dar-al-ilm-library-XXXXXX)"
fi
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

"$ROOT/scripts/setup.sh" --backend > /dev/null

cd "$ROOT/backend"
if [ ! -f "$DATA_DIR/library.db" ]; then
  echo "[e2e-server] Seeding a demo library in $DATA_DIR"
  .venv/bin/python scripts/seed_demo.py --data-dir "$DATA_DIR"
fi
if [ ! -f "$ROOT/frontend/out/index.html" ]; then
  echo "[e2e-server] frontend/out is missing: run 'npm run build' in frontend/ (API only for now)" >&2
fi

echo "[e2e-server] Serving $DATA_DIR on http://127.0.0.1:$PORT"
DAR_DATA_DIR="$DATA_DIR" DAR_PORT="$PORT" exec .venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning
