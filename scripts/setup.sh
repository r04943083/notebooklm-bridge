#!/usr/bin/env bash
# Phase 1 setup helper. Wires the local notebooklm-py CLI to this project:
#
#   1. probe `notebooklm` CLI (must already be installed by the operator)
#   2. notebooklm login → writes ~/.notebooklm/profiles/<profile>/storage_state.json
#   3. copy storage_state.json into ./secrets/auth.json with chmod 600
#   4. pin notebooklm-py in pyproject.toml to the installed version
#   5. pip install -e '.[runtime]'  (so the bridge can `import notebooklm`)
#   6. ensure .env exists (paths point at the local checkout)
#   7. smoke-test: `notebooklm list` (proves the cookies actually work)
#
# Idempotent: every step is gated on its own "already done" check.
# Refuses to clobber existing state without --force.
#
# Usage:
#   scripts/setup.sh                # interactive
#   scripts/setup.sh --yes          # non-interactive, accept all defaults
#   scripts/setup.sh --refresh-cookies   # re-run notebooklm login even if storage_state.json exists
#   scripts/setup.sh --skip-pip          # skip the pip install step
#   scripts/setup.sh --skip-smoke        # skip the CLI smoke test
#   scripts/setup.sh --profile NAME      # use a non-default CLI profile

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Options ────────────────────────────────────────────────
YES=0
REFRESH_COOKIES=0
SKIP_PIP=0
SKIP_SMOKE=0
PROFILE="${NOTEBOOKLM_PROFILE:-default}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) YES=1; shift ;;
        --refresh-cookies) REFRESH_COOKIES=1; shift ;;
        --skip-pip) SKIP_PIP=1; shift ;;
        --skip-smoke) SKIP_SMOKE=1; shift ;;
        --profile) PROFILE="$2"; shift 2 ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# *//'; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Helpers ────────────────────────────────────────────────
