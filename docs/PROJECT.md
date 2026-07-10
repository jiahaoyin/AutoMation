# Apple ID Automation 项目上下文

> 目标系统：macOS 15 Sequoia。Windows 仅用于纯逻辑、协议和语法测试。

## 1. 项目目标

| 阶段 | 实现 | 人工介入 |
|------|------|----------|
| macOS 系统设置登录 Apple ID | AppleScript / Swift AX | 手机验证码人工输入 |
| 等待系统登录完成 | 状态轮询 | 必要时 Enter 确认 |
| Firefox 登录 account.apple.com | **ruyiPage only** | 无 |
| 浏览器 2FA | FollowUpUI 与系统设置双通道取码 + ruyiPage 填码 | Mac 已登录同账号 |
| 采集姓名、生日 | ruyiPage 页面读取 | 无 |

浏览器启动、接管、导航、元素定位、页面读取、输入、截图和退出均由 ruyiPage 完成。Node 只负责编排 Python 子进程、macOS 取码和报告，不持有浏览器连接。

## 2. 优先级与失败策略

1. 敏感输入使用 ruyiPage `scope.actions` 原生 BiDi 动作；macOS 通过 `Command+A`、Delete 和带间隔键入清空并填写。
2. JS 只通过 ruyiPage `page.run_js()` 做无副作用的状态与文本查询。
3. 元素必须先被识别后才交互；2FA 未识别到单框或六格输入时拒绝盲打。
4. 登录时必须确认“记住账号”已勾选；控件缺失或状态未生效即停止。
5. 密码提交前必须完成 `prepare_2fa` 握手；旧码只按该边界判定，不能按 `need_2fa` 到达时间猜测。
6. popup 优先 8 秒，之后与系统设置并行竞速；任一来源失败时继续等待另一路，获胜后清理 loser。
7. 交互间使用有界随机停顿，避免固定节奏；超时均有上限。
8. ruyiPage 或 Python 不可用时明确失败，不回退到 Node BiDi、JS 事件或其他页面自动化方案。

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
密码提交前 Python 发出 `prepare_2fa`；Node 清理准备边界之前的旧窗并启动持续 watcher，回传 `2fa_prepared` 后 Python 才提交。页面确认 2FA 后，Node 从 popup 与可取消的系统设置 helper 中取首个稳定六位码。

## 4. 环境安装

`./install.sh` 执行：

1. 立即执行 `sudo -v`，由 `sudo` 读取一次管理员密码；项目不保存或记录密码。
2. 检测 Python 3.10+；缺失时下载 Python.org 官方 Python 3.12.10 universal2 PKG，核对固定 SHA-256，并在 root 私有暂存目录中使用系统 `pkgutil` 验证 Python Software Foundation Developer ID 签名后执行安装。
3. 检查 Node 18+；缺失时下载 nodejs.org 官方二进制到 `.runtime/node`。
4. 使用已检测或刚安装的 Python 创建 `.runtime/ruyipage-venv`。
5. 在隔离虚拟环境中执行 `python -m pip install --upgrade ruyiPage==1.2.45`。
6. 检查 Firefox、编译 Swift AX/2FA helper，并引导辅助功能与自动化授权。

项目显式使用本机 Firefox，因此不额外执行 `python -m ruyipage install` 下载配套 runtime。
日常执行 `./run.sh` 不使用提权安装入口，也不会重复请求管理员密码。

## 5. Profile 策略

- `BROWSER_PROFILE_MODE=persistent`：默认。复用 `data/firefox-apple-automation`，适合测试同一账号并保留“记住账号”结果。
- `BROWSER_PROFILE_MODE=fresh`：每次在 `data/firefox-apple-automation-fresh/<run-id>` 创建隔离 Profile，适合切换身份。
- `FIREFOX_PROFILE_DIR`：覆盖 Profile 根目录。
- `RUYIPAGE_BACKEND_TIMEOUT_MS=720000`：浏览器阶段总预算 12 分钟，覆盖登录等待、macOS 2FA 取码和登录后采集。
- `BROWSER_2FA_SETTINGS_AFTER_MS=8000`：从准备完成起为 popup 保留 8 秒优先窗口，之后启动系统设置并行取码。
- `BROWSER_2FA_SETTINGS_FALLBACK=1`：默认启用系统设置来源；设为 `0` 才禁用。
- `BROWSER_2FA_POLL_MS=800`：FollowUpUI 状态轮询间隔。

切换账号时优先使用 `fresh`，避免身份和 Cookie 串用。

## 6. 关键文件

| 文件 | 职责 |
|------|------|
| `scripts/apple-id-full-flow.mjs` | 总流程与报告 |
| `scripts/lib/account-browser-flow.js` | ruyiPage 子进程、macOS 2FA 编排 |
| `scripts/lib/ruyipage-backend-runner.js` | JSONL、超时、子进程错误处理 |
| `scripts/ruyipage/apple_account_flow.py` | 唯一浏览器实现 |
| `scripts/lib/ruyipage-runtime.js` | Python/ruyiPage 探测与隔离安装 |
| `scripts/lib/firefox-runtime.js` | Firefox 路径和 Profile 路径策略；不启动浏览器 |
| `scripts/lib/env-setup.js` | macOS 环境和权限探测 |
| `scripts/lib/two-fa-sidecar.js` | macOS popup/系统设置双通道 collector 与 loser 清理 |
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
6. popup 早到时被缓存；8 秒内没有稳定码时系统设置自动进入双重认证取码，两个来源仍同时有效。
7. 验证码只写入已识别的单框或六格控件，loser helper/弹窗随后关闭。
8. 登录后访问个人信息页并生成 `02-ruyipage-after-login.png`、`03-account-manage.png`。
9. `report.json` 中 `browserLogin.backend` 为 `ruyipage`，姓名/生日结果与页面一致。

## 9. 故障排查

| 现象 | 处理 |
|------|------|
| ruyiPage 未就绪 | 运行 `./install.sh`；脚本会自动安装 Python 3.12.10（如需要）并创建项目 venv |
| Firefox 未找到 | 安装 Firefox 或设置 `FIREFOX_EXECUTABLE` |
| 记住账号控件失败 | 保留失败截图，核对 Apple 登录页控件结构 |
| 2FA 输入框未识别 | 查看 `99-ruyipage-failure.png`，补充 ruyiPage selector；不得改成无焦点输入 |
| macOS 取码超时 | 确认系统设置已登录同账号并授予 Terminal 辅助功能/自动化权限；查看 `2fa-audit.jsonl` 中 popup 与 settings 各自失败原因 |
| 姓名或生日为空 | 查看 `03-account-manage.png`，调整 ruyiPage 页面解析标签 |

## 10. 安全边界

- 不提交 `.env`、`data/`、`.runtime/`、`dist/`。
- 不在日志、命令行参数或报告中写明文密码。
- 不使用 JS 设置敏感输入值或派发输入事件。
- 不在运行时切换到未审核的浏览器后端。
