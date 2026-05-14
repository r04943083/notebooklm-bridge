# Plan: NotebookLM 内网共享 — 方案 A 详细计划

## Context

你有一个 Google 账号,上面建好了 NotebookLM 的 notebook 和源材料。团队成员**完全连不上 Google**,需要从内网用同一份内容做问答。

**方案**:在一台能访问 Google 的机器上跑 Bridge(FastAPI),内部用 [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) 调 NotebookLM 的内部 RPC;再起一个 React 前端给团队多人同时使用;飞书 Bot 作为 Phase 3 加项。

**约束**:
- 必须:Q&A 带引用源;网页端可多人同时使用;沿用现有项目栈和端口约定
- 加分:飞书集成;Studio(podcast/video/quiz)
- 共享方式:同一份内容(单 Google 账号);每个内部用户的会话上下文应用层隔离

---

## 开发原则(来自 [andrej-karpathy-skills/CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md))

整个项目按这几条执行,不要漂移:

- **Minimum code that solves the problem. Nothing speculative.** 只写本计划列出的功能,不主动加配置项、不预留扩展点、不写"以后可能要"的抽象。
- **Surgical changes.** 不重构无关代码、不顺手"改进"格式,改动的每一行都能追到具体需求。
- **Match existing style.** 跟 E2UniScript / cpp_rename 一致:React + Vite + TypeScript 前端、FastAPI + 内存 dict + JSON 文件持久化后端,不要引入 Redis / Vue / 复杂状态机。
- **Think before coding. Don't hide confusion.** 凡 notebooklm-py 的字段、Google 行为不确定 → 先写最小验证脚本跑一遍再继续,不要凭文档猜。
- **Goal-driven execution.** 每个 Phase 有可验证 DoD,跑通才算结束。
- **Don't assume — surface tradeoffs.** 实施中遇到"两种实现都行"时停下来问,而不是默选一个。

## 作者署名(项目级硬性规则)

- 本项目所有代码、提交、文档署名只能是 **yihonglu**(项目所有者)。
- **任何 commit 都不允许出现 `Co-Authored-By: Claude ...` 或 `Generated with Claude Code` 一类字样**;PR / README / changelog / 代码注释里也不出现 "Claude" 或暗示由 AI 生成的标记。
- 用 Claude Code 协作时,执行前在 commit message 模板里删掉默认的 Co-Authored-By 行。
- 这条规则会写进项目根 `CLAUDE.md`,作为开发期间的强约束。

---

## 栈与端口(对齐既有项目)

| 项目 | Frontend(vite) | Backend(uvicorn) | 框架 | 状态存储 |
|---|---|---|---|---|
| E2UniScript | 5173 | 8000 | React 18/19 | 内存 + JSON |
| cpp_rename | 5174 | 8001 | React 19 | 内存 + JSON |
| **notebooklm-bridge** | **5175** | **8002** | **React 19** | **内存 + JSON** |

`scripts/start-web.sh / stop-web.sh / status-web.sh / _supervise.sh` 从 `E2UniScript/scripts/` 复刻,只改端口和模块名 — 包括 supervisor 自愈、`--force` 处理同项目残留 pid、`.backend.pid / .frontend.pid / .backend.log / .frontend.log` 命名。

---

## 总体架构

```
┌─────────────────────────────────────┐         ┌──────────────────────────────────────┐
│   内网(NO Google)                    │         │   Bridge 主机(YES Google)             │
│                                      │         │                                      │
│   [用户 A 浏览器] ─┐                  │         │                                      │
│   [用户 B 浏览器] ─┼──→  :5175 (vite) │ HTTPS  │  uvicorn :8002 (1 worker)            │
│   [用户 C 浏览器] ─┘     /api proxy  │ ─────→ │      │                                │
│                                      │         │   NotebookLMClient(单例 + keepalive) │
│   [飞书 Bot Server, Phase 3] ────────│ ─────→ │      │                                │
│                                      │         │   notebooklm.google.com (内部 RPC)   │
└─────────────────────────────────────┘         │   state.json (会话/限流持久化)        │
                                                └──────────────────────────────────────┘
```

