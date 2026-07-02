# Apple ID Automation — 项目上下文文档

> **用途**：新开会话 / 新协作者快速了解本项目。  
> **仓库**：独立项目，与 `ChromeTest`（浏览器指纹探针）分离维护。  
> **本地路径**：`/Users/yu/Apple-AutoMation`  
> **目标系统**：macOS 15 Sequoia

---

## 1. 项目目标

自动化完成以下流程（测试/运维场景）：

| 阶段 | 方式 | 人工介入 |
|------|------|----------|
| Mac 系统设置登录 Apple ID | AppleScript GUI | **手机 SMS 验证码** |
| 等待 Mac 登录完成 | 轮询 + 可选 Enter 确认 | 验证码输入后等待 |
| Firefox 打开 account.apple.com | WebDriver BiDi + 拟人输入 | — |
| 浏览器 2FA | macOS `FollowUpUI` 弹窗读码 | 需 Mac 已登录同账号 |
| 采集个人信息 | 页面解析 | — |

**未实现 / 后续**：`developer.apple.com`、`appstoreconnect.apple.com` 多标签流程。

---

## 2. 技术选型（为何不用 Chrome/Playwright）

| 层级 | 选型 | 原因 |
|------|------|------|
| Mac 2FA 弹窗 | `scripts/apple-2fa-wait.scpt` | 读 `FollowUpUI` 六位码 |
| 系统设置填表 | AppleScript + System Events | 必须控制原生 UI |
| 浏览器 | **Firefox** 独立 Profile | BiDi + `input.performActions` 拟人输入 |
| 协议 | WebDriver BiDi（`ws://127.0.0.1:PORT/session`） | 非 CDP，降低检测面 |
| Node 依赖 | 无 npm 第三方包 | 原生 WebSocket、`child_process` |
| 安装 | **不用 Homebrew** | Node 用 nodejs.org 官方包；Firefox 手动安装 |

---

## 3. 目录结构

```
Apple-AutoMation/
├── install.sh              # 环境安装（Node + 辅助功能）
├── run.sh                  # 主入口
├── package.json            # 版本号 = 发布版本
├── .env.example
├── docs/
│   └── PROJECT.md          # 本文件
├── scripts/
│   ├── apple-id-full-flow.mjs      # 主编排
│   ├── setup-environment.mjs
│   ├── check-environment.mjs
│   ├── bootstrap-macos.sh          # Node 官方包引导
│   ├── build-release.mjs           # 打 zip 并可选上传 GitHub Releases
│   ├── fetch-latest.sh             # 从 Releases 下载最新 zip
│   ├── bump-patch-version.mjs
│   ├── apple-2fa-wait.scpt
│   ├── mac-settings-apple-login.applescript
│   ├── mac-settings-signed-in.applescript
│   ├── accessibility-check.applescript
│   └── lib/
│       ├── credentials.js          # 终端输入 → 备份 .env
│       ├── accessibility.js        # 辅助功能检测/引导
│       ├── mac-settings-login.js
│       ├── account-browser-flow.js
│       ├── bidi-client.js
│       ├── human-input-bidi.js
│       ├── two-fa-sidecar.js
│       ├── env-setup.js
│       ├── macos.js                # Sequoia 版本/深链
│       ├── prompt.js
│       └── report.js
└── dist/                   # npm run package 输出（gitignore）
```

---

## 4. 运行流程（数据流）

```
./run.sh
  → bootstrap（确保 Node 18+）
  → setup-environment（Firefox、辅助功能等）
  → promptAppleCredentials（终端输入 → 写 .env 600）
  → [Mac] mac-settings-apple-login.applescript（env: APPLE_SCRIPT_*）
  → waitForMacSettingsLoginComplete（轮询 signed-in）
  → [Browser] 启动 Firefox --profile --remote-debugging-port=0
  → BiDi session → account.apple.com 登录
  → two-fa-sidecar + apple-2fa-wait.scpt
  → 抓取姓名/生日 → data/reports/apple-id-flow-*/report.json
```

### 凭证传递

- **不再**通过 AppleScript argv 传密码（`@` 等特殊字符会编译失败）
- Node 设置环境变量：`APPLE_SCRIPT_APPLE_ID`、`APPLE_SCRIPT_PASSWORD`
- AppleScript 内 `system attribute` 读取

### AppleScript 要点

