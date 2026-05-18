# notebooklm-bridge 部署手册

把仓库根的 `scripts/pack.sh` 在开发机上跑一次,会生成

```
dist/notebooklm-bridge-v<VERSION>.tar.gz
dist/notebooklm-bridge-v<VERSION>.tar.gz.sha256
```

把这个 `.tar.gz` 拷到目标机(LAN 内能访问 google.com 的那台),按下面步骤跑。

---

## 1. 前置条件

目标机需要:

- Python ≥ 3.11
- Node ≥ 18(只用来 serve 前端 `dist/`,不需要 npm install)
- 能直接访问 `https://notebooklm.google.com`(notebooklm-py 单点强制要求)
- 能监听端口 **8002**(backend)和 **5175**(frontend)— 这是硬约束,见仓库根 `CLAUDE.md` §3.2

如果只想跑回环(localhost),后面用 `bash scripts/start-web.sh --local`。

---

## 2. 首次部署

```bash
# 校验 tarball 没有损坏(可选但建议)
sha256sum -c notebooklm-bridge-v<VERSION>.tar.gz.sha256

tar -xzf notebooklm-bridge-v<VERSION>.tar.gz
cd notebooklm-bridge-v<VERSION>

# 装 .venv + 从 wheels/ 离线装依赖 + 创建 secrets/
bash deploy.sh
```

`deploy.sh` 跑完之后还有两件事必须人工补:

### 2.1 写入 INTERNAL_AUTH_SHARED_SECRET

```bash
# 在已经被 deploy.sh 创建好的 .env 里,把这一行换成真值
INTERNAL_AUTH_SHARED_SECRET=<paste here>

# 推荐用:
openssl rand -hex 32
```

这个秘密给所有内网用户共享 — 前端 fetch 时会在请求头加 `X-Shared-Secret`,跟 backend 比对。

### 2.2 放入 secrets/auth.json

cookies 需要从已经走完 Phase 1 的主机拷过来。具体过程见仓库根的 `docs/cookie-refresh-runbook.md`,核心步骤:

```bash
# 从 Phase 1 主机
scp secrets/auth.json target-host:~/notebooklm-bridge-v<VERSION>/secrets/

# 在目标机
chmod 600 secrets/auth.json
```

---

## 3. 启动 + 验证

```bash
bash scripts/start-web.sh           # 默认绑 0.0.0.0,LAN 内可访问
# 或:
bash scripts/start-web.sh --local   # 只绑 127.0.0.1

# 验证
curl -fsS http://localhost:8002/api/healthz
# 期望:{"auth_valid": true, ...}
```

浏览器开 `http://<目标机 IP>:5175`,首次进会弹窗让输入 X-User-Id。

---

## 4. 升级到新版本

在新版本的 tarball 同级目录解开,然后让 `update.sh` 帮你把 `.env` / `secrets/` / `.venv` 从旧目录搬过来:

```bash
tar -xzf notebooklm-bridge-v<NEW>.tar.gz
cd notebooklm-bridge-v<NEW>
bash update.sh /path/to/notebooklm-bridge-v<OLD>
bash scripts/start-web.sh
```

`update.sh` 会:

1. 调 `stop-web.sh` 把旧版本的 supervisor 停掉
2. 把 `<OLD>/.env`、`<OLD>/secrets/`、`<OLD>/.venv` 复制到当前目录
3. 在 `.venv` 里用新 `wheels/` 重新装一次 backend 包(包括 notebooklm-bridge 本身)

升级回滚 = `cd <OLD> && bash scripts/start-web.sh`。state.json 默认在仓库根的 `state.json`,两个版本可以来回切而不丢 session。

---

## 5. 常见故障

| 症状 | 原因 / 处理 |
|---|---|
| `/api/healthz` 返回 `auth_valid: false` | cookie 过期 → 重做 Phase 1 → 覆盖 `secrets/auth.json` → 重启 |
| `start-web.sh` 报端口被占 | `bash scripts/start-web.sh --force` 会杀掉**本项目目录下**的占端口进程,不会动其他项目的 |
| 浏览器 401 | `.env` 里 `INTERNAL_AUTH_SHARED_SECRET` 跟前端 build 时注入的不一致 — 重新部署,不要手改 frontend/dist 里的字符串 |
| 突然 503 集中 | upstream 进了熔断 — 等 30s 自动恢复;`.backend.log` 里有 `circuit_breaker_open` 字样 |
| 装了一堆 wheels 还报 ModuleNotFoundError | 大概率忘了 `.venv/bin/pip install -e .` — `deploy.sh` / `update.sh` 都会做这一步,直接重跑 |

更多见仓库根 `README.md` 和 `docs/upstream-breakage-runbook.md`。

---

## 6. 安全清单

- [ ] `secrets/auth.json` 是 `0600`,owner 限制为运行 bridge 的 system user
- [ ] `.env` 里的 `INTERNAL_AUTH_SHARED_SECRET` 是 ≥32 字节随机值,**没** commit 到任何代码库
- [ ] 目标机的防火墙允许 :5175 / :8002 只对你信任的内网开放(不对公网开)
- [ ] 升级后 `secrets/auth.json` 还是 `0600`(update.sh 会保留权限但建议手验一次)

如果 `.env` 不慎泄露,立刻 rotate `INTERNAL_AUTH_SHARED_SECRET` 然后所有用户都得重新填一遍(实际上前端 build 时注入,所以 rebuild 重 pack 重 deploy 才生效)。