say()    { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()     { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
    if [ "$YES" -eq 1 ] || [ ! -t 0 ]; then return 0; fi
    local prompt="$1"
    read -r -p "$prompt [y/N] " resp
    case "$resp" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# pip command. Prefer venv if active; otherwise --user --break-system-packages
# (PEP 668 on Ubuntu/Debian system Python).
pip_install() {
    if [ -n "${VIRTUAL_ENV:-}" ]; then
        python3 -m pip install "$@"
    else
        python3 -m pip install --user --break-system-packages "$@"
    fi
}

# ── Step 0: preflight ──────────────────────────────────────
say "Step 0/7 — preflight checks"

command -v notebooklm >/dev/null 2>&1 \
    || fail "notebooklm CLI not found. Install with: pip install --user --break-system-packages 'notebooklm-py'"
command -v python3 >/dev/null 2>&1 || fail "python3 not found."
command -v openssl >/dev/null 2>&1 || fail "openssl not found (needed to generate the shared secret)."

[ -f "$PROJECT_ROOT/pyproject.toml" ] && [ -d "$PROJECT_ROOT/backend" ] \
    || fail "Not inside the notebooklm-bridge project root (no pyproject.toml / backend/)."

CLI_VERSION=$(notebooklm --version 2>&1 | head -1 || true)
ok "$CLI_VERSION"

# Playwright Chromium needs a pile of system .so files (libnspr4/libnss3 et al.)
# that pip never installs. If anything's missing, offer to install via apt right
# here — interactively (sudo will prompt for the password on the terminal) so
# the user doesn't have to remember a separate command.
#
# We deliberately bypass `playwright install-deps chromium` because that command
# lives in the user-site Python and breaks under `sudo` (root's sys.path drops
# ~/.local). Listing apt packages directly is portable and matches what
# install-deps would do on Ubuntu 24.04 anyway.
CHROME_BIN=$(ls -1 "$HOME"/.cache/ms-playwright/chromium*/chrome-linux*/chrome 2>/dev/null | head -1 || true)
chrome_missing_libs() {
    [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ] \
        && ldd "$CHROME_BIN" 2>/dev/null | awk '/=> not found/ {print $1}' | sort -u
}

if [ -n "$CHROME_BIN" ]; then
    MISSING=$(chrome_missing_libs)
    if [ -n "$MISSING" ]; then
        warn "Playwright's bundled Chromium is missing shared libraries:"
        echo "$MISSING" | sed 's/^/      /' >&2

        # Ubuntu 24.04 package list. libnspr4 + libnss3 alone cover what `ldd`
        # reports missing today; the rest are libraries Chromium dlopen()s at
        # runtime — installing them now avoids a second failure on first launch.
        APT_PKGS=(
            libnspr4 libnss3 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64
            libcups2t64 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2
            libasound2t64 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3
            libxrandr2 libxshmfence1
        )

        echo ""
        echo "    Need to run:"
        echo "      sudo apt-get install -y ${APT_PKGS[*]}"
        echo "    (sudo will prompt for your password on this terminal.)"
        if ! confirm "Run it now?"; then
            fail "Declined. Install the deps yourself and re-run scripts/setup.sh."
        fi

        sudo apt-get install -y "${APT_PKGS[@]}" \
            || fail "apt-get install failed. Fix manually and re-run."

        # Re-verify; if anything is still missing, hard fail with the exact list.
        STILL_MISSING=$(chrome_missing_libs)
        if [ -n "$STILL_MISSING" ]; then
            warn "Still missing after install:"
            echo "$STILL_MISSING" | sed 's/^/      /' >&2
            fail "Playwright Chromium still can't load. Try: sudo $HOME/.local/bin/playwright install-deps chromium (or check Playwright docs)."
        fi
        ok "Chromium deps installed and verified"
    else
        ok "Playwright Chromium deps look fine ($CHROME_BIN)"
    fi
fi

# ── Step 1: notebooklm login → storage_state.json ─────────
say "Step 1/7 — login (storage_state.json)"
NBLM_HOME="${HOME}/.notebooklm"
NBLM_STATE="$NBLM_HOME/profiles/$PROFILE/storage_state.json"
BRIDGE_SECRETS="$PROJECT_ROOT/secrets"
BRIDGE_AUTH="$BRIDGE_SECRETS/auth.json"

mkdir -p "$BRIDGE_SECRETS"

need_login=0
if [ ! -f "$NBLM_STATE" ]; then
    warn "No storage_state.json for profile '$PROFILE' at $NBLM_STATE"
    need_login=1
elif [ "$REFRESH_COOKIES" -eq 1 ]; then
    warn "--refresh-cookies given: re-running login."
    need_login=1
fi

if [ "$need_login" -eq 1 ]; then
    echo "    'notebooklm login' will open a browser. Sign in with the Google account"
    echo "    whose notebooks the bridge should expose; the CLI will close the browser"
    echo "    when authentication completes and persist cookies to:"
    echo "      $NBLM_STATE"
    if ! confirm "Run: notebooklm --profile $PROFILE login ?"; then
        fail "User declined. Re-run when ready, or drop your own storage_state.json at $BRIDGE_AUTH."
    fi
    notebooklm --profile "$PROFILE" login \
        || fail "Login failed. See docs/cookie-refresh-runbook.md for fallbacks."
    [ -f "$NBLM_STATE" ] || fail "Login reported success but $NBLM_STATE is missing."
    ok "Logged in; cookies at $NBLM_STATE"
else
    ok "Existing cookies at $NBLM_STATE (use --refresh-cookies to re-login)"
fi

cp "$NBLM_STATE" "$BRIDGE_AUTH"
chmod 600 "$BRIDGE_AUTH"
ok "Copied to $BRIDGE_AUTH (mode 0600)"

# ── Step 2: detect notebooklm-py version ──────────────────
say "Step 2/7 — detect notebooklm-py version"
NBLM_VERSION=$(python3 -c "
import importlib.metadata as m
try:
    print(m.version('notebooklm-py'))
except m.PackageNotFoundError:
    pass
" 2>/dev/null || true)

if [ -z "$NBLM_VERSION" ]; then
    NBLM_VERSION=$(pipx list --short 2>/dev/null | awk '/^notebooklm-py /{print $2}' || true)
fi

if [ -z "$NBLM_VERSION" ]; then
    warn "Could not detect notebooklm-py version; leaving pyproject.toml placeholder."
else
    ok "notebooklm-py version: $NBLM_VERSION"
fi

# ── Step 3: pin pyproject.toml ─────────────────────────────
say "Step 3/7 — pin pyproject.toml"
PLACEHOLDER='"notebooklm-py>=0.0.0",'
if [ -n "$NBLM_VERSION" ] && grep -qF "$PLACEHOLDER" pyproject.toml; then
    if confirm "Pin pyproject.toml to notebooklm-py==$NBLM_VERSION ?"; then
        if sed --version >/dev/null 2>&1; then
            sed -i "s|$PLACEHOLDER|\"notebooklm-py==$NBLM_VERSION\",|" pyproject.toml
        else
            sed -i '' "s|$PLACEHOLDER|\"notebooklm-py==$NBLM_VERSION\",|" pyproject.toml
        fi
        ok "pyproject.toml pinned to $NBLM_VERSION"
    else
        warn "Skipped pin; pyproject.toml still has placeholder."
    fi
elif [ -n "$NBLM_VERSION" ] && grep -qF "notebooklm-py==$NBLM_VERSION" pyproject.toml; then
    ok "pyproject.toml already pinned to $NBLM_VERSION"
else
    ok "Pin step skipped (no detected version or non-placeholder pin already present)"
fi

# ── Step 4: pip install -e .[runtime] ─────────────────────
say "Step 4/7 — pip install -e '.[runtime]'"
if [ "$SKIP_PIP" -eq 1 ]; then
    warn "Skipped (--skip-pip)"
elif python3 -c "import notebooklm" 2>/dev/null; then
    ok "notebooklm already importable in python3 (skipping install)"
else
    if confirm "Run: pip install -e '.[runtime]' (user-site if not in venv) ?"; then
        pip_install -e '.[runtime]' >/tmp/nblm-pip.log 2>&1 \
            && ok "Installed runtime deps (full log: /tmp/nblm-pip.log)" \
            || fail "pip install failed. See /tmp/nblm-pip.log"
        python3 -c "import notebooklm" 2>/dev/null \
            || fail "After install, 'import notebooklm' still fails. Check /tmp/nblm-pip.log."
        ok "import notebooklm OK"
    else
        warn "Skipped install; bridge will run in degraded mode (chat returns 503)."
    fi
fi

# ── Step 5: .env (backend) ─────────────────────────────────
# v1.0.3 dropped the X-Shared-Secret authn entirely, so this step has shrunk
# to "make sure .env exists and points at sane local paths".
say "Step 5/7 — .env"
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
    ok "Created .env from .env.example"
fi

# Rewrite the /opt example paths only if they're still the example defaults.
sed -i 's|^NOTEBOOKLM_AUTH_JSON=/opt/notebooklm-bridge/secrets/auth.json|NOTEBOOKLM_AUTH_JSON=./secrets/auth.json|' "$PROJECT_ROOT/.env"
sed -i 's|^STATE_JSON=/opt/notebooklm-bridge/state.json|STATE_JSON=./state.json|' "$PROJECT_ROOT/.env"

# ── Step 6: CLI smoke test ─────────────────────────────────
say "Step 6/7 — CLI smoke test"
if [ "$SKIP_SMOKE" -eq 1 ]; then
    warn "Skipped (--skip-smoke)"
else
    echo "    Running 'notebooklm list' to prove the cookies are valid:"
    if NBLM_LIST_OUTPUT=$(notebooklm --profile "$PROFILE" list 2>&1); then
        ok "notebooklm list OK"
        echo "$NBLM_LIST_OUTPUT" | sed 's/^/      | /'
    else
        echo "$NBLM_LIST_OUTPUT" | sed 's/^/      | /' >&2
        fail "notebooklm list failed. Cookies may be invalid — see docs/cookie-refresh-runbook.md."
    fi
fi

# ── Step 7: summary ────────────────────────────────────────
say "Step 7/7 — done. Next steps:"
cat <<'EOF'

  1. Start the dev servers:
       scripts/start-web.sh           # default :8002 / :5175; if busy, auto-
                                      # increments up to 10 times — see the
                                      # printed banner or .runtime-ports.json
                                      # for the actual numbers
       scripts/status-web.sh          # supervisor + ports + log tail
       scripts/stop-web.sh

  2. Verify auth is live:
       curl http://localhost:8002/api/healthz | python3 -m json.tool
       # Expect: auth_valid=true, notebooklm_py_version=<real version>

  3. Open the UI:
       http://localhost:5175

  4. Ask via curl (replace <notebook_id> with one from the list above):
       curl -X POST http://localhost:8002/api/chat \
         -H "X-User-Id: $USER" \
         -H "Content-Type: application/json" \
         -d '{"notebook_id":"<notebook_id>","question":"概括这本 notebook 的主题"}'

  Troubleshooting:
    .backend.log                                 # full backend stderr
    docs/cookie-refresh-runbook.md               # auth_valid=false
    docs/upstream-breakage-runbook.md            # chat.ask errors

EOF