**部署关键**:
- Bridge 主机必须 `curl -I https://notebooklm.google.com` 通(海外 VPS / 跳板机)。
- `uvicorn --workers 1`,不能加 worker — notebooklm-py 是 single-event-loop async re-entrant、不是线程安全,多 worker 会撕裂 client / cookies / 限流计数器。在 `start-web.sh` 里硬编码且加注释。

---

## 多人并发使用 — 核心设计

### 1. 一个 worker 怎么撑多人
notebooklm-py 文档原话:

> "The client is async re-entrant on a single event loop... Not thread-safe. Do not share NotebookLMClient across threads or multiple event loops."

`client.chat.ask()` 是 IO-bound(等 Google 返回),一个 event loop 里 N 个协程并发等响应,瓶颈在 Google 限流而不是 Bridge。多人按问 → 多个协程并发 → 各自拿自己的答案。所有路由必须 `async`,不能写阻塞代码。

### 2. 用户身份(谁是谁)
内网 trusted 网络,**前端首次访问弹窗问"你的名字 / 工号"**,写 localStorage,从此每次请求带 `X-User-Id`。`X-User-Id` 是后续所有逻辑的 key — 会话隔离、限流。

不做 SSO、不做多种 auth mode 切换。

### 3. 会话隔离
内存 dict:
```python
# bridge/store.py
sessions: dict[tuple[str, str], str] = {}   # (user_id, notebook_id) -> conversation_id
```
启动时从 `state.json` 加载,每次写入异步 dump 到 `state.json`。重启不丢历史。

### 4. 公平 / 限流 / 防滥用
两条防线,都用内存(不需要 Redis):

- **每用户令牌桶**:容量 3,速率 10/分钟,超限 429 + `Retry-After`
- **全局并发上限**:`asyncio.Semaphore(8)` 包 `client.chat.ask()`,第 9 个请求排队,排队 > 30 秒 503

### 5. 全局熔断
- 收到 Google 429/5xx → 设 `circuit_open_until = now() + 30s`
- 这 30 秒内所有 `/api/chat` 直接返 503 + 文案,**避免雪崩重试把账号打挂**
- 30 秒后自动恢复

### 6. 失败保护
- cookies 失效 → 所有 `/api/chat` 返 503;前端展示"凭证失效,管理员处理中",不崩溃
- 任一用户的协程异常 → 只该请求失败,其他用户不受影响

### 7. 不做的事(明确边界)
- ❌ SSE 流式 — 用户没要求,先一次性返回 + spinner 够用
- ❌ "在线人数"显示 — 思辨性
- ❌ 多种 auth mode 切换 — 只做 header 模式
- ❌ Redis — 内存 + JSON 文件够用、对齐既有项目
- ❌ 多 conversation 切换的高级 UI — 一个用户在一个 notebook 上一个 conversation,需要新对话就点"新对话"按钮

---

## 工程结构

```
notebooklm-bridge/
├── pyproject.toml
├── README.md
├── .env.example
├── scripts/
│   ├── start-web.sh        # 启动 backend :8002 + frontend :5175,E2UniScript 风格
│   ├── stop-web.sh
│   ├── status-web.sh
│   └── _supervise.sh
├── backend/
│   ├── __init__.py
│   ├── app.py              # FastAPI 入口、lifespan、路由注册
│   ├── config.py           # pydantic-settings
│   ├── client.py           # NotebookLMClient 单例 + keepalive task
│   ├── store.py            # sessions + 限流 + 熔断,内存 + JSON 持久化(参考 cpp_rename/backend/store.py)
│   ├── auth.py             # 校验 X-User-Id + X-Shared-Secret
│   ├── schemas.py          # pydantic 请求/响应
│   ├── routes/
│   │   ├── chat.py         # POST /api/chat, /api/chat/reset
│   │   ├── notebooks.py    # GET /api/notebooks, /api/sources
│   │   └── health.py       # GET /healthz
│   └── logging_conf.py
├── tests/
│   ├── test_chat_concurrency.py   # 多协程并发 ask 隔离
│   ├── test_store.py              # sessions + 限流 + 熔断
│   └── test_auth.py
├── docs/
│   ├── cookie-refresh-runbook.md
│   └── upstream-breakage-runbook.md
└── frontend/               # React + Vite + TypeScript,匹配 cpp_rename/frontend 风格
    ├── package.json
    ├── vite.config.ts      # port 5175, strictPort: true, /api → :8002
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts          # fetch wrapper,自动带 X-User-Id
        └── components/
            ├── UserPrompt.tsx     # 首次访问问名字
            ├── NotebookPicker.tsx
            ├── ChatPane.tsx       # 问 + 答 + citations
            └── ConversationHistory.tsx   # localStorage 里最近 20 个 (notebook, conv_id, 首句)
```

