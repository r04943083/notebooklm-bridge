# CLAUDE.md — notebooklm-bridge 开发规约

本文件给所有在本仓库里写代码的 AI 协作工具(Claude Code / Codex / Cursor / …)和人类开发者读。**遵守它,不要漂移**。

---

## 0. 项目是什么

把单个 Google 账号下的 NotebookLM 内容,通过一台能访问 google.com 的 Bridge 主机,对内网团队多人开放(网页 + 飞书)。详细设计见同目录 `plan.md`。

栈:**FastAPI + notebooklm-py + React 19 + Vite + TypeScript**,后端**内存 dict + JSON 文件持久化**(不引入 Redis)。

端口:**Backend 8002 / Frontend 5175**(沿用工作区现有约定:E2UniScript 5173/8000,cpp_rename 5174/8001)。

---

## 1. 作者署名(硬性规则,违反即回滚)

- **本项目所有 commit、PR、文档、代码注释,作者只能是 `yihonglu`**。
- **任何 commit message、PR body、changelog 都不允许出现下列字样**(无论中英):
  - `Co-Authored-By: Claude …`
  - `Generated with Claude Code` / `🤖 Generated with …`
  - `Authored-by: <任何 AI 名字>` / `Assistant` / `GPT` / `Codex`
  - 任何暗示"由 AI 生成 / 协助 / 共著"的水印、徽章、链接
- 用 Claude Code 协作时,**在执行 `git commit` 之前,必须删掉默认 commit 模板里的 `Co-Authored-By` 行**。如果有 hook / settings 在自动添加,先关掉再 commit。
- 代码注释里不写 "Claude said …" / "as AI suggested …" / "TODO from AI" — 该是什么思路就用第一人称写。
- README / 顶层文档不放 "Built with Claude" / "Powered by AI" 一类宣传语。

**给 AI 协作工具的明确指令**:你输出代码时不要在文件头部加版权声明 / 生成器标记;你协助 commit 时主动 strip 掉所有 AI 署名痕迹再交给用户确认。

---

## 2. 开发原则(来自 https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md)

按这几条执行,不要漂移:

- **Minimum code that solves the problem. Nothing speculative.** 只写 plan.md 列出的功能,不主动加配置项、不预留扩展点、不写"以后可能要"的抽象。如果想加 → 先问用户。
- **Surgical changes.** 不重构无关代码、不顺手"改进"格式,改动的每一行都能追到具体需求。Flag unrelated dead code,但不要未经允许删除。
- **Match existing style.** 跟工作区同级项目 `E2UniScript` / `cpp_rename` 对齐:
  - 前端 React + Vite + TypeScript(不要换 Vue / Svelte)
  - 后端 FastAPI + 内存 + JSON 文件(不要引入 Redis / SQLite / Postgres)
  - `scripts/start-web.sh / stop-web.sh / status-web.sh / _supervise.sh` 照 E2UniScript 复刻
  - `backend/` `frontend/` 命名(不是 `bridge/` `web/`)
- **Think before coding. Don't hide confusion.** notebooklm-py 的字段、Google 行为不确定 → 先写最小验证脚本跑一遍再继续,不要凭文档猜。
- **Goal-driven execution.** 每个 Phase 有可验证 DoD(见 plan.md),DoD 跑通才算结束;不要边写边改 DoD。
- **Don't assume — surface tradeoffs.** 实施中遇到"两种实现都行"时停下来问用户,而不是默选一个。
- **State assumptions explicitly.** 改完后写一段简短说明:做了什么、为什么、有什么风险 — 不要把决策隐藏在 diff 里。

---

## 3. 硬性技术约束

这几条违反会直接出问题,看好:

> **v2.0 起仅 online install**。`scripts/deploy.sh` 在线从 PyPI 装,没有 offline
> wheels 分支;`pack.sh` 不再产 `wheels/`,tarball ~5MB。部署机必须能访问
> `pypi.org` 和 `cdn.playwright.dev`(Chromium 二进制,~150MB,deploy.sh 自动装)。
> 如果未来部署机断网,`git checkout v1.0.10` 拿带 offline wheels 的版本。
>
> **v2.0 install 路径固定** 为 `~/notebooklm-bridge`(可被 `NOTEBOOKLM_BRIDGE_HOME`
> 覆盖)。`deploy.sh` 把新版本源码 rsync 到这个固定路径,排除掉 `secrets/` /
> `.env` / `state.json` / `.venv/` / log / pid 文件 — **首次部署和升级是同一条
> 命令**,不需要拷文件、不需要重登 Google。改 deploy.sh / pack.sh 时
> 任何"假设源码就是工作目录"的代码都得改成"源码 rsync 完才进 install path"。

### 3.1 `uvicorn --workers 1`
notebooklm-py 的 `NotebookLMClient` 是 "single event loop async re-entrant, not thread-safe"。多 worker 会让每个 worker 各起一份 client,把 cookies / keepalive / 限流计数器 / 熔断状态全部撕裂。

**`scripts/start-web.sh` 里硬编码 `--workers 1` 并加注释解释**。任何 PR 想改成多 worker → 直接 reject。

### 3.2 端口起始 5175 / 8002,自动递增 ≤ 10 次
- `.env` 里的 `BACKEND_PORT` / `FRONTEND_PORT` 是**起始**端口,默认 `8002` / `5175`
- `scripts/start-web.sh` 在 `[start, start+9]` 范围 probe,选第一个空闲端口;10 个都占
  就清晰报错 exit 1
- 选定的端口写到项目根的 `.runtime-ports.json`(gitignored);`stop-web.sh` /
  `status-web.sh` / `frontend/vite.config.ts` 全部跟着这个文件走 — 前端 proxy 也指向
  实际选定的 backend 端口(不是写死的 8002)
