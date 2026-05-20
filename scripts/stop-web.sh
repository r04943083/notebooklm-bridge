#!/usr/bin/env bash
# Stop notebooklm-bridge backend and frontend dev servers.
#
# Strategy:
#   1. If the PID file exists and the supervisor is alive, kill the supervisor
#      (which prevents respawn) then kill its whole process group.
#   2. If the PID file is missing or stale, fall back to looking up the listener
#      on the expected port and killing it — but ONLY if its cwd is this
#      project (safety net so we never kill another project sharing the port).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKEND_PID_FILE="$PROJECT_ROOT/.backend.pid"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"
RUNTIME_PORTS_FILE="$PROJECT_ROOT/.runtime-ports.json"

# Read the ports start-web.sh actually picked (it may have auto-incremented past
# the .env starting port). Fall back to .env / defaults if the runtime file is
# missing, e.g. start-web.sh was never run on this checkout.
if [ -f "$RUNTIME_PORTS_FILE" ]; then
    BACKEND_PORT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['backend_port'])" "$RUNTIME_PORTS_FILE" 2>/dev/null || echo "")
    FRONTEND_PORT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['frontend_port'])" "$RUNTIME_PORTS_FILE" 2>/dev/null || echo "")
fi
if [ -z "${BACKEND_PORT:-}" ] || [ -z "${FRONTEND_PORT:-}" ]; then
    if [ -f "$PROJECT_ROOT/.env" ]; then
        # shellcheck disable=SC1091
        set -a; source "$PROJECT_ROOT/.env"; set +a
    fi
    : "${BACKEND_PORT:=8002}"
    : "${FRONTEND_PORT:=5175}"
fi

# ── Helper: kill a PID + its process group, with graceful fallback ─
kill_tree() {
    local pid="$1"
    if ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    pkill -TERM -P "$pid" 2>/dev/null || true

    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
        sleep 1
        waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        pkill -KILL -P "$pid" 2>/dev/null || true
    fi
}

# ── Stage 1: PID-file path ────────────────────────────────
stop_via_pidfile() {
    local pid_file="$1"
    local label="$2"

    if [ ! -f "$pid_file" ]; then
        echo "$label: no PID file ($pid_file); will try port fallback."
        return 1
    fi

    local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        echo "$label: PID file points at dead PID ($pid); cleaning up + port fallback."
        rm -f "$pid_file"
        return 1
    fi

    echo "$label: stopping supervisor (PID $pid) and its process group ..."
    kill_tree "$pid"

    if kill -0 "$pid" 2>/dev/null; then
        echo "  WARNING: $label supervisor PID $pid did not die." >&2
        return 2
    fi

    rm -f "$pid_file"
    echo "  $label stopped."
    return 0
}

# ── Stage 2: port fallback (with cwd safety) ──────────────
stop_via_port() {
    local port="$1"
    local label="$2"

    local pid; pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)
    if [ -z "$pid" ]; then
        echo "$label: port $port is already free."
        return 0
    fi

    local cmd cwd
    cmd=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null | sed 's/ $//')
    cwd=$(readlink /proc/"$pid"/cwd 2>/dev/null || echo "?")

    if [[ "$cwd" != "$PROJECT_ROOT" && "$cwd" != "$PROJECT_ROOT"/* ]]; then
        echo "$label: port $port is held by a process from a DIFFERENT project, NOT killing:"
        echo "  PID: $pid  cmdline: $cmd  cwd: $cwd"
        echo "  If you really want to free the port, run manually:  kill $pid"
        return 0
    fi

    echo "$label: port $port held by orphan from this project (PID $pid); killing ..."
    echo "  cmdline: $cmd"
    kill_tree "$pid"

    if kill -0 "$pid" 2>/dev/null; then
        echo "  WARNING: orphan PID $pid did not die." >&2
        return 1
    fi
    echo "  $label orphan stopped."
}

stop_one() {
    local pid_file="$1"
    local port="$2"
    local label="$3"
    if ! stop_via_pidfile "$pid_file" "$label"; then
        stop_via_port "$port" "$label"
    fi
}

stop_one "$BACKEND_PID_FILE"  "$BACKEND_PORT"  "backend"
stop_one "$FRONTEND_PID_FILE" "$FRONTEND_PORT" "frontend"

# Clear runtime ports file so the next start-web.sh begins from .env / defaults
# instead of inheriting whatever increment we ended up with last time.
rm -f "$RUNTIME_PORTS_FILE"

echo "Done."
