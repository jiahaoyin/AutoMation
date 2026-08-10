# 当前运行手册：Developer-first → Account → Small Business

> 唯一操作入口。浏览器内核为 Camoufox；细节见 [CAMOUFOX.md](CAMOUFOX.md)。

## 1. 运行目标

同一 Camoufox 会话（**一套 macOS 指纹** / 系统默认 profile）内按固定顺序：

1. **新建 tab** 打开 https://developer.apple.com/account → 登录 / 2FA → 会员判定并持久化；
2. 按 `DEVELOPER_MEMBERSHIP_GATE` 决定是否 **新建 Account tab**；
3. Account 登录 / 2FA → 个人信息采集 → **同 tab 改密**；
4. **新建 tab** 提交 Small Business 申请。

网页 2FA：`prepare_2fa` → Node 取码 → `2fa_code` → Camoufox `fill_security_code`。  
Node 不持有浏览器连接。

## 2. 安装与日常

~~~bash
./install.sh          # Node + Python venv + Camoufox FF152 dev 源 + Swift helpers
./run.sh              # 完整：设置 + 浏览器
./run.sh --skip-mac   # 仅浏览器（常用）
./run.sh --skip-browser
~~~

**启动前关闭图标打开的 Firefox**，否则默认 profile 被锁。

## 3. System Settings（可选）

完整 `./run.sh` 才会进入。SMS / 后置默认开启；设 `=0` 关闭：

~~~bash
APPLE_AUTOMATION_SMS_ENABLED=0
APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=0
~~~

浏览器网页 2FA 与 Settings SMS **不共享验证码**。

## 4. 浏览器要点

| 项 | 行为 |
| --- | --- |
| Profile | 系统 Firefox 默认 profile + `--allow-downgrade` |
| 指纹 | 启动时随机 macOS 预设；同 context 多 tab 共用 |
| 代理 | Clash `127.0.0.1:7890` + geoip |
| 输入 | 兼容层保留原选择器与 human_click / type / OTP 流程 |

Gate：

- `DEVELOPER_MEMBERSHIP_GATE=0`：任意已认证会员结果都继续 Account
- `=1`：仅 `active` 继续；非 active 为成功的 gate stop（`accountModule.skipped=true`，`developer_membership_gate_blocked`）

截图：`03-developer-membership.png`（仅 active）、`02-account-information.png`、`04-small-business-application.png`。会员结果写入私有 `developer_membership`。

## 5. 产物与排错

~~~text
data/reports/apple-id-flow-<timestamp>/
  report.json / flow-audit.jsonl / 2fa-audit.jsonl / screenshots/
~~~

| 现象 | 先看 |
| --- | --- |
| Developer 未完成 | `flow-audit.jsonl` → `developer_account_*` |
| gate stop | `developer_membership_gate_blocked` + `accountModule.skipped` |
| 2FA 已取码网页未确认 | `2fa-audit.jsonl` 固定阶段链 |
| profile 锁 | 关闭 Dock Firefox 后重试 |

反馈时只给脱敏 JSONL / report，不要给 `.env`、OTP、账号密码或完整截图。

## 6. 协作文档

- [PROJECT.md](PROJECT.md) — 架构与配置
- [CAMOUFOX.md](CAMOUFOX.md) — 浏览器内核
- [2FA_HANDOFF_DIAGNOSTICS.md](2FA_HANDOFF_DIAGNOSTICS.md) — OTP 交接
- [WINDOWS_MAC_CODEX.md](WINDOWS_MAC_CODEX.md) / [MAC_CODEX_HANDOFF.md](MAC_CODEX_HANDOFF.md) — 双机协作
