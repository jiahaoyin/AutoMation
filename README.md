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
- 当前运行主体的「辅助功能」权限（`install.sh` 会引导；本地通常为 Terminal / iTerm，受监督验收为 Codex / 原生 helper）

Vision OCR 使用「屏幕与系统音频录制」（Screen & System Audio Recording）
权限，这是自动取码的**必需权限**。`install.sh` 会在编译 exact native helper 后
立即请求并确认授权；`run.sh` 也会在 Firefox 启动前再次确认。未授权、helper 不可用
或授权状态未生效时流程会在提交账号密码前停止，不会降级为静默跳过 OCR。若系统要求
重启运行主体，请按提示重新打开当前终端或 Codex 后重新运行 `./install.sh`。

## 安装故障排查

- **安装 ruyiPage 时出现 PyPI TLS 证书错误**：`install.sh` 始终保持 HTTPS 证书校验；仅项目管理的 macOS 虚拟环境且 pip 支持 `truststore` 时优先使用系统信任库，显式 `RUYIPAGE_PYTHON` 不承诺该行为。如处于企业代理环境，请先将代理根证书安装到 macOS 系统钥匙串，再重新执行 `./install.sh`。

## 命令

| 命令 | 说明 |
|------|------|
| `./install.sh` | 前置授权；自动安装 Python/Node、ruyiPage，并确认辅助功能与屏幕录制 |
| `./run.sh` | 完整流程 |
| `./run.sh --skip-mac` | 仅浏览器 |
| `./run.sh --skip-browser` | 仅系统设置 |
| `npm run check` | 环境自检 |
| `npm run test:browser-backend` | 浏览器后端选择逻辑测试 |
| `npm run test:ruyipage-protocol` | ruyipage JSONL 协议自测 |
| `npm run test:ruyipage-flow` | ruyiPage Python 流程与安全边界测试 |
| `npm run test:2fa-allow-unit` | Allow、popup AX/OCR 与隐私 source-contract 测试 |
| `npm run test:2fa-sidecar` | popup 优先、系统设置串行回退测试 |
| `npm run test:2fa-settings-unit` | 可取消系统设置 helper 生命周期测试 |
| `npm run test:mac-settings-login-selector` | 系统设置登录窗口/控件唯一性与非剪贴板输入契约测试 |
| `npm run test:mac-settings-post-sms-finalization` | 短信后四类 modal 绑定、Vision 定位与 stdin 边界测试 |
| `npm run test:account-browser-flow` | 浏览器运行与 2FA collector 生命周期测试 |
| `npm run test:python-bootstrap` | Python 自动安装与提权入口合同测试 |
| `npm run package` | 本地打包 `dist/`（保留 zip） |
| `npm run release` | patch+1 → 打包 → 上传 GitHub Releases → 清理本地 `dist/` |

### 系统设置短信验证

在 `.env` 中启用并配置短信流程：

```bash
APPLE_AUTOMATION_SMS_ENABLED=1
APPLE_AUTOMATION_SMS_PHONE=+8613800130051
APPLE_AUTOMATION_SMS_API_URL='https://provider.example/record?token=private'
APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1
```

随后运行：

```bash
./run.sh --skip-browser
```

完整的号码和 URL 会直接复用，不再显示输入提示。初次启用、缺少其中一项或值无效时，脚本会要求重新输入完整 pair，并在格式校验通过后以 `0600` 权限原子写回 `.env`。需要替换已保存配置时，将 `APPLE_AUTOMATION_SMS_RECONFIGURE=1` 写入 `.env` 后运行一次；成功保存新 pair 后该开关会自动恢复为 `0`。将 `APPLE_AUTOMATION_SMS_ENABLED=0` 可保留 pair 但禁用短信自动化。验证码不会写入 `.env`、日志、报告、截图或子进程环境。

多号码页只选择尾号匹配的“发送短信至”控件；单号码页则先核验页面显示的尾号，再轮询一个独立六位码。填写后 Apple 自动推进，系统设置窗口保留，脚本持续等待登录状态确认。

若短信后出现条款、Mac 密码、iPhone 解锁或“查找我的 Mac”位置选择弹窗，将 `APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1` 打开。模块按 AX 树与窗口绑定逐个重新扫描：条款只勾选唯一同意框后点击“同意”，Mac 密码只向唯一密码框写入固定测试值 `000000`，iPhone 页用 Vision 确认稳定的 4/6 格后自动填入同长度的 `0`，位置页只点击 `action-button-2` 的“以后”，绝不点“允许”。所有输入只走受监督 helper 的 stdin，不写入 `.env`、报告、日志、参数或环境；绑定或识别不稳定就保留页面供人工处理。

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
- **[docs/MAC_CODEX_HANDOFF.md](docs/MAC_CODEX_HANDOFF.md)** — Mac Codex 新会话交接、当前 2FA 状态与手工反馈流程
- **[docs/WINDOWS_MAC_CODEX.md](docs/WINDOWS_MAC_CODEX.md)** — Windows 调度 Mac Codex 测试、证据回传与修复重测

