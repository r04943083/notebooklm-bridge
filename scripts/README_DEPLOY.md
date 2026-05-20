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
- 能访问 `https://pypi.org`(`deploy.sh` 在线装 backend Python 包)、`https://cdn.playwright.dev`(`deploy.sh` 自动下载 ~150MB Chromium 浏览器二进制)、`https://notebooklm.google.com`(bridge 运行时)
- **Python ≥ 3.11**(任意小版本 — 3.11 / 3.12 / 3.13 都可以,pip 会按你机器上的解释器挑对应的 wheel)
- Node ≥ 18(只用来 serve 前端 `dist/`,不需要 npm install)
- 起始端口 **8002**(backend)和 **5175**(frontend);如果被占,`start-web.sh` 会自动
  在 `[8002,8011]` / `[5175,5184]` 范围 probe,选第一个空闲的。10 个都被占才报错。见 §5。
- 能 `sudo apt install`(或 `sudo dnf install`)装 Chromium 依赖的系统库(libnspr4 / libnss3 / …);`login.sh` 会自动检测 + prompt

### 1.1 多 Python 版本共存的机器

`deploy.sh` 会按 `python3.13 → python3.12 → python3.11 → python3` 顺序探,选第一个
满足 `>=3.11` 的解释器。不会被"系统默认 python3 是 3.9"卡住。

如果你的 Python 装在不在 `$PATH` 的位置(比如 `/opt/python3.12/bin/python3.12`),
用环境变量 override:

```bash
PYTHON_BIN=/opt/python3.12/bin/python3.12 bash deploy.sh
```

#### 自建 / devtoolset Python(`scripts/check-python.sh`)

如果你的 Python 是自编译的、或装在 `/opt/devtoolset/python-3.X.Y/` 这种和 OpenSSL
绑在一起的 toolchain 目录里,它的 `libpython3.X.so` 和 `libssl.so.1.1` 大概率不
在系统 ldconfig 搜索路径里 — 直接跑会卡在:

- `error while loading shared libraries: libpython3.11.so.1.0: cannot open …`
- `import ssl` 失败 → pip 没法 HTTPS 到 PyPI

`scripts/check-python.sh` 专门处理这种 case:接受 `--python-path=<install root>`
或 `--python-bin=<full path>`,自动找补缺的 `.so`,验证 ssl + venv 都能用,把
解析出的 `PYTHON_BIN + LD_LIBRARY_PATH` 写到 `$INSTALL_HOME/.python-env`。
之后 `deploy.sh` 和 `start-web.sh` 都会 source 这个文件,运行时 `.venv/bin/python`
也能找到 lib。

```bash
# 一次性验证 + 写入 .python-env
bash scripts/check-python.sh --python-path=/opt/devtoolset/python-3.11.4/

# 也可以直接传给 deploy.sh,它会先调 check-python.sh
bash deploy.sh --python-path=/opt/devtoolset/python-3.11.4/
```

普通 apt/dnf/zypper 装的 Python 不需要这一步,`deploy.sh` 一句搞定。

### 1.2 按发行版的具体准备步骤

`deploy.sh` 和 `scripts/login.sh` 都会读 `/etc/os-release` 自动识别发行版
(debian / rhel / suse 三大家),装包时用对应的包管理器 + 包名,失败时给针对性
错误提示。下面是每个发行版需要操作员**手动**做的事(IT 提前装好这些,deploy 就
能一路通到底)。

#### Ubuntu 22.04+ / Debian 12+ (apt)

```bash
sudo apt update
sudo apt install -y python3.11 python3.11-venv nodejs    # Node 不够新就上 NodeSource
# Chromium 系统库由 scripts/login.sh 自动检测 + 装
```

Ubuntu 20.04 的 apt 仓里没有 3.11,先加 deadsnakes PPA:

```bash
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.11 python3.11-venv
```

