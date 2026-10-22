#!/usr/bin/env bash
# Starts Dar al Ilm (docs/ARCHITECTURE.md section 15).
#
#   ./start.sh               set up if needed, build if stale, serve on 127.0.0.1:8000 and
#                            open the app window; closing the window stops everything
#   ./start.sh --no-browser  the same, without opening a window (stop with Ctrl+C)
#   ./start.sh --dev         API with reload on :8000 and the Next.js dev server on :3000
#   ./start.sh --smoke       start, check /api/health and /, stop; exit 0 only if both pass
#
# Environment: DAR_PORT (default 8000), DAR_DATA_DIR (default ./library_data).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DAR_PORT:-8000}"
DEV_PORT=3000
HOST=127.0.0.1
DATA_DIR="${DAR_DATA_DIR:-$ROOT/library_data}"
HEALTH_TIMEOUT_S=30

mode=prod
open_browser=1
for arg in "$@"; do
  case "$arg" in
    --dev) mode=dev ;;
    --smoke) mode=smoke; open_browser=0 ;;
    --no-browser) open_browser=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "start.sh: unknown option '$arg' (use --dev, --no-browser, --smoke or --help)" >&2; exit 2 ;;
  esac
done

log() { echo "[dar] $*"; }
fail() { echo "[dar] $*" >&2; exit 1; }

# --- Child processes: every one is stopped on exit, Ctrl+C or TERM ----------------------------

children=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${children[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${children[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  [ "${#children[@]}" -gt 0 ] && log "Stopped."
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Checks ------------------------------------------------------------------------------------

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  else
    (exec 3<>"/dev/tcp/$HOST/$port") 2>/dev/null
  fi
}

require_free_port() {
  local port="$1"
  if port_in_use "$port"; then
    fail "Port $port is already in use. Dar al Ilm may already be running: open http://$HOST:$port, or stop the program using the port, then try again. (Nothing was stopped.)"
  fi
}

http_ok() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 5 "$url"
  else
    "$ROOT/backend/.venv/bin/python" - "$url" <<'PY'
import sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=5) as response:
    sys.exit(0 if 200 <= response.status < 300 else 1)
PY
  fi
}

wait_for_health() {
  local url="http://$HOST:$PORT/api/health"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if http_ok "$url" 2>/dev/null; then return 0; fi
    # The server died while starting: report it at once.
    if ! kill -0 "${children[-1]}" 2>/dev/null; then fail "The library service stopped while starting (see the messages above)."; fi
    sleep 0.5
  done
  fail "The library service did not answer $url within $HEALTH_TIMEOUT_S s."
}

# --- Setup, build, data folder -------------------------------------------------------------------

ensure_setup() {
  if [ ! -x "$ROOT/backend/.venv/bin/python" ] || [ ! -d "$ROOT/frontend/node_modules" ]; then
    log "First start: setting up (this needs internet access once)."
    "$ROOT/scripts/setup.sh"
  fi
}

frontend_is_stale() {
  local out="$ROOT/frontend/out/index.html"
  [ -f "$out" ] || return 0
  # Any source or config file newer than the build means it must be rebuilt.
  [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/public" "$ROOT/frontend/package.json" "$ROOT/frontend/next.config.ts" \
    -newer "$out" -print -quit 2>/dev/null)" ]
}

ensure_build() {
  if frontend_is_stale; then
    log "Building the interface (about a minute)..."
    (cd "$ROOT/frontend" && NEXT_TELEMETRY_DISABLED=1 npm run --silent build >/dev/null) || fail "The interface build failed. Run 'cd frontend && npm run build' to see why."
  fi
}

ensure_data_dir() {
  mkdir -p "$DATA_DIR"/{pdfs,covers,cache,staging}
}

start_api() {
  local reload=()
  [ "$mode" = dev ] && reload=(--reload --reload-dir "$ROOT/backend/app")
  (
    cd "$ROOT/backend"
    DAR_DATA_DIR="$DATA_DIR" DAR_PORT="$PORT" exec .venv/bin/uvicorn app.main:app \
      --host "$HOST" --port "$PORT" --log-level warning "${reload[@]}"
  ) &
  children+=("$!")
}

# --- App window ----------------------------------------------------------------------------------

open_window() {
  local url="$1"
  local browser
  for browser in chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge; do
    if command -v "$browser" >/dev/null 2>&1; then
      log "Opening the app window ($browser). Close it to stop Dar al Ilm."
      "$browser" --app="$url" --user-data-dir="$DATA_DIR/.browser-profile" --no-first-run --no-default-browser-check \
        >/dev/null 2>&1 &
      children+=("$!")
      # A dedicated profile keeps this process alive until its window closes.
      wait "${children[-1]}" 2>/dev/null || true
      return 0
    fi
  done
  if command -v xdg-open >/dev/null 2>&1; then
    log "No Chromium-based browser found: opening $url in your default browser."
    xdg-open "$url" >/dev/null 2>&1 || true
  else
    log "Open $url in your browser."
  fi
  log "Press Ctrl+C to stop Dar al Ilm."
  wait "${children[0]}"
}

# --- Modes ---------------------------------------------------------------------------------------

ensure_setup
ensure_data_dir

case "$mode" in
  dev)
    require_free_port "$PORT"
    require_free_port "$DEV_PORT"
    start_api
    wait_for_health
    (
      cd "$ROOT/frontend"
      NEXT_PUBLIC_API_BASE="http://$HOST:$PORT" exec npm run --silent dev
    ) &
    children+=("$!")
    log "Development: API on http://$HOST:$PORT, interface on http://$HOST:$DEV_PORT (Ctrl+C stops both)."
    if [ "$open_browser" = 1 ]; then
      # Wait for the dev server, then open it.
      for _ in $(seq 1 120); do http_ok "http://$HOST:$DEV_PORT" 2>/dev/null && break; sleep 0.5; done
      open_window "http://$HOST:$DEV_PORT"
    else
      wait "${children[0]}"
    fi
    ;;
  prod | smoke)
    ensure_build
    require_free_port "$PORT"
    start_api
    wait_for_health
    if [ "$mode" = smoke ]; then
      http_ok "http://$HOST:$PORT/api/health" || fail "Smoke test failed: /api/health"
      http_ok "http://$HOST:$PORT/" || fail "Smoke test failed: /"
      log "Smoke test passed: /api/health and / answer on http://$HOST:$PORT."
      exit 0
    fi
    log "Dar al Ilm is running on http://$HOST:$PORT (library folder: $DATA_DIR)."
    if [ "$open_browser" = 1 ]; then
      open_window "http://$HOST:$PORT"
    else
      log "Press Ctrl+C to stop."
      wait "${children[0]}"
    fi
    ;;
esac