注意:`backend/` 而不是 `bridge/` — 对齐 cpp_rename 命名;`frontend/` 也对齐。

---

## Phase 1 — MVP(1~2 天):命令行打通

**目标**:Bridge 主机上 notebooklm-py CLI 能问到答案。**不写应用代码**,只验证网络 + cookies。

1. 选 Bridge 主机:`curl -I https://notebooklm.google.com` 200/302;Python 3.11+。
2. 本地 Chrome 登 NotebookLM,打开目标 notebook 一次。
3. ```bash
   pipx install "notebooklm-py[browser,cookies]"
   notebooklm auth import-cookies --browser chrome --profile default
   scp ~/.notebooklm/auth.json bridge:/opt/notebooklm-bridge/secrets/auth.json
   ```
4. Bridge 上:
   ```bash
   export NOTEBOOKLM_AUTH_JSON=/opt/notebooklm-bridge/secrets/auth.json
   notebooklm notebook list
   notebooklm chat ask <notebook_id> "测试问题"
   ```

### Phase 1 DoD
- [ ] `notebook list` 列出预期 notebook
- [ ] `chat ask` 返回带引用的答案
- [ ] keepalive 跑 2 小时,cookies 仍有效

---

## Phase 2 — Bridge + 多人前端(1~2 周)

### 2.1 依赖

`pyproject.toml`:
```toml
[project]
name = "notebooklm-bridge"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.32",
  "notebooklm-py>=<pin-current-stable>",
  "pydantic>=2.9",
  "pydantic-settings>=2.6",
  "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "respx>=0.21", "ruff", "mypy"]
```

`.env.example`:
```
NOTEBOOKLM_AUTH_JSON=/opt/notebooklm-bridge/secrets/auth.json
NOTEBOOKLM_KEEPALIVE_SECONDS=1800
ALLOWED_NOTEBOOK_IDS=                # 空 = 不限制;否则逗号分隔
BACKEND_HOST=0.0.0.0
BACKEND_PORT=8002
STATE_JSON=/opt/notebooklm-bridge/state.json
RATE_LIMIT_PER_MINUTE=10
RATE_LIMIT_BURST=3
MAX_INFLIGHT_ASKS=8
ASK_TIMEOUT_SECONDS=60
CIRCUIT_BREAKER_COOLDOWN=30
INTERNAL_AUTH_SHARED_SECRET=<32B 随机>
LOG_LEVEL=INFO
```

### 2.2 `backend/client.py` — 单例 + keepalive
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_settings()
    app.state.client = await NotebookLMClient.from_storage(cfg.auth_json_path)
    app.state.keepalive_task = asyncio.create_task(_keepalive(app.state.client, cfg))
    app.state.semaphore = asyncio.Semaphore(cfg.max_inflight_asks)
    app.state.store = Store.load(cfg.state_json)
    yield
    app.state.keepalive_task.cancel()
    app.state.store.flush()
    await app.state.client.close()
