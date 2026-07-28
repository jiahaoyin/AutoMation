# Apple ID Automation 项目上下文

> 目标系统：macOS 15 Sequoia。Windows 仅用于纯逻辑、协议和语法测试。

## 1. 项目目标

| 阶段 | 实现 | 人工介入 |
|------|------|----------|
| macOS 系统设置登录 Apple ID | AppleScript / Swift AX | 手机验证码人工输入 |
| 等待系统登录完成 | 状态轮询 | 必要时 Enter 确认 |
| Firefox 登录 account.apple.com | **ruyiPage only** | 无 |
| 浏览器 2FA | Apple popup AX/Vision OCR -> 系统设置 -> 隐藏终端手输的串行回退 + ruyiPage 填码 | 必要时手动 Allow/手输 |
| 采集姓名、生日 | ruyiPage 页面读取 | 无 |

浏览器启动、接管、导航、元素定位、页面读取、输入、截图和退出均由 ruyiPage 完成。Node 只负责编排 Python 子进程、macOS 取码和报告，不持有浏览器连接。

## 2. 优先级与失败策略

1. 敏感输入使用 ruyiPage `scope.actions` 原生 BiDi 动作；macOS 通过 `Command+A`、Delete 和带间隔键入清空并填写。
2. JS 只通过 ruyiPage `page.run_js()` 做无副作用的状态与文本查询。
3. 元素必须先被识别后才交互；2FA 未识别到单框或六格输入时拒绝盲打。
4. 登录时必须确认“记住账号”已勾选；控件缺失或状态未生效即停止。
5. 密码提交前必须完成 `prepare_2fa` 握手；旧码只按该边界判定，不能按 `need_2fa` 到达时间猜测。
6. popup AX 优先；AX 无合法码才对可信 Apple window ID 做 Vision OCR。自 `need_2fa` 起先给 popup 30 秒，确认 Allow 后再给 30 秒；未获新码才串行回退到 Settings，Settings 结束后且不早于首次 acquisition 90 秒才可手输。两代共享 240 秒期限与 Settings 总预算。
7. 交互间使用有界随机停顿，避免固定节奏；超时均有上限。
8. ruyiPage 或 Python 不可用时明确失败，不回退到 Node BiDi、JS 事件或其他页面自动化方案。
9. 最多两代验证码；只有可信 Apple 页面明确显示英/简中/繁中的验证码错误、无效或过期时才换码。captcha、锁定和未知错误立即停止。

## 3. 运行链路

```text
./run.sh
  -> bootstrap-macos.sh（Node 18+）
  -> setup-environment.mjs（Firefox、隔离 Python/ruyiPage、macOS 权限）
  -> 终端读取账号密码并写入权限 600 的 .env
  -> macOS 系统设置登录
  -> account-browser-flow.js（仅进程与 2FA 编排）
  -> ruyipage-backend-runner.js（JSONL 协议）
  -> apple_account_flow.py（全部浏览器和页面操作）
  -> report.json + screenshots/
```

账号通过子进程环境变量传入 Python，不出现在进程命令行参数中。密码也只通过环境变量传递。
密码提交前 Python 发出 `prepare_2fa`；Node 清理准备边界之前的旧窗并启动持续 watcher，回传 `2fa_prepared` 后 Python 才提交。页面确认 2FA 后，Node 严格按 popup、可取消的系统设置 helper、隐藏终端手输的顺序取码；当前阶段取得合法六位码即交给 ruyiPage，后续阶段不再启动。

popup 先尝试 AX 文本读取；只有 AX 没有合法码才启动 Vision OCR。AX 对当前 helper
未授权时，OCR 仅在 `need_2fa` 后按 dedicated Apple authentication process 的 on-screen
window ID 运行；其余情况仍只捕获 AX 已验证 Apple 系统窗口的 window ID。全窗仅接受 `NNN NNN`，中心裁剪连续六位
必须在同一 window ID 的两次独立 capture 中一致后才发布。同一轮重复枚举不计作
第二帧；空帧、不同码或窗口消失都会重置候选。OCR 不包含点击、全屏搜索或图片
落盘。

