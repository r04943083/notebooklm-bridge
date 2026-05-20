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

# deploy.sh ships at the tarball's top-level directory (pack.sh copies it there
# from scripts/), but in the source repo it actually lives at scripts/deploy.sh.
# Auto-locate the project root by looking for pyproject.toml so both invocations
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

# Detect distro family (debian / rhel / suse / other) so we can suggest the
# right `apt`/`dnf`/`zypper` command when something's missing.
detect_distro() {
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        for tag in "${ID:-}" ${ID_LIKE:-}; do
            case "$tag" in
                debian|ubuntu) echo "debian"; return ;;
                rhel|centos|rocky|almalinux|fedora) echo "rhel"; return ;;
                suse|opensuse|opensuse-leap|opensuse-tumbleweed|sles) echo "suse"; return ;;
            esac
        done
    fi
    echo "other"
}

DISTRO=$(detect_distro)

# Distro-specific hint for installing Python 3.11. Printed only when the probe
# fails — most hosts already have it and don't need to read this.
print_python311_install_hint() {
    case "$DISTRO" in
        debian)
            echo "       Ubuntu 22.04+ / Debian 12+:"
            echo "         sudo apt update && sudo apt install -y python3.11 python3.11-venv"
            echo "       Ubuntu 20.04 needs the deadsnakes PPA first:"
            echo "         sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt update"
            echo "         sudo apt install -y python3.11 python3.11-venv"
            ;;
        rhel)
            echo "       RHEL 9 / CentOS Stream 9 / Rocky 9 / AlmaLinux 9:"
            echo "         sudo dnf install -y python3.11"
            echo "       (3.11 is in the default AppStream; venv module is bundled — no separate -venv package)"
            ;;
        suse)
            echo "       openSUSE / SLES:"
            echo "         sudo zypper install -y python311 python311-venv"
            ;;
        *)
            echo "       Distro not detected. Install Python 3.11 via your package manager"
            echo "       or pyenv (https://github.com/pyenv/pyenv)."
            ;;
    esac
    echo ""
    echo "       If python3.11 ends up at a non-PATH location, point at it explicitly:"
    echo "         PYTHON_BIN=/full/path/to/python3.11 bash deploy.sh"
}

PY=$(find_python311) || {
    echo "ERROR: need Python >= 3.11 to create the venv (detected distro: $DISTRO)" >&2
    print_python311_install_hint >&2
    exit 1
}
command -v node >/dev/null 2>&1 || {
    case "$DISTRO" in
        debian) echo "ERROR: node not found — sudo apt install -y nodejs (or use NodeSource for Node 18+)" >&2 ;;
        rhel)   echo "ERROR: node not found — sudo dnf module install -y nodejs:20  (or use NodeSource)" >&2 ;;
        suse)   echo "ERROR: node not found — sudo zypper install -y nodejs20" >&2 ;;
        *)      echo "ERROR: node not found — install Node 18+ via your package manager" >&2 ;;
    esac
    exit 1
}

PY_VER="$("$PY" -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))')"
echo "✓ $PY $PY_VER ($("$PY" -c 'import sys; print(sys.executable)'))"
echo "✓ node $(node -v)"

# wheels/ must exist and be non-empty — this is the one hard difference between
# deploy.sh (offline install from tarball) and a dev install. Developers running
# this in the source repo by mistake should hit this early with a clear hint to
# use setup.sh / pack.sh instead, NOT a downstream "pip: file not found".
if [ ! -d wheels ] || ! ls wheels/*.whl >/dev/null 2>&1; then
    echo "" >&2
    echo "ERROR: wheels/ missing or empty at $HERE." >&2
    echo "       deploy.sh installs from offline wheels — meant ONLY for the tarball" >&2
    echo "       produced by scripts/pack.sh, not for the source repo." >&2
    echo "" >&2
    echo "  → On the deploy host:  get the tarball from the developer machine first" >&2
    echo "      tar -xzf notebooklm-bridge-vX.Y.Z.tar.gz" >&2
    echo "      cd notebooklm-bridge-vX.Y.Z && bash deploy.sh" >&2
    echo "" >&2
    echo "  → On the developer machine (dev install, not deploy):" >&2
    echo "      bash scripts/setup.sh" >&2
    echo "      # or:  $PY -m venv .venv && .venv/bin/pip install -e '.[runtime,dev]'" >&2
    exit 1
fi

# -- venv + offline pip install -------------------------------------------
# Detect a broken .venv (directory exists but bin/pip missing / non-executable).
# Common causes: an interrupted earlier `python -m venv` run, a venv created
# `--without-pip`, or carrying over a .venv from a different distro. If we
# just check `-d .venv` and skip creation, the pip step below fails with a
# useless "no such file or directory". Detect and rebuild instead.
if [ -d .venv ] && [ ! -x .venv/bin/pip ]; then
    echo "→ Found broken .venv (no working pip inside); removing for clean re-create"
    rm -rf .venv
fi

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
