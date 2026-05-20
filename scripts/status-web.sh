#!/usr/bin/env bash
# Show health of notebooklm-bridge backend + frontend dev servers.
#
# Reports for each service:
#   - whether the supervisor is alive (from PID file)
#   - whether the expected port has a listener and which process owns it
#   - count of recent crash markers in the log (since last start)
#   - last 5 lines of the log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_PORTS_FILE="$PROJECT_ROOT/.runtime-ports.json"

# Read the ports start-web.sh actually picked. Fall back to .env / defaults if
# the runtime file is missing (e.g. start-web.sh has never run on this checkout).
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

report_one() {
    local label="$1"
    local pid_file="$2"
    local port="$3"
    local logfile="$4"

    echo "── $label ─────────────────────────────────"

    if [ -f "$pid_file" ]; then
        local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "  supervisor : RUNNING  pid=$pid"
        else
            echo "  supervisor : STALE PID FILE  (pid=$pid not alive)"
        fi
    else
        echo "  supervisor : no PID file"
    fi

    local listener_pid
    listener_pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)
    if [ -n "$listener_pid" ]; then
        local lcwd; lcwd=$(readlink /proc/"$listener_pid"/cwd 2>/dev/null || echo "?")
        local lcmd; lcmd=$(tr '\0' ' ' </proc/"$listener_pid"/cmdline 2>/dev/null | sed 's/ $//')
        if [[ "$lcwd" == "$PROJECT_ROOT" || "$lcwd" == "$PROJECT_ROOT"/* ]]; then
            echo "  port $port  : LISTENING  pid=$listener_pid  (this project)"
        else
            echo "  port $port  : LISTENING  pid=$listener_pid  (OTHER project: $lcwd)"
        fi
        echo "               cmdline: $lcmd"
    else
        echo "  port $port  : free"
    fi

    if [ -f "$logfile" ]; then
        local crashes
        crashes=$(grep -c "exited (code=" "$logfile" 2>/dev/null || echo 0)
        local crash_loops
        crash_loops=$(grep -c "\[CRASH-LOOP\]" "$logfile" 2>/dev/null || echo 0)
        echo "  crashes    : $crashes total restarts, $crash_loops crash-loop episodes (since last start)"

        echo "  log tail (last 5 lines of $logfile):"
        tail -n 5 "$logfile" 2>/dev/null | sed 's/^/    | /'
    else
        echo "  log        : not found ($logfile)"
    fi
    echo
}

report_one "backend"  "$PROJECT_ROOT/.backend.pid"  "$BACKEND_PORT"  "$PROJECT_ROOT/.backend.log"
report_one "frontend" "$PROJECT_ROOT/.frontend.pid" "$FRONTEND_PORT" "$PROJECT_ROOT/.frontend.log"
