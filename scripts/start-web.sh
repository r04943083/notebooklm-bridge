#!/usr/bin/env bash
# Start notebooklm-bridge backend and frontend dev servers under a supervisor.
# Each service is auto-restarted on crash; logs land in .backend.log /
# .frontend.log; PID files at the project root point at the supervisor.
#
# Usage:
#   scripts/start-web.sh                 # bind 0.0.0.0 (LAN-accessible)
#   scripts/start-web.sh --local         # bind 127.0.0.1 (localhost only)
#   scripts/start-web.sh --force         # if a port is held by a stale process
#                                        # in *this* project, kill it first
#   scripts/start-web.sh --local --force # both flags

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKEND_PID_FILE="$PROJECT_ROOT/.backend.pid"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"
BACKEND_LOG="$PROJECT_ROOT/.backend.log"
FRONTEND_LOG="$PROJECT_ROOT/.frontend.log"

# Port pinning is a HARD requirement, see CLAUDE.md §3.2.
BACKEND_PORT=8002
FRONTEND_PORT=5175

# Load .env so the supervised uvicorn process inherits NOTEBOOKLM_AUTH_JSON,
# STATE_JSON, INTERNAL_AUTH_SHARED_SECRET, etc.
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

# Parse options
HOST="0.0.0.0"
FORCE=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --local) HOST="127.0.0.1"; shift ;;
        --force) FORCE=1; shift ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# *//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Helper: describe whoever is holding $port ─────────────
port_holder_info() {
    local port="$1"
    local pid
    pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)
    if [ -z "$pid" ]; then
        echo ""
        return
    fi
    local cmd cwd
    cmd=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null | sed 's/ $//')
    cwd=$(readlink /proc/"$pid"/cwd 2>/dev/null || echo "?")
    echo "${pid}|${cmd}|${cwd}"
}

# ── Helper: ensure $port is free; respect --force scope ───
ensure_port_free() {
    local port="$1"
    local label="$2"

    local info; info=$(port_holder_info "$port")
    if [ -z "$info" ]; then
        return 0
    fi

    local holder_pid holder_cmd holder_cwd
    holder_pid=$(echo "$info" | cut -d'|' -f1)
    holder_cmd=$(echo "$info" | cut -d'|' -f2)
    holder_cwd=$(echo "$info" | cut -d'|' -f3)

    echo "Port $port (needed for $label) is already in use:"
    echo "  PID:     $holder_pid"
    echo "  cmdline: $holder_cmd"
    echo "  cwd:     $holder_cwd"

    if [ "$FORCE" -eq 1 ] && [[ "$holder_cwd" == "$PROJECT_ROOT" || "$holder_cwd" == "$PROJECT_ROOT"/* ]]; then
        echo "  --force enabled and holder is from this project; sending SIGTERM."
        kill -TERM "$holder_pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            kill -0 "$holder_pid" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$holder_pid" 2>/dev/null || true
        sleep 1
        if [ -n "$(port_holder_info "$port")" ]; then
            echo "Error: still occupied after force kill." >&2
            exit 1
        fi
        return 0
    fi

    if [[ "$holder_cwd" == "$PROJECT_ROOT" || "$holder_cwd" == "$PROJECT_ROOT"/* ]]; then
        echo "Hint: holder belongs to this project — re-run with --force to auto-kill it."
    else
        echo "Hint: holder belongs to a DIFFERENT project; not touching it."
        echo "      Stop it manually if you really want this port:  kill $holder_pid"
    fi
    exit 1
}

# ── Helper: handle stale PID files ────────────────────────
cleanup_stale_pidfile() {
    local pid_file="$1"
    local label="$2"
    if [ -f "$pid_file" ]; then
        local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "Error: $label supervisor is already running (PID $pid)."
            echo "       Run scripts/stop-web.sh first."
            exit 1
        else
            rm -f "$pid_file"
        fi
    fi
}

cleanup_stale_pidfile "$BACKEND_PID_FILE" "backend"
cleanup_stale_pidfile "$FRONTEND_PID_FILE" "frontend"
ensure_port_free "$BACKEND_PORT" "backend"
ensure_port_free "$FRONTEND_PORT" "frontend"

# ── Truncate logs (fresh start) ───────────────────────────
: > "$BACKEND_LOG"
: > "$FRONTEND_LOG"

# ── Backend (uvicorn under supervisor) ────────────────────
# IMPORTANT: --workers 1 is REQUIRED. notebooklm-py NotebookLMClient is a
# single-event-loop async re-entrant object and is NOT thread-safe. Multiple
# workers would create separate clients with split cookies / keepalive /
# rate-limit counters / breaker state. See CLAUDE.md §3.1 and plan.md.
echo "Starting backend (host=$HOST, port=$BACKEND_PORT) ..."
cd "$PROJECT_ROOT"
"$SCRIPT_DIR/_supervise.sh" backend "$BACKEND_LOG" -- \
    uvicorn backend.app:app \
        --host "$HOST" --port "$BACKEND_PORT" \
        --workers 1 \
        --reload \
        --reload-dir backend \
        --no-access-log &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"
echo "  Backend supervisor PID: $BACKEND_PID  (log: $BACKEND_LOG)"

# ── Frontend (vite under supervisor) ──────────────────────
if [ -d "$PROJECT_ROOT/frontend" ]; then
    echo "Starting frontend (port=$FRONTEND_PORT) ..."
    cd "$PROJECT_ROOT/frontend"
    "$SCRIPT_DIR/_supervise.sh" frontend "$FRONTEND_LOG" -- \
        npm run dev &
    FRONTEND_PID=$!
    echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"
    echo "  Frontend supervisor PID: $FRONTEND_PID  (log: $FRONTEND_LOG)"
else
    echo "Warning: frontend directory not found; skipping frontend start."
fi

echo ""
echo "Done. Open in browser:"
echo "  Local:   http://localhost:$FRONTEND_PORT"
if [ "$HOST" != "127.0.0.1" ]; then
    for ip in $(hostname -I 2>/dev/null); do
        echo "  Network: http://${ip}:$FRONTEND_PORT"
    done
fi
echo ""
echo "Tools:"
echo "  scripts/status-web.sh   # check health + log tail"
echo "  scripts/stop-web.sh     # stop both services"
echo "  tail -f .backend.log    # live backend log"
echo "  tail -f .frontend.log   # live frontend log"
