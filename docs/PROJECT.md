# Apple-AutoMation 项目参考

操作入口见 [运行手册](RUNTIME_RUNBOOK.md)；浏览器细节见 [Camoufox](CAMOUFOX.md)。

## 1. 目标

| 能力 | 契约 |
| --- | --- |
| macOS 系统设置 | 可选；`--skip-mac` 跳过 |
| 浏览器 | Camoufox-only；Developer 初始 tab → Account 新 tab → Small Business 新 tab |
| 认证 | email / password / remember / OTP / trust 同一可信链 |
| Developer | `active` / `not_enrolled` / `unknown`；仅 active 保存会员截图 |
| Account | 个人信息采集后改密，写回私有 `APPLE_PASSWORD` |
| 诊断 | 脱敏 JSONL + 简洁终端进度 |

## 2. 模块架构

~~~mermaid
flowchart LR
    Launcher[run.sh] --> Main[apple-id-full-flow.mjs]
    Main --> Settings[mac-settings-*.js]
    Main --> Browser[account-browser-flow.js]
    Browser --> Runner[ruyipage-backend-runner.js]
    Runner <--> Python[apple_account_flow.py]
    Python --> Compat[camoufox_compat.py]
    Compat --> Camoufox[Camoufox Firefox]
~~~

| 区域 | 文件 |
| --- | --- |
| 总流程 | `scripts/apple-id-full-flow.mjs` |
| 浏览器编排 | `scripts/lib/account-browser-flow.js` |
| JSONL runner | `scripts/lib/ruyipage-backend-runner.js` |
| 浏览器实现 | `scripts/ruyipage/apple_account_flow.py` |
| Camoufox 适配 | `scripts/ruyipage/camoufox_compat.py`、`camoufox_session.py` |
| 安装 / venv | `scripts/lib/ruyipage-runtime.js`、`requirements.txt` |
| 系统设置 | `scripts/lib/mac-settings-*.js` + `scripts/swift/*` |

## 3. Browser 状态机

~~~text
camoufox_session_ready  (macos fingerprint, reuse=true)
  -> developer_account_tab_created
  -> developer_login / developer_membership
  -> [gate] account_module_tab_created | developer_membership_gate_blocked
  -> account authentication / shared 2FA  (need_2fa -> 2fa_code -> fill_security_code)
  -> account_home_confirmed -> profile -> password_change
  -> small_business_application_tab_created -> enrollment
  -> finalization
~~~

`DEVELOPER_MEMBERSHIP_GATE=0`（默认）允许非 active 继续 Account；`=1` 时仅 active 继续。

## 4. 结果与 acceptance

`recordAccountHomeAcceptanceMarker()` 只在 `browserLogin.accountHomeConfirmed=true` 时写 marker。  
Developer gate stop 的 marker 固定为 skipped。截图仅文件名元数据：`03-developer-membership.png`、`02-account-information.png`、`04-small-business-application.png`。

私有 `.env` 写入 `developer_membership`、`name`、`birthday` 等；报告与 JSONL 不保存明文资料。

## 5. 配置边界

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `BROWSER_BACKEND` | camoufox | `auto` / `ruyipage` 为兼容别名 |
| `BROWSER_PROFILE_MODE` | persistent | 系统 Firefox 默认 profile；`fresh` 用隔离目录 |
| `CAMOUFOX_PROXY_SERVER` | `http://127.0.0.1:7890` | Clash + geoip |
| `DEVELOPER_MEMBERSHIP_GATE` | 0 | 见上 |
| `BROWSER_PRESERVE_ON_*` | 1 | 成功/失败后是否保留浏览器 |

## 6. 安装契约

- Python ≥ 3.10，项目 venv：`.runtime/camoufox-venv`
- 包：`camoufox[geoip]`；浏览器通道默认 `official/prerelease`（FF152 dev 源）
- 安装顺序：`camoufox sync` → `set <channel>` → `fetch`
- macOS pip SSL 失败时：`--trusted-host` + 清华镜像自动重试

## 7. 测试入口

- `npm run test:browser-backend`
- `npm run test:account-browser-flow`
- `npm run test:ruyipage-protocol`
- `npm run test:flow-audit`
- `npm run test:mac-settings-*`（设置链路）