## 浏览器后端

浏览器启动、导航、页面读取、接管、输入、截图与关闭全部由 Python `ruyiPage` 完成。项目不再包含 Node BiDi 或其他页面自动化回退；ruyiPage 未就绪时会明确停止并提示运行 `./install.sh`。

```bash
BROWSER_BACKEND=ruyipage          # 唯一后端；auto 仅兼容旧 .env
RUYIPAGE_PYTHON=python3           # 可选；默认使用 .runtime/ruyipage-venv
BROWSER_PROFILE_MODE=persistent   # persistent | fresh
RUYIPAGE_BACKEND_TIMEOUT_MS=720000
RUYIPAGE_KILL_GRACE_MS=5000
BROWSER_PRESERVE_ON_FAILURE=1  # 失败时保留 Firefox 现场；超时或外部终止仍强制清理
BROWSER_PRESERVE_ON_SUCCESS=1  # 成功后保留已登录窗口和标签页
BROWSER_ATTACH_EXISTING=1      # 下次运行优先接管现有 account.apple.com 标签页
BROWSER_ATTACH_ADDRESS=127.0.0.1:9222  # 可选：显式 ruyiPage 接管地址
# 终端诊断仅接受 shell/export 运行时开关，不从 .env 读取：
# APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac
BROWSER_2FA_SETTINGS_AFTER_MS=30000
BROWSER_2FA_SETTINGS_FALLBACK=1
BROWSER_2FA_MANUAL_FALLBACK=1
BROWSER_2FA_POLL_MS=800
```

登录成功后，ruyiPage 会精确访问
`https://account.apple.com/account/manage/section/information`。姓名与生日卡连续稳定后，
保存唯一截图 `screenshots/02-account-information.png`，先读取生日，再打开姓名弹窗；
采集值写入 `.env` 的 `name`、`birthday`，交互终端会直接显示两项供核对。Firefox 窗口、
标签页和持久 Profile 默认保留，下一次运行优先接管现有登录态。

普通终端只显示简洁业务进度；完整脱敏事件始终写入 `flow-audit.jsonl`。需要同步查看
底层 `browser_stage`、`input_progress`、`twofa_progress` 和 `browser_observation` 时，
使用 `APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac`。该开关只接受 shell/export
运行时值，`.env` 中的同名项会忽略；调试模式不会打印密码、
OTP、Cookie、原始页面正文、姓名或生日到日志。

## 2FA 获取与恢复顺序

ruyiPage 填好密码和“记住账号”后，会先通过 JSONL 要求 Node 清理旧验证码窗、记录 `preparedAt` 并启动 popup watcher；收到 `2fa_prepared` 后才提交密码。watcher 可以在网页发出 `need_2fa` 前预热，但不会提前启动系统设置或终端手输。

第一次 `getCode` acquisition 才启动共享 240 秒期限；如网页明确拒绝第一代验证码，第二代沿用同一期限，不会重新计时。取码严格串行：

1. popup watcher 先用 AX 从已验证的 Apple 系统弹窗读取 `NNN NNN`。AX 没有合法验证码时，才对同一个可信 Apple window ID 做内存 Vision OCR；全窗只接受 `NNN NNN`，中心裁剪的连续六码还必须在两次独立捕获中一致。OCR 不点击、不做全屏搜索、不写临时 PNG。
2. popup-primary 至少等待 30 秒；确认 Allow 后会额外保留 popup/OCR 宽限。只有这段窗口没有新鲜验证码，才启动系统设置取码。系统设置最多两次，每次最多 60 秒，两次之间退避 5 秒；不会和 popup-primary 或终端手输并行。
3. 两次系统设置尝试结束后，且从首次 acquisition 起至少经过 90 秒，如果 stdin/stdout 都是 TTY 且手输未被明确禁用，才显示固定提示并隐藏读取六位验证码。手输默认启用；只有 `BROWSER_2FA_MANUAL_FALLBACK=0` 才禁用。
4. 任一阶段得到合法验证码后立即交给 ruyiPage，并取消尚未启动或仍在运行的后续来源。第一次 acquisition 起 240 秒到期后，runner 清理 helper 与进程组并整体失败。

Allow 自动动作最多尝试两次。两次都未确认时，终端只提示用户手动点击
“允许”；popup 监听、系统设置和后续手输来源不会因此停止。自动尝试只有在后续
原生状态确认 Allow 消失或验证码窗出现后才算成功。

