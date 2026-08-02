# Mac 验证交接

> Mac 不是测试专机。`verify` 做精确 SHA 验证，`implementation` 允许 macOS 特定实现、测试、优化和 ruyiPage 页面注释，并回传脱敏产物。当前运行方案以 docs/RUNTIME_RUNBOOK.md 为准。

## 1. 先读什么

进入仓库后按顺序阅读：

1. AGENTS.md
2. docs/MAC_CODEX_HANDOFF.md（本文）
3. docs/RUNTIME_RUNBOOK.md
4. docs/PROJECT.md
5. README.md
6. docs/WINDOWS_MAC_CODEX.md（仅当 Windows 调度 Mac 时）

当前分支通常是 **codex/ruyipage-risk-reduction**，但一切行为以当前已推送、已同步的 HEAD 和测试为准。历史 commit、历史计划只提供背景，不是永久运行基线。

## 2. 平台职责

| 环境 | 职责 |
| --- | --- |
| Windows 开发机 | 读源码、修改、跑 Windows-safe tests、review、commit、push。 |
| Mac verify | 拉取精确 SHA，做只读测试或用户监督的 GUI 验收，回传脱敏证据。 | 修改/提交/推送仓库、覆盖脏工作树。 |
| Mac implementation | 在 writer lock 下修改源码、测试、文档，运行 macOS 检查并用 ruyiPage 标注页面；回传脱敏 diff/manifest/annotation。 | 读取秘密、写 `.git`、提交/推送、强制 checkout、递归删除或覆盖既有脏改动。 |
| Mac Codex sandbox | verify 只写本轮 TMPDIR；implementation 另写项目工作树。 | 读取 `.env`、auth、SSH/Git 凭据、netrc 或共享系统目录。 |

默认 Mac 仓库路径：

~~~text
/Users/admin/Desktop/Apple-AutoMation
~~~

不要 reset、clean、revert 或删除工作树中的无关改动。

## 3. 当前浏览器方案

浏览器操作只能使用 **ruyiPage**。Firefox 启动、标签页、导航、查询、输入、点击和截图全部由 **scripts/ruyipage/apple_account_flow.py** 负责。Node 只通过 framed JSONL 做流程编排、2FA provider、脱敏 audit 和报告。

禁止将浏览器输入换成 Playwright、Puppeteer、Selenium、AppleScript 浏览器控制、Node browser driver、DOM dispatchEvent 或坐标点击。

### Developer-first 顺序

~~~text
初始 Firefox tab
  -> https://developer.apple.com/account
  -> 登录 / 共享 2FA / 会员状态
  -> 立即持久化 developer_membership
  -> 按 gate 决定是否新建 Account tab
  -> https://account.apple.com/account/manage/section/information
  -> 个人信息截图与采集
~~~

| 配置 | 结果 |
| --- | --- |
| DEVELOPER_MEMBERSHIP_GATE=0 | 默认测试模式；仅在 Developer 登录已确认后，active、not_enrolled、unknown 都继续 Account。 |
| DEVELOPER_MEMBERSHIP_GATE=1 | 只有已认证的 active 新建 Account tab；已认证的非 active 是成功的 gate stop。 |

Developer 的固定状态为 active、not_enrolled、unknown，前提是 Developer 登录已经确认。Node 只在 developer_membership_checked 到达时，或已认证后的 membership partial 时写入私有 developer_membership。登录未完成时不写会员结果、不创建 Account tab。仅 active 可生成 **03-developer-membership.png**；个人信息页稳定后才可生成 **02-account-information.png**。

gate=1 的非 active 结果必须同时满足：

- developer_membership_gate_blocked；
- accountModule.skipped=true；
- browserLogin.accountHomeConfirmed=false；
- acceptance_marker_skipped。

它不是 Account 登录失败。

## 4. 2FA provider 契约

默认顺序固定，不能重排或并发竞争：

1. ruyiPage 发出 need_2fa 后，popup watcher 先给可信 Apple popup 30 秒主窗口；
2. AX 无有效码时，同一可信 window 才允许内存 Vision OCR；
3. Allow 确认后 popup/OCR 有额外固定宽限；
4. 只有 popup-primary 无有效新码时，System Settings 才开始；最多两次、有界超时、间隔退避；
5. Settings 结束且满足最小等待窗口后，真实 TTY 才允许隐藏手输；
6. 有效新码马上交给 ruyiPage，后续 provider 不再启动；
7. 第二代验证码只在可信网页明确拒绝第一代时出现，两代共享期限与 Settings 总预算。

OTP 永远不写入 terminal、flow-audit.jsonl、2fa-audit.jsonl、report.json、截图、错误文本或 .env。

网页 handoff 的最小顺序：

~~~text
twofa_code_delivery_started
→ twofa_code_delivery_sent
→ code_received
→ twofa_code_delivery_acknowledged
→ target_resolved
→ input_completed
→ submit_sent
→ transition_confirmed
~~~

更多定位细节见 docs/2FA_HANDOFF_DIAGNOSTICS.md。

## 5. Mac 权限和环境

| 权限 | 用途 |
| --- | --- |
| 辅助功能 | native popup 与 System Settings AX helper。 |
| 屏幕与系统音频录制 | Vision OCR 的硬门槛；缺失时浏览器凭据不会提交。 |
| 自动化 | 仅 macOS 系统设置登录阶段；浏览器-only 的 --skip-mac 不需要。 |

安装/更新 native helper 后运行：

~~~bash
./install.sh
~~~

若 macOS 要求，关闭并重新打开实际运行主体后再测试。不要用 shell hack、AppleScript 或未受信 helper 规避 TCC。

## 6. Mac 同步与人工流程

