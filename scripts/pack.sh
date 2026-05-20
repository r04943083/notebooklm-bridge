#!/usr/bin/env bash
# Build a release tarball that another LAN host can `tar -xzf && bash deploy.sh`.
#
# Output layout (single-layer tar, see plan §10):
#   dist/notebooklm-bridge-vX.Y.Z.tar.gz
#       notebooklm-bridge-vX.Y.Z/
#           backend/                 .py sources (no __pycache__)
#           frontend/dist/           pre-built static assets
#           scripts/                 start-web / stop-web / status-web /
#                                    _supervise / login
#           docs/
#           pyproject.toml
#           README.md  CLAUDE.md  plan.md  .env.example
#           deploy.sh                first-time target-host install (copy of scripts/deploy.sh)
#           README_DEPLOY.md         runbook
#   dist/notebooklm-bridge-vX.Y.Z.tar.gz.sha256
#
# Not packed: secrets/, .env, .git, dist/, build/, .venv, tests, node_modules,
# anything that's a runtime/secret/devtool artefact. Cookies get minted on the
# target host by scripts/login.sh.
#
# v2.0 simplification: this tarball no longer ships offline wheels/. deploy.sh
# installs from PyPI online. Tarball size: ~40MB → ~5MB. If a target host is
# truly air-gapped, `git checkout v1.0.10` for the last release that bundled
# offline wheels.
#
# Inspired by ../cpp_rename/scripts/pack.sh and ../E2UniScript/scripts/pack.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# -- [1/5] Version consistency --------------------------------------------
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
echo "[1/5] Packing $NAME"
echo "      stage = $STAGE"

# -- [2/5] Build frontend --------------------------------------------------
echo "[2/5] Building frontend"
(
    cd frontend
    if [ -d node_modules ]; then
        npm run build
    else
        npm ci
        npm run build
    fi
)

# -- [3/5] Stage sources ---------------------------------------------------
echo "[3/5] Staging sources"

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

# Scripts — exactly the 5 the operator runs + the supervisor helper they
# don't run directly. update.sh / setup.sh removed in v2.0 (see CHANGELOG).
mkdir -p "$STAGE/scripts"
for f in scripts/start-web.sh scripts/stop-web.sh scripts/status-web.sh \
         scripts/_supervise.sh scripts/login.sh; do
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
cp README.md "$STAGE/"
cp CLAUDE.md "$STAGE/" 2>/dev/null || true
cp plan.md "$STAGE/" 2>/dev/null || true
cp .env.example "$STAGE/"

# -- [4/5] Bundle deploy script + runbook ---------------------------------
echo "[4/5] Bundling deploy script"
cp scripts/deploy.sh "$STAGE/deploy.sh"
cp scripts/README_DEPLOY.md "$STAGE/README_DEPLOY.md"
chmod +x "$STAGE/deploy.sh"
chmod +x "$STAGE/scripts/"*.sh

# -- [5/5] Tar + sha256 ----------------------------------------------------
echo "[5/5] Tar + SHA256"
mkdir -p "$ROOT/dist"
TARBALL="$ROOT/dist/${NAME}.tar.gz"
(cd "$STAGE_PARENT" && tar -czf "$TARBALL" "$NAME")
(cd "$ROOT/dist" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256")

SIZE="$(du -h "$TARBALL" | awk '{print $1}')"
SHA="$(awk '{print $1}' "$ROOT/dist/${NAME}.tar.gz.sha256")"

cat <<EOF

✓ Built dist/${NAME}.tar.gz ($SIZE)
  sha256: $SHA

Deploy on the target host (needs outbound HTTPS to pypi.org):
  tar -xzf ${NAME}.tar.gz
  cd ${NAME}
  bash deploy.sh
  bash scripts/login.sh
  bash scripts/start-web.sh
EOF
