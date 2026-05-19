# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
