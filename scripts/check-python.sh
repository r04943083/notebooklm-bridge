#!/usr/bin/env bash
# Validate the Python environment for notebooklm-bridge install, and persist
# the resolved interpreter + library paths to $INSTALL_HOME/.python-env so
# deploy.sh and start-web.sh pick them up automatically.
#
# Most operators don't need this — deploy.sh's auto-detect handles Python
# from distro package managers (apt/dnf/zypper) just fine. Run this when:
#   - Your Python is in an unusual location (e.g. /opt/devtoolset/python-3.11.4/)
#   - deploy.sh's auto-detect reports "no Python >= 3.11 found"
#   - A self-built Python is failing to load libpython.so / libssl.so
#
# Usage:
#   bash scripts/check-python.sh                                             # auto-detect (same as deploy.sh)
#   bash scripts/check-python.sh --python-path=/opt/devtoolset/python-3.11.4 # install root (has bin/ + lib/)
#   bash scripts/check-python.sh --python-bin=/full/path/to/python3          # explicit binary
#
# Env vars:
#   NOTEBOOKLM_BRIDGE_HOME — install path (default: $HOME/notebooklm-bridge)
#
# Output on success:
#   Writes $INSTALL_HOME/.python-env with PYTHON_BIN (+ LD_LIBRARY_PATH if
#   needed). Re-run any time to regenerate.

set -euo pipefail

PYTHON_ROOT=""
PYTHON_BIN_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --python-path=*) PYTHON_ROOT="${1#*=}"; shift ;;
        --python-path)   PYTHON_ROOT="${2:?--python-path needs a value}"; shift 2 ;;
        --python-bin=*)  PYTHON_BIN_ARG="${1#*=}"; shift ;;
        --python-bin)    PYTHON_BIN_ARG="${2:?--python-bin needs a value}"; shift 2 ;;
        -h|--help)
            sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

INSTALL_HOME="${NOTEBOOKLM_BRIDGE_HOME:-$HOME/notebooklm-bridge}"
PYENV_FILE="$INSTALL_HOME/.python-env"

cat <<EOF
============================================================
 notebooklm-bridge — check-python
============================================================
Install path:    $INSTALL_HOME    (override: NOTEBOOKLM_BRIDGE_HOME=/path)
Env file:        $PYENV_FILE
EOF
[ -n "$PYTHON_ROOT" ]    && echo "Python root:     $PYTHON_ROOT"
[ -n "$PYTHON_BIN_ARG" ] && echo "Python binary:   $PYTHON_BIN_ARG"
echo "============================================================"

# -- Resolve candidate binary ---------------------------------------------
candidate=""
extra_libs=""   # accumulated LD_LIBRARY_PATH entries (most-specific first)

if [ -n "$PYTHON_BIN_ARG" ]; then
    candidate="$PYTHON_BIN_ARG"
    if [ ! -x "$candidate" ]; then
        echo "ERROR: $candidate is not an executable file." >&2; exit 1
    fi
elif [ -n "$PYTHON_ROOT" ]; then
    PYTHON_ROOT="${PYTHON_ROOT%/}"
    for name in python3 python3.13 python3.12 python3.11; do
        if [ -x "$PYTHON_ROOT/bin/$name" ]; then
            candidate="$PYTHON_ROOT/bin/$name"; break
        fi
    done
    if [ -z "$candidate" ]; then
        echo "ERROR: no python3* binary under $PYTHON_ROOT/bin/" >&2; exit 1
    fi
    # If the install ships its own libpython, pre-seed LD_LIBRARY_PATH with it
    # so the binary can find its own .so even before we probe.
    if ls "$PYTHON_ROOT/lib/libpython3."*.so* >/dev/null 2>&1; then
        extra_libs="$PYTHON_ROOT/lib"
    fi
else
    for name in python3.13 python3.12 python3.11 python3; do
        if command -v "$name" >/dev/null 2>&1; then
            candidate="$(command -v "$name")"; break
        fi
    done
    if [ -z "$candidate" ]; then
        cat >&2 <<EOF
ERROR: no python3* on PATH.

  Install one for your distro:
    Ubuntu/Debian:  sudo apt install -y python3.11 python3.11-venv
    RHEL/CentOS 9:  sudo dnf install -y python3.11
    openSUSE/SLES:  sudo zypper install -y python311 python311-venv

  Or, if your Python lives somewhere outside \$PATH:
    bash $0 --python-path=/full/path/to/python-3.X.Y/
EOF
        exit 1
    fi
fi
echo "→ Candidate: $candidate"

# -- Probe helper ---------------------------------------------------------
# Runs the candidate with current $extra_libs prepended to LD_LIBRARY_PATH.
# Captures combined stderr+stdout into $probe_out, returns the exit code.
probe() {
    probe_out=$(LD_LIBRARY_PATH="${extra_libs}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
        "$candidate" -c "$1" 2>&1) || return $?
    return 0
}

