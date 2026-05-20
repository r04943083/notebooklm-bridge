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
- **Python ≥ 3.11**(打包里的 wheels 是 cp311 ABI,3.10 装不进、3.9 完全跑不了)
- Node ≥ 18(只用来 serve 前端 `dist/`,不需要 npm install)
- 起始端口 **8002**(backend)和 **5175**(frontend);如果被占,`start-web.sh` 会自动
  在 `[8002,8011]` / `[5175,5184]` 范围 probe,选第一个空闲的。10 个都被占才报错。见 §5。
- 能 `sudo apt install`(或 `sudo dnf install`)装 Chromium 依赖的系统库(libnspr4 / libnss3 / …);`login.sh` 会自动检测 + prompt

### 1.1 多 Python 版本共存的机器

如果目标机同时装了 3.9 和 3.11(常见情况:系统默认 `python3` 是 3.9,但 IT 把
`python3.11` 单独装上了),`deploy.sh` / `update.sh` 会**自动**按
`python3.11 → python3.12 → python3` 顺序找第一个满足 `>=3.11` 的解释器,不会被
"系统默认 python3 是 3.9"卡住。

如果 `python3.11` 装在不在 `$PATH` 的位置(比如 `/opt/python3.11/bin/python3.11`),
用环境变量 override:

```bash
PYTHON_BIN=/opt/python3.11/bin/python3.11 bash deploy.sh
```

`update.sh` 也认同一个环境变量。

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
# 默认端口 8002;如果 start-web.sh 因 8002 被占自动递增了,实际端口看 .runtime-ports.json
# 或 `bash scripts/status-web.sh` 的输出
curl -s http://localhost:8002/api/healthz | jq
# 期望:{"auth_valid": true, ...}
```

浏览器开 `http://<目标机 IP>:5175`(同理,实际前端端口看 status-web.sh 的输出),首次
进会弹窗让你输入名字 / 工号(就是 `X-User-Id`)。

### 2.1 想换默认端口

`.env` 里改 `BACKEND_PORT` / `FRONTEND_PORT`,这就是"起始端口"。下次 start-web.sh 从
这个值起 probe。`.env.example` 顶部有说明。**不要**再去改 `scripts/start-web.sh` /
`vite.config.ts` / `stop-web.sh` 里的常量 — 那些已经不再持有硬编码端口了。

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
| `start-web.sh` 启动慢一拍并提示 "Port 8002 busy ... trying next" | 起始端口被占,脚本自动跳到 8003 / 8004 / …;查实际端口跑 `bash scripts/status-web.sh` 或看 `.runtime-ports.json`。属预期行为,不算 bug。 |
| `start-web.sh` 报 "no free port for backend in [8002, 8011]" | 起始端口 +9 范围全占,真没空了。要么 `.env` 里把 `BACKEND_PORT` 换到别的段(比如 9100),要么先释放些端口。`--force` 仅能杀**本项目目录下**的进程释放起始端口,不动别的项目。 |
| `deploy.sh` 报 "need Python >= 3.11" | `python3` 默认是 3.9 但机器装了 3.11 → 用 `PYTHON_BIN=/path/to/python3.11 bash deploy.sh`;详见 §1.1 |
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