popup 读到并校验六位验证码后会立即交给网页流程；关闭原生验证码窗只是尽力清理，
关闭失败会保留固定审计状态和终端提示，不能再阻塞验证码提交。

最终发布合同最多允许两代验证码。generation 已从 ruyiPage 事件经 runner 和
`account-browser-flow` 透传到 collector。只有可信 Apple 页面明确显示英文、简中或
繁中的验证码错误、无效或过期语义时，才可请求第二代；第一代立即进入全局拒绝
集合，所有来源都不得再次返回。captcha、账号锁定或未知登录错误必须停止，不能借
“换码”继续尝试。

sidecar `onStatus` 已接入外层终端，只显示固定阶段提示，包括 Settings 第 1/2 次、
5 秒重试、手动 Allow、隐藏手输、OCR 权限缺失、获胜来源和 240 秒超时；不插入
OTP、原始 AX/OCR/stderr 或完整 Apple ID。主控 fresh Windows 验证已通过 Python
290/290、ruyipage flow、protocol、sidecar、account-browser-flow、Allow 61/61、
permissions 和 release，四路最终专项复审均为 PASS。该证据覆盖逻辑与 source-contract，不代表 Swift 编译、
TCC 或 macOS 15 原生 UI 已验收。

## 权限分层

- 浏览器 2FA 的「辅助功能」检查和提示由现有 `mac-2fa-popup-read.swift` 通过 `AXIsProcessTrusted()`、`AXIsProcessTrustedWithOptions(...)` 及 `--preflight-accessibility` / `--prompt-accessibility` 原生完成。旧 AppleScript 2FA/Accessibility 权限探针已移除。
- `./run.sh --skip-mac` 只要求实际运行主体获得「辅助功能」权限，用于受限 Apple popup/Settings AX helper；本地通常是 Terminal / iTerm，受监督验收会明确提示 Codex / 原生 helper；不要求 Terminal 控制 System Events 或“系统设置”。
- 只有执行 macOS“系统设置登录 Apple Account”阶段时，才要求「自动化」中允许当前终端 App 控制“系统设置”。
- Screen Recording 是 Vision OCR 自动取码的硬门槛。`install.sh` 编译 `mac-2fa-popup-ocr` 后会请求并确认「屏幕与系统音频录制」；`run.sh` 在 Firefox 启动前再次校验。缺失时固定为 `screen_recording_missing` 并停止，不会提交账号密码。普通运行复用 `install.sh` 编译到 `scripts/bin` 的 helper；受监督验收使用固定的用户级 helper 缓存，只在源码变化时原子重编译，避免每轮随机路径触发新的 TCC 身份。
- 权限变更后应按 macOS 提示退出并重新打开终端，再开始下一次运行。

## macOS 15 验收

Windows 只能验证 Node/Python 逻辑、协议、语法和 source-contract，不能替代 Swift
编译或 macOS 15 原生 UI 验收。Mac 测试机拉取后运行：

```bash
./install.sh
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-ax-fill.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-sms-verification.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-post-sms-finalization.swift
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
npm run test:mac-settings-post-sms-finalization
npm run test:account-browser-flow
npm run test:ruyipage-protocol
npm run test:ruyipage-flow
./run.sh --skip-mac
```

真机还必须验证 Screen Recording 已授权以及未授权时 Firefox 不启动、英文/简中/繁中 popup、
Allow 两次上限与手动接管、Settings 两次重试、从首次 acquisition 起算的 90 秒
隐藏手输和 240 秒截止，以及取消/迟到弹窗清理。终端、`report.json` 和
`2fa-audit.jsonl` 不得出现 OTP、原始
AX/OCR/stderr、完整 Apple ID 或认证页面正文；认证失败不得保存全页截图，OCR
不得留下图片文件。完整 macOS 设置登录另行使用 `./run.sh` 验证 Automation 权限。

## 安全

- `.env` 含账号密码，**勿提交 git**
- `data/` 含 Firefox Profile 与报告，注意保管
- 敏感认证失败只保留固定失败原因和脱敏安全审计，不保存认证页全页截图
- 姓名和生日只保存在私有 `.env` 并在直接交互终端显示；`report.json` 和 audit 仅记录落盘布尔状态
- 每次 `./run.sh` 的 `report.json`、`flow-audit.jsonl`、`2fa-audit.jsonl`
  和 `launcher-audit.jsonl` 使用同一 `runId`；启动日志通过 hard link 归档到本次报告目录，
  因此 Node 流程返回后的 launcher 完成/失败阶段也不会遗漏

## 版本

当前 `package.json` 版本即发布版本；`npm run release` 默认 patch +1 后上传 GitHub Releases。
