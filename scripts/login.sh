#!/usr/bin/env bash
# scripts/login.sh — IT-facing one-shot cookies setup / refresh.
#
# Run this on the deploy host (must have a desktop environment + outbound
# internet to google.com and cdn.playwright.dev) when:
#   * you've just unpacked the tarball and run deploy.sh, OR
#   * /api/healthz starts returning auth_valid=false.
#
# It will:
#   1. find the .venv (created by deploy.sh) and the notebooklm CLI inside it
#   2. check Playwright's Chromium can launch; sudo apt install any missing
#      system libs (libnspr4 / libnss3 / ...) after asking you
#   3. open a real Chromium window via `notebooklm login` — sign in with
#      YOUR Google account, open the target notebook once, close the window
#   4. install the resulting cookies as ./secrets/auth.json (mode 0600)
#   5. smoke-test by running `notebooklm list`
#
# Re-running is idempotent: cookies still valid → it offers to skip;
# cookies expired → re-login overwrites in place.
#
# Usage:
#   bash scripts/login.sh                # interactive
#   bash scripts/login.sh --yes          # accept all confirms (non-interactive)
#   bash scripts/login.sh --refresh      # force re-login even if cookies exist
#   bash scripts/login.sh --profile NAME # use a non-default CLI profile

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# ── Options ────────────────────────────────────────────────
YES=0
FORCE_REFRESH=0
PROFILE="${NOTEBOOKLM_PROFILE:-default}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) YES=1; shift ;;
        --refresh) FORCE_REFRESH=1; shift ;;
        --profile) PROFILE="$2"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \?//'; exit 0 ;;
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

# ── Step 0: preflight ──────────────────────────────────────
say "Step 0/6 — preflight"
[ -f pyproject.toml ] && [ -d scripts ] \
    || fail "Run from the deploy directory (this dir doesn't look like one — no pyproject.toml / scripts/)."

# ── Step 1: locate the venv ────────────────────────────────
say "Step 1/6 — find the venv from deploy.sh"
VENV="$HERE/.venv"
[ -d "$VENV" ] \
    || fail "$VENV not found. Run 'bash deploy.sh' first."
NBLM="$VENV/bin/notebooklm"
[ -x "$NBLM" ] \
    || fail "$NBLM not found. 'bash deploy.sh' may have failed (notebooklm-py[browser,cookies] not installed). Re-run it and watch for errors."

NBLM_VERSION=$("$NBLM" --version 2>&1 | head -1 || true)
ok "${NBLM_VERSION:-notebooklm CLI present}"

# ── Step 2: Playwright Chromium system libs ────────────────
say "Step 2/6 — verify Playwright Chromium can run"
CHROME_BIN=$(ls -1 "$HOME"/.cache/ms-playwright/chromium*/chrome-linux*/chrome 2>/dev/null | head -1 || true)

chrome_missing_libs() {
    [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ] \
        && ldd "$CHROME_BIN" 2>/dev/null | awk '/=> not found/ {print $1}' | sort -u
}

if [ -z "$CHROME_BIN" ]; then
    # Playwright's Chromium binary is downloaded on first use. Warn the user
    # so they're not surprised when the next step takes a minute or two.
    ok "Playwright Chromium not yet downloaded; the first 'notebooklm login' will fetch it (~150MB from cdn.playwright.dev)."
else
    MISSING=$(chrome_missing_libs)
    if [ -n "$MISSING" ]; then
        warn "Playwright's bundled Chromium is missing shared libraries:"
        echo "$MISSING" | sed 's/^/      /' >&2

        # Ubuntu 24.04 / Debian package set — covers what Chromium needs to
        # render. RHEL / CentOS hosts may have different package names; if
        # apt-get fails, follow docs/cookie-refresh-runbook.md.
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
            fail "Declined. Install the deps yourself and re-run scripts/login.sh."
        fi

        sudo apt-get install -y "${APT_PKGS[@]}" \
            || fail "apt-get install failed. Fix manually and re-run."

        STILL_MISSING=$(chrome_missing_libs)
        if [ -n "$STILL_MISSING" ]; then
            warn "Still missing after install:"
            echo "$STILL_MISSING" | sed 's/^/      /' >&2
            fail "Chromium still can't load. Try: sudo $VENV/bin/playwright install-deps chromium (or see docs/cookie-refresh-runbook.md)."
        fi
        ok "Chromium deps installed and verified"
    else
        ok "Playwright Chromium deps look fine ($CHROME_BIN)"
    fi
fi

# ── Step 3: notebooklm login (interactive browser) ─────────
say "Step 3/6 — sign in to NotebookLM"
NBLM_HOME="${HOME}/.notebooklm"
NBLM_STATE="$NBLM_HOME/profiles/$PROFILE/storage_state.json"
BRIDGE_AUTH="$HERE/secrets/auth.json"

need_login=1
if [ "$FORCE_REFRESH" -eq 0 ] && [ -f "$NBLM_STATE" ] && [ -f "$BRIDGE_AUTH" ]; then
    warn "Existing cookies found at $NBLM_STATE."
    warn "(If /api/healthz says auth_valid=false you DO need to re-login.)"
    if ! confirm "Re-login anyway?"; then
        need_login=0
        ok "Skipped login; will re-copy existing cookies to secrets/auth.json."
    fi
fi

if [ "$need_login" -eq 1 ]; then
    cat <<EOF

    'notebooklm login' is about to open a real Chromium window. Inside that window:
      1. Sign in with the Google account that owns these notebooks.
      2. Open the target notebook at least once (this seeds notebook-specific cookies).
      3. Close the browser window. The CLI will write:
           $NBLM_STATE

EOF
    if ! confirm "Open the browser now?"; then
        fail "Declined. Re-run scripts/login.sh when ready."
    fi
    "$NBLM" --profile "$PROFILE" login \
        || fail "Login failed. See docs/cookie-refresh-runbook.md for fallbacks."
    [ -f "$NBLM_STATE" ] || fail "Login reported success but $NBLM_STATE is missing."
    ok "Logged in; cookies saved at $NBLM_STATE"
fi

# ── Step 4: copy into secrets/auth.json ────────────────────
say "Step 4/6 — install cookies for the bridge"
mkdir -p "$HERE/secrets"
chmod 700 "$HERE/secrets"
cp "$NBLM_STATE" "$BRIDGE_AUTH"
chmod 600 "$BRIDGE_AUTH"
ok "Copied to $BRIDGE_AUTH (mode 0600)"

# ── Step 5: smoke test ─────────────────────────────────────
say "Step 5/6 — smoke test (notebooklm list)"
if NBLM_LIST_OUTPUT=$("$NBLM" --profile "$PROFILE" list 2>&1); then
    ok "Cookies are working — Google replied with your notebook list:"
    echo "$NBLM_LIST_OUTPUT" | sed 's/^/      | /'
else
    echo "$NBLM_LIST_OUTPUT" | sed 's/^/      | /' >&2
    fail "'notebooklm list' failed. Cookies may be invalid — re-run with --refresh, or see docs/cookie-refresh-runbook.md."
fi

# ── Step 6: next steps ─────────────────────────────────────
say "Step 6/6 — done."
cat <<'EOF'

  Cookies are live. If the bridge is already running, restart it so it picks
  up the new auth.json:

      bash scripts/stop-web.sh && bash scripts/start-web.sh

  Then verify:

      curl -s http://localhost:8002/api/healthz | jq
      # Expect: auth_valid=true

EOF
