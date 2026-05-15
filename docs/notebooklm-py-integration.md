# notebooklm-py integration — Phase 1 → Phase 2 handoff

This skeleton was authored without `notebooklm-py` installed. Two seams insulate
the code from the upstream library so the swap-in is mechanical:

1. **Lazy import** in `backend/client.py`. The import lives inside
   `_import_notebooklm()` so the rest of the module imports cleanly even when
   `notebooklm-py` is missing.
2. **Structural Protocols** in `backend/_notebooklm_protocol.py`. These mirror
   the slice of the upstream API the bridge actually uses (`chat.ask`,
   `notebooks.list`, `sources.list`, `close`). Tests use FakeClients that
   satisfy these Protocols structurally; production swaps in the real client.

## 1. Pin a real version

After Phase 1 ("CLI 打通", see plan.md) confirms a working version against
your account:

```bash
# Find the version that works (e.g. 0.5.3):
pipx run notebooklm-py --version

# Update pyproject.toml — change the placeholder line:
#   "notebooklm-py>=0.0.0",  # placeholder — pin after Phase 1
# to:
#   "notebooklm-py==0.5.3",
$EDITOR pyproject.toml

pip install -e '.[runtime]'
```

## 2. Verify API shape

Run mypy after the upgrade. If the upstream renamed any of the symbols we
import in `backend/client.py`, mypy will flag it:

```bash
mypy backend/
```

The names this codebase depends on:

* Constructor:        `notebooklm.NotebookLMClient.from_storage(path)`
* Async close:        `client.close()`
* Catalogue:          `await client.notebooks.list()`, `await client.sources.list(notebook_id)`
* Q&A:                `await client.chat.ask(notebook_id=, question=, source_ids=, conversation_id=)`
* Result attributes:  `.answer`, `.citations`, `.conversation_id`, `.turn`
* Citation attrs:     `.source_id`, `.source_title`, `.text`, `.page`
* Exception classes:  `notebooklm.errors.RateLimitedByGoogle / UpstreamServerError / AuthExpired`

If any name has shifted, the fix is local to **one file**:

* **`backend/client.py`** for constructor / close / exception classes
* **`backend/routes/chat.py`** for result attribute access (already accessed via
  `getattr` so missing fields fall back to empty strings rather than 500'ing)
* **`backend/_notebooklm_protocol.py`** to match the new types

## 3. Verify behaviour

```bash
pytest -xvs tests/                          # all 34 should still pass (FakeClient is unchanged)
scripts/start-web.sh                        # backend now binds to real upstream
curl http://localhost:8002/api/healthz      # expect auth_valid=true, real version string
```

Then run the end-to-end script from plan.md "端到端验证".

## 4. Update keepalive interval

Default keepalive is 30 min (`NOTEBOOKLM_KEEPALIVE_SECONDS=1800`). After Phase 1
verifies how long real cookies last, tune this if needed. The lower bound
enforced by `client.py:keepalive_loop` is 60 seconds.

## 5. (Optional) Promote runtime extra to base deps

If `notebooklm-py` is now considered stable enough that every CI / dev install
should pull it, move the line from `[project.optional-dependencies] runtime` to
`[project] dependencies`. This makes `pip install -e .[dev]` install the
upstream too. **Don't** do this until Phase 1 is fully signed off — it would
break devs who clone the repo before completing Phase 1.