`prepare_2fa` 只清理旧窗、记录 `preparedAt` 并启动 watcher；在 `need_2fa` 前不点击
Allow、不读取候选码、不启动 Settings。第一次 `getCode` acquisition 才开始共享 240 秒
期限：popup 主阶段从 `need_2fa` 起为 30 秒；确认 Allow 后，最后一次确认再延长 30 秒。
窗口到期仍无新码才启动 Settings，最多两次、每次 60 秒、两次之间退避 5 秒；Settings
阶段开始后不接受迟到 popup 候选码。

Settings 的有界尝试结束后，若从第一次 acquisition 起已过 90 秒、stdin/stdout 均为
TTY 且手输未被明确禁用，才隐藏读取手输验证码。手输默认启用，只有
`BROWSER_2FA_MANUAL_FALLBACK=0` 才禁用；文档配置示例使用 `=1` 表示显式启用。Allow
自动动作最多两次；之后提示用户手动点击，但仍只在 popup 主阶段内继续等待。

## 4. 环境安装

`./install.sh` 执行：

1. 立即执行 `sudo -v`，由 `sudo` 读取一次管理员密码；项目不保存或记录密码。
2. 检测 Python 3.10+；缺失时下载 Python.org 官方 Python 3.12.10 universal2 PKG，核对固定 SHA-256，并在 root 私有暂存目录中使用系统 `pkgutil` 验证 Python Software Foundation Developer ID 签名后执行安装。
3. 检查 Node 18+；缺失时下载 nodejs.org 官方二进制到 `.runtime/node`。
4. 使用已检测或刚安装的 Python 创建 `.runtime/ruyipage-venv`。
5. 在隔离虚拟环境中执行 `python -m pip install --upgrade ruyiPage==1.2.45`。
6. 检查 Firefox，编译 Swift AX/2FA helper，并在安装结束前确认辅助功能和 Vision OCR 的「屏幕与系统音频录制」权限。OCR helper 或该权限缺失时安装失败，避免后续在 2FA 页面才发现无法自动取码。

项目显式使用本机 Firefox，因此不额外执行 `python -m ruyipage install` 下载配套 runtime。
日常执行 `./run.sh` 不使用提权安装入口，也不会重复请求管理员密码。

## 5. Profile 策略

- `BROWSER_PROFILE_MODE=persistent`：默认。复用 `data/firefox-apple-automation`，适合测试同一账号并保留“记住账号”结果。
- `BROWSER_PROFILE_MODE=fresh`：每次在 `data/firefox-apple-automation-fresh/<run-id>` 创建隔离 Profile，适合切换身份。
- `FIREFOX_PROFILE_DIR`：覆盖 Profile 根目录。
- `RUYIPAGE_BACKEND_TIMEOUT_MS=720000`：浏览器阶段总预算 12 分钟，覆盖登录等待、macOS 2FA 取码和登录后采集。
- `BROWSER_2FA_SETTINGS_AFTER_MS=30000`：从 `need_2fa` 起的 popup 主窗口；确认 Allow 后还会保留固定 30 秒 popup/OCR 宽限，之后才可启动 Settings。
- `BROWSER_2FA_SETTINGS_FALLBACK=1`：默认启用系统设置来源；设为 `0` 才禁用。
- `BROWSER_2FA_MANUAL_FALLBACK=1`：显式启用隐藏终端手输；该来源默认启用，只有设为 `0` 才禁用，非 TTY 时始终不可用。它只在 Settings 有界尝试结束后、且不早于第一次 `getCode` acquisition 90 秒启用。
- `BROWSER_2FA_POLL_MS=800`：FollowUpUI 状态轮询间隔。
- `BROWSER_PRESERVE_ON_FAILURE=1`：直接运行 `./run.sh` 时失败后默认保留 Firefox，便于核对当前 Apple 页面；设置为 `0` 才关闭。受监督 broker 会话仍严格清理。
- `BROWSER_PRESERVE_ON_SUCCESS=1`：直接运行成功后默认保留 Firefox 窗口和已登录标签页；设为 `0` 才在 Python 结束时关闭。
- `BROWSER_ATTACH_EXISTING=1`：下次直接运行时优先用 ruyiPage 接管现有 `account.apple.com` 标签页，并检测已登录状态；`BROWSER_ATTACH_ADDRESS` 可显式指定调试地址。
- 登录成功后精确访问 `https://account.apple.com/account/manage/section/information`，在姓名/生日两张卡连续稳定后保存唯一截图 `screenshots/02-account-information.png`。流程先读取生日，再点击姓名卡并从结构化弹窗字段读取名与姓；值仅写入 `.env` 的小写 `name`、`birthday`，交互终端用于核对，audit 和 `report.json` 仅保留是否采集成功。
- OTP 不会输出到终端、audit、报告、截图或错误文本；使用固定状态与交接阶段排查取码和填码问题。
- 普通终端只显示 `[→]`、`[✓]`、`[!]`、`[×]` 进度；每条脱敏 backend 事件仍完整写入 `flow-audit.jsonl`。排查时以 shell/export 运行时开关设置 `APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac`，在终端额外镜像脱敏机器协议；该开关不从 `.env` 读取，受监督验收会自动启用协议。