#### CentOS Stream 9 / RHEL 9 / Rocky 9 / AlmaLinux 9 (dnf)

```bash
sudo dnf install -y python3.11        # 3.11 在默认 AppStream;venv 模块已内置,无需 -venv 子包
sudo dnf module install -y nodejs:20  # 或者上 NodeSource:  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
```

**`scripts/login.sh` 装 Chromium 系统库时若报 "No match for argument: libxshmfence"**,
说明 CRB(CodeReady Builder)仓没启用 — minimal 安装的 RHEL 9 / Rocky 9 默认关
的。`libxshmfence` 在 CRB 里。一行解决:

```bash
sudo dnf config-manager --set-enabled crb
# Rocky/Alma:  sudo dnf config-manager --set-enabled crb
# RHEL 9:      sudo subscription-manager repos --enable codeready-builder-for-rhel-9-x86_64-rpms
```

然后重跑 `bash scripts/login.sh`。

`deploy.sh` 自动检测到 RHEL 家族会按 dnf 的包名报错;login.sh 装 Chromium 库时
也会按 RHEL 包名跑(`nspr nss dbus-libs atk at-spi2-atk ...`,不是 Ubuntu 的
`libnspr4 libnss3 ...`)。

#### openSUSE / SLES (zypper)

```bash
sudo zypper install -y python311 python311-venv nodejs20
```

login.sh 的 Chromium 库列表也覆盖了 zypper 的包名 (`mozilla-nspr mozilla-nss
libatk-1_0-0 ...`)。

#### 其他发行版

`detect_distro` 报 `other` 时,deploy.sh / login.sh 不会自动跑包管理器,而是
建议你跑 Playwright 自带的安装器:

```bash
sudo .venv/bin/playwright install-deps chromium
```

Playwright 认得的发行版比我们这个脚本更多。

如果目标机没桌面或不能联网,看 `docs/cookie-refresh-runbook.md` 的 "Fallback" 段。

---

## 2. 首次部署(4 步)

```bash
# 校验 tarball 没损坏
sha256sum -c notebooklm-bridge-v<VERSION>.tar.gz.sha256

# 1. 解压
tar -xzf notebooklm-bridge-v<VERSION>.tar.gz
cd notebooklm-bridge-v<VERSION>

# 2. 部署:rsync 源码到 ~/notebooklm-bridge,装 .venv + 依赖 + Chromium、
#    创建 secrets/ + .env(同一句命令也用于升级,见 §4)。
#    要换装到别的路径:  NOTEBOOKLM_BRIDGE_HOME=/opt/notebooklm-bridge bash deploy.sh
bash deploy.sh

# 3. 切到固定安装路径,后面所有命令都在这里跑
cd ~/notebooklm-bridge

# 4. 弹 Chromium 让你用 Google 账号登录,产出 secrets/auth.json
bash scripts/login.sh

# 5. 启动
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
cd ~/notebooklm-bridge                             # 固定安装路径
bash scripts/login.sh                              # 弹浏览器,再登一次
bash scripts/stop-web.sh && bash scripts/start-web.sh
```

`login.sh` 是 idempotent 的,可以任意次重跑。`--refresh` flag 强制重登,`--profile NAME` 切换多账号。

---

## 4. 升级到新版本

跟首装**完全一样的命令**。`deploy.sh` 把新版本源码 rsync 到固定安装路径
(`~/notebooklm-bridge`),`secrets/auth.json` / `.env` / `state.json` / `.venv/`
全部自动保留。

```bash
tar -xzf notebooklm-bridge-v<NEW>.tar.gz
cd notebooklm-bridge-v<NEW>
bash deploy.sh                       # rsync 到 ~/notebooklm-bridge,凭证 / 状态 / venv 全保留
cd ~/notebooklm-bridge
bash scripts/stop-web.sh && bash scripts/start-web.sh
```

不需要拷 secrets、不需要重登、session 不丢。

