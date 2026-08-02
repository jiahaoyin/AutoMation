# Current policy (2026-08-02)

Windows and Mac are both development hosts. `verify` is the default exact-SHA validation mode;
`implementation` is the controlled Mac writer mode for macOS-specific code, tests, optimization,
and detailed ruyiPage browser annotations. Implementation runs take the exclusive writer lock,
default to `--no-sync`, preserve existing Mac edits, deny secrets and `.git`, and return a
sanitized `git-diff.patch`, `git-untracked.txt`, and `browser-annotations.jsonl`. Browser actions
remain ruyiPage-only; Playwright, Puppeteer, Selenium, destructive Git commands, and automatic commit/push are not allowed.

# Windows 调度 Mac 手册

Windows 与 Mac 都是开发主机；verify 模式负责精确 SHA 验证，implementation 模式负责受控 Mac 实现、测试、优化和页面标注。

## 1. 角色与不可变边界

| 环境 | 允许做什么 | 禁止做什么 |
| --- | --- | --- |
| Windows 开发机 | 修改源码、运行 Windows-safe tests、review、commit、push、发起 Mac 调度。 | 以 Windows 结果替代 macOS TCC / Swift / GUI 验收。 |
| Mac verify | 拉取精确 SHA、运行非交互检查、在明确监督下执行 GUI 验收、回传证据。 | 修改仓库、提交/推送、覆盖脏工作树。 |
| Mac implementation | 修改源码/测试/文档、macOS 优化、使用 ruyiPage 做页面标注并回传脱敏产物。 | 读取秘密、写 `.git`、提交/推送、强制 checkout、递归删除或覆盖既有脏改动。 |
| Mac Codex sandbox | verify 只写本轮 TMPDIR；implementation 另写项目工作树。 | 读取 `.env`、auth、SSH/Git 凭据、netrc 或共享系统目录。 |

浏览器一律 ruyiPage-only。不要添加 Playwright、Puppeteer、Selenium、AppleScript browser control 或 Node browser driver。

## 2. 运行前准备

Windows 项目根目录：

~~~text
D:WorkApple-AutoMation
~~~

典型 Mac 项目根目录：

~~~text
/Users/admin/Desktop/Apple-AutoMation
~~~

Windows 启动前先确认：

~~~powershell
git status --short
git branch --show-current
git rev-parse HEAD
npm.cmd run -s test:mac-codex
~~~

`verify` 和显式 `--sync` 的 implementation round 需要 Windows worktree 干净且目标分支已 push。
默认 implementation round 使用 `--no-sync`，从现有 Mac 工作树继续并保留脏改动；不要使用 git reset --hard、git clean、强制 checkout 或目录删除来“修复”。

## 3. 标准 Windows → Mac 循环

~~~powershell
# 1. Windows 完成实现和定点回归
npm.cmd run -s test:account-browser-flow
npm.cmd run -s test:ruyipage-protocol
npm.cmd run -s test:ruyipage-flow
npm.cmd run -s test:flow-audit
npm.cmd run -s test:release-copy-paths
git diff --check

# 2. 仅暂存本轮文件并提交
git add <本轮文件>
git commit -m "<本轮说明>"
git push origin codex/ruyipage-risk-reduction

# 3. 确认本地仍干净
git status --short

# 4. 调度 Mac 非交互验证
npm.cmd run -s mac:codex -- --task "运行与本次修改相关的非交互静态检查和定点测试；返回结构化结论、精确 HEAD 与证据路径。"
~~~

长任务文本使用 UTF-8 文件：

~~~powershell
npm.cmd run -s mac:codex -- --task-file .mac-test-task.txt --round 1
~~~

调度器会检查 Windows clean、Mac clean、分支与 HEAD；在 Mac 端执行受控 fetch/switch/merge --ff-only，并验证两个 HEAD 文件都等于 Windows 精确 SHA。返回的 JSON 中必须读取 summary.json、final.json、events.jsonl 和 stderr.log 的路径后再决定是否改代码。

