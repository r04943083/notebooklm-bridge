# notebooklm-bridge

Expose one Google account's NotebookLM notebooks to an intranet team via a small
FastAPI bridge + React frontend. The bridge runs on a host that *can* reach
google.com; internal users hit the bridge over the LAN and never touch Google
directly. A Feishu (Lark) bot adapter is planned as Phase 3.

Architecture, port choices, multi-user concurrency model, and risk register
live in [`plan.md`](plan.md). Project-wide rules (no AI signatures in commits,
`--workers 1`, port 5175/8002 strict, …) live in [`CLAUDE.md`](CLAUDE.md).

## Tech stack

| Layer       | Tech                                            |
|-------------|-------------------------------------------------|
| Bridge HTTP | FastAPI + uvicorn (single worker)               |
| NotebookLM  | [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) (single shared client) |
| State       | In-memory dicts + JSON file persistence (`state.json`) |
| Frontend    | React 19 + Vite 5 + TypeScript                  |
| Tests       | pytest + pytest-asyncio + asgi-lifespan + httpx |

Backend on **:8002**, frontend on **:5175**. These are `strictPort: true` /
`--port 8002` hard-coded — they match the project convention next to
`E2UniScript` (5173/8000) and `cpp_rename` (5174/8001).

## Prerequisites

* The bridge host must be able to reach `https://notebooklm.google.com`.
* Python ≥ 3.11, Node ≥ 18, npm.
* Phase 1 of [`plan.md`](plan.md) completed — that is, a valid
  `secrets/auth.json` exported from Chrome via the `notebooklm-py` CLI. See
  [`docs/cookie-refresh-runbook.md`](docs/cookie-refresh-runbook.md).

## Install

```bash
# Backend (dev install, without notebooklm-py — phase 1 pins it later)
pip install -e '.[dev]'

# Frontend
cd frontend && npm install && cd ..

# Env file
cp .env.example .env
# Generate a shared secret and paste it into .env:
openssl rand -hex 32

# Cookie file (after Phase 1):
chmod 600 secrets/auth.json
```

Once Phase 1 has chosen a working `notebooklm-py` version, follow
[`docs/notebooklm-py-integration.md`](docs/notebooklm-py-integration.md) to
pin it and `pip install -e '.[runtime]'`.

## Run (dev)

```bash
scripts/start-web.sh             # binds 0.0.0.0 (LAN-reachable)
scripts/start-web.sh --local     # binds 127.0.0.1 only
scripts/start-web.sh --force     # if a stale process from THIS project holds the port

scripts/status-web.sh            # supervisor health + port owner + log tail
scripts/stop-web.sh              # stop both supervisors
```

Each service is wrapped in `scripts/_supervise.sh`, so a single crash gets
auto-restarted; >5 crashes in 30s triggers a 30s back-off. Logs go to
`.backend.log` and `.frontend.log` at the project root.

## Packaging & Deployment

To roll the bridge out onto another LAN host, build a self-contained release
tarball:

```bash
scripts/pack.sh
# → dist/notebooklm-bridge-v0.1.0.tar.gz  (+ .sha256 sidecar)
```

The tarball bundles: backend `.py` sources, the pre-built frontend `dist/`,
offline pip `wheels/`, the dev scripts, and a `deploy.sh` / `update.sh` /
`README_DEPLOY.md` for the target host. It does *not* bundle `secrets/` or
`.env` — those stay on the operator's side.

On the target host:

```bash
tar -xzf notebooklm-bridge-v0.1.0.tar.gz
cd notebooklm-bridge-v0.1.0
bash deploy.sh
# Then: drop in secrets/auth.json (chmod 600) and edit .env
#       with INTERNAL_AUTH_SHARED_SECRET=$(openssl rand -hex 32)
bash scripts/start-web.sh
```

Upgrading an existing install reuses `.venv` / `.env` / `secrets/` automatically:

```bash
tar -xzf notebooklm-bridge-v<NEW>.tar.gz
cd notebooklm-bridge-v<NEW>
bash update.sh /path/to/old/install
bash scripts/start-web.sh
```

