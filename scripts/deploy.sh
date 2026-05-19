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
#   * Generate INTERNAL_AUTH_SHARED_SECRET for you (operator pastes the value)
#   * Copy secrets/auth.json (operator brings cookies from Phase 1 host)
#   * Start the service (operator runs start-web.sh after secrets are in place)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

cat <<'EOF'
============================================================
 notebooklm-bridge — first-time deploy
============================================================
Required on this host:
  - Python 3.11+
  - Node 18+              (only for serving the prebuilt frontend)
  - Ability to reach https://notebooklm.google.com from this host

You will need:
  - secrets/auth.json     Google cookies from your Phase 1 host
  - .env with INTERNAL_AUTH_SHARED_SECRET = $(openssl rand -hex 32)
============================================================
EOF

# -- Preflight ------------------------------------------------------------
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found" >&2; exit 1; }
command -v node    >/dev/null 2>&1 || { echo "ERROR: node not found"    >&2; exit 1; }

PY_VER="$(python3 -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))')"
PY_MAJOR="${PY_VER%.*}"
PY_MINOR="${PY_VER#*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
    echo "ERROR: python3 must be >= 3.11 (you have $PY_VER)" >&2
    exit 1
fi
echo "✓ python3 $PY_VER"
echo "✓ node $(node -v)"

# -- venv + offline pip install -------------------------------------------
if [ ! -d .venv ]; then
    echo "→ Creating .venv"
    python3 -m venv .venv
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

# -- .env (auto-generate INTERNAL_AUTH_SHARED_SECRET) --------------------
if [ ! -f .env ]; then
    cp .env.example .env
    echo "→ Created .env from .env.example"
fi

# If the secret is still the placeholder, generate one. IT used to be told
# "go run openssl rand -hex 32 yourself", which was easy to miss.
if grep -q "<32B random" .env; then
    if command -v openssl >/dev/null 2>&1; then
        SECRET=$(openssl rand -hex 32)
        # Both GNU and BSD sed: write to a tmp file and mv to be portable.
        sed "s|<32B random — replace this placeholder>|$SECRET|" .env > .env.tmp \
            && mv .env.tmp .env
        echo "✓ Generated INTERNAL_AUTH_SHARED_SECRET (32 random bytes) in .env"
    else
        echo "⚠ openssl not found — please paste a 32-byte hex value into .env yourself:"
        echo "    INTERNAL_AUTH_SHARED_SECRET=<your value>"
    fi
else
    echo "✓ .env already has INTERNAL_AUTH_SHARED_SECRET set, leaving it alone"
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

  3. Verify:
       curl -s http://localhost:8002/api/healthz | jq
       # Expect: auth_valid=true
============================================================
EOF
