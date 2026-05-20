#!/usr/bin/env bash
# First-time install (and upgrade) on a target LAN host. Run from inside an
# unpacked notebooklm-bridge-vX.Y.Z/ directory — or from this repo's checkout.
#
# What this does (idempotent — safe to re-run for upgrades):
#   1. Find a usable Python (>=3.11, any minor — 3.11 / 3.12 / 3.13 all OK)
#      and node.
#   2. rsync source into the fixed install path (default ~/notebooklm-bridge,
#      override with NOTEBOOKLM_BRIDGE_HOME=/path). Preserves secrets/, .env,
#      state.json, .venv/, .runtime-ports.json, log/pid files across versions.
#   3. Create .venv at $INSTALL_HOME/.venv and install backend from PyPI.
#   4. Run `playwright install chromium` so login.sh has the browser ready.
#   5. Create secrets/ (mode 700) and .env (from .env.example if missing).
#   6. Print next steps (cd $INSTALL_HOME → login.sh → start-web.sh).
#
# What this does NOT do — by design:
#   * Mint Google cookies (scripts/login.sh does that — see "Next steps" below)
#   * Start the service (operator runs scripts/start-web.sh after login.sh)
#
# v2.0 simplifications:
#   - online-only install (no offline wheels/; `git checkout v1.0.10` for offline)
#   - fixed install path: deploy.sh + upgrade are the same command
#   - .venv lives under the install path, not the tarball-extract directory

set -euo pipefail

# deploy.sh ships at the tarball's top-level directory (pack.sh copies it there
# from scripts/), but in the source repo it actually lives at scripts/deploy.sh.
# Auto-locate the source root by looking for pyproject.toml so both invocations
# work:
#   ./deploy.sh                  (from inside an unpacked tarball)
#   ./scripts/deploy.sh          (from inside the source repo)
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$HERE/pyproject.toml" ]; then
    if [ -f "$HERE/../pyproject.toml" ]; then
        HERE="$(cd "$HERE/.." && pwd)"
    else
        echo "ERROR: pyproject.toml not found at $HERE or one level up." >&2
        echo "       deploy.sh must be invoked from the tarball's top-level directory" >&2
        echo "       (where pack.sh placed it), or from scripts/ in the source repo." >&2
        exit 1
    fi
fi

INSTALL_HOME="${NOTEBOOKLM_BRIDGE_HOME:-$HOME/notebooklm-bridge}"

cat <<EOF
============================================================
 notebooklm-bridge — deploy
============================================================
Source dir:    $HERE
Install path:  $INSTALL_HOME    (override with NOTEBOOKLM_BRIDGE_HOME=/path)

Required on this host:
  - Python >= 3.11        (any minor; 3.11 / 3.12 / 3.13 all work — pip
                           picks the right wheels for whichever you have)
  - Node 18+              (only for serving the prebuilt frontend)
  - Outbound HTTPS to pypi.org + cdn.playwright.dev (deploy.sh downloads
    Python deps + Chromium browser, ~150MB total)
  - Desktop environment + outbound HTTPS to notebooklm.google.com
    (for scripts/login.sh later)

Override Python with PYTHON_BIN=/path/to/python if needed.
============================================================
EOF

# -- Preflight ------------------------------------------------------------
# Find a Python >= 3.11. Any minor version is fine — we install online from
# PyPI, so pip auto-selects wheels matching the local interpreter.
check_py_ver() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null
}
find_python() {
    if [ -n "${PYTHON_BIN:-}" ]; then
        if check_py_ver "$PYTHON_BIN"; then
            echo "$PYTHON_BIN"; return 0
        fi
        echo "ERROR: PYTHON_BIN=$PYTHON_BIN does not point at Python >= 3.11" >&2
        return 1
    fi
    for cand in python3.13 python3.12 python3.11 python3; do
        if command -v "$cand" >/dev/null 2>&1 && check_py_ver "$cand"; then
            echo "$cand"; return 0
        fi
    done
    return 1
}

PY=$(find_python) || {
    cat >&2 <<EOF
ERROR: no Python >= 3.11 found on this host.

  Install one for your distro:
    Ubuntu/Debian:  sudo apt install -y python3 python3-venv    # (3.12 ships with 24.04; 3.11 with 22.04 via deadsnakes)
    RHEL/CentOS 9:  sudo dnf install -y python3.11              # (venv module is bundled, no -venv subpkg needed)
    openSUSE/SLES:  sudo zypper install -y python311 python311-venv

  Then re-run:  bash $0
  Or, if your Python lives somewhere outside \$PATH:
    PYTHON_BIN=/full/path/to/python3 bash $0
EOF
    exit 1
}
command -v node >/dev/null 2>&1 || {
    echo "ERROR: node not found." >&2
    echo "       Install Node 18+ via your package manager (apt/dnf/zypper) or NodeSource." >&2
    exit 1
}
command -v rsync >/dev/null 2>&1 || {
    echo "ERROR: rsync not found (required to sync source into the install path)." >&2
    echo "       Ubuntu/Debian: sudo apt install -y rsync" >&2
    echo "       RHEL/CentOS:   sudo dnf install -y rsync" >&2
    exit 1
}

PY_VER="$("$PY" -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))')"
echo "✓ $PY $PY_VER ($("$PY" -c 'import sys; print(sys.executable)'))"
echo "✓ node $(node -v)"

