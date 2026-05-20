#!/usr/bin/env bash
# Internal helper used by start-web.sh — DO NOT call directly.
#
# Runs a command in a restart loop so the web services survive crashes.
# - Each restart appends a marker to the log file with timestamp + exit info.
# - Exponential back-off when the command crashes 5+ times within 30 seconds
#   (avoids burning CPU on a permanently broken config).
# - Forwards SIGTERM/SIGINT to the child and exits cleanly.
#
# Usage:
#   _supervise.sh <label> <logfile> -- <cmd> [args...]

set -uo pipefail   # NOTE: no -e — we want the loop to handle child exit, not abort

LABEL="${1:?label required}"
LOGFILE="${2:?logfile required}"
shift 2
if [ "${1:-}" != "--" ]; then
    echo "[$LABEL supervisor] usage: _supervise.sh <label> <logfile> -- <cmd...>" >&2
    exit 2
fi
shift

# ── Crash-loop state ──────────────────────────────────────
WINDOW_SECONDS=30
WINDOW_MAX_CRASHES=5
LONG_BACKOFF=30
SHORT_BACKOFF=2
crash_times=()           # epoch seconds of recent crashes

# ── Signal handling ───────────────────────────────────────
CHILD_PID=""
SHUTTING_DOWN=0

forward_signal() {
    SHUTTING_DOWN=1
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        # Child runs in its own process group (setsid below); kill the whole group
        kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
    fi
}
trap forward_signal TERM INT HUP

log_marker() {
    # Use printf to avoid echo's interpretation differences
    printf '\n[%s supervisor] %s\n' "$LABEL" "$*" >> "$LOGFILE"
}

# ── Main loop ─────────────────────────────────────────────
log_marker "starting (pid=$$, cmd: $*)"

while [ "$SHUTTING_DOWN" -eq 0 ]; do
    # setsid -> child gets its own PGID so we can signal the whole group
    setsid "$@" >>"$LOGFILE" 2>&1 &
    CHILD_PID=$!

    wait "$CHILD_PID"
    EXIT_CODE=$?
    CHILD_PID=""

    if [ "$SHUTTING_DOWN" -eq 1 ]; then
        log_marker "shutdown requested, exiting"
        break
    fi

    NOW=$(date +%s)
    crash_times+=("$NOW")
    # Drop entries older than WINDOW_SECONDS
    cutoff=$((NOW - WINDOW_SECONDS))
    new_times=()
    for t in "${crash_times[@]}"; do
        [ "$t" -ge "$cutoff" ] && new_times+=("$t")
    done
    crash_times=("${new_times[@]}")

    if [ "${#crash_times[@]}" -ge "$WINDOW_MAX_CRASHES" ]; then
        log_marker "[CRASH-LOOP] ${#crash_times[@]} crashes in last ${WINDOW_SECONDS}s (last exit=$EXIT_CODE); backing off ${LONG_BACKOFF}s"
        sleep "$LONG_BACKOFF"
        crash_times=()   # reset window after the long sleep
    else
        log_marker "exited (code=$EXIT_CODE), restarting in ${SHORT_BACKOFF}s [crashes in last ${WINDOW_SECONDS}s: ${#crash_times[@]}]"
        sleep "$SHORT_BACKOFF"
    fi
done

log_marker "supervisor stopped"
