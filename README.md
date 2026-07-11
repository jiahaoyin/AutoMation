# Apple ID Automation (macOS)

在 **macOS 15 Sequoia** 上自动化完成 Apple ID 登录与信息采集：

1. **系统设置** → Apple Account 自动填表（手机验证码人工）
2. **Firefox** + ruyiPage → `account.apple.com` 登录与 2FA
3. 采集**姓名、生日**，输出报告与截图

与 [ChromeTest](https://github.com) 探针项目**完全独立**，本仓库单独维护。

## 快速开始

```bash
./install.sh    # 前置管理员授权、Python/Node 自动安装、辅助功能引导
./run.sh        # 终端输入账号密码 → 自动备份 .env → 执行流程
```

`./install.sh` 启动后会立即请求一次管理员密码授权。若没有 Python 3.10+，
安装器会下载 Python.org 官方 Python 3.12.10 universal2 PKG，核对固定
SHA-256 和 Python Software Foundation Developer ID 签名，再从 root 私有暂存
目录完成系统安装并继续创建 `.runtime/ruyipage-venv`，无需重新运行脚本。
管理员密码仅由系统 `/usr/bin/sudo` 读取；日常运行 `./run.sh` 不会请求管理员授权。

## 环境

- macOS 15（推荐）
- Node.js 18+（[nodejs.org](https://nodejs.org) 或 `install.sh` 下载官方包）
- Python 3.10+（`install.sh` 自动检测；缺失时安装已验签的官方 Python 3.12.10）
- Firefox（[mozilla.org/firefox](https://www.mozilla.org/firefox/)）
- 终端「辅助功能」权限（`install.sh` 会引导）

Vision OCR 使用「屏幕与系统音频录制」（Screen & System Audio Recording）
权限，但这是**可选增强**。未授权不会导致 `install.sh` 失败；AX 弹窗读取、
系统设置取码和隐藏终端手输仍可继续工作。需要启用 OCR 时，请在下次运行前打开
「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」，勾选当前终端 App，按系统
提示重新打开终端后再运行 `./run.sh`。

## 命令

| 命令 | 说明 |
|------|------|
| `./install.sh` | 前置授权；自动安装 Python/Node、ruyiPage 与辅助功能检测 |
| `./run.sh` | 完整流程 |
| `./run.sh --skip-mac` | 仅浏览器 |
| `./run.sh --skip-browser` | 仅系统设置 |
| `npm run check` | 环境自检 |
| `npm run test:browser-backend` | 浏览器后端选择逻辑测试 |
| `npm run test:ruyipage-protocol` | ruyipage JSONL 协议自测 |
| `npm run test:ruyipage-flow` | ruyiPage Python 流程与安全边界测试 |
| `npm run test:2fa-allow-unit` | Allow、popup AX/OCR 与隐私 source-contract 测试 |
| `npm run test:2fa-sidecar` | popup 与系统设置双通道竞速测试 |
| `npm run test:2fa-settings-unit` | 可取消系统设置 helper 生命周期测试 |
| `npm run test:account-browser-flow` | 浏览器运行与 2FA collector 生命周期测试 |
| `npm run test:python-bootstrap` | Python 自动安装与提权入口合同测试 |
| `npm run package` | 本地打包 `dist/`（保留 zip） |
| `npm run release` | patch+1 → 打包 → 上传 GitHub Releases → 清理本地 `dist/` |

## 发布与分发

**本机发布**（打包上传至 GitHub Releases，本地不保留 zip）：

```bash
npm run release
```

**其他 Mac 拉取最新版**（无需 clone 仓库，下载解压即用）：

```bash
# 方式一：一键脚本（推荐）
curl -fsSL https://raw.githubusercontent.com/jiahaoyin/Apple-AutoMation/main/scripts/fetch-latest.sh | bash

# 方式二：已 clone 仓库时
./scripts/fetch-latest.sh

# 解压后进入目录
cd apple-id-automation-latest/apple-id-automation-*/
./install.sh && ./run.sh
```

或手动下载：[GitHub Releases](https://github.com/jiahaoyin/Apple-AutoMation/releases) 中的 `*-macos.zip`，解压后 `./install.sh && ./run.sh`。

## 文档

- **[docs/PROJECT.md](docs/PROJECT.md)** — 架构、文件说明、故障排查（新会话必读）

## 浏览器后端

浏览器启动、导航、页面读取、接管、输入、截图与关闭全部由 Python `ruyiPage` 完成。项目不再包含 Node BiDi 或其他页面自动化回退；ruyiPage 未就绪时会明确停止并提示运行 `./install.sh`。

```bash
BROWSER_BACKEND=ruyipage          # 唯一后端；auto 仅兼容旧 .env
RUYIPAGE_PYTHON=python3           # 可选；默认使用 .runtime/ruyipage-venv
BROWSER_PROFILE_MODE=persistent   # persistent | fresh
RUYIPAGE_BACKEND_TIMEOUT_MS=720000
RUYIPAGE_KILL_GRACE_MS=5000
BROWSER_2FA_SETTINGS_AFTER_MS=8000
BROWSER_2FA_SETTINGS_FALLBACK=1
BROWSER_2FA_MANUAL_FALLBACK=1
BROWSER_2FA_POLL_MS=800
```

## 2FA 获取与恢复顺序

ruyiPage 填好密码和“记住账号”后，会先通过 JSONL 要求 Node 清理旧验证码窗、记录 `preparedAt` 并启动 popup watcher；收到 `2fa_prepared` 后才提交密码。watcher 可以在网页发出 `need_2fa` 前缓存当前登录的 popup 验证码，但这时尚未启动完整取码竞速，也尚未开始 240 秒总期限。

第一次 `getCode` acquisition 才启动取码竞速和共享 240 秒期限；如网页明确拒绝第一代验证码，第二代沿用同一期限，不会重新计时。来源按以下顺序加入：

1. popup watcher 先用 AX 从已验证的 Apple 系统弹窗读取 `NNN NNN`。AX 没有合法验证码时，才对同一个可信 Apple window ID 做内存 Vision OCR。全窗只接受 `NNN NNN`；只有中心裁剪可接受连续六位，而且必须在同一 window ID 的两次独立捕获中保持一致。OCR 不点击、不做全屏搜索、不写临时 PNG。
2. 系统设置只在 `getCode` 已活跃后启动，并以 `preparedAt + 8s` 为门槛；如果门槛已过就立即加入，否则等待到门槛。最多两次，每次最多 60 秒，两次之间退避 5 秒；popup watcher 同时继续。
3. 从第一次 acquisition 起 90 秒后，如果 stdin/stdout 都是 TTY 且手输未被明确禁用，则显示固定提示并隐藏读取六位验证码。手输默认启用；只有 `BROWSER_2FA_MANUAL_FALLBACK=0` 才禁用，配置示例中的 `=1` 是显式启用写法。
4. 首个合法来源获胜；其余来源被取消并执行有界弹窗清理。第一次 acquisition 起 240 秒到期后，runner 清理 helper 与进程组并整体失败。

Allow 自动动作最多尝试两次。两次都未确认时，终端只提示用户手动点击
“允许”；popup 监听、系统设置和后续手输来源不会因此停止。自动尝试只有在后续
原生状态确认 Allow 消失或验证码窗出现后才算成功。

最终发布合同最多允许两代验证码。generation 已从 ruyiPage 事件经 runner 和
`account-browser-flow` 透传到 collector。只有可信 Apple 页面明确显示英文、简中或
繁中的验证码错误、无效或过期语义时，才可请求第二代；第一代立即进入全局拒绝
集合，所有来源都不得再次返回。captcha、账号锁定或未知登录错误必须停止，不能借
“换码”继续尝试。

sidecar `onStatus` 已接入外层终端，只显示固定阶段提示，包括 Settings 第 1/2 次、
5 秒重试、手动 Allow、隐藏手输、OCR 权限缺失、获胜来源和 240 秒超时；不插入
OTP、原始 AX/OCR/stderr 或完整 Apple ID。主控 fresh Windows 验证已通过 Python
126/126、ruyipage flow、protocol、sidecar、account-browser-flow、Allow 61/61、
permissions 和 release，四路最终专项复审均为 PASS。该证据覆盖逻辑与 source-contract，不代表 Swift 编译、
TCC 或 macOS 15 原生 UI 已验收。

## 权限分层

- 浏览器 2FA 的「辅助功能」检查和提示由现有 `mac-2fa-popup-read.swift` 通过 `AXIsProcessTrusted()`、`AXIsProcessTrustedWithOptions(...)` 及 `--preflight-accessibility` / `--prompt-accessibility` 原生完成。旧 AppleScript 2FA/Accessibility 权限探针已移除。
- `./run.sh --skip-mac` 只要求当前终端 App 获得「辅助功能」权限，用于受限 Apple popup/Settings AX helper；不要求 Terminal 控制 System Events 或“系统设置”。
- 只有执行 macOS“系统设置登录 Apple Account”阶段时，才要求「自动化」中允许当前终端 App 控制“系统设置”。
- Screen Recording 仅供 Vision OCR 使用。缺失时 capability 固定为 `permission_missing`，不会请求权限，也不会阻断安装；AX、Settings 和隐藏终端手输仍可工作。
- 权限变更后应按 macOS 提示退出并重新打开终端，再开始下一次运行。

## macOS 15 验收

Windows 只能验证 Node/Python 逻辑、协议、语法和 source-contract，不能替代 Swift
编译或 macOS 15 原生 UI 验收。Mac 测试机拉取后运行：

```bash
./install.sh
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-ax-fill.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-click-allow.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-read.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-ocr.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift
npm run check
npm run test:python-bootstrap
npm run test:2fa-allow-unit
npm run test:2fa-sidecar
npm run test:2fa-settings
npm run test:2fa-settings-unit
npm run test:account-browser-flow
npm run test:ruyipage-protocol
npm run test:ruyipage-flow
./run.sh --skip-mac
```

真机还必须分别验证 Screen Recording 已授权/未授权、英文/简中/繁中 popup、
Allow 两次上限与手动接管、Settings 两次重试、从首次 acquisition 起算的 90 秒
隐藏手输和 240 秒截止，以及取消/迟到弹窗清理。终端、`report.json` 和
`2fa-audit.jsonl` 不得出现 OTP、原始
AX/OCR/stderr、完整 Apple ID 或认证页面正文；认证失败不得保存全页截图，OCR
不得留下图片文件。完整 macOS 设置登录另行使用 `./run.sh` 验证 Automation 权限。

## 安全

- `.env` 含账号密码，**勿提交 git**
- `data/` 含 Firefox Profile 与报告，注意保管
- 敏感认证失败只保留固定失败原因和脱敏安全审计，不保存认证页全页截图

## 版本

当前 `package.json` 版本即发布版本；`npm run release` 默认 patch +1 后上传 GitHub Releases。