权限分层：

- 浏览器 Accessibility 使用 `mac-2fa-popup-read.swift` 的 `AXIsProcessTrusted()` / `AXIsProcessTrustedWithOptions(...)` 原生 preflight/prompt；旧 AppleScript 2FA/Accessibility 权限探针已移除。
- `./run.sh --skip-mac` 仍要求实际运行主体获得「辅助功能」；本地通常是 Terminal / iTerm，受监督验收会明确提示 Codex / 原生 helper，但不要求 Terminal 控制 System Events 或“系统设置”。
- 只有 macOS 系统设置登录阶段需要「自动化」权限，即允许当前终端 App 控制“系统设置”。
- Vision OCR 使用「屏幕与系统音频录制」权限，并且是自动取码的必需条件。`install.sh` 编译 exact helper 后立刻请求并确认；`run.sh` 在 Firefox 启动前再次校验。未授权时固定输出 `screen_recording_missing` 并停止，账号密码不会提交。若 macOS 要求重新启动运行主体，请按提示重新打开当前终端或 Codex。普通运行复用 `install.sh` 写入 `scripts/bin` 的 native helper；受监督验收使用固定的用户级 helper 缓存，只在源码变化时原子重编译，避免每轮随机路径被 macOS 当作新的 TCC 客户端。

切换账号时优先使用 `fresh`，避免身份和 Cookie 串用。

## 6. 关键文件

| 文件 | 职责 |
|------|------|
| `scripts/apple-id-full-flow.mjs` | 总流程与报告 |
| `scripts/lib/account-browser-flow.js` | ruyiPage 子进程、macOS 2FA 编排 |
| `scripts/lib/ruyipage-backend-runner.js` | JSONL、超时、常驻组长与有界子进程清理 |
| `scripts/ruyipage/apple_account_flow.py` | 唯一浏览器实现 |
| `scripts/lib/ruyipage-runtime.js` | Python/ruyiPage 探测与隔离安装 |
| `scripts/lib/firefox-runtime.js` | Firefox 路径和 Profile 路径策略；不启动浏览器 |
| `scripts/lib/env-setup.js` | macOS 环境和权限探测 |
| `scripts/lib/two-fa-sidecar.js` | macOS popup 优先、Settings 串行回退、隐藏手输最终兜底的 collector |
| `scripts/lib/mac-settings-2fa.js` | 可取消的系统设置验证码 helper 子进程 |
| `scripts/build-release.mjs` | 发布包复制清单与依赖校验 |

## 7. 常用命令