```

`_keepalive` 每 30 分钟跑一次 `client.notebooks.list()` 当心跳 + 续 `__Secure-1PSIDTS`,记录 `last_refresh_ts`。

### 2.3 `backend/store.py` — 状态全集中

单一 `Store` 类(对齐 cpp_rename `backend/store.py` 单例风格)封装:

- `sessions: dict[tuple[str, str], str]` — `(user_id, notebook_id) → conversation_id`
- `rate_buckets: dict[str, tuple[float tokens, float last_refill_ts]]` — 令牌桶
- `circuit_open_until: float` — 熔断截止时间

接口:
- `get_session(user_id, notebook_id) -> str | None`
- `set_session(user_id, notebook_id, conversation_id)`
- `reset_session(user_id, notebook_id)`
- `try_acquire_rate(user_id) -> bool`
- `is_circuit_open() -> bool`
- `trip_circuit()`
- `flush()` / `load(path)`

每次写操作触发后台 `asyncio.create_task(flush_async())` 异步持久化到 `state.json`(debounce 1 秒)。

### 2.4 `backend/auth.py`
```python
async def require_internal_user(
    x_user_id: Annotated[str, Header()],
    x_shared_secret: Annotated[str, Header()],
) -> str:
    if x_shared_secret != settings.internal_auth_shared_secret:
        raise HTTPException(401, "无效凭证")
    if not x_user_id or len(x_user_id) > 64:
        raise HTTPException(400, "无效 X-User-Id")
    return x_user_id
```

### 2.5 `backend/routes/chat.py`

```python
class ChatRequest(BaseModel):
    notebook_id: str
    question: str = Field(min_length=1, max_length=4000)
    source_ids: list[str] | None = None
    reset: bool = False

class Citation(BaseModel):
    source_id: str
    source_title: str
    text: str
    page: int | None = None

class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    conversation_id: str
    turn: int

@router.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, user_id: str = Depends(require_internal_user)):
    cfg = get_settings()
    if cfg.allowed_notebook_ids and req.notebook_id not in cfg.allowed_notebook_ids:
        raise HTTPException(403, "notebook 不在允许列表")

    store = app.state.store
    if store.is_circuit_open():
        raise HTTPException(503, "服务繁忙,请稍后")
    if not store.try_acquire_rate(user_id):
        raise HTTPException(429, "请求过频", headers={"Retry-After": "6"})

    cid = None if req.reset else store.get_session(user_id, req.notebook_id)

    async with app.state.semaphore:
        try:
            result = await asyncio.wait_for(
                app.state.client.chat.ask(
                    notebook_id=req.notebook_id,
                    question=req.question,
                    source_ids=req.source_ids,
                    conversation_id=cid,
                ),
                timeout=cfg.ask_timeout_seconds,
            )
        except (RateLimitedByGoogle, UpstreamServerError):
            store.trip_circuit()
            raise HTTPException(503, "上游限流,服务暂歇")

    store.set_session(user_id, req.notebook_id, result.conversation_id)
    return ChatResponse(
        answer=result.answer,
        citations=[Citation(**c.model_dump()) for c in result.citations],
        conversation_id=result.conversation_id,
        turn=result.turn,
    )
```

`POST /api/chat/reset`:`store.reset_session(user_id, notebook_id)`,返回 204。

### 2.6 `backend/routes/notebooks.py`
- `GET /api/notebooks` → `client.notebooks.list()`,30 秒内存 LRU
- `GET /api/sources?notebook_id=X` → `client.sources.list(...)`,30 秒 LRU

### 2.7 `backend/routes/health.py`
`GET /healthz`:
```json
{
  "auth_valid": true,
  "last_refresh_ts": "...",
  "last_rpc_ts": "...",
  "inflight_asks": 2,
  "circuit_open": false,
  "notebooklm_py_version": "x.y.z"
}
```

### 2.8 前端(`frontend/`)

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8002' },
  },
})
```

组件(故意保持最小):
| 组件 | 行为 |
|---|---|
| `UserPrompt.tsx` | 检查 localStorage `nblm_user_id`,空 → 模态框让用户输入名字 → 写入 |
| `NotebookPicker.tsx` | 调 `/api/notebooks`,下拉切换;选择写 localStorage |
| `ChatPane.tsx` | 输入框 → 提交 → spinner → 收到 ChatResponse 后渲染 answer + 内联 citation 标号 `[1] [2]`;答案下面列 citations 详情 |
| `ConversationHistory.tsx` | localStorage 存最近 20 个 (notebook_id, conversation_id, 首句),侧边列表,点切换;"新对话"按钮 → 调 `/api/chat/reset` |