- `vite.config.ts` 仍然 `strictPort: true`:端口 probe 是 shell 脚本的事,vite 自己
  不允许"silently bump to 5176",否则日志和 banner 会跟实际端口对不上
- 想把"起始端口"换地方:改 `.env` 里的 `BACKEND_PORT=9100`、重启 start-web.sh 即可;
  不要再回头改 start-web.sh / stop-web.sh / status-web.sh / vite.config.ts 里的常量
  (它们已经不再持有硬编码了)

### 3.3 所有路由 `async`
任何 `def`(同步)的路由 / 中间件,review 必须打回。一个同步 handler 会卡住整个 event loop,所有用户同时受影响。

### 3.4 `client.chat.ask()` 必须经 `app.state.semaphore` + 熔断检查
不允许在路由里 / 后台任务里裸调 `ask()`。这是保护单个 Google 账号不被限流的唯一防线。

### 3.5 状态写入必须经 `Store` 单例
不允许在路由里直接读写全局 dict / 文件。所有 sessions / 限流 / 熔断状态走 `app.state.store` 的方法。

### 3.6 cookies
- `secrets/auth.json` 文件权限 `0600`,owner 才能读
- `INTERNAL_AUTH_SHARED_SECRET` 在 v1.0.3 起已废弃 — bundle-baked secret 跟
  deploy 机 auto-gen 出来的值必然错位会让浏览器整套 API 401,不修反而靠
  谱(LAN 已经是 trust boundary,X-User-Id 单 header 验证就够)

---

## 4. 测试要求

新功能 PR 必须带至少一个测试。优先级:

1. **`tests/test_chat_concurrency.py`** — 多协程并发 ask 的隔离 + Semaphore 排队 + 熔断触发(用 respx mock notebooklm-py)
2. **`tests/test_store.py`** — sessions get/set/reset、限流令牌桶边界、熔断开/关、`state.json` 持久化往返
3. **`tests/test_auth.py`** — `X-User-Id` 缺失 / 过长 / 共享口令错都被正确拒

跑测试:`pytest -xvs tests/` 全绿才能 merge。

---

## 5. 提交流程

1. 改完 → `pytest` 全绿 → `ruff check .` `mypy backend/` 无 error
2. 前端改动 → `npm run build` 不报错
3. 端到端验证(plan.md "端到端验证脚本"那一节里的步骤)按当前 Phase 跑通
4. **版号 patch +1**(下面 §5.1 详细列出哪些文件要同步改;改完后这些
   文件的 diff 会一起进同一笔 commit)
5. `git commit` — **先确认 message 里没有任何 AI 署名痕迹**,再提交
6. `git push origin <current-branch>` — **commit 完自动推**,solo 工作流不
   走 PR review;如果你确实在 feature branch 且想攒一批再 push,临时跟我说
   "这次不要 push" 就可以。main 分支强制推。
7. 如果走 PR(以后多人协作时):PR 描述用第一人称写"我做了什么、为什么、
   风险点",不出现"Claude 帮我 …"

### 5.1 版号 bump 规则

每次 commit 前 patch +1(`1.0.3 → 1.0.4 → 1.0.5 …`)。**只动以下 6 处**,
其他 `v1.0.x` 出现的地方全是历史叙事(CHANGELOG 条目、`v1.0.3 dropped X`
注释、`up to v1.0.2 we required X` 这种)**绝对不要碰**,改了会让代码里的
变更说明跟历史脱节。

| 文件 | 怎么改 |
|---|---|
| `pyproject.toml` | 顶层 `version = "X.Y.Z"`(single source of truth) |
| `frontend/package.json` | 顶层 `"version": "X.Y.Z"` |
| `README.md` | `**Status: vX.Y.Z**` 那一行;Quick start / Build sections 里的 `notebooklm-bridge-vX.Y.Z.tar.gz` 和 `cd notebooklm-bridge-vX.Y.Z` 命令例(grep `vX.Y.Z` 即可定位,通常 5-6 处) |
| `CHANGELOG.md` | 顶部**新增**一条 `## vX.Y.Z — <date>` 段,简述本次改动;旧条目原样保留 |

不要碰:
- `frontend/package-lock.json`(里面 1.0.x 是第三方依赖版本)
- 任何叙述性引用("v1.0.3 dropped …"、"up to v1.0.2"、"v1.0.0 deploy bug"
  等)— 这些是 commit 历史 / 代码注释里对旧版本行为的记录
- `scripts/pack.sh` 的版本号不在脚本里写死,它会去读 `pyproject.toml`(如果以后改成读 — 也只改读取逻辑,不在脚本里再 hardcode 一份)

bump 时机:**在 `git add` 之前** bump,这样版号改动跟功能改动一起进同一笔
commit,git log 上每条 commit 都对应一个明确的版本号。

如果当次 commit 只是 typo / 格式 / 注释微调,确实不想 bump → 跟我说"这次不
bump",我跳过该步骤。但默认行为是 bump。

---

## 6. 项目状态(随阶段更新)

- [x] Phase 0 — 设计:`plan.md` 完成
- [x] Phase 1 — CLI 打通(网络 + cookies 验证)
- [x] Phase 2 — Bridge + 多人前端(v1.0.0)
- [x] Phase 2.5 — v2.0 部署去复杂化(online-only,删 update.sh / setup.sh / wheels)
- [ ] Phase 3 — 飞书 Bot
- [ ] Phase 4 — Studio(暂搁置)

---

## 7. 相关参考

- 上游库:https://github.com/teng-lin/notebooklm-py
- 风格基准:`../E2UniScript/`、`../cpp_rename/`
- 开发原则源:https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md