## 4. Sandbox 与并发

默认同步运行持有独占 writer lock。只有 Mac 已同步到准确 Windows SHA 后，才可对独立只读 review 使用 --no-sync：

~~~powershell
npm.cmd run -s mac:codex -- --no-sync --task "只读审查当前提交的 Developer-first 文档和测试契约，不改源文件。"
~~~

--no-sync 的 reader lock 不得与同步 writer 并发。出现 Mac repository is busy 时，等待现有任务结束后重试。

verify 模式的权限 profile 继承 read-only，唯一可写位置是本轮 TMPDIR；implementation 模式额外允许项目源码/测试/文档写入，仍拒绝秘密与 `.git`：

~~~text
/Users/admin/.codex-orchestrator/runs/<runId>/mac/round-XX/tmp
~~~

该目录同时作为 TMPDIR。不要使用 legacy --add-dir，也不要放宽到仓库、round 根目录、HOME 或系统共享临时目录。Swift typecheck 需要明确的模块缓存：

~~~bash
/usr/bin/xcrun swiftc -module-cache-path "$TMPDIR/apple-automation-swift-module-cache" -typecheck <file>
~~~

implementation 可用 ruyiPage 接管**已登录**的 Firefox 页面完成注释；不读取 `.env`，也不跑登录或
2FA。元素确认后只能写入脱敏元数据：

~~~zsh
node scripts/write-browser-annotation.mjs '{"phase":"developer","selectorKind":"membership-card","selectorHash":"<stable-hash>","status":"confirmed"}'
~~~

该命令固定写到 `$APPLE_AUTOMATION_REPORT_ROOT/browser-annotations.jsonl`。收集器会再次校验并脱敏；
URL、页面文本、截图、账户字段和原始 AX/OCR 均会被拒绝。

## 5. 受监督 GUI 验收

真实 Apple 登录、2FA 或需要图形界面确认的测试默认不执行。只有用户明确正在监督该 Mac 会话时，才使用同步独占模式：

~~~powershell
npm.cmd run -s mac:codex -- --task-file .mac-supervised-task.txt --round 2 --allow-supervised-gui
~~~

该开关只适用于受监督的 `verify`，不放宽：

- Mac verify 仓库 read-only；
- TMPDIR 唯一可写边界；
- .env 与凭据脱敏；
- 浏览器 ruyiPage-only；
- 精确 SHA 与 clean worktree；
- 报告、截图、2FA audit、Firefox profile 必须位于本轮 TMPDIR。

生产 GUI 命令固定为：

~~~text
./run.sh --skip-mac
~~~

Mac Codex 不能通过 open、launchctl、AppleScript 或自定义 GUI 启动器绕开受控 bridge。bridge 只处理带随机 nonce 的一次性 trigger，并把原始生产输出限制为固定阶段/失败类别；任何密钥、OTP、原始页面文本和完整截图都不进入 events、final 或固定证据清单。

兼容性记录保留：真实 Apple ID 的手动验收仍只在受监督 verify 中进行；profile 继续以
`sandbox_mode = "read-only"`、`umask 077`、30 秒与 30 天的既有时限约束为准。
每轮仍产生 `codex-exit.txt`、`git-before.txt` 和 `git-after.txt`；手工 `test:2fa-allow`
仍仅允许在受监督 verify 中执行。

## 6. Developer-first 验收合同

默认值 **DEVELOPER_MEMBERSHIP_GATE=0** 是双模块测试模式。受监督浏览器运行的固定证据顺序为：

~~~text
developer_account_started
→ developer_account_authentication_started
→ developer_account_authenticated
→ developer_membership_checked
→ account_module_started
→ account_module_tab_created
→ account_home_confirmed
→ profile_capture_*
~~~

