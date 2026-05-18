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
if [ ! -d .venv ]; then
    echo "→ No .venv carried over, creating a fresh one"
    python3 -m venv .venv
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