The full checklist (security, port firewall, troubleshooting) lives in
[`scripts/README_DEPLOY.md`](scripts/README_DEPLOY.md).

## API surface

All non-`/healthz` endpoints require two headers:

| Header             | Value                                                  |
|--------------------|--------------------------------------------------------|
| `X-User-Id`        | free-form internal identifier (max 64 chars, no `\|`)    |
| `X-Shared-Secret`  | matches `INTERNAL_AUTH_SHARED_SECRET` in `.env`        |

| Method | Path                    | Purpose |
|--------|-------------------------|---------|
| GET    | `/api/healthz`          | Public health: auth status, last refresh, inflight count |
| GET    | `/api/notebooks`        | List of notebooks the shared account can see (30s cache) |
| GET    | `/api/sources?notebook_id=…` | Sources inside a notebook (30s cache) |
| POST   | `/api/chat`             | Ask a question; returns answer + citations + conversation_id |
| POST   | `/api/chat/reset?notebook_id=…` | Start a fresh conversation for this (user, notebook) |

`POST /api/chat` body:

```json
{
  "notebook_id": "string",
  "question": "string",
  "source_ids": null,
  "reset": false
}
```

## Multi-user model

* A single shared Google account's `NotebookLMClient` runs as one async-reentrant
  singleton — that's why `--workers 1` is required (see CLAUDE.md §3.1).
* Each internal user is identified by `X-User-Id` only. No SSO, no OAuth.
* Sessions are isolated per `(user_id, notebook_id)` and persisted across restarts.
* Per-user token bucket: capacity 3, refill 10/min (configurable).
* Global semaphore caps concurrent upstream calls; default 8.
* Circuit breaker trips on upstream 429/5xx for 30s, preventing a thundering-herd
  retry storm against Google.

## Tests

```bash
pytest -xvs tests/
ruff check .
mypy backend/
```

34 tests cover Store (sessions, rate limit, breaker, persistence, debounce),
auth (header validation), and chat (concurrency, semaphore, breaker, restart
recovery, degraded mode when notebooklm-py / cookies are missing).

The test suite uses a `FakeClient` that satisfies
`backend._notebooklm_protocol.NotebookLMClientLike` structurally, so it runs
without `notebooklm-py` installed.

## Troubleshooting

* `auth_valid=false` in `/api/healthz` → [`docs/cookie-refresh-runbook.md`](docs/cookie-refresh-runbook.md)
* Unexpected exceptions in `.backend.log` → [`docs/upstream-breakage-runbook.md`](docs/upstream-breakage-runbook.md)
* Port already in use → `scripts/start-web.sh --force` (only kills if cwd matches this project)

## Project layout

```
notebooklm-bridge/
├── backend/                  FastAPI app, store, auth, routes
├── frontend/                 React 19 + Vite + TypeScript
├── scripts/
│   ├── start-web / stop-web / status-web / _supervise   (dev daemon mgmt)
│   ├── pack.sh                                          (build release tarball)
│   ├── deploy.sh / update.sh                            (run on target host)
│   └── README_DEPLOY.md                                 (deploy runbook)
├── tests/                    pytest (no notebooklm-py needed at test time)
├── docs/                     runbooks + notebooklm-py integration guide
├── dist/                     release tarballs from pack.sh (gitignored)
├── requirements-runtime.txt  flat dep list for offline `pip download`
├── plan.md                   Design document
├── CLAUDE.md                 Project-wide development rules
└── pyproject.toml            Python packaging
```

## Phases

* [x] Phase 0 — design (`plan.md`)
* [x] Phase 1 — CLI verified (auth.json works, `notebooklm chat ask` returns answers)
* [x] Phase 2 — bridge + multi-user frontend (CitationDrawer, history, packaging)
* [ ] Phase 3 — Feishu bot
* [ ] Phase 4 — Studio (optional; not in roadmap)

Maintained by yihonglu.