| 检查项 | 正确结果 |
| --- | --- |
| Developer 结果 | 仅在 Developer 登录确认后记录 active、not_enrolled 或 unknown，并在进入 Account 前私有持久化。 |
| active 截图 | 仅 active 时可出现 03-developer-membership.png。 |
| Account 截图 | 仅个人信息页稳定后可出现 02-account-information.png。 |
| gate=1 非 active | developer_membership_gate_blocked、accountModule.skipped=true、acceptance_marker_skipped；这是成功的 gate stop。 |
| Account acceptance | 只有 account_home_confirmed=true 时允许 acceptance_marker_completed。 |
| Developer 登录未确认 | 无论 gate 值都不得创建 Account tab；浏览器按失败保留策略保留，会员值不写入。 |

不要把 screenshot 的缺失单独当成失败：会员截图只属于 active；个人信息截图只属于 information page ready。

## 7. 证据读取与回传

每个 Mac 调度结果都需要确认：

1. `verify` 的 Windows 与 Mac status 文件都为空，两个 HEAD 文件都等于 Windows SHA；
2. implementation 保存 `git-diff.patch`、`git-untracked.txt` 与 canonical `browser-annotations.jsonl`，并人工 review patch；
3. summary.json 与 final.json 的结果一致；
4. `events.jsonl`、`stderr.log`、`final.json` 已经由统一 sanitizer 处理，不含原始页面内容、URL、路径或秘密；
5. 若是受监督 GUI，包含完成的 run.sh --skip-mac command event 和固定 production acceptance artifact。

可回传的首选证据：

- 本轮 TMPDIR 的 flow-audit.jsonl 与 2fa-audit.jsonl；
- summary.json、final.json、events.jsonl、stderr.log 的路径；
- report.json 的固定状态字段（确认不含个人字段后）；
- 无个人数据的固定错误类别。

不要回传：

- .env、Firefox profile、Cookie、session、API key、GitHub 凭据；
- Apple ID、密码、OTP；
- raw AX tree、OCR 文本、网络请求/响应、URL query；
- 完整认证页、未脱敏个人信息截图或视频。

## 8. 常见失败与重测

| 状态 | 处理 |
| --- | --- |
| Windows 不是 clean | 停止；保留无关改动，先由拥有者处理。 |
| verify Mac worktree 脏或无法 fast-forward | 停止；回报分支、HEAD、status，不强制同步。 |
| implementation Mac worktree 脏 | 用默认 `--no-sync` writer round 保留改动并回传脱敏 patch；不要强制同步。 |
| Mac HEAD 不等于 Windows SHA | 停止；修复同步链后新开 round。 |
| sandbox policy 验证失败 | 立即失败；不要退回更宽的 profile。 |
| Swift typecheck 缓存失败 | 使用本轮 TMPDIR 的 module-cache-path，不写仓库。 |
| Developer 后 Account 未打开 | 先核对 DEVELOPER_MEMBERSHIP_GATE 与 developer_membership_gate_blocked。 |
| Account home 已确认但资料 partial | 以 profile_capture_* 和 browser preservation 为准；不要重写登录链。 |
| 2FA provider 结束但网页未确认 | 用 2FA handoff 固定状态定位，不输出/重放 OTP。 |

一次修改 → 一次 Windows 定点回归 → 一次干净 push → 一个新的 Mac round。不要让旧 round 的结果替代新 SHA 的验证。

## 9. 交付前清单

- [ ] README、运行手册、PROJECT、Mac/Windows 交接与 release 文档和当前实现一致。
- [ ] 所有新增固定状态在 audit/report sanitizer、测试和文档中出现。
- [ ] verify 或 `--sync` implementation 前，Windows worktree clean 且当前 SHA 已 push。
- [ ] Windows 定点测试和 git diff --check 通过。
- [ ] Mac 任务使用适当的同步/锁模式。
- [ ] verify 证据属于当前 SHA 和当前 round；implementation 证据含可 review 的 patch/manifest/annotation。
- [ ] 没有秘密或个人截图被写入日志、报告、提交或回传。