# -- Sync source into the fixed install path ------------------------------
# Skip rsync if $HERE already IS $INSTALL_HOME (user re-running deploy.sh
# from inside their install directory — common during upgrade testing).
# Use realpath so symlinks / relative paths don't trick the comparison.
mkdir -p "$INSTALL_HOME"
HERE_REAL=$(realpath "$HERE")
INSTALL_REAL=$(realpath "$INSTALL_HOME")
if [ "$HERE_REAL" = "$INSTALL_REAL" ]; then
    echo "→ Already in install path ($INSTALL_HOME); source sync skipped"
else
    echo "→ Syncing source $HERE → $INSTALL_HOME"
    # --delete-after removes files from $INSTALL_HOME that no longer exist in
    # the new source (e.g. when v2.1 deletes a backend module that v2.0 had).
    # Exclusions: runtime/state assets that must survive across versions.
    rsync -a --delete-after \
        --exclude='secrets/' \
        --exclude='.env' \
        --exclude='state.json' \
        --exclude='.venv/' \
        --exclude='.runtime-ports.json' \
        --exclude='.backend.pid' --exclude='.frontend.pid' \
        --exclude='.backend.log' --exclude='.frontend.log' \
        --exclude='__pycache__' \
        --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='.ruff_cache' \
        --exclude='dist/' \
        --exclude='.git/' \
        --exclude='node_modules/' \
        "$HERE"/ "$INSTALL_HOME"/
fi
cd "$INSTALL_HOME"

# -- venv + online pip install --------------------------------------------
# Detect a broken .venv (directory exists but bin/pip missing / non-executable).
# Common causes: an interrupted earlier `python -m venv` run, a venv created
# `--without-pip`, or carrying over a .venv from a different distro / Python.
if [ -d .venv ] && [ ! -x .venv/bin/pip ]; then
    echo "→ Found broken .venv (no working pip inside); removing for clean re-create"
    rm -rf .venv
fi

if [ ! -d .venv ]; then
    echo "→ Creating .venv with $PY"
    # On Debian/Ubuntu the venv module ships in a separate apt package
    # (python3.X-venv). If it's missing, `python -m venv` prints a useful
    # hint but then exits non-zero — set -e would otherwise terminate the
    # script with no further context. Catch it explicitly and give a hint.
    if ! "$PY" -m venv .venv; then
        PY_MINOR=$("$PY" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo "?")
        cat >&2 <<EOF

ERROR: '$PY -m venv .venv' failed (see Python's message above).

  Most likely the venv module isn't installed for your Python:
    Ubuntu/Debian:  sudo apt install -y python3.${PY_MINOR}-venv
    RHEL/CentOS:    sudo dnf reinstall -y python3.11             # (venv is bundled; reinstall usually fixes)
    openSUSE/SLES:  sudo zypper install -y python311-base

  Then re-run:  bash $0
EOF
        exit 1
    fi
else
    echo "✓ Reusing existing .venv at $INSTALL_HOME/.venv"
fi
echo "→ Upgrading pip (this can be slow on a constrained network — pip's own progress will print)"
.venv/bin/pip install --upgrade pip

# Install backend via the [runtime] extra (which pins
# notebooklm-py[browser,cookies]==0.4.1 + playwright + rookiepy).
# Output is NOT quieted — on slow / proxied networks the install can take
# several minutes; seeing pip's per-package progress is the only way the
# operator knows it's working and not hung.
echo "→ Installing backend from PyPI (online; expect a few minutes on slow networks)"
.venv/bin/pip install -e '.[runtime]'
echo "✓ Backend installed"

# -- Playwright Chromium ---------------------------------------------------
# notebooklm-py's CLI uses playwright under the hood to pop a browser window
# during `notebooklm login`. The Python `playwright` package is installed via
# the [runtime] extra above, but the actual Chromium browser binary is a
# separate ~150MB download from cdn.playwright.dev. `playwright install
# chromium` is idempotent — if the binary's already present it just prints
# "is already installed" and exits 0.
#
# Pre-v2.0 we left this to login.sh's "first run will fetch" hint, but that
# was based on a wrong assumption: notebooklm-py's CLI does NOT auto-fetch
# Chromium, it just crashes with BrowserError. So login.sh would fail every
# time on a fresh install. Doing it here in deploy.sh means login.sh always
# has the browser available.
echo "→ Installing Playwright Chromium (~150MB one-time download; skipped if already present)"
if ! .venv/bin/playwright install chromium; then
    cat >&2 <<EOF

ERROR: playwright install chromium failed.

  Most common cause: outbound network to cdn.playwright.dev is blocked or
  unstable. Re-run deploy.sh, or manually:
    cd $INSTALL_HOME
    .venv/bin/playwright install chromium
EOF
    exit 1
fi
echo "✓ Playwright Chromium ready"

# -- secrets/ directory ---------------------------------------------------
mkdir -p secrets
chmod 700 secrets

# -- .env -----------------------------------------------------------------
# Preserve existing .env across upgrades (rsync excluded it, but double-check).
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

cat <<EOF

============================================================
✓ Install complete. Next:

  cd $INSTALL_HOME

  1. Sign in to NotebookLM with your Google account:
       bash scripts/login.sh
     (This pops a Chromium window; sign in, open your target notebook
      once, then close the browser. Skip if upgrading and cookies still
      valid — check with curl on /api/healthz.)

  2. Start the bridge:
       bash scripts/start-web.sh          # binds 0.0.0.0 (LAN)
       bash scripts/start-web.sh --local  # binds 127.0.0.1 only

  3. Verify (default backend port 8002; if start-web.sh auto-incremented
     because 8002 was busy, the actual port is in .runtime-ports.json):
       curl -s http://localhost:8002/api/healthz | jq
       # Expect: auth_valid=true
============================================================
EOF
