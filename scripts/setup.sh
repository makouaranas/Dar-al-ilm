#!/usr/bin/env bash
# Sets up the development environment for Dar al Ilm.
#
#   ./scripts/setup.sh              backend and frontend
#   ./scripts/setup.sh --backend    Python virtual environment only (backend/.venv)
#   ./scripts/setup.sh --frontend   npm packages only (frontend/node_modules)
#
# Safe to run repeatedly: packages are reinstalled only when the requirement or
# lock files change. Needs internet access the first time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"

do_backend=1
do_frontend=1
for arg in "$@"; do
  case "$arg" in
    --backend) do_backend=1; do_frontend=0 ;;
    --frontend) do_backend=0; do_frontend=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "setup.sh: unknown option '$arg' (use --backend, --frontend or --help)" >&2; exit 2 ;;
  esac
done

log() { echo "[setup] $*"; }

checksum() { cat "$@" | sha256sum | cut -d' ' -f1; }

setup_backend() {
  if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "[setup] $PYTHON not found. Install Python 3.12 or newer." >&2
    exit 1
  fi
  if ! "$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
    echo "[setup] Python 3.12 or newer is required (found $("$PYTHON" --version 2>&1))." >&2
    exit 1
  fi

  local venv="$ROOT/backend/.venv"
  if [ ! -x "$venv/bin/python" ]; then
    log "Creating backend/.venv"
    "$PYTHON" -m venv "$venv"
  fi

  local stamp="$venv/.requirements.sha256"
  local wanted
  wanted="$(checksum "$ROOT/backend/requirements.txt" "$ROOT/backend/requirements-dev.txt")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$wanted" ]; then
    log "Backend packages are up to date"
  else
    log "Installing backend packages"
    "$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
      -r "$ROOT/backend/requirements.txt" -r "$ROOT/backend/requirements-dev.txt"
    echo "$wanted" > "$stamp"
  fi
}

setup_frontend() {
  local frontend="$ROOT/frontend"
  if [ ! -f "$frontend/package.json" ]; then
    log "frontend/package.json does not exist yet; skipping the frontend"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[setup] Node.js not found. Install Node.js 20.9 or newer." >&2
    exit 1
  fi
  if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 9) ? 0 : 1)'; then
    echo "[setup] Node.js 20.9 or newer is required (found $(node --version))." >&2
    exit 1
  fi

  local stamp="$frontend/node_modules/.package-lock.sha256"
  local wanted
  wanted="$(checksum "$frontend/package.json" "$frontend/package-lock.json")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$wanted" ]; then
    log "Frontend packages are up to date"
  else
    log "Installing frontend packages"
    (cd "$frontend" && NEXT_TELEMETRY_DISABLED=1 npm ci --no-audit --no-fund)
    echo "$wanted" > "$stamp"
  fi
}

[ "$do_backend" = 1 ] && setup_backend
[ "$do_frontend" = 1 ] && setup_frontend
log "Done"
