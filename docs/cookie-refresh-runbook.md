# Cookie refresh runbook

`/api/healthz` reports `auth_valid=false`, or `/api/chat` is returning 503
with "上游凭证未就绪". The Google session cookie chain expired or was
revoked. This runbook restores service. **RTO target: 5 minutes.**

## Standard path — desktop deploy host with internet access

This is what to do on a deploy host like `ai-test` that has a desktop
environment (GNOME / KDE / XFCE / etc.) and can reach both
`notebooklm.google.com` and `cdn.playwright.dev`.

```bash
cd /path/to/notebooklm-bridge-vX.Y.Z   # the unpacked deploy directory
bash scripts/login.sh
```

`scripts/login.sh` will:

1. Verify the `.venv` from `deploy.sh` exists and the `notebooklm` CLI is
   installed inside it.
2. Check Playwright's bundled Chromium can launch; if a shared library is
   missing, prompt for `sudo apt-get install …` (Ubuntu / Debian package
   names; on RHEL / CentOS you may need different packages — see the
   "Chromium libs on RHEL" appendix below).
3. Open a Chromium window. **In that window:**
   - sign in with the Google account that owns the target notebooks,
   - open the target notebook at least once (seeds notebook-specific
     cookies),
   - close the browser window.
4. Copy the resulting cookies to `./secrets/auth.json` (mode 0600).
5. Smoke-test by running `notebooklm list` — if the listing comes back,
   Google has accepted the new session.

Then restart the bridge so it picks up the new cookies:

```bash
bash scripts/stop-web.sh && bash scripts/start-web.sh
curl -s http://localhost:8002/api/healthz | jq
# Expect: auth_valid=true
```

Re-running `scripts/login.sh` is idempotent — it will offer to skip if
cookies look fine, or accept `--refresh` to force-relogin.

## Fallback — headless / air-gapped deploy host

If the deploy host has **no desktop** (you only have an SSH terminal) or
**can't reach `cdn.playwright.dev`** to download Chromium, you can't run
`scripts/login.sh` on the deploy host itself. Use a two-machine workflow:

1. **On a workstation** that *does* have a desktop and internet access
   (your laptop, e.g. WSL2 + Chrome, macOS, Linux desktop):

   ```bash
   # Unpack the same release tarball there (just to get scripts/login.sh
   # and the bundled wheels — no service will run here).
   tar -xzf notebooklm-bridge-vX.Y.Z.tar.gz
   cd notebooklm-bridge-vX.Y.Z
   bash deploy.sh            # creates .venv with the notebooklm CLI
   bash scripts/login.sh     # pops the browser, writes ./secrets/auth.json
   ```

2. **Copy just `secrets/auth.json` over** to the deploy host:

   ```bash
   scp ./secrets/auth.json bridge:/path/to/notebooklm-bridge-vX.Y.Z/secrets/auth.json
   ssh bridge 'chmod 600 /path/to/notebooklm-bridge-vX.Y.Z/secrets/auth.json'
   ```

3. **Restart on the deploy host**:

   ```bash
   ssh bridge 'cd /path/to/notebooklm-bridge-vX.Y.Z && bash scripts/stop-web.sh && bash scripts/start-web.sh'
   curl -s http://bridge:8002/api/healthz | jq
   ```

Permissions on `secrets/auth.json` **must** be `0600`. Anyone with read
access on the bridge can otherwise impersonate the shared NotebookLM
account.

## Smoke test after a refresh

```bash
SECRET=$(grep ^INTERNAL_AUTH_SHARED_SECRET .env | cut -d= -f2-)
curl -X POST http://localhost:8002/api/chat \
  -H "X-User-Id: smoketest" \
  -H "X-Shared-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"notebook_id":"<known-id>","question":"ping"}'
# Expect: 200 + non-empty answer.
```

## If cookies expire again within 24 hours

Most likely causes:

- Google detected the workstation IP no longer matches typical sign-in
  patterns. Sign in interactively in the same browser session first, then
  re-run `scripts/login.sh`.
- The bridge host's egress IP differs from where the cookies were minted.
  Mint them from a host whose egress matches the bridge's (e.g. SSH into
  the bridge and run `scripts/login.sh` *there*, with X11 forwarded — see
  the X11-forwarding appendix below).
- The Google account is rate-limited or flagged. Wait 30 minutes,
  re-sign-in, re-export.

## If the bridge can't reach `notebooklm.google.com` at all

```bash
curl -sI https://notebooklm.google.com
```

should return 200 / 302. If not, that's a network problem — escalate to
whoever owns the bridge host's egress.

## Appendix: Chromium libs on RHEL / CentOS / Rocky / Alma

`scripts/login.sh` knows the Ubuntu / Debian package names. On the RHEL
family, the equivalent packages are usually:

```bash
sudo dnf install -y \
    nss nspr atk at-spi2-atk cups-libs libdrm libxkbcommon \
    libdrm pango cairo alsa-lib at-spi2-core libXcomposite \
    libXdamage libXfixes libXrandr libxshmfence
```

After installing, re-run `scripts/login.sh` — it re-checks the shared
library set after each `sudo install`.

## Appendix: X11 forwarding for headless servers

If the deploy host is headless but you can SSH into it from a desktop that
has an X server (most Linux desktops; macOS via XQuartz; Windows via
VcXsrv or similar):

```bash
ssh -X bridge   # X-forward enabled
cd /path/to/notebooklm-bridge-vX.Y.Z
bash scripts/login.sh
# The Chromium window opens on your local screen but cookies are written
# on the bridge — no scp needed.
```

This often beats the two-machine workflow because the cookies are minted
from the bridge's own egress IP, which Google is less likely to flag.
