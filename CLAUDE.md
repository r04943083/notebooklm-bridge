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

### 3.1 `uvicorn --workers 1`
notebooklm-py 的 `NotebookLMClient` 是 "single event loop async re-entrant, not thread-safe"。多 worker 会让每个 worker 各起一份 client,把 cookies / keepalive / 限流计数器 / 熔断状态全部撕裂。

**`scripts/start-web.sh` 里硬编码 `--workers 1` 并加注释解释**。任何 PR 想改成多 worker → 直接 reject。

### 3.2 端口固定 5175 / 8002
- `frontend/vite.config.ts`: `port: 5175, strictPort: true`
- `scripts/start-web.sh`: `BACKEND_PORT=8002` `FRONTEND_PORT=5175`

冲突时报错退出,不允许 vite 自动迁移到 5176。

### 3.3 所有路由 `async`
任何 `def`(同步)的路由 / 中间件,review 必须打回。一个同步 handler 会卡住整个 event loop,所有用户同时受影响。

### 3.4 `client.chat.ask()` 必须经 `app.state.semaphore` + 熔断检查
不允许在路由里 / 后台任务里裸调 `ask()`。这是保护单个 Google 账号不被限流的唯一防线。

### 3.5 状态写入必须经 `Store` 单例
不允许在路由里直接读写全局 dict / 文件。所有 sessions / 限流 / 熔断状态走 `app.state.store` 的方法。

### 3.6 cookies / 共享口令文件
- `secrets/auth.json` 文件权限 `0600`,owner 才能读
- `INTERNAL_AUTH_SHARED_SECRET` 不入仓 — 只在 `.env`(已 `.gitignore`)
- `.env.example` 用占位符 `<32B 随机>`,不放真值

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
4. `git commit` — **先确认 message 里没有任何 AI 署名痕迹**,再提交
5. PR 描述用第一人称写"我做了什么、为什么、风险点",不出现"Claude 帮我 …"

---

## 6. 项目状态(随阶段更新)

- [x] Phase 0 — 设计:`plan.md` 完成
- [ ] Phase 1 — CLI 打通(网络 + cookies 验证)
- [ ] Phase 2 — Bridge + 多人前端
- [ ] Phase 3 — 飞书 Bot
- [ ] Phase 4 — Studio(暂搁置)

进入 Phase 2 之前,Phase 1 的 DoD 全部 check 完。

---

## 7. 相关参考

- 上游库:https://github.com/teng-lin/notebooklm-py
- 风格基准:`../E2UniScript/`、`../cpp_rename/`
- 开发原则源:https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md
