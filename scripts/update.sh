#!/usr/bin/env bash
# In-place upgrade for an existing notebooklm-bridge install. Run from inside
# the *new* notebooklm-bridge-vX.Y.Z/ directory; pass the path of the previous
# install so we can pull over .venv / .env / secrets.
#
# Usage:
#   bash update.sh /path/to/old/notebooklm-bridge-v0.1.0

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

OLD="${1:-}"
if [ -z "$OLD" ]; then
    cat <<EOF >&2
Usage: bash update.sh /path/to/previous/install

The previous install must contain:
  .venv/        — Python virtual environment (will be reused)
  .env          — runtime config (carried over verbatim)
  secrets/      — auth.json + state.json (carried over verbatim)
EOF
    exit 2
fi

if [ ! -d "$OLD" ]; then
    echo "ERROR: $OLD does not exist" >&2
    exit 1
fi

# -- Stop current supervisors (if they were started from $OLD) ------------
if [ -x "$OLD/scripts/stop-web.sh" ]; then
    echo "→ Stopping old supervisors"
    (cd "$OLD" && bash scripts/stop-web.sh) || true
fi

# -- Carry forward state -------------------------------------------------
for f in .env; do
    if [ -f "$OLD/$f" ]; then
        cp "$OLD/$f" "$HERE/$f"
        echo "✓ carried over $f"
    fi
done
for d in secrets state .venv; do
    if [ -d "$OLD/$d" ]; then
        # rm -rf any placeholder, then copy. Using cp -a to preserve mode bits
        # (secrets/auth.json must stay 600, .venv hashes are stable enough).
        rm -rf "$HERE/$d"
        cp -a "$OLD/$d" "$HERE/$d"
        echo "✓ carried over $d/"
    fi
done

# -- Refresh the venv: reinstall from new wheels/ -------------------------
# If a fresh venv is needed, find a 3.11 interpreter the same way deploy.sh does
# so a host with both 3.9 and 3.11 installed doesn't accidentally pick 3.9 and
# then choke on the cp311 wheels.
find_python311() {
    local candidate
    if [ -n "${PYTHON_BIN:-}" ]; then
        if "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
            echo "$PYTHON_BIN"; return 0
        fi
        echo "ERROR: PYTHON_BIN=$PYTHON_BIN does not point at Python >= 3.11" >&2
        return 1
    fi
    for candidate in python3.11 python3.12 python3; do
        if command -v "$candidate" >/dev/null 2>&1 \
           && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
            echo "$candidate"; return 0
        fi
    done
    return 1
}

if [ ! -d .venv ]; then
    PY=$(find_python311) || {
        echo "ERROR: need Python >= 3.11 to create the venv. Install python3.11" >&2
        echo "       or set PYTHON_BIN=/full/path/to/python3.11 and re-run." >&2
        exit 1
    }
    echo "→ No .venv carried over, creating a fresh one with $PY"
    "$PY" -m venv .venv
fi
echo "→ Reinstalling backend from new wheels/"
.venv/bin/pip install --quiet --no-index --find-links wheels/ --upgrade \
    fastapi 'uvicorn[standard]' pydantic pydantic-settings httpx notebooklm-py
.venv/bin/pip install --quiet --no-build-isolation --no-deps -e . --force-reinstall

# -- Confirm 0600 on auth.json (cp -a should already, double check) -------
if [ -f secrets/auth.json ]; then
    chmod 600 secrets/auth.json
fi

cat <<EOF

✓ Upgrade complete. Start the service:
    bash scripts/start-web.sh
EOF