`api.ts`:
```ts
const userId = () => localStorage.getItem('nblm_user_id') ?? ''
const secret = import.meta.env.VITE_SHARED_SECRET

export async function ask(req: ChatRequest): Promise<ChatResponse> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId(),
      'X-Shared-Secret': secret,
    },
    body: JSON.stringify(req),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
```

文案中文优先,顶部显眼提示"问答内容会发送到 NotebookLM (Google) 服务器"。

### 2.9 `scripts/start-web.sh`(关键差异)

从 `E2UniScript/scripts/start-web.sh` 复刻,改这几个值:
```bash
BACKEND_PORT=8002
FRONTEND_PORT=5175
# 后端启动行:
"$SCRIPT_DIR/_supervise.sh" backend "$BACKEND_LOG" -- \
    uvicorn backend.app:app \
        --host "$HOST" --port "$BACKEND_PORT" \
        --workers 1 \
        --reload --reload-dir backend \
        --no-access-log &
# 注释里写清楚:--workers 1 是硬性约束,见 notebooklm-py single event loop 说明
```

`stop-web.sh / status-web.sh / _supervise.sh` 同样改端口照搬。

### Phase 2 DoD
- [ ] `scripts/start-web.sh` 起后,backend 0.0.0.0:8002、vite 0.0.0.0:5175 都通,内网用户访问 `http://<bridge>:5175` 看到 UI
- [ ] 单用户单轮:`POST /api/chat` 200 + 非空 answer + ≥1 citation
- [ ] 多轮:同 user_id 连发两条相关问题,第二条引用第一条上下文
- [ ] **多人并发隔离**(核心):playwright 起 5 个 tab 模拟 5 个不同 user_id 同时各发 3 轮,answer 不串扰
- [ ] 限流:同 user_id 一分钟 20 次 → 第 11 次起 429
- [ ] 全局并发:mock 让 ask() 各 sleep 10 秒,9 个同时发 → 第 9 个排队,30s 内拿到结果或 503
- [ ] 熔断:mock notebooklm-py 抛 RateLimited → 接下来 30 秒所有人 503;30 秒后自动恢复
- [ ] 重启恢复:`scripts/stop-web.sh && start-web.sh` → 5 个用户都能继续多轮(state.json 生效)
- [ ] 凭证失效降级:`mv auth.json auth.json.bak` 后重启 → `/healthz` `auth_valid=false`、`/api/chat` 503 + 明确文案、不 500
- [ ] 单测:store(sessions + 限流 + 熔断 + 持久化往返)、auth、并发协程隔离

---

## Phase 3 — 飞书 Bot(加分项,3~5 天)

只在 Phase 2 全 DoD 通过后启动。

实现要点:
- `backend/feishu.py` 单文件(不拆 verify/handler/card 三文件 — 保持最小)
- 飞书事件回调:校验签名 → 取 `sender.open_id` → 复用 Phase 2 的 chat 函数(同样过 store 限流 + 熔断) → 渲染消息卡片回复
- 配 `FEISHU_DEFAULT_NOTEBOOK_ID`,飞书用户不用选 notebook

DoD:
- [ ] 私聊一条问题 → 30s 内卡片回复带引用
- [ ] 群里 @Bot → 同上
- [ ] 卡片"新对话"按钮 → 调 reset
- [ ] 伪造签名 → 401
- [ ] 多飞书用户并发,各自上下文不串

> **网络拓扑提醒**:飞书事件回调是飞书云 → Bridge,Bridge 需要公网入口。海外 VPS 天然成立;内网部署需要反向代理 / 内网穿透。

---

## Phase 4 — Studio(远期可选,只在被要求时做)

不在当前 roadmap。要做时:`POST /api/studio/audio` 等异步端点 → 任务表 → 文件落内网 MinIO → 给内网下载 URL。每用户同时最多 1 个 in-flight studio task。

