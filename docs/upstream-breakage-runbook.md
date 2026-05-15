# Upstream breakage runbook

`chat.ask()` is returning unexpected exceptions, or `/api/chat` is 503-ing in a
way that doesn't match the cookie-refresh runbook. Likely cause: Google changed
its internal NotebookLM RPC and `notebooklm-py` needs updating.

## 1. Confirm the symptom is upstream, not us

```bash
# Healthz should be 200 even when chat is broken:
curl http://<bridge>:8002/api/healthz | jq

# If auth_valid=true and circuit_open=false, but chat still 503s,
# tail the backend log to see the actual exception class:
ssh bridge 'tail -n 100 /opt/notebooklm-bridge/.backend.log'
```

The log marker to look for is `upstream error <ExceptionName>`. If the
exception name is unfamiliar (not RateLimitedByGoogle / UpstreamServerError /
AuthExpired), `notebooklm-py` is likely already a step behind upstream.

## 2. Check for an existing fix

* https://github.com/teng-lin/notebooklm-py/releases — look for a release in
  the last 24-48 hours.
* https://github.com/teng-lin/notebooklm-py/issues — search for the exception
  name or HTTP status.

## 3. Apply an upstream fix

If a new release exists:

```bash
ssh bridge
cd /opt/notebooklm-bridge
# Update the pin in pyproject.toml [project.optional-dependencies] runtime
$EDITOR pyproject.toml
pip install -e '.[runtime]' --upgrade
scripts/stop-web.sh
scripts/start-web.sh
```

Verify with the smoke-test from `docs/cookie-refresh-runbook.md` §3.

## 4. Rollback

If the new version breaks something else, pin the previous version:

```bash
$EDITOR pyproject.toml   # set notebooklm-py back to the known-good version
pip install -e '.[runtime]' --upgrade --force-reinstall
scripts/stop-web.sh && scripts/start-web.sh
```

## 5. If no fix exists yet

* Open an issue on the notebooklm-py repo with the exception trace and any RPC
  payload visible in the log (redact the bearer token).
* In the meantime, the bridge is already returning 503 to users. Post a notice
  in the team channel: "NotebookLM Bridge is degraded — upstream NotebookLM
  API changed. Tracking <issue link>."
* The Feishu bot (Phase 3, if running) will receive the same 503 and report
  the message to its callers.
