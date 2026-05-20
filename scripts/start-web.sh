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
RUNTIME_PORTS_FILE="$PROJECT_ROOT/.runtime-ports.json"

# Load .env so the supervised uvicorn process inherits NOTEBOOKLM_AUTH_JSON,
# STATE_JSON, INTERNAL_FRONTEND_ORIGIN, etc. — and so BACKEND_PORT / FRONTEND_PORT
# from .env (if set) become the starting ports for the probe below.
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

# Starting ports — see CLAUDE.md §3.2. If the starting port is busy, find_free_port
# scans up to MAX_PORT_TRIES-1 increments before giving up. The chosen ports are
# written to .runtime-ports.json so stop-web.sh / status-web.sh / vite see the
# same numbers.
: "${BACKEND_PORT:=8002}"
: "${FRONTEND_PORT:=5175}"
MAX_PORT_TRIES=10

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

# ── Helper: find a free port in [start_port, start_port+MAX_PORT_TRIES-1] ─
# stdout: chosen port (caller captures via $(...))
# stderr: per-iteration diagnostics so the operator sees what got skipped
# rc 1: range exhausted
#
# --force semantics: only at i==0 (the starting port). If the start port is held
# by a process whose cwd is inside this project, --force will SIGTERM/SIGKILL it
# and use that port — keeping the "primary" port stable when this project's own
# stale instance is the only blocker. For i>0 we always skip-and-try-next (we
# don't want --force killing arbitrary processes mid-scan).
find_free_port() {
    local start_port="$1"
    local label="$2"
    local i port info holder_pid holder_cmd holder_cwd

    for ((i=0; i<MAX_PORT_TRIES; i++)); do
        port=$((start_port + i))
        info=$(port_holder_info "$port")

        if [ -z "$info" ]; then
            echo >&2 "Port $port free for $label"
            echo "$port"
            return 0
        fi

        holder_pid=$(echo "$info" | cut -d'|' -f1)
        holder_cmd=$(echo "$info" | cut -d'|' -f2)
        holder_cwd=$(echo "$info" | cut -d'|' -f3)

        if [ "$i" -eq 0 ] && [ "$FORCE" -eq 1 ] \
           && [[ "$holder_cwd" == "$PROJECT_ROOT" || "$holder_cwd" == "$PROJECT_ROOT"/* ]]; then
            echo >&2 "Port $port held by this project (PID $holder_pid); --force enabled, SIGTERM"
            kill -TERM "$holder_pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$holder_pid" 2>/dev/null || break
                sleep 1
            done
            kill -KILL "$holder_pid" 2>/dev/null || true
            sleep 1
            if [ -z "$(port_holder_info "$port")" ]; then
                echo >&2 "Port $port freed by --force; using it for $label"
                echo "$port"
                return 0
            fi
        fi

        echo >&2 "Port $port busy for $label (PID $holder_pid, cwd: $holder_cwd); trying next"
    done

    local end=$((start_port + MAX_PORT_TRIES - 1))
    echo >&2 "ERROR: no free port for $label in [$start_port, $end] after $MAX_PORT_TRIES tries"
    return 1
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

SELECTED_BACKEND_PORT=$(find_free_port "$BACKEND_PORT" "backend")  || exit 1
SELECTED_FRONTEND_PORT=$(find_free_port "$FRONTEND_PORT" "frontend") || exit 1

# Persist selected ports so stop-web.sh / status-web.sh / vite.config.ts see
# the same numbers we picked here.
cat > "$RUNTIME_PORTS_FILE" <<EOF
{"backend_port": $SELECTED_BACKEND_PORT, "frontend_port": $SELECTED_FRONTEND_PORT}
EOF
echo "Runtime ports written to $RUNTIME_PORTS_FILE"

# ── Truncate logs (fresh start) ───────────────────────────
: > "$BACKEND_LOG"
: > "$FRONTEND_LOG"

# ── Backend (uvicorn under supervisor) ────────────────────
# IMPORTANT: --workers 1 is REQUIRED. notebooklm-py NotebookLMClient is a
# single-event-loop async re-entrant object and is NOT thread-safe. Multiple
# workers would create separate clients with split cookies / keepalive /
# rate-limit counters / breaker state. See CLAUDE.md §3.1 and plan.md.
echo "Starting backend (host=$HOST, port=$SELECTED_BACKEND_PORT) ..."
cd "$PROJECT_ROOT"
"$SCRIPT_DIR/_supervise.sh" backend "$BACKEND_LOG" -- \
    uvicorn backend.app:app \
        --host "$HOST" --port "$SELECTED_BACKEND_PORT" \
        --workers 1 \
        --reload \
        --reload-dir backend \
        --no-access-log &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"
echo "  Backend supervisor PID: $BACKEND_PID  (log: $BACKEND_LOG)"

# ── Frontend (vite under supervisor) ──────────────────────
# Tell vite.config.ts which ports we picked so its proxy points at the right
# backend and its dev server binds the right port.
if [ -d "$PROJECT_ROOT/frontend" ]; then
    echo "Starting frontend (port=$SELECTED_FRONTEND_PORT) ..."
    cd "$PROJECT_ROOT/frontend"
    export VITE_BACKEND_PORT="$SELECTED_BACKEND_PORT"
    export VITE_PORT="$SELECTED_FRONTEND_PORT"
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
echo "  Local:   http://localhost:$SELECTED_FRONTEND_PORT"
if [ "$HOST" != "127.0.0.1" ]; then
    for ip in $(hostname -I 2>/dev/null); do
        echo "  Network: http://${ip}:$SELECTED_FRONTEND_PORT"
    done
fi
echo ""
echo "Tools:"
echo "  scripts/status-web.sh   # check health + log tail"
echo "  scripts/stop-web.sh     # stop both services"
echo "  tail -f .backend.log    # live backend log"
echo "  tail -f .frontend.log   # live frontend log"
