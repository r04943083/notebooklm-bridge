# Cookie refresh runbook

`/api/healthz` reports `auth_valid=false`, or `/api/chat` is returning 503 with
"上游凭证未就绪". The Google session cookie chain expired or got revoked. This
runbook restores service. RTO target: **10 minutes**.

## 1. Refresh cookies on a workstation that can reach google.com

```bash
# On the Chrome host (NOT the bridge):
# 1. Open Chrome, navigate to https://notebooklm.google.com, sign in.
# 2. Open the target notebook once (this seeds notebook-specific cookies).
# 3. Export cookies via the notebooklm-py CLI:
pipx install 'notebooklm-py[browser,cookies]'
notebooklm auth import-cookies --browser chrome --profile default
# This writes ~/.notebooklm/auth.json.
```

**Browser-keyring fallback** — if `import-cookies` fails with "could not unlock
keyring" (common on Linux), close Chrome entirely first, then re-run. On macOS,
you may be prompted to enter your login keychain password.

## 2. Ship the new auth.json to the bridge host

```bash
scp ~/.notebooklm/auth.json bridge:/opt/notebooklm-bridge/secrets/auth.json
ssh bridge 'chmod 600 /opt/notebooklm-bridge/secrets/auth.json'
```

Permission **must** be 0600. Anyone with read access on the bridge can otherwise
impersonate the shared NotebookLM account.

## 3. Restart and verify

```bash
ssh bridge 'cd /opt/notebooklm-bridge && scripts/stop-web.sh && scripts/start-web.sh'
curl http://<bridge>:8002/api/healthz | jq
# Expect: auth_valid=true, last_refresh_ts within the last minute,
#         notebooklm_py_version is a real version (not "not-installed").
```

Smoke-test:

```bash
curl -X POST http://<bridge>:8002/api/chat \
  -H "X-User-Id: smoketest" \
  -H "X-Shared-Secret: $INTERNAL_AUTH_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"notebook_id":"<known-id>","question":"ping"}'
# Expect 200 + non-empty answer.
```

## 4. If cookies expire again within 24h

Likely causes:

* Google detected the workstation IP no longer matches typical sign-in patterns.
  Sign in interactively in Chrome to refresh fingerprint, then re-export.
* The bridge is behind a different egress IP than where the cookies were minted.
  Either sign in from a host whose egress matches the bridge's, or keep an SSH
  tunnel open so the bridge looks like the workstation for cookie purposes.
* Account got rate-limited or flagged by Google. Wait 30 minutes, re-sign-in,
  re-export.

## 5. If the bridge can't reach notebooklm.google.com at all

`curl -sI https://notebooklm.google.com` should return 200/302. If not, this is
a network problem — escalate to the team that owns the bridge host's egress.
