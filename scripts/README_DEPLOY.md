# notebooklm-bridge 部署手册(IT 视角)

把仓库根的 `scripts/pack.sh` 在开发机上跑一次,会生成

```
dist/notebooklm-bridge-v<VERSION>.tar.gz
dist/notebooklm-bridge-v<VERSION>.tar.gz.sha256
```

把这两个文件拷到目标机(LAN 内能访问 google.com 的那台),按下面 4 步跑。

---

## 1. 前置条件

目标机需要:

- **桌面环境**(GNOME / KDE / XFCE 之类),`scripts/login.sh` 会弹 Chromium 让你用 Google 账号登录
- 能访问 `https://notebooklm.google.com` 和 `https://cdn.playwright.dev`(playwright 第一次跑要下载 ~150MB Chromium)
- Python ≥ 3.11
- Node ≥ 18(只用来 serve 前端 `dist/`,不需要 npm install)
- 能监听端口 **8002**(backend)和 **5175**(frontend)— 这是硬约束,见仓库根 `CLAUDE.md` §3.2
- 能 `sudo apt install`(或 `sudo dnf install`)装 Chromium 依赖的系统库(libnspr4 / libnss3 / …);`login.sh` 会自动检测 + prompt

如果目标机没桌面或不能联网,看 `docs/cookie-refresh-runbook.md` 的 "Fallback" 段。

---

## 2. 首次部署(4 步)

```bash
# 校验 tarball 没损坏
sha256sum -c notebooklm-bridge-v<VERSION>.tar.gz.sha256

# 1. 解压
tar -xzf notebooklm-bridge-v<VERSION>.tar.gz
cd notebooklm-bridge-v<VERSION>

# 2. 装依赖 + 创建 .venv + 准备 .env
bash deploy.sh

# 3. 弹 Chromium 让你用 Google 账号登录,产出 secrets/auth.json
bash scripts/login.sh

# 4. 启动
bash scripts/start-web.sh
```

验证:

```bash
curl -s http://localhost:8002/api/healthz | jq
# 期望:{"auth_valid": true, ...}
```

浏览器开 `http://<目标机 IP>:5175`,首次进会弹窗让你输入名字 / 工号(就是 `X-User-Id`)。

> **注:v1.0.3 起不再有 `INTERNAL_AUTH_SHARED_SECRET`**。之前那套"开发机 mint secret → 写进前端 build → IT 部署机得 paste 一样的值"的方案被废弃了(它在 IT 跑 `deploy.sh` 自动生成新 secret 时会跟 prebuilt 前端 bundle 错位,所有 API 都 401)。LAN 已经是 trust boundary,X-User-Id 单 header 验证就够。

---

## 3. Cookie 过期后重新登录

`/api/healthz` 显示 `auth_valid=false` 时:

```bash
cd /path/to/notebooklm-bridge-v<VERSION>
bash scripts/login.sh                              # 弹浏览器,再登一次
bash scripts/stop-web.sh && bash scripts/start-web.sh
```

`login.sh` 是 idempotent 的,可以任意次重跑。`--refresh` flag 强制重登,`--profile NAME` 切换多账号。

---

## 4. 升级到新版本

```bash
tar -xzf notebooklm-bridge-v<NEW>.tar.gz
cd notebooklm-bridge-v<NEW>
bash update.sh /path/to/notebooklm-bridge-v<OLD>
bash scripts/start-web.sh
```

`update.sh` 会:

1. 调 `stop-web.sh` 停掉旧版本的 supervisor
2. 把 `<OLD>/.env`、`<OLD>/secrets/`、`<OLD>/state.json` 复制过来(免得重登 + 重做配置)
3. 在 `.venv` 里用新 `wheels/` 重新装一次 backend 包

升级回滚:`cd <OLD> && bash scripts/start-web.sh`。`state.json` 默认在目录根,两个版本来回切不丢 session。

---

## 5. 常见故障

| 症状 | 原因 / 处理 |
|---|---|
| `/api/healthz` 返回 `auth_valid: false` | cookies 过期 → 重跑 `bash scripts/login.sh` → 重启 |
| `login.sh` 报 "Chromium 缺 lib…" | 按 prompt 跑 `sudo apt-get install …`;脚本会自动 verify |
| `login.sh` 报 "X server / DISPLAY not available" | 目标机没桌面 → 看 `docs/cookie-refresh-runbook.md` 的 fallback(在你工位机跑 login.sh + scp `secrets/auth.json` 到目标机) |
| `start-web.sh` 报端口被占 | `bash scripts/start-web.sh --force` 会杀掉**本项目目录下**的占端口进程,不动别的 |
| 突然 503 集中 | upstream 触发熔断 — 等 30s 自动恢复;`.backend.log` 里有 `circuit_breaker_open` 字样 |
| `ModuleNotFoundError` | 大概率忘了 `pip install -e .` — `deploy.sh` / `update.sh` 都会做这一步,直接重跑 |

更多见仓库根 `README.md` 和 `docs/upstream-breakage-runbook.md`。

---

## 6. 安全清单

- [ ] `secrets/auth.json` 是 `0600`,owner 限制为运行 bridge 的 system user(`login.sh` 自动设)
- [ ] 目标机的防火墙允许 `:5175` / `:8002` 只对你信任的内网开放(**不对公网**)
- [ ] 升级后 `secrets/auth.json` 还是 `0600`(`update.sh` 会保留权限,建议手验一次)
- [ ] `state.json` 不要 commit(默认 `.gitignored`)
- [ ] 别把 `secrets/auth.json` 转贴 / 发给别人 — 它是个有效的 Google session,等价于你账号本身
