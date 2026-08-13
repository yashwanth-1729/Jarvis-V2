#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# JARVIS v1 — start the FastAPI backend and the Next.js frontend together.
#
#   ./run.sh          start both
#   ./run.sh setup    install dependencies, then start both
#
# On Windows, run this from Git Bash. Native PowerShell users: use ./run.ps1
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

BACKEND_PORT="${JARVIS_PORT:-8000}"
FRONTEND_PORT="${JARVIS_FRONTEND_PORT:-3000}"

# Git Bash on Windows keeps the venv executables under Scripts/, not bin/.
if [ -x "$BACKEND/.venv/Scripts/python.exe" ]; then
  PYTHON="$BACKEND/.venv/Scripts/python.exe"
elif [ -x "$BACKEND/.venv/bin/python" ]; then
  PYTHON="$BACKEND/.venv/bin/python"
else
  PYTHON=""
fi

log()  { printf '\033[36m[jarvis]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[jarvis]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[jarvis]\033[0m %s\n' "$*" >&2; exit 1; }

setup() {
  log "Creating backend virtualenv…"
  ( cd "$BACKEND" && python -m venv .venv )

  if [ -x "$BACKEND/.venv/Scripts/python.exe" ]; then
    PYTHON="$BACKEND/.venv/Scripts/python.exe"
  else
    PYTHON="$BACKEND/.venv/bin/python"
  fi

  log "Installing backend dependencies…"
  "$PYTHON" -m pip install --upgrade pip --quiet
  "$PYTHON" -m pip install -r "$BACKEND/requirements.txt"

  log "Installing frontend dependencies…"
  ( cd "$FRONTEND" && npm install --no-audit --no-fund )

  log "Setup complete."
}

if [ "${1:-}" = "setup" ]; then
  setup
fi

# --- preflight -------------------------------------------------------------

[ -n "$PYTHON" ] || die "No virtualenv found. Run: ./run.sh setup"
[ -d "$FRONTEND/node_modules" ] || die "Frontend dependencies missing. Run: ./run.sh setup"

if [ ! -f "$BACKEND/.env" ]; then
  warn "backend/.env not found — copying from .env.example."
  cp "$BACKEND/.env.example" "$BACKEND/.env"
  warn "Add your ANTHROPIC_API_KEY to backend/.env, then restart."
fi

if [ ! -f "$FRONTEND/.env.local" ]; then
  log "Creating frontend/.env.local from the example."
  cp "$FRONTEND/.env.local.example" "$FRONTEND/.env.local"
fi

# --- run -------------------------------------------------------------------

PIDS=()

shutdown() {
  log "Shutting down…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown INT TERM

log "Backend  → http://127.0.0.1:$BACKEND_PORT  (docs at /docs)"
( cd "$BACKEND" && "$PYTHON" -m uvicorn main:app --reload --port "$BACKEND_PORT" ) &
PIDS+=($!)

log "Frontend → http://localhost:$FRONTEND_PORT"
( cd "$FRONTEND" && npm run dev -- --port "$FRONTEND_PORT" ) &
PIDS+=($!)

log "Both processes started. Press Ctrl-C to stop."
wait -n 2>/dev/null || wait
shutdown