```bash
./install.sh
npm run check
npm run test:python-bootstrap
npm run test:ruyipage-flow
npm run test:2fa-sidecar
npm run test:2fa-settings-unit
npm run test:account-browser-flow
./run.sh

# 仅浏览器；仍由 ruyiPage 完成
./run.sh --skip-mac

# 仅系统设置；不要求 ruyiPage
./run.sh --skip-browser
```

## 8. macOS 测试检查点

1. `./install.sh` 显示项目虚拟环境中的 ruyiPage 版本。
2. `npm run check` 显示 backend 为 `ruyipage`，Firefox 路径正确。
3. 登录页账号输入后进入密码步骤。
4. “记住账号”被勾选；若无法确认，流程应报错停止。
5. 终端在提交密码前显示预备 2FA 监听，且准备失败时密码不会提交。
6. `need_2fa` 后只启动 popup 主阶段；30 秒内若确认 Allow，再给 popup/OCR 额外 30 秒。该阶段取得新码时，Settings 和手输均不得启动。
7. popup 窗口到期后才启动 Settings；最多两次、每次不超过 60 秒且中间退避 5 秒。Settings 结束后、从第一次 acquisition 起不早于 90 秒时，真实 TTY 才可隐藏手输；240 秒后停止并完成 runner cleanup。
8. Allow 自动最多两次；未确认后提示人工点击，且只在 popup 主阶段继续等待，不提前启动 Settings 或手输。
9. 全窗 OCR 只接受 `NNN NNN`；中心连续六位需同一 window ID 两次独立捕获一致。Screen Recording 缺失时安装和 Firefox 登录都不启动，直到授权完成。
10. 验证码只写入已识别的单框或六格控件。已验证的 popup 码不能因原生弹窗关闭失败而被扣留；关闭属于尽力清理并保留固定状态。
11. 第一代只有在可信 Apple 页明确 OTP 错误/无效/过期时才可被第二代替换；第二代重新走 popup 主阶段，但沿用 240 秒期限与 Settings 两次总预算，旧码不再复用。captcha、锁定和未知错误停止。
12. 登录后精确访问个人信息页，仅在姓名/生日两张卡稳定后生成 `02-account-information.png`；截图先于姓名弹窗打开。
13. `report.json` 中 `browserLogin.backend` 为 `ruyipage`，仅记录资料采集/落盘状态和固定截图文件名，不包含账号、姓名或生日。

第 11 项已完成：ruyiPage、runner、`account-browser-flow` 和 collector 透传 generation，
且只有可信 Apple 页明确英/简中/繁中 OTP 拒绝才进入第二代；第一代全局拒绝，
第二代回到 popup 主阶段并共享期限与 Settings 预算，captcha、锁定和未知错误停止。
固定 `onStatus` 阶段提示、Settings 结束后的 manual/240 秒期限以及 runner deadline
cleanup 也已接入。OTP 不会显示在终端，且绝不写入 audit、报告、截图或错误文本；通过固定
交接阶段排查取码、投递、输入、提交和登录状态确认问题。

Windows 发布门槛包括 Python 290 项、ruyipage flow/protocol、sidecar、
account-browser-flow、Allow 61 项、permissions、release 和 mac-codex contract；每个待发布
提交都必须重新执行，不能沿用旧提交的 PASS。这些结果只证明逻辑、协议与 source-contract；
Swift typecheck/TCC 和 macOS 15 原生 UI 必须以同一精确提交在测试机验收。

## 9. 故障排查