# -- Step 1: binary can load (catches missing libpython.so) ---------------
if ! probe 'import sys; print(sys.version_info[:3])'; then
    if echo "$probe_out" | grep -q "error while loading shared libraries"; then
        missing=$(echo "$probe_out" | sed -n 's/.*shared libraries: \([^:]*\):.*/\1/p' | head -1)
        echo "✗ Binary can't load $missing — searching for it"
        # Look under the install root (parent of bin/) first.
        found=""
        if [ -n "$PYTHON_ROOT" ] || [ -n "$PYTHON_BIN_ARG" ]; then
            search_root="$(dirname "$(dirname "$candidate")")"
            found=$(find "$search_root" -name "$missing" 2>/dev/null | head -1)
        fi
        if [ -n "$found" ]; then
            extra_libs="$(dirname "$found")${extra_libs:+:$extra_libs}"
            echo "  → found $found; retrying with LD_LIBRARY_PATH=$extra_libs"
            probe 'import sys; print(sys.version_info[:3])' || true
        fi
    fi
    if echo "$probe_out" | grep -q "error while loading"; then
        echo "ERROR: $candidate still can't find shared libs. Last error:" >&2
        echo "$probe_out" >&2
        exit 1
    fi
fi
probe 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))'
ver="$probe_out"
echo "✓ Python $ver"

# -- Step 2: version >= 3.11 ----------------------------------------------
if ! probe 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'; then
    echo "ERROR: $candidate is $ver, but Python >= 3.11 is required." >&2; exit 1
fi

# -- Step 3: ssl module works (catches missing libssl.so.1.1) -------------
if ! probe 'import ssl; print(ssl.OPENSSL_VERSION)'; then
    if echo "$probe_out" | grep -q "libssl.so.1.1: cannot open"; then
        echo "✗ ssl module wants libssl.so.1.1 (OpenSSL 1.1) but it's not on the system"
        # RHEL 9 / CentOS Stream 9 default to OpenSSL 3.x; self-built Pythons
        # linked against 1.1 need a sibling install of OpenSSL 1.1. Common spots:
        ssl_found=""
        for cand_dir in /opt/devtoolset/openssl-1.* /usr/local/openssl-1.1* /opt/openssl-1.1*; do
            [ -d "$cand_dir/lib" ] || continue
            if [ -f "$cand_dir/lib/libssl.so.1.1" ]; then
                ssl_found="$cand_dir/lib"; break
            fi
        done
        if [ -n "$ssl_found" ]; then
            extra_libs="$ssl_found${extra_libs:+:$extra_libs}"
            echo "  → found $ssl_found/libssl.so.1.1; retrying"
            probe 'import ssl; print(ssl.OPENSSL_VERSION)' || true
        fi
    fi
    if ! echo "$probe_out" | grep -q "OpenSSL"; then
        cat >&2 <<EOF
ERROR: Python ssl module not usable. Last output:
$probe_out

  This Python was compiled without OpenSSL, or against an OpenSSL version
  that's no longer on the system. Without ssl, pip can't reach pypi.org.

  Options:
    1. Install distro Python instead (apt/dnf/zypper — see --help text).
    2. If you have OpenSSL 1.1 elsewhere, pass its parent dir to LD_LIBRARY_PATH
       and re-run this script.
    3. Rebuild this Python against the system's current OpenSSL.
EOF
        exit 1
    fi
fi
echo "✓ ssl module ($probe_out)"

# -- Step 4: venv module --------------------------------------------------
if ! probe 'import venv'; then
    probe 'import sys; print(sys.version_info.minor)' || true
    py_minor="$probe_out"
    cat >&2 <<EOF
ERROR: $candidate is missing the venv module.

  Ubuntu/Debian:  sudo apt install -y python3.${py_minor}-venv
  RHEL/CentOS:    sudo dnf reinstall -y python3.11
  openSUSE/SLES:  sudo zypper install -y python311-base
EOF
    exit 1
fi
echo "✓ venv module"

# -- Persist --------------------------------------------------------------
mkdir -p "$INSTALL_HOME"
{
    echo "# Generated by scripts/check-python.sh on $(date -Iseconds)"
    echo "# Sourced by deploy.sh and start-web.sh."
    echo "# Re-run check-python.sh to regenerate."
    echo "export PYTHON_BIN=\"$candidate\""
    if [ -n "$extra_libs" ]; then
        echo "export LD_LIBRARY_PATH=\"$extra_libs\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
    fi
} > "$PYENV_FILE"
chmod 644 "$PYENV_FILE"

cat <<EOF

============================================================
✓ Python environment validated and persisted.

  File:         $PYENV_FILE
  PYTHON_BIN:   $candidate
EOF
[ -n "$extra_libs" ] && echo "  LD_LIBRARY_PATH (prepended): $extra_libs"
cat <<EOF

  Next:
    bash scripts/deploy.sh         # picks up .python-env automatically
============================================================
EOF
