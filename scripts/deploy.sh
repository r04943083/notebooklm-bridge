#!/usr/bin/env bash
# First-time install on a target LAN host. Run from inside an unpacked
# notebooklm-bridge-vX.Y.Z/ directory.
#
# What this does (idempotent — safe to re-run):
#   1. Verify python3 / node available.
#   2. Create .venv, install backend offline from wheels/.
#   3. Create secrets/ (mode 700).
#   4. If .env missing, copy .env.example and warn the operator to fill it in.
#   5. Print next steps (drop in secrets/auth.json, then bash scripts/start-web.sh).
#
# What this does NOT do — by design:
#   * Mint Google cookies (scripts/login.sh does that — see "Next steps" below)
#   * Start the service (operator runs scripts/start-web.sh after login.sh)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

cat <<'EOF'
============================================================
 notebooklm-bridge — first-time deploy
============================================================
Required on this host:
  - Python 3.11+          (notebooklm-py upstream is >=3.10; we pin 3.11
                           because the offline wheels in this tarball are
                           cp311 manylinux2014_x86_64)
  - Node 18+              (only for serving the prebuilt frontend)
  - Desktop environment + ability to reach https://notebooklm.google.com
    and https://cdn.playwright.dev (for scripts/login.sh later)

Override the Python interpreter with PYTHON_BIN=/path/to/python3.11 if you
have multiple versions installed and `python3` resolves to the wrong one.
============================================================
EOF

# -- Preflight ------------------------------------------------------------
# Find a Python >= 3.11 interpreter. On hosts where the system default
# `python3` is older (e.g. 3.9) but python3.11 is available as a side-install,
# we MUST use the side-install — otherwise `python3 -m venv .venv` creates a
# 3.9 venv and pip then refuses to install the cp311 wheels in wheels/.
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

PY=$(find_python311) || {
    echo "ERROR: need Python >= 3.11 — install python3.11 (e.g. via your distro's package manager)" >&2
    echo "       or set PYTHON_BIN=/full/path/to/python3.11 and re-run." >&2
    exit 1
}
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found" >&2; exit 1; }

PY_VER="$("$PY" -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))')"
echo "✓ $PY $PY_VER ($("$PY" -c 'import sys; print(sys.executable)'))"
echo "✓ node $(node -v)"

# -- venv + offline pip install -------------------------------------------
# If a stale .venv from an earlier (wrong-version) run exists, the operator
# can blow it away with `rm -rf .venv` before re-running this script.
if [ ! -d .venv ]; then
    echo "→ Creating .venv with $PY"
    "$PY" -m venv .venv
fi
echo "→ Installing backend from wheels/ (offline)"
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet --no-index --find-links wheels/ \
    fastapi 'uvicorn[standard]' pydantic pydantic-settings httpx \
    'notebooklm-py[browser,cookies]'
echo "→ Installing notebooklm-bridge package itself"
.venv/bin/pip install --quiet --no-build-isolation --no-deps -e .
echo "✓ Backend installed"

# -- secrets/ directory ---------------------------------------------------
mkdir -p secrets
chmod 700 secrets

# -- .env -----------------------------------------------------------------
# v1.0.3 removed the shared-secret authentication, so .env no longer needs
# operator-supplied credentials. We still copy the template in case the
# operator wants to tweak the rate-limit / circuit-breaker knobs.
if [ ! -f .env ]; then
    cp .env.example .env
    echo "→ Created .env from .env.example"
else
    echo "✓ .env already exists, leaving it alone"
fi

# -- secrets/auth.json check ---------------------------------------------
if [ ! -f secrets/auth.json ]; then
    echo ""
    echo "⚠ secrets/auth.json is missing. The next step (bash scripts/login.sh)"
    echo "  will sign you in to NotebookLM and create it."
else
    chmod 600 secrets/auth.json
    echo "✓ secrets/auth.json present (mode 600)"
fi

cat <<'EOF'

============================================================
✓ Install complete. Next:

  1. Sign in to NotebookLM with your Google account:
       bash scripts/login.sh
     (This pops a Chromium window; sign in, open your target notebook
      once, then close the browser.)

  2. Start the bridge:
       bash scripts/start-web.sh          # binds 0.0.0.0 (LAN)
       bash scripts/start-web.sh --local  # binds 127.0.0.1 only

  3. Verify (default backend port 8002; if start-web.sh auto-incremented
     because 8002 was busy, the actual port is in .runtime-ports.json):
       curl -s http://localhost:8002/api/healthz | jq
       # Expect: auth_valid=true
============================================================
EOF
