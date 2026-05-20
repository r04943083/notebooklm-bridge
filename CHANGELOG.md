# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] — 2026-05-20

`deploy.sh` is now self-sufficient: one command handles both the dev box
(no wheels, online install from PyPI) and the IT deploy host (offline
install from the tarball's wheels/). No more "you ran the wrong script,
go read setup.sh" experience.

### Changed

- **`deploy.sh` auto-selects install mode** based on what's actually on
  the host:
  - `wheels/` present and non-empty → offline install from those wheels
    (the old, only path; unchanged for IT tarball deploys)
  - `wheels/` missing/empty + PyPI reachable → online install via
    `pip install -e '.[runtime]'`
  - neither → fails with two concrete fix paths (offline tarball, or
    point pip at an internal mirror)

  Motivated by user feedback: "deploy.sh's guidance isn't smart enough.
  Either install offline, or tell me how to install, but I shouldn't have
  to intervene." Right.

- **`pyproject.toml` `[runtime]` extra** now pins
  `notebooklm-py[browser,cookies]==0.4.1` (was bare `notebooklm-py==0.4.1`).
  Without the `[browser,cookies]` sub-extras, online install would
  succeed but `scripts/login.sh` would later fail with "notebooklm CLI
  present but cannot launch browser" — playwright never got installed.
  Verified with `pip install --dry-run -e '.[runtime]'`: playwright,
  pyee, greenlet are now pulled correctly.

### Added

- **Distro-aware venv-failure handler**. When `$PY -m venv .venv` fails
  (very common on Ubuntu/Debian where the venv module lives in a
  separate `python3.X-venv` package that isn't installed by default),
  Python's own message is shown, then deploy.sh prints a tailored
  follow-up:
  - debian → `sudo apt install -y python3.${MINOR}-venv` with the
    detected Python's actual minor version, and a "then re-run: bash $0"
  - rhel → suggests `sudo dnf reinstall python3.11` (venv module ships
    bundled, so failure is unusual)
  - suse → `sudo zypper install -y python311-base`
  - other → generic install-the-venv-module hint

### Verified end-to-end

Ran `./scripts/deploy.sh` from the source repo on WSL Ubuntu
(/home/luyh/work/notebooklm-bridge) this release:
- mode detection prints `✓ online mode (no wheels/, but PyPI is reachable)`
- venv creation hits Ubuntu's missing `python3.12-venv` and the new
  handler prints the right `sudo apt install` line
- `pip install --dry-run -e '.[runtime]'` against the new pyproject
  resolves all deps including playwright (via `notebooklm-py[browser]`)
  and would land `notebooklm-bridge-1.0.8` — i.e. the full install path
  would succeed once the system venv package is installed

## [1.0.8] — 2026-05-20

`deploy.sh` / `update.sh` no longer fail with cryptic
`.venv/bin/pip: No such file or directory` when invoked the "wrong" way
or finding a broken venv. Triaged from the real failure on the maintainer's
dev box where `./scripts/deploy.sh` died at line 137. Three root causes
were all hidden behind that one error:

### Fixed

- **Wrong cwd when invoked from `scripts/`**. Previously `deploy.sh` did
  `cd "$HERE"` blindly, which lands in `scripts/` if you ran
  `./scripts/deploy.sh` from the source repo (rather than `bash deploy.sh`
  from the tarball top-level where pack.sh placed it). With cwd wrong,
  every later relative path (`wheels/`, `.venv/`, `.env.example`) breaks.
  Now: auto-locate the project root by looking for `pyproject.toml` at
  `$HERE` or `$HERE/..`, so both invocations work. Same fix for
  `update.sh`.

- **`wheels/` missing → cryptic downstream error**. `deploy.sh` is an
  *offline* installer; running it from the source repo (where pack.sh
  hasn't yet generated `wheels/`) used to fall through to a confusing
  `pip` error several seconds in. Now: explicit early check with a
  multi-line message that distinguishes "you're on the deploy host but
  forgot the tarball" from "you're on the dev machine — use setup.sh
  instead". Same check in `update.sh`.

- **Broken `.venv` directories now detected**. If `python -m venv` was
  interrupted (or, on Ubuntu, ran without `python3.12-venv` package
  installed), it leaves a `.venv/` with only a `bin/python` symlink and
  no `pip`. The old `if [ ! -d .venv ]` check skipped re-creation and the
  next pip step crashed with the now-famous `No such file or directory`.
  Now: `.venv` is treated as broken (and rebuilt) whenever `.venv/bin/pip`
  is missing or non-executable. Same fix in `update.sh` for carried-over
  venvs from a different distro.

### Verified

Actually ran `./scripts/deploy.sh` on the WSL Ubuntu dev box this release:
- with no `wheels/` → exits 1 with the dev-machine vs. deploy-host hint
- with empty `wheels/` and the pre-existing broken `.venv` → wheels check
  catches it, then broken-venv detection runs cleanly when wheels exist
- with broken venv + wheels present → rebuild attempt runs; surfaces
  Ubuntu's `apt install python3.12-venv` hint upstream from Python's own
  ensurepip error when the system venv package isn't installed

Lesson: shell scripts shipped to users *must* be exercised end-to-end on
the maintainer's machine before release. `bash -n` and unit-testing the
helper functions in isolation don't catch cwd / glob / set-flag interactions.

## [1.0.7] — 2026-05-20

Deploy scripts now detect the host distro family (Debian/Ubuntu vs.
RHEL/CentOS/Rocky/Alma vs. SUSE) and produce distro-specific error
messages and install commands. Motivated by the dev box being WSL Ubuntu
while the IT deploy target is CentOS Stream 9 — previously the scripts
hard-coded `apt-get` and Ubuntu 24.04 package names, which would have
failed silently or noisily on the deploy host.

### Added

- **`scripts/login.sh`** Chromium-deps step now branches on the detected
  distro and picks the right package names:
  - Debian/Ubuntu: `libnspr4 libnss3 libatk1.0-0t64 …` via `apt-get`
  - **RHEL family (CentOS 9 / Rocky 9 / Alma 9): `nspr nss atk
    at-spi2-atk libxshmfence …` via `dnf`** — new
  - openSUSE/SLES: `mozilla-nspr mozilla-nss …` via `zypper` — new
  - Unknown distro: falls back to suggesting Playwright's own
    `playwright install-deps chromium`

  RHEL 9 / Rocky 9 minimal installs hide `libxshmfence` behind the CRB
  (CodeReady Builder) repo; if `dnf install` reports "No match for
  argument", the error message tells the operator to enable CRB and
  retry (`sudo dnf config-manager --set-enabled crb`).

- **`scripts/deploy.sh`** prints a distro-specific Python 3.11 install
  hint when `find_python311` fails — Ubuntu apt vs. Rocky dnf vs. SUSE
  zypper. Same treatment for `node not found`. Previously the error was
  generic: "need Python >= 3.11", which is unhelpful on a CentOS host
  where the operator might reach for `apt-get` reflexively.

- **`scripts/README_DEPLOY.md` §1.2: "按发行版的具体准备步骤"** — full
  copy-pasteable steps for Debian/Ubuntu, RHEL 9 family (with CRB
  caveat), openSUSE, with a fallback for anything else.

### Internal

- Added `detect_distro()` helper to both `deploy.sh` and `login.sh`
  (inlined, not extracted to a shared lib — bash source-ing across
  scripts is fragile under `cd "$HERE"`). Reads `/etc/os-release`
  `ID` + `ID_LIKE` and maps to one of `debian` / `rhel` / `suse` /
  `other`. Verified on WSL Ubuntu (returns `debian`) and tested with
  simulated CentOS Stream 9 / Rocky 9 inputs (both return `rhel`).

## [1.0.6] — 2026-05-20

UX fix: the "credential not ready" 503 error now tells the user what to do
about it instead of just saying "service unavailable".

### Changed

- **503 detail message** (in `backend/routes/chat.py`, `backend/routes/
  notebooks.py`, `backend/routes/sources.py`) rewritten from
  `服务暂不可用 — 上游凭证未就绪` to a full operator-actionable string:
  `NotebookLM 登录凭证已失效或未配置。请通知系统管理员重新登录(管理员操作:
  在 bridge 主机执行 bash scripts/login.sh 后重启服务)。`
  End users now know *why* the bridge is down and *who* to ask; the
  admin reading it sees the exact command to run.

- **`frontend/src/api.ts`** now parses FastAPI's `{"detail": "..."}` error
  body and surfaces just the `detail` string. Previously the chat error
  banner showed the full JSON wrapped in `API 503: {"detail":"..."}`,
  which obscured the actual message and looked like a server bug to
  non-technical users. Falls back to raw text for non-JSON / non-`detail`
  error bodies so nothing useful gets swallowed.

## [1.0.5] — 2026-05-20

Docs-only release. Captures a real-world lesson learned from a v1.0.4
deploy where the operator's `.venv` was still Python 3.9 from an earlier
v1.0.3 install.

### Known issue (informational, no code change)

- **Python 3.9 venvs cannot run this project, even though the source uses
  `from __future__ import annotations` everywhere.** pydantic v2 calls
  `typing.get_type_hints()` at BaseModel class-definition time to build
  the validator, which forces string annotations to be eagerly evaluated.
  On 3.9 the evaluation of `list[str] | None` (and 12 other similar
  fields in `backend/schemas.py`) raises `TypeError: Unable to evaluate
  type annotation`. The fix is operational, not code-level: re-create
  `.venv` with Python 3.11, see `scripts/README_DEPLOY.md` §1.1 for the
  `PYTHON_BIN=` override path.

  This contradicts the original judgement in
  `~/.claude/plans/plan-mode-1-python-3-9-moonlit-noodle.md` §A.2 — that
  plan section is now annotated with a correction. The general principle:
  any library that builds objects via runtime type introspection
  (pydantic, FastAPI, SQLAlchemy) will bypass `__future__` lazy
  evaluation, so "we have `from __future__ import annotations`" is **not**
  sufficient evidence of Python-version compatibility. Actually start the
  service against the target interpreter before claiming compatibility.

### Open (deferred to a follow-up release)

- `scripts/start-web.sh` runs `npm run dev` for the frontend even on the
  deploy host, but `pack.sh` does not bundle `node_modules`. This causes a
  `[frontend supervisor] exited (code=7)` crash-loop on freshly-deployed
  hosts. Pre-existed since v1.0.3 — `README_DEPLOY.md` says "Node ≥ 18,
  only used to serve `frontend/dist/`" which contradicts what the script
  actually does. Tracked for next patch release; safe to ignore for now
  if you only care about the backend HTTP API.

## [1.0.4] — 2026-05-20

Two operational fixes for hosts with quirky environments + a new "every
commit bumps patch + auto-push" rule baked into `CLAUDE.md` §5.

### Fixed

- **`scripts/start-web.sh` starting port now auto-increments**. Previous
  behaviour: the script hard-coded `BACKEND_PORT=8002` on L24, overriding
  whatever was in `.env`, and exited on conflict. New behaviour: `.env`'s
  `BACKEND_PORT` / `FRONTEND_PORT` are *starting* ports; the script probes
  `[start, start+9]` and picks the first free one, writes the chosen pair
  to `.runtime-ports.json`. `stop-web.sh` / `status-web.sh` / vite's proxy
  all read from that file. `--force` still only kills processes from this
  project (won't touch other projects' holders — those just trigger the
  auto-increment fall-through).
- **`scripts/deploy.sh` / `scripts/update.sh` venv creation now requires
  Python ≥ 3.11**, with explicit interpreter probing (`python3.11 →
  python3.12 → python3`). Fixes the case where the host's default `python3`
  is 3.9 but `python3.11` is installed side-by-side: `python3 -m venv .venv`
  would create a 3.9 venv, then pip would refuse to install the bundled
  cp311 wheels. `PYTHON_BIN=/path/to/python3.11` overrides the probe if
  python3.11 lives outside `$PATH`.

### Added

- **`CLAUDE.md` §5.1: version bump rule.** Every commit bumps patch +1
  (`1.0.3 → 1.0.4 → …`) and auto-pushes to origin on main. Lists exactly
  which 4 files to touch (pyproject.toml + frontend/package.json +
  README.md + CHANGELOG.md) and which `v1.0.x` strings *not* to touch
  (CHANGELOG history entries, `v1.0.3 dropped X`-style narrative comments).

### Changed

- `CLAUDE.md` §3.2 rewritten: ports are no longer "pinned 8002 / 5175",
  they're starting ports with auto-probe.
- `README.md` Quick start + `scripts/README_DEPLOY.md` §1.1 and §2.1
  explain `PYTHON_BIN=...` override and the port auto-increment for
  operators.

### Migration

Drop-in compatible with v1.0.3 deployments — no config changes required
on existing hosts. If you previously hand-edited `start-web.sh` /
`vite.config.ts` to change ports, move that change to `.env` instead
(`BACKEND_PORT` / `FRONTEND_PORT`).

## [1.0.3] — 2026-05-19

Drops the `X-Shared-Secret` header that v1.0.2 still required. The
deployment pattern shipped in v1.0.2 (operator runs `deploy.sh` which
auto-generates a fresh `INTERNAL_AUTH_SHARED_SECRET`) was fundamentally
broken: the frontend bundle is prebuilt on the developer's host with the
developer's secret baked in, so the deploy host's new secret never
matched what the browser sent — every UI API call returned 401.

The LAN is already the trust boundary, so the shared-secret check was
security theatre that introduced a real cross-host coupling bug. v1.0.3
removes it entirely.

### Removed

- **`X-Shared-Secret` header check** in `backend/auth.py`. Only
  `X-User-Id` is authenticated now.
- `internal_auth_shared_secret` field in `backend/config.py`. Legacy
  `.env` files with this line are ignored (pydantic-settings has
  `extra="ignore"`).
- `X-Shared-Secret` from CORS `allow_headers` in `backend/app.py`.
- `VITE_SHARED_SECRET` consumption in `frontend/src/api.ts` and the
  associated `frontend/.env.local` mirroring in `scripts/setup.sh`.
- Auto-generation of `INTERNAL_AUTH_SHARED_SECRET` in `scripts/deploy.sh`
  (the workflow it enabled was the bug).

### Changed

- **`tests/test_auth.py`** — removed the two tests that exercised
  shared-secret rejection, added one test (`test_extra_shared_secret_header_is_ignored`)
  that confirms legacy clients still sending the header don't get rejected.
- **`tests/conftest.py`** — `SHARED_SECRET` constant + monkeypatch
  + request-level header removed. 4 test files updated to follow.
- **`scripts/setup.sh`** — collapsed from 8 steps to 7 (the
  `frontend/.env.local` mirror step is gone).
- **`scripts/README_DEPLOY.md`** — rewritten. IT deploy is now 4
  commands: `tar -xzf` → `deploy.sh` → `scripts/login.sh` →
  `scripts/start-web.sh`. No more "paste this secret into .env".
- **`.env.example`** — `INTERNAL_AUTH_SHARED_SECRET` line removed (with
  a comment explaining the version-skew migration path).
- **`README.md`** — Mermaid diagram, env-vars table, API-headers table,
  Configuration and Developer-setup sections all updated. The behaviour
  table now says one header (`X-User-Id`), not two.
- **`CLAUDE.md` §3.6** — rewritten to reflect that `INTERNAL_AUTH_SHARED_SECRET`
  is deprecated.

### Migration

For IT operators upgrading v1.0.2 → v1.0.3:

```bash
tar -xzf notebooklm-bridge-v1.0.3.tar.gz
cd notebooklm-bridge-v1.0.3
bash update.sh /path/to/notebooklm-bridge-v1.0.2
bash scripts/stop-web.sh && bash scripts/start-web.sh
```

The leftover `INTERNAL_AUTH_SHARED_SECRET=...` line in the old `.env`
is harmless and can be left alone. No browser bookmark changes; the UI
just stops sending the header automatically once the new bundle loads.

## [1.0.2] — 2026-05-19

Deployment ergonomics: IT operators can now sign in to NotebookLM with
their own Google account via a single script on the deploy host, with no
manual cookie copying between machines.

### Added

- **`scripts/login.sh`** — IT-facing one-shot cookies setup / refresh
  script. Verifies the `.venv` from `deploy.sh`, auto-installs Playwright
  Chromium's missing system libs (with a sudo prompt), pops a real Chromium
  window via `notebooklm login`, writes `./secrets/auth.json` (mode 0600),
  and smoke-tests by listing notebooks. Re-runnable any time
  `/api/healthz` reports `auth_valid=false`; supports `--refresh` to force
  re-login, `--profile NAME` for multi-account setups, `--yes` for
  non-interactive use.
- `scripts/deploy.sh` now auto-generates `INTERNAL_AUTH_SHARED_SECRET` into
  `.env` instead of asking the operator to `openssl rand -hex 32` manually.
- `requirements-runtime.txt` now pulls `notebooklm-py[browser,cookies]` so
  the offline `wheels/` set includes Playwright — `scripts/login.sh` works
  on the deploy host without needing PyPI access (though Playwright still
  downloads Chromium binary itself from `cdn.playwright.dev` the first
  time, see Notes).
- `scripts/pack.sh` packs `scripts/login.sh` into the release tarball.

### Changed

- **`README.md`** — "Quick start" rewritten as a 4-step recipe for IT
  operators (unpack → `deploy.sh` → `login.sh` → `start-web.sh`). The
  previous developer-oriented quick start moved to a new "Developer setup"
  section, clearly labelled as for project contributors, not deployers.
- **`docs/cookie-refresh-runbook.md`** — rewritten. Standard recovery path
  is now "re-run `bash scripts/login.sh` on the deploy host", RTO 5
  minutes. The old "sign in on a workstation + scp the auth.json over"
  path is documented as a fallback for headless / air-gapped servers,
  alongside a new appendix on X11 forwarding (cookies minted from the
  bridge's own egress IP).
- `scripts/deploy.sh` next-steps prompt now points to `scripts/login.sh`
  instead of "scp `auth.json` from another host".

### Notes

- The deploy host must have a desktop environment and outbound internet to
  `cdn.playwright.dev` for the first `scripts/login.sh` to download
  Chromium (~150MB, cached forever after). Headless / air-gapped hosts
  follow the runbook's fallback workflow.
- The release tarball is larger now (~11MB → ~40MB) because the offline
  wheel set bundles Playwright + browser_cookie3.
- `secrets/auth.json` is now minted **on the deploy host** by the IT
  operator's own Google account, instead of being copied from the
  developer's workstation. This is a workflow change, not a code-API
  change — the file format and bridge behaviour are identical.

## [1.0.1] — 2026-05-19

v1.0.0 部署到 IT 那边的 Python 3.11 主机时报 "No matching distribution
found for httptools" — patch release 修这个打包 bug。v1.0.0 tarball 受
影响,部署前换成 v1.0.1。

### Fixed

- **`scripts/pack.sh`** — `pip download` 现在显式锁定 `--python-version 3.11
  --platform manylinux2014_x86_64 --implementation cp --abi cp311
  --only-binary=:all:`。之前不指定这几个参数,pip 默认拉本机解释器
  (3.12)的 wheel,产出 `cp312-cp312` 标签的 `httptools` / `uvloop` /
  `watchfiles` / `pyyaml`,3.11 解释器拒绝加载这些 ABI 不匹配的 wheel。
  `--only-binary=:all:` 让缺 wheel 立即报错,避免 fallback 到目标机
  无法 compile 的 sdist。
- 锁定平台后,打包机本地是 Python 3.12 还是 3.11 都不影响产物 —— wheel
  set 始终是 cp311 + manylinux2014_x86_64。

## [1.0.0] — 2026-05-19

第一个对内可用的版本。一台 Bridge 主机把单个 Google 账号的 NotebookLM
开放给内网团队,网页端多用户同时使用;飞书 Bot(Phase 3)和 Studio(Phase 4)
不在本次发布范围。

### Added

- **Backend** — FastAPI bridge,接入 `notebooklm-py 0.4.1` 共享单个 async
  re-entrant client(`uvicorn --workers 1` 强约束)。
- **Multi-user isolation** — per-`(user_id, notebook_id)` session 映射,JSON
  文件 debounce 持久化到 `state.json`,重启不丢历史。
- **Concurrency safety** — per-user 令牌桶(burst 3,refill 10/min)→ 全局
  semaphore(默认 cap 8)→ 30s circuit breaker(429/5xx),三层保护单个
  Google 账号不被打挂。
- **Health endpoint** — `GET /api/healthz` 返回 `auth_valid`、`inflight_asks`、
  `circuit_open`,无需鉴权。
- **Chat API** — `POST /api/chat`(ask 带引用)、`POST /api/chat/reset`、
  `POST /api/chat/select`(从历史恢复对话)。
- **Sources API** — `GET /api/notebooks`、`GET /api/sources`、
  `GET /api/sources/{id}/fulltext`(支持 30s 缓存)。
- **Auth** — `X-User-Id` + `X-Shared-Secret` 双头验证;`require_internal_user`
  拒绝过长 / 含 `|` / 控制字符的 user id。
- **Frontend** — React 19 + Vite + TypeScript 三栏布局,Markdown 答案渲染、
  dark / light theme 切换、用户头像 + "切换用户" 下拉。
- **Citation Drawer** — 点 citation chip 滑出抽屉,在 source 全文里高亮匹配
  段。4 级 fallback(L1=40 字精确 / L2=25 字 / L3=空白标准化 / L4=15 字
  兜底)+ 命中级别 badge,未命中标红警示。
- **History popover** — `localStorage` 保存最近 20 个对话,按当前 notebook
  过滤,点击恢复 turns;"清除本 notebook 历史" 按钮带二次确认。
- **Packaging** — `scripts/pack.sh` 输出离线 tarball(`dist/notebooklm-bridge-vX.Y.Z.tar.gz`
  + `.sha256` sidecar),内含 backend 源码、frontend `dist/`、offline pip
  `wheels/`、dev 脚本、`deploy.sh` / `update.sh` / `README_DEPLOY.md`。
- **Deployment scripts** — `deploy.sh` 首装(创建 `.venv`、从模板生成 `.env`、
  目录建好后留给运维放 `secrets/auth.json`)、`update.sh` 原地升级(复用
  老 install 的 `.venv` / `.env` / `secrets`)。
- **Supervisor** — `scripts/start-web.sh` / `stop-web.sh` / `status-web.sh` /
  `_supervise.sh`,单进程崩了自动重启;30s 内 >5 次崩溃触发 30s back-off。
- **Tests** — 45 个 pytest 单元 / 集成测试,覆盖 Store(sessions / 限流 /
  熔断 / 持久化)、auth header 校验、并发协程隔离、circuit breaker 行为、
  `/chat/select`、source fulltext、降级模式(无 cookies / 无 notebooklm-py)。
- **Operational docs** — `docs/cookie-refresh-runbook.md`、
  `docs/upstream-breakage-runbook.md`。

### Fixed

- WSL `/mnt/<drive>/` 路径下 Vite chokidar 丢 inotify 事件 → HMR 静默失败:
  vite.config 自动检测 `/mnt/` 并启 `usePolling`(间隔 300ms)。
- "刷新后还续在上次 conversation_id" 导致 history 全串成一锅:mount-once
  effect 调 `/api/chat/reset` 让后端忘记上次 cid,真正实现 "刷新 = 干净对话框"。
- "发完问题画面自动清空 + 点同 cid 历史无反应":`ChatPane` key 跟 in-flight
  cid 解耦,改用独立 `paneEpoch` 计数器作显式 remount 信号;`handleTurn`
  不再触动 `activeConversationId`。
- CitationDrawer 内文贴右壁 / 双层滚动条 / 标题区跟着滚动等若干布局 bug。
- `getSourceFulltext` 命中 4 级 fallback 但没有可观察性:加 `Slices.level`
  字段 + DrawerHeader 命中级别 badge。

### Security

- `secrets/auth.json` 强制 `chmod 0600`,文件 owner 才能读;`pack.sh` 明确
  排除 `secrets/`、`.env`、`state.json`,凭证由部署者手动放。
- `INTERNAL_AUTH_SHARED_SECRET` 不入仓,仅在 `.env`(已 `.gitignore`);
  `.env.example` 用 `<32B random>` 占位符。
- `X-User-Id` 校验拒绝过长 / 控制字符 / `|`,防止 cross-tenant key 注入。

### Known limitations

- 复制答案 / Regenerate / 编辑上一问 — 推迟到 v1.1。
- 移动端响应式 — 当前主场景是内网 PC,推迟到 v1.1。
- Phase 3(飞书 Bot)、Phase 4(Studio:Audio Overview / Mind map)— 不在
  v1.0 roadmap。