升级回滚:旧 tarball 解压目录还在的话,可以从那里再跑 `bash deploy.sh` 把旧
源码 rsync 回 `~/notebooklm-bridge` 完成回滚;`.venv` 会保留(里面装的是
**最新**版本对应的依赖,如果旧版本依赖不一样需要重跑 `pip install -e '.[runtime]'`)。

---

## 5. 常见故障

| 症状 | 原因 / 处理 |
|---|---|
| `/api/healthz` 返回 `auth_valid: false` | cookies 过期 → 重跑 `bash scripts/login.sh` → 重启 |
| `login.sh` 报 "Chromium 缺 lib…" | 按 prompt 跑 `sudo apt-get install …`;脚本会自动 verify |
| `login.sh` 报 "X server / DISPLAY not available" | 目标机没桌面 → 看 `docs/cookie-refresh-runbook.md` 的 fallback(在你工位机跑 login.sh + scp `secrets/auth.json` 到目标机) |
| `start-web.sh` 启动慢一拍并提示 "Port 8002 busy ... trying next" | 起始端口被占,脚本自动跳到 8003 / 8004 / …;查实际端口跑 `bash scripts/status-web.sh` 或看 `.runtime-ports.json`。属预期行为,不算 bug。 |
| `start-web.sh` 报 "no free port for backend in [8002, 8011]" | 起始端口 +9 范围全占,真没空了。要么 `.env` 里把 `BACKEND_PORT` 换到别的段(比如 9100),要么先释放些端口。`--force` 仅能杀**本项目目录下**的进程释放起始端口,不动别的项目。 |
| `deploy.sh` 报 "no Python >= 3.11 found" | 机器装的 `python3` 太老 → 装 `python3.11` 或更新版本,或用 `PYTHON_BIN=/path/to/python3 bash deploy.sh`;自编译 Python 卡在 `libpython3.X.so` / `libssl.so.1.1` → `bash scripts/check-python.sh --python-path=...` 先验证。详见 §1.1 |
| `deploy.sh` 报 "playwright install chromium failed" | cdn.playwright.dev 不通 → 检查防火墙/代理。已部分下载的可以手工补:`cd ~/notebooklm-bridge && .venv/bin/playwright install chromium` |
| `login.sh` 报 "Playwright Chromium binary not found" | 不该出现 — `deploy.sh` 会先装好。若真出现:`cd ~/notebooklm-bridge && .venv/bin/playwright install chromium` |
| 想把 install 路径换到 `/opt/notebooklm-bridge` | `NOTEBOOKLM_BRIDGE_HOME=/opt/notebooklm-bridge bash deploy.sh`(先 `sudo mkdir /opt/notebooklm-bridge && sudo chown $USER`)。换路径后所有命令(login/start-web/stop-web)都在新路径下跑。 |
| 突然 503 集中 | upstream 触发熔断 — 等 30s 自动恢复;`.backend.log` 里有 `circuit_breaker_open` 字样 |
| `ModuleNotFoundError` | 大概率忘了 `pip install -e '.[runtime]'` — `deploy.sh` 会做这一步,直接重跑 |

更多见仓库根 `README.md` 和 `docs/upstream-breakage-runbook.md`。

---

## 6. 安全清单

- [ ] `secrets/auth.json` 是 `0600`,owner 限制为运行 bridge 的 system user(`login.sh` 自动设)
- [ ] 目标机的防火墙允许 `:5175` / `:8002` 只对你信任的内网开放(**不对公网**)
- [ ] 升级后 `secrets/auth.json` 还是 `0600`(`cp -a` 保留权限,但建议手验一次:`stat -c '%a' secrets/auth.json` 应输出 `600`)
- [ ] `state.json` 不要 commit(默认 `.gitignored`)
- [ ] 别把 `secrets/auth.json` 转贴 / 发给别人 — 它是个有效的 Google session,等价于你账号本身
