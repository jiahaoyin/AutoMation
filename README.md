# Apple-AutoMation（macOS）

> Developer 会员判定 → Account 个人信息/改密 → 小开发者申请。浏览器内核为 **Camoufox**（反检测 Firefox）。

项目分两块，互不混用验证码：

| 部分 | 说明 |
| --- | --- |
| **系统设置** | 可选 macOS System Settings 登录 / SMS / 后置页（`--skip-mac` 跳过） |
| **浏览器** | Camoufox：同一指纹会话内按固定顺序开 tab 完成各阶段 |

Node 只做编排、2FA sidecar、脱敏 JSONL 与报告；浏览器生命周期与页面输入都在 Python Camoufox 中。

## 浏览器执行顺序（固定）

~~~mermaid
flowchart TD
    A[启动 Camoufox<br/>系统 Firefox 默认 profile<br/>macOS 指纹一套 + Clash geoip] --> B[新建 tab：Developer]
    B --> C[登录 / 共享 2FA]
    C --> D[会员判定]
    D -->|gate=0 或 active| E[新建 tab：Account]
    D -->|gate=1 且非 active| X[正常 gate stop]
    E --> F[Account 登录 / 共享 2FA]
    F --> G[个人信息采集]
    G --> H[同 tab：登录与安全性改密]
    H --> I[新建 tab：Small Business 申请]
~~~

1. **启动内核**：Camoufox **FF152 dev 源**（默认 `official/prerelease`，[daijro/camoufox](https://github.com/daijro/camoufox) 最新预发布）；`fingerprint_preset` + `os=macos`；`humanize`；Clash `127.0.0.1:7890` + `geoip`；`--allow-downgrade` 打开系统默认 profile。同一 persistent context，后续 tab **复用同一套指纹**。
2. **新建 Developer tab** → 登录与 2FA → 会员状态。
3. **新建 Account tab**（仅 Developer 已认证且 gate 允许）→ 登录与共享 2FA。
4. **同一 Account tab** 采集个人信息并改密（新密码写回私有 `.env`）。
5. **新建 Small Business tab** → 提交申请。

## 2FA 交接（网页）

~~~text
Camoufox 发出 prepare_2fa
  → Node sidecar 准备监听
  → 回写 2fa_prepared
Camoufox 发出 need_2fa + generation
  → Node 取码（popup AX → Settings → TTY）
  → 回写 2fa_code
  → Camoufox fill_security_code（兼容层点击/拟人键盘输入）
~~~

终端、report、audit **从不输出 OTP**。浏览器 2FA 与 System Settings SMS **不共用验证码**。

## 快速开始

~~~bash
# 首次：Node / Python venv / camoufox[geoip] / FF152 dev 浏览器 / Swift helpers
./install.sh

# 完整流程
./run.sh

# 仅浏览器（常用）
./run.sh --skip-mac
~~~

启动前请关闭由 Dock/图标打开的 Firefox（默认 profile 不能双开）。需本机 Clash 监听 `7890`（可用 `CAMOUFOX_PROXY_ENABLED=0` 关闭代理）。

## install / run 自检

| 阶段 | 检查项 |
| --- | --- |
| `./install.sh` | Node、Python≥3.10、`.runtime/camoufox-venv`、`camoufox[geoip]`、`camoufox sync/set/fetch` → `official/prerelease`（FF152 dev）、系统 Firefox（供 profile）、Swift helpers、2FA 权限预检 |
| `./run.sh` | 再跑环境自检（`--skip-camoufox` 仅在 `--skip-browser` 时）；backend=`camoufox`；profile=系统默认 |
| `npm run check` | 打印 `python/camoufox`、backend、profile 路径 |

兼容旧旗标：`--install-ruyipage` / `--skip-ruyipage` 等同 Camoufox 安装/跳过。

## 运行模式

| 目标 | 配置 |
| --- | --- |
| 默认测试 | `DEVELOPER_MEMBERSHIP_GATE=0`：Developer 任意已认证结果都继续 Account |
| 业务 gate | `DEVELOPER_MEMBERSHIP_GATE=1`：仅 `active` 进 Account |
| 仅浏览器 | `./run.sh --skip-mac` |
| 仅系统设置 | `./run.sh --skip-browser` |

## 会员与截图

| Developer | `.env` | 截图 |
| --- | --- | --- |
| **active** | `developer_membership=已加入` | `03-developer-membership.png` |
| **not_enrolled** | `developer_membership=未加入` | 无 |
| **unknown** | `developer_membership=未确认` | 无 |

- Account 个人信息：`02-account-information.png`
- 小开发者提交确认：`04-small-business-application.png`

## 产物

~~~text
data/reports/apple-id-flow-<timestamp>/
├── report.json
├── flow-audit.jsonl
├── 2fa-audit.jsonl
└── screenshots/
~~~

## 配置速查

~~~bash
BROWSER_BACKEND=camoufox
BROWSER_PROFILE_MODE=persistent          # 系统 Firefox 默认 profile
CAMOUFOX_CHANNEL=official/prerelease     # FF152 dev 源（仓库最新预发布）
CAMOUFOX_PROXY_SERVER=http://127.0.0.1:7890
CAMOUFOX_PROXY_ENABLED=1
DEVELOPER_MEMBERSHIP_GATE=0
BROWSER_PRESERVE_ON_FAILURE=1
BROWSER_PRESERVE_ON_SUCCESS=1
BROWSER_ATTACH_EXISTING=0                # Camoufox 不接管外部 Firefox
~~~

## 文档

- [运行手册](docs/RUNTIME_RUNBOOK.md)
- [项目参考](docs/PROJECT.md)
- [Camoufox 内核](docs/CAMOUFOX.md)
- [2FA 交接诊断](docs/2FA_HANDOFF_DIAGNOSTICS.md)
- [Windows ↔ Mac](docs/WINDOWS_MAC_CODEX.md) / [Mac 交接](docs/MAC_CODEX_HANDOFF.md)

## 安全

- `.env`、`data/`、`.runtime/` 不进 Git。
- 报告/审计不保存账号、密码、OTP、Cookie 或完整个人资料明文。