- 所有 `click` / `keystroke` 必须在 `tell application "System Events"` 内，否则 **osacompile 失败**
- Sequoia 深链：`x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings`

---

## 5. 环境与安装

### install.sh

1. 检测 Node 18+；无则下载 nodejs.org 官方 tar 到 `.runtime/node`
2. `setup-environment.mjs`：检查 Firefox、辅助功能
3. 辅助功能未授权 → 打开系统设置 → 轮询等待（最长 3 分钟）

### 账号密码

- **每次** `./run.sh` 终端交互输入
- 自动写入 `.env`（权限 600）
- 不要提交 `.env` 到 git

---

## 6. 打包与发布

```bash
npm run package          # 仅本地打包（保留 dist/）
npm run package:no-bump  # 不递增版本
npm run release          # patch+1 → 打包 → 上传 GitHub Releases → 清理本地 dist/
npm run release:no-bump  # 不递增版本，直接发布当前版本
```

本地打包输出：`dist/apple-id-automation-{version}/` 与 `dist/apple-id-automation-{version}-macos.zip`

**推荐发布流程**：改完代码后执行 `npm run release`，zip 上传至 [GitHub Releases](https://github.com/jiahaoyin/Apple-AutoMation/releases)，本地 `dist/` 自动清理。

**其他机器拉取**（无需 clone，下载解压即用）：

```bash
curl -fsSL https://raw.githubusercontent.com/jiahaoyin/Apple-AutoMation/main/scripts/fetch-latest.sh | bash
cd apple-id-automation-latest/apple-id-automation-*/
./install.sh && ./run.sh
```

已 clone 仓库时也可运行 `./scripts/fetch-latest.sh`；有 `gh` 时优先用 gh，否则自动 fallback 到 curl。

`build-release.mjs` 会在打包前 **校验 COPY_PATHS 是否包含所有 lib 依赖**（避免漏文件如 `macos.js`）。

---

## 7. 常见问题

| 现象 | 处理 |
|------|------|
| `Cannot find module .../macos.js` | 旧 zip 缺文件，用新版本或补拷 `scripts/lib/macos.js` |
| AppleScript `-2741` 语法错误 | 升级脚本；确认 UI 命令在 System Events tell 内 |
| Homebrew Permission denied | 本项目**不依赖** brew；用 nodejs.org 装 Node |
| 系统设置填表失败 | 辅助功能授权；手动打开 Apple Account 页 |
| 2FA 超时 | Mac 系统设置需已登录；确认 FollowUpUI 弹窗 |

---

## 8. 与 ChromeTest 的关系

- **ChromeTest**（`/Users/yu/ChromeTest`）：浏览器指纹 / 交互风险**探针**平台（前后端 + Playwright/Puppeteer/Firefox BiDi probe）
- **本仓库**：仅 Apple ID macOS + Firefox 自动化，从 ChromeTest 的 `scripts/` 拆出（2025-07）
- 两仓库**独立版本号、独立推送**，互不影响

**正式跑 `./run.sh` 前**，建议在执行机跑探针门禁（云端或本地）：

```bash
export PROBE_BASE=https://your-probe-server
cd /path/to/ChromeTest && npm run probe:gate:firefox
# PASS 后再执行本仓库 ./run.sh
```

探针配置手册：`ChromeTest/docs/AUTOMATION_PLAYBOOK.md`

---

## 9. 开发备忘

- 改功能后：`npm run release` 发布至 GitHub Releases
- 每次发布默认 **patch 版本 +1**（1.0.2 → 1.0.3）
- 测试机：macOS 15.6+，Terminal 需辅助功能
- 勿在仓库中提交：`.env`、`data/`、`.runtime/`、`dist/`

---

## 10. 关键入口文件速查

| 需求 | 文件 |
|------|------|
| 改总流程 | `scripts/apple-id-full-flow.mjs` |
| 改系统设置登录 | `scripts/mac-settings-apple-login.applescript` |
| 改浏览器登录/采集 | `scripts/lib/account-browser-flow.js` |
| 改 2FA 读码 | `scripts/apple-2fa-wait.scpt` |
| 改安装/环境 | `scripts/lib/env-setup.js`, `install.sh` |
| 改打包/发布 | `scripts/build-release.mjs` → `COPY_PATHS`；`npm run release` |

---

*最后更新：2025-07-02，版本 1.0.2*
