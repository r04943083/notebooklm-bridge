#!/usr/bin/env bash
# Build a release tarball that another LAN host can `tar -xzf && bash deploy.sh`.
#
# Output layout (single-layer tar, see plan §10):
#   dist/notebooklm-bridge-vX.Y.Z.tar.gz
#       notebooklm-bridge-vX.Y.Z/
#           backend/                 .py sources (no __pycache__)
#           frontend/dist/           pre-built static assets
#           wheels/                  offline pip wheels (so target needs no PyPI)
#           scripts/                 start-web / stop-web / status-web / _supervise
#           docs/
#           pyproject.toml
#           requirements-runtime.txt
#           README.md  CLAUDE.md  plan.md  .env.example
#           deploy.sh                first-time target-host install
#           update.sh                in-place upgrade
#           README_DEPLOY.md         runbook
#   dist/notebooklm-bridge-vX.Y.Z.tar.gz.sha256
#
# Not packed: secrets/, .env, .git, dist/, build/, .venv, tests, node_modules,
# anything that's a runtime/secret/devtool artefact. Cookies + the shared
# secret get filled in by the operator on the target host (see deploy.sh).
#
# Inspired by ../cpp_rename/scripts/pack.sh (offline wheels) and
# ../E2UniScript/scripts/pack.sh (single-layer tar + exclude list).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# -- [1/6] Version consistency --------------------------------------------
PY_VER="$(grep -oE 'version = "[^"]+"' pyproject.toml | head -1 | sed -E 's/version = "(.*)"/\1/')"
NPM_VER="$(node -p "require('./frontend/package.json').version")"
if [ "$PY_VER" != "$NPM_VER" ]; then
    echo "ERROR: version mismatch:" >&2
    echo "  pyproject.toml       = $PY_VER" >&2
    echo "  frontend/package.json = $NPM_VER" >&2
    echo "Bump both to the same value before packing." >&2
    exit 1
fi
VER="$PY_VER"
NAME="notebooklm-bridge-v${VER}"

STAGE_PARENT="$(mktemp -d -t nblm-pack-XXXX)"
STAGE="$STAGE_PARENT/$NAME"
trap 'rm -rf "$STAGE_PARENT"' EXIT
mkdir -p "$STAGE"
echo "[1/6] Packing $NAME"
echo "      stage = $STAGE"

# -- [2/6] Build frontend --------------------------------------------------
echo "[2/6] Building frontend"
(
    cd frontend
    if [ -d node_modules ]; then
        npm run build
    else
        npm ci
        npm run build
    fi
)

# -- [3/6] Download offline wheels ----------------------------------------
echo "[3/6] Downloading wheels (target: Python 3.11 + Linux x86_64 manylinux2014)"
mkdir -p "$STAGE/wheels"
# Pin the wheel set's ABI / platform / Python version explicitly. Without
# this, pip download picks the LOCAL interpreter's tag, so packing on 3.12
# would ship cp312 wheels (httptools / uvloop / watchfiles / pyyaml) that
# refuse to install on a 3.11 deploy host — this is the bug v1.0.1 is
# fixing. manylinux2014 covers glibc ≥ 2.17 (RHEL 7+ / Ubuntu 18+).
#
# --only-binary=:all: makes pip fail loudly if any dep lacks a matching
# wheel, instead of falling back to an sdist that the deploy host (offline
# and likely without gcc) can't compile.
python3 -m pip download \
    --dest "$STAGE/wheels" \
    --python-version 3.11 \
    --platform manylinux2014_x86_64 \
    --implementation cp \
    --abi cp311 \
    --only-binary=:all: \
    --requirement requirements-runtime.txt

# -- [4/6] Stage sources ---------------------------------------------------
echo "[4/6] Staging sources"

# Backend — strip caches but keep the full package tree.
rsync -a \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='*.pyo' \
    --exclude='.pytest_cache' \
    --exclude='.mypy_cache' \
    --exclude='.ruff_cache' \
    backend/ "$STAGE/backend/"

# Frontend — only the build output + package.json (for `vite preview` /
# `npm run preview` to serve it on the target). No node_modules, no src.
mkdir -p "$STAGE/frontend"
cp -r frontend/dist "$STAGE/frontend/dist"
cp frontend/package.json "$STAGE/frontend/package.json"
cp frontend/package-lock.json "$STAGE/frontend/package-lock.json" 2>/dev/null || true
cp frontend/vite.config.ts "$STAGE/frontend/vite.config.ts" 2>/dev/null || true
cp -r frontend/public "$STAGE/frontend/public" 2>/dev/null || true

# Scripts (start-web / stop-web / status-web / _supervise / setup).
mkdir -p "$STAGE/scripts"
for f in scripts/start-web.sh scripts/stop-web.sh scripts/status-web.sh scripts/_supervise.sh scripts/setup.sh; do
    if [ -f "$f" ]; then
        cp "$f" "$STAGE/scripts/"
    fi
done

# Docs (runbooks live here; copy whole tree, skip if absent).
if [ -d docs ]; then
    rsync -a docs/ "$STAGE/docs/"
fi

# Top-level files.
cp pyproject.toml "$STAGE/"
cp requirements-runtime.txt "$STAGE/"
cp README.md "$STAGE/"
cp CLAUDE.md "$STAGE/" 2>/dev/null || true
cp plan.md "$STAGE/" 2>/dev/null || true
cp .env.example "$STAGE/"

# -- [5/6] Bundle deploy scripts ------------------------------------------
echo "[5/6] Bundling deploy scripts"
cp scripts/deploy.sh "$STAGE/deploy.sh"
cp scripts/update.sh "$STAGE/update.sh"
cp scripts/README_DEPLOY.md "$STAGE/README_DEPLOY.md"
chmod +x "$STAGE/deploy.sh" "$STAGE/update.sh"
chmod +x "$STAGE/scripts/"*.sh

# -- [6/6] Tar + sha256 ----------------------------------------------------
echo "[6/6] Tar + SHA256"
mkdir -p "$ROOT/dist"
TARBALL="$ROOT/dist/${NAME}.tar.gz"
(cd "$STAGE_PARENT" && tar -czf "$TARBALL" "$NAME")
(cd "$ROOT/dist" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256")

SIZE="$(du -h "$TARBALL" | awk '{print $1}')"
SHA="$(awk '{print $1}' "$ROOT/dist/${NAME}.tar.gz.sha256")"

cat <<EOF

✓ Built dist/${NAME}.tar.gz ($SIZE)
  sha256: $SHA

Deploy on the target host:
  tar -xzf ${NAME}.tar.gz
  cd ${NAME}
  bash deploy.sh
  # then drop in secrets/auth.json + edit .env, see README_DEPLOY.md

Upgrade an existing install (in same directory):
  tar -xzf ${NAME}.tar.gz
  cd ${NAME}
  bash update.sh /path/to/previous/install
EOF