真实 Apple 登录必须由用户监督。开始前，Mac 必须是干净工作树并 fast-forward 到 Windows 已推送 SHA：

~~~bash
cd /Users/admin/Desktop/Apple-AutoMation
git status --short
git fetch origin
git switch codex/ruyipage-risk-reduction
git pull --ff-only origin codex/ruyipage-risk-reduction
git rev-parse HEAD
~~~

只有 status 为空且 HEAD 等于 Windows 指定 SHA 才继续。不要使用 git reset --hard、git clean、强制 checkout 或任何覆盖同步。

用户手工执行浏览器验证：

~~~bash
./run.sh --skip-mac
~~~

默认使用 DEVELOPER_MEMBERSHIP_GATE=0，预期顺序是：

~~~text
developer_account_authentication_started
→ developer_account_authenticated
developer_membership_checked
→ account_module_tab_created
→ account_home_confirmed
→ profile_capture_*
~~~

若刻意测试业务 gate，设置 DEVELOPER_MEMBERSHIP_GATE=1，并确认 non-active 的终点是正常跳过，不存在 Account home marker。

## 7. 可回传证据

优先回传当前报告目录的脱敏固定状态：

- flow-audit.jsonl 中相关阶段；
- 2fa-audit.jsonl 中 provider 生命周期；
- report.json 的固定完成/跳过字段（确认不含个人字段后）；
- 启动失败时 launcher-audit.jsonl 的固定阶段；
- 受监督 Windows 调度时的 summary.json、final.json、events.jsonl、stderr.log 路径。

不要发送：

- .env、Apple ID、密码、session、Cookie、API key、GitHub 凭据；
- OTP；
- 原始 AX tree、OCR 文本、网络载荷、URL query、完整认证页面文本；
- 未脱敏个人信息截图或视频。

截图是私有数据。03-developer-membership.png 仅 active 存在；02-account-information.png 可能含姓名/生日。无法确认脱敏时，不发送图片。

## 8. 证据分流表

| 现象 | 首先查看 |
| --- | --- |
| Firefox 不能启动 | scripts/lib/ruyipage-runtime.js、scripts/lib/ruyipage-backend-runner.js。 |
| Developer 登录/会员异常 | apple_account_flow.py、developer_account_*、developer_membership_checked。 |
| Developer 后没有 Account | DEVELOPER_MEMBERSHIP_GATE、developer_membership_gate_blocked、accountModule。 |
| Account tab 创建/认证异常 | account_module_started、account_module_tab_created、account_home_confirmed。 |
| Account home 已确认但资料 partial | profile_capture_*、personal-information readiness、browser preservation。 |
| 已取码但网页没有完成 | 2FA handoff 顺序和 owner-frame BiDi 状态。 |
| OTP 被拒绝 | explicit invalid/expired/rejected 检测与 generation 2。 |
| Screen Recording 缺失 | preflight 输出和实际运行主体的 TCC 授权。 |

修复时从最小拥有模块开始。不要用弱化目标验证、盲输、坐标点击、日志记录秘密来掩盖问题。

## 9. 安全的本地检查

Mac Codex 在 `verify` 模式可以做不触发 GUI 的只读/静态检查；`implementation` 模式还可做受控源码修改、测试和 ruyiPage 页面注释：

~~~bash
node --check scripts/apple-id-full-flow.mjs
node --check scripts/lib/account-browser-flow.js
node --check scripts/lib/two-fa-sidecar.js
python -m py_compile scripts/ruyipage/apple_account_flow.py
git diff --check
~~~

只有在本轮改动跨越对应模块时，再扩展到关联 Node/Python 测试。真实 Apple 流程、manual 2FA、test:2fa-allow manual 模式与自动 GUI 验收不得由 Mac Codex 自行启动。

## 10. 新 Mac 会话提示词

~~~text
先阅读 /Users/admin/Desktop/Apple-AutoMation/AGENTS.md、
/Users/admin/Desktop/Apple-AutoMation/docs/MAC_CODEX_HANDOFF.md 和
/Users/admin/Desktop/Apple-AutoMation/docs/RUNTIME_RUNBOOK.md。

这是只读人工反馈阶段。不要读取 .env，不要启动真实 Apple 登录、Firefox、系统设置、
supervised GUI 或自动 Mac 测试。不要输出凭据、OTP、原始 AX/OCR、截图、URL query
或认证页面正文。

浏览器必须保持 ruyiPage-only。当前顺序是 Developer-first：初始 tab 判定会员并持久化
developer_membership；仅 gate 允许时创建 Account tab。2FA 必须维持 popup AX/OCR →
Settings → optional hidden manual 的严格串行策略。等待我提供脱敏日志或已脱敏视觉证据，
implementation 模式的修改通过脱敏 diff、untracked manifest 和 browser-annotations.jsonl 回传；仍不得提交或推送 Mac 工作树。
~~~

## 11. 不可破坏的仓库规则

- 浏览器 automation 只用 ruyiPage。
- 不读取、不输出秘密。
- 不使用 bulk/recursive 删除或破坏性 Git 命令。
- 保留用户无关改动。
- audit 和报告只保留固定脱敏状态，不插入 raw helper stderr、AX/OCR、截图、OTP 或页面正文。
Windows 与 Mac 都可改源；verify 负责精确 SHA 验证，implementation 负责受控实现并回传脱敏证据。
# Current collaboration policy (2026-08-02)

Mac is no longer test-only. Use `--mac-mode implementation` for controlled source changes,
macOS optimization, and ruyiPage browser annotation. The mode is an exclusive writer run and
returns a sanitized patch/untracked manifest; `--no-sync` preserves existing Mac edits. Keep
`.env`, auth files, SSH/Git credentials, raw page text, OTP, and raw screenshots out of reports.
