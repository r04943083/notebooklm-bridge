#!/usr/bin/env bash
# In-place upgrade for an existing notebooklm-bridge install. Run from inside
# the *new* notebooklm-bridge-vX.Y.Z/ directory; pass the path of the previous
# install so we can pull over .venv / .env / secrets.
#
# Usage:
#   bash update.sh /path/to/old/notebooklm-bridge-v0.1.0

set -euo pipefail

# Same project-root detection as deploy.sh — works whether update.sh sits at
# the tarball top-level (pack.sh's placement) or at scripts/ in the repo.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$HERE/pyproject.toml" ]; then
    if [ -f "$HERE/../pyproject.toml" ]; then
        HERE="$(cd "$HERE/.." && pwd)"
    else
        echo "ERROR: pyproject.toml not found at $HERE or one level up." >&2
        echo "       update.sh must be invoked from the tarball top-level dir," >&2
        echo "       or from scripts/ in the source repo." >&2
        exit 1
    fi
fi
cd "$HERE"

if [ ! -d wheels ] || ! ls wheels/*.whl >/dev/null 2>&1; then
    echo "ERROR: wheels/ missing or empty at $HERE." >&2
    echo "       update.sh reinstalls from offline wheels — needs the wheels/ shipped" >&2
    echo "       in the tarball produced by scripts/pack.sh." >&2
    exit 1
fi

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
# Find python3.11 specifically — see deploy.sh for the "why strict 3.11"
# rationale (cp311 wheel ABI lock-in). PYTHON_BIN= overrides.
find_python311() {
    if [ -n "${PYTHON_BIN:-}" ]; then
        if "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
            echo "$PYTHON_BIN"; return 0
        fi
        echo "ERROR: PYTHON_BIN=$PYTHON_BIN does not point at Python >= 3.11" >&2
        return 1
    fi
    if command -v python3.11 >/dev/null 2>&1 \
       && python3.11 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
        echo "python3.11"; return 0
    fi
    return 1
}

# Treat a venv missing pip the same as no venv at all (see deploy.sh for the
# rationale — interrupted runs / --without-pip / cross-distro carryover all
# manifest as bin/pip absent, and skipping straight to pip install fails with
# a confusing "No such file or directory").
if [ -d .venv ] && [ ! -x .venv/bin/pip ]; then
    echo "→ Carried-over .venv has no working pip; removing for clean re-create"
    rm -rf .venv
fi

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
.venv/bin/pip install --no-index --find-links wheels/ --upgrade \
    fastapi 'uvicorn[standard]' pydantic pydantic-settings httpx 'notebooklm-py[browser,cookies]'
.venv/bin/pip install --no-build-isolation --no-deps -e . --force-reinstall

# -- Confirm 0600 on auth.json (cp -a should already, double check) -------
if [ -f secrets/auth.json ]; then
    chmod 600 secrets/auth.json
fi

cat <<EOF

✓ Upgrade complete. Start the service:
    bash scripts/start-web.sh
EOF
