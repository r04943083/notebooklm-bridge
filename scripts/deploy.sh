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

# Choose install mode based on what's actually available, instead of forcing
# the operator to pick the right script. Same `bash scripts/deploy.sh` works
# from the source repo (no wheels, but has internet) AND from the tarball
# (wheels present, may be airgapped):
#   - wheels/ present + non-empty  → offline install from those wheels
#   - wheels/ missing + PyPI reachable → online install from PyPI
#   - neither                       → fail with a fix-it hint
if [ -d wheels ] && ls wheels/*.whl >/dev/null 2>&1; then
    INSTALL_MODE=offline
    WHEEL_COUNT=$(ls wheels/*.whl 2>/dev/null | wc -l)
    echo "✓ offline mode (found $WHEEL_COUNT wheel files in wheels/)"
elif "$PY" -c "import urllib.request, socket; socket.setdefaulttimeout(8); urllib.request.urlopen('https://pypi.org/simple/notebooklm-py/').read(1)" 2>/dev/null; then
    INSTALL_MODE=online
    echo "✓ online mode (no wheels/, but PyPI is reachable)"
else
    echo "" >&2
    echo "ERROR: cannot install backend — neither offline nor online path is available." >&2
    echo "       • wheels/ is missing or empty (no offline install possible)" >&2
    echo "       • PyPI (https://pypi.org) is not reachable within 8s either" >&2
    echo "" >&2
    echo "       Fix one of these:" >&2
    echo "         → Get an offline tarball from a machine with internet:" >&2
    echo "             (on dev machine)  bash scripts/pack.sh" >&2
    echo "             scp dist/notebooklm-bridge-vX.Y.Z.tar.gz this-host:~" >&2
    echo "             tar -xzf notebooklm-bridge-vX.Y.Z.tar.gz && cd notebooklm-bridge-vX.Y.Z" >&2
    echo "             bash deploy.sh" >&2
    echo "         → Or point pip at an internal PyPI mirror, then re-run:" >&2
    echo "             mkdir -p ~/.pip && echo -e '[global]\nindex-url = https://your-mirror/simple/' >> ~/.pip/pip.conf" >&2
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
    # On Debian/Ubuntu the venv module ships in a separate apt package
    # (python3.X-venv). If it's missing, `python -m venv` prints a useful
    # hint but then exits non-zero — set -e would otherwise terminate the
    # script with no further context. Catch it explicitly and print a
    # distro-tailored fix.
    if ! "$PY" -m venv .venv; then
        echo "" >&2
        PY_MINOR=$("$PY" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo "?")
        echo "ERROR: '$PY -m venv .venv' failed (see Python's message above)." >&2
        case "$DISTRO" in
            debian)
                echo "" >&2
                echo "  → On Debian/Ubuntu the venv module ships separately. Install it:" >&2
                echo "      sudo apt install -y python3.${PY_MINOR}-venv" >&2
                echo "    Then re-run:  bash $0" >&2
                ;;
            rhel)
                echo "" >&2
                echo "  → On RHEL/CentOS/Rocky/Alma the venv module is bundled with python3.11," >&2
                echo "    so this failure is unusual. Try reinstalling:" >&2
                echo "      sudo dnf reinstall -y python3.11" >&2
                ;;
            suse)
                echo "" >&2
                echo "  → On openSUSE/SLES:  sudo zypper install -y python311-base" >&2
                ;;
            *)
                echo "" >&2
                echo "  → Install the venv module for your Python distribution and re-run." >&2
                ;;
        esac
        exit 1
    fi
fi
echo "→ Upgrading pip"
.venv/bin/pip install --quiet --upgrade pip
if [ "$INSTALL_MODE" = "offline" ]; then
    echo "→ Installing backend from wheels/ (offline)"
    .venv/bin/pip install --quiet --no-index --find-links wheels/ \
        fastapi 'uvicorn[standard]' pydantic pydantic-settings httpx \
        'notebooklm-py[browser,cookies]'
    .venv/bin/pip install --quiet --no-build-isolation --no-deps -e .
else
    # Online: let pip resolve everything from PyPI via the package's
    # [runtime] extra (which pins notebooklm-py[browser,cookies]==0.4.1).
    echo "→ Installing backend from PyPI (online, may take a minute)"
    .venv/bin/pip install --quiet -e '.[runtime]'
fi
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