---

## 运维文档

### `docs/cookie-refresh-runbook.md`
`/healthz` 报 `auth_valid=false` 时:
1. 本地 Chrome 重登 NotebookLM
2. `notebooklm auth import-cookies --browser chrome --profile default`
3. `scp ~/.notebooklm/auth.json bridge:/opt/notebooklm-bridge/secrets/auth.json`
4. `scripts/stop-web.sh && scripts/start-web.sh`
5. `curl /healthz` 确认 + `notebooklm chat ask <id> "ping"` 烟测

RTO < 10 分钟。

### `docs/upstream-breakage-runbook.md`
`chat.ask()` 报 RPC 错时:
1. 查 [notebooklm-py releases](https://github.com/teng-lin/notebooklm-py/releases) / issues
2. 有 fix → `pip install -U notebooklm-py`,重启验证
3. 没 fix → 前端 / 飞书 503 + 公告,跟 issue

---

## 关键文件清单

| 路径 | 优先级 | Phase |
|---|---|---|
| `scripts/start-web.sh / stop-web.sh / status-web.sh / _supervise.sh` | P0 | 2 |
| `backend/app.py` `config.py` `client.py` `store.py` `auth.py` `schemas.py` | P0 | 2 |
| `backend/routes/{chat,notebooks,health}.py` | P0 | 2 |
| `frontend/` 全部(vite 5175 + React) | P0 | 2 |
| `tests/test_chat_concurrency.py` `test_store.py` `test_auth.py` | P0 | 2 |
| `docs/cookie-refresh-runbook.md` `docs/upstream-breakage-runbook.md` | P0 | 2 |
| `backend/feishu.py` | P2 | 3 |

---

## 端到端验证脚本(按顺序)

最终验证应该能被一个脚本 `scripts/e2e.sh` 串起来跑完。手动顺序:

1. **网络**:Bridge 上 `curl -sI https://notebooklm.google.com` 200/302
2. **健康**:`curl http://<bridge>:8002/healthz` → `auth_valid=true`、`last_refresh_ts` 30 分钟内
3. **Q&A 单轮**:
   ```bash
   curl -X POST http://<bridge>:8002/api/chat \
     -H "X-User-Id: alice" -H "X-Shared-Secret: $SECRET" \
     -d '{"notebook_id":"<id>","question":"<已知问题>"}'
   ```
   断言 200 + answer 非空 + citations ≥ 1
4. **多轮**:同 user_id 第二条问"再展开一点" → 应该承接前一条
5. **多人隔离**(核心):playwright 模拟 5 个 user 同时各发 3 轮,grep 答案不应出现"别人问的关键词"
6. **限流**:一分钟 20 次 → 第 11 次起 429
7. **熔断**:mock ask() 抛 RateLimited → 接下来 30 秒全员 503;30 秒后恢复
8. **重启**:`stop-web.sh && start-web.sh` → 5 个用户的多轮上下文都还在
9. **降级**:`mv secrets/auth.json secrets/auth.json.bak` 后重启 → `/healthz` 标红、`/api/chat` 503、不 500
10. **前端真机**:用两台机器 / 两个浏览器同时打开 `http://<bridge>:5175`,各填不同名字,各自提问,互不干扰
11. **(Phase 3)** 飞书私聊 + 群 @,30s 内卡片回复;签名伪造 → 401

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Google 改内部 RPC,notebooklm-py 挂 | 监控 + runbook;版本可秒回滚 |
| cookies 突然失效 | `/healthz` 告警 + 10 分钟人工恢复 runbook |
| 单账号被 Google 限流 | Bridge 主动限流 + 熔断 + 指数退避;后期备用账号轮换 |
| 内部用户问敏感内容被传 Google | 前端 / 飞书首次明确提示;严苛合规需 NotebookLM Enterprise |
| Bridge 主机被攻陷 → cookies 泄漏 | secrets 0600 权限 + nginx 内网 IP 白名单 |
| 多 worker 误起致 client 撕裂 | `start-web.sh` 硬编码 `--workers 1` + 注释 |