| 现象 | 处理 |
|------|------|
| ruyiPage 未就绪 | 运行 `./install.sh`；脚本会自动安装 Python 3.12.10（如需要）并创建项目 venv |
| Firefox 未找到 | 安装 Firefox 或设置 `FIREFOX_EXECUTABLE` |
| 记住账号控件失败 | 查看固定失败报告与脱敏状态；敏感认证页不保存全页截图，不得改成盲点或盲输 |
| 2FA 输入框未识别 | 查看固定失败原因和 `2fa-audit.jsonl` 的安全状态，补充 ruyiPage selector；不得改成无焦点输入 |
| macOS 取码超时 | 确认系统设置已登录同账号、终端已获辅助功能；按 audit 的固定 phase/reason 检查 popup 主阶段、OCR、Settings 串行回退和最终 manual。`--skip-mac` 不需要 Automation |
| 短信后置弹窗未自动处理 | 仅在 `.env` 设置 `APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1` 后启用。确认当前终端拥有辅助功能；iPhone 视觉路径还需要屏幕录制。模块按同一 AX owner、visual host、CGWindowID 绑定逐个处理条款、Mac 密码、iPhone 解锁和位置页，位置只接受 `action-button-2` 的“以后”，任一身份、窗口、OCR 或 4/6 格不稳定都会保留人工操作。 |
| OCR capability 为 `permission_missing` | 这是硬门槛；在「隐私与安全性 -> 屏幕与系统音频录制」授权实际运行主体，按 macOS 提示重开终端或 Codex 后重新运行 `./install.sh` |
| Mac 设置登录提示 Automation 未授权 | 仅完整流程/`--skip-browser` 需要；在「隐私与安全性 → 自动化」允许当前终端控制“系统设置” |
| 姓名或生日为空 | 查看 `02-account-information.png` 和 `flow-audit.jsonl`；需要终端同步机器协议时用 `APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac` |

## 10. 安全边界

- 不提交 `.env`、`data/`、`.runtime/`、`dist/`。
- 不在日志、命令行参数或报告中写明文密码。
- 不使用 JS 设置敏感输入值或派发输入事件。
- 不在运行时切换到未审核的浏览器后端。
- 不记录或转发 OTP、原始 AX/OCR/stderr、完整 Apple ID、认证页面正文或 URL query。
- 敏感认证失败不保存全页截图；Vision 像素只在内存中使用，不生成临时 PNG。

## 11. macOS 15 发布验收

Windows 仅用于逻辑、协议、语法与 source-contract；以下命令和 UI 行为必须在
macOS 15 测试机验证：

```bash
./install.sh
SWIFT_MODULE_CACHE="$TMPDIR/apple-automation-swift-module-cache"
/bin/mkdir -p "$SWIFT_MODULE_CACHE"
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-settings-ax-fill.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-settings-sms-verification.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-settings-post-sms-finalization.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-2fa-click-allow.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-2fa-popup-read.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-2fa-popup-ocr.swift
/usr/bin/xcrun swiftc -module-cache-path "$SWIFT_MODULE_CACHE" -typecheck scripts/swift/mac-settings-2fa-code.swift
npm run test:2fa-allow-unit
npm run test:2fa-sidecar
npm run test:2fa-settings
npm run test:2fa-settings-unit
npm run test:account-browser-flow
npm run test:ruyipage-protocol
npm run test:ruyipage-flow
./run.sh --skip-mac
```

验收覆盖英文、简中、繁中，Screen Recording 已授权以及未授权时 Firefox 不启动，AX 命中和 OCR fallback，
Allow 自动两次后人工接管，`need_2fa` 起 30 秒 popup 主窗口和 Allow 后额外 30 秒，
Settings 两次串行回退与取消/迟到清理，以及 Settings 结束后、从首次 acquisition 起算的
90 秒 TTY 手输、两代共享的 Settings 总预算和 240 秒截止。
另以 `./run.sh` 验证 Mac 设置登录阶段的 Automation 权限。检查终端、
`report.json`、`2fa-audit.jsonl` 和报告目录，确认无 OTP、raw AX/OCR/stderr、
完整 Apple ID、认证全页截图或 OCR 图片残留。

每次 `./run.sh` 会生成一个非敏感 `runId`，并贯通 `report.json`、
`flow-audit.jsonl`、`2fa-audit.jsonl` 和 `launcher-audit.jsonl`。launcher
日志在 Node 主流程创建报告目录后以 hard link 归档，保证后续
`apple_flow_completed` 或 `failure` 仍写入同一份报告内日志。各 JSONL
独立使用从 1 开始的 `sequence`，用于判断单个日志是否缺行。
