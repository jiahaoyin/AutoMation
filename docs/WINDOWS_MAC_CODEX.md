# Windows 调度 Mac Codex 操作手册

本文档说明如何让 Windows 上的 Codex 负责开发和修复，让 Mac 上的 Codex 独立负责
macOS 环境识别、检查和测试，再把完整证据交回 Windows 进入下一轮修改与重测。

文档中的密钥一律使用占位符。不要把真实 API Key、GitHub PAT 或 `.env` 内容写入命令、
任务文本、日志或 Git。

## 1. 当前机器与角色

| 项目 | Windows | Mac |
|---|---|---|
| 角色 | 开发、修改、提交、推送 | 只读检查、macOS 测试、结构化报告 |
| 仓库 | `D:\work\apple-automation` | `/Users/admin/Desktop/Apple-AutoMation` |
| 分支 | `codex/ruyipage-risk-reduction` | 与 Windows fast-forward 到相同 SHA |
| SSH | 别名 `mac-codex` | `admin@192.168.249.148` |
| 系统 | Windows | macOS 15.6.1, Intel `x86_64` |
| Codex | Windows Codex | `/Users/admin/.local/bin/codex`, CLI 0.144.3 |

Mac 已有 Xcode 26.1、Swift 6.2.1、Python 3.12.10、Firefox 和隔离环境
`.runtime/ruyipage-venv`（ruyiPage 1.2.45）。项目 bootstrap 会安装本地 Node
22.14.0 到 `.runtime/node`，不依赖 Homebrew。

## 2. Mac 开启 SSH

在 Mac 本机终端执行：

```bash
sudo systemsetup -setremotelogin on
sudo ssh-keygen -A
sudo systemsetup -getremotelogin
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
nc -vz 127.0.0.1 22
```

预期：`Remote Login: On`，主机 ED25519 指纹可见，本机 22 端口连接成功。

Windows 创建专用密钥时使用：

```powershell
ssh-keygen -t ed25519 -a 100 -f $HOME\.ssh\codex_mac_ed25519 -C windows-codex-to-mac
```

把 Windows 公钥内容作为单独一行写入 Mac 的
`/Users/admin/.ssh/authorized_keys`。当前网络可限制来源为 Windows VMnet8 地址：

```text
restrict,from="192.168.249.1/32" ssh-ed25519 <WINDOWS_PUBLIC_KEY> windows-codex-to-mac
```

然后在 Mac 执行：

```bash
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
ssh-keygen -lf "$HOME/.ssh/authorized_keys"
```

Windows 的 `$HOME\.ssh\config` 使用以下结构：

```sshconfig
Host mac-codex
    HostName 192.168.249.148
    User admin
    IdentityFile C:/Users/hasee/.ssh/codex_mac_ed25519
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking yes
    UserKnownHostsFile C:/Users/hasee/.ssh/known_hosts_mac_codex
    HostKeyAlias mac-codex
    HostKeyAlgorithms ssh-ed25519
```

先在可信局域网内当面核对 Mac 显示的主机指纹，再写入专用 known-hosts 文件。测试：

```powershell
ssh mac-codex 'printf SSH_OK'
ssh -G mac-codex | Select-String '^(hostname|user|identityfile|stricthostkeychecking) '
```

## 3. SSH 改为仅密钥登录

这一步需要在 Mac 本机输入一次 `admin` 的管理员密码，不能从无人值守 Windows 会话
安全代输。确认密钥登录已经成功后，在 Mac 本机执行：

```bash
sudo /usr/bin/install -d -o root -g wheel -m 0755 /etc/ssh/sshd_config.d
printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PubkeyAuthentication yes' \
  | sudo /usr/bin/tee /etc/ssh/sshd_config.d/100-codex-key-only.conf >/dev/null
sudo /usr/sbin/chown root:wheel /etc/ssh/sshd_config.d/100-codex-key-only.conf
sudo /bin/chmod 0644 /etc/ssh/sshd_config.d/100-codex-key-only.conf
sudo /usr/sbin/sshd -t
sudo /bin/launchctl kickstart -k system/com.openssh.sshd
```

保持当前 Mac 终端不要关闭，从 Windows 新开终端复测 `ssh mac-codex`。确认密钥仍可登录
后再结束旧会话。Windows 可用 `ssh -G mac-codex` 查看客户端配置；服务端生效值需在
Mac 用 `sudo /usr/sbin/sshd -T` 核对。

## 4. Mac Codex CLI 与 PATH

Intel Mac 使用 OpenAI 官方 release 的 `x86_64-apple-darwin` 包。下载后先核对 release
提供的 SHA-256，再核对 Apple Developer ID 签名，然后安装到用户目录：

```bash
mkdir -p "$HOME/.local/bin"
install -m 0755 <VERIFIED_CODEX_BINARY> "$HOME/.local/bin/codex"
line='export PATH="$HOME/.local/bin:$PATH"'
touch "$HOME/.zprofile" "$HOME/.zshenv"
grep -Fqx "$line" "$HOME/.zprofile" || printf '%s\n' "$line" >> "$HOME/.zprofile"
grep -Fqx "$line" "$HOME/.zshenv" || printf '%s\n' "$line" >> "$HOME/.zshenv"
chmod 600 "$HOME/.zshenv"
"$HOME/.local/bin/codex" --version
```

自动化仍使用绝对路径 `/Users/admin/.local/bin/codex`；`.zprofile` 服务交互登录终端，
`.zshenv` 让非交互 SSH 的 zsh 也能直接解析短命令 `codex`。

登录 API Key 时不要把密钥放进命令历史：

```bash
read -s "CODEX_API_KEY?Codex API Key: "
printf '\n'
printf '%s' "$CODEX_API_KEY" | "$HOME/.local/bin/codex" login --with-api-key
unset CODEX_API_KEY
"$HOME/.local/bin/codex" login status
```

## 5. 对齐 Windows 与 Mac Codex 配置

Windows 与 Mac 当前统一使用以下非秘密设置：

```toml
model = "gpt-5.6-sol"
model_provider = "codex_local_access"
model_reasoning_effort = "xhigh"
service_tier = "priority"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_catalog_json = "/Users/admin/.codex/cockpit-provider-model-catalog.json"

[model_providers.codex_local_access]
name = "ai.mypic.qzz.io"
base_url = "https://ai.mypic.qzz.io/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Mac 的常规配置放在 `~/.codex/config.toml`。无人值守测试配置放在
`~/.codex/automation.config.toml`，并在上述内容后增加：

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[shell_environment_policy]
include_only = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR"]
```

设置权限：

```bash
chmod 700 "$HOME/.codex"
chmod 600 "$HOME/.codex/config.toml"
chmod 600 "$HOME/.codex/automation.config.toml"
chmod 600 "$HOME/.codex/auth.json"
```

从 Windows 同步模型目录，不包含认证信息：

```powershell
scp $HOME\.codex\cockpit-provider-model-catalog.json `
  mac-codex:/Users/admin/.codex/cockpit-provider-model-catalog.json
```

用两端 SHA-256 确认文件一致。`service_tier = "priority"` 对齐请求服务档位；实际每分钟
请求数、并发和吞吐上限仍由 `base_url` 对应供应商的账号配额决定，Codex 本地配置无法
越过服务端限流。

## 6. Mac 项目基础环境

Windows 修复 Intel Node 映射并推送后，在 Mac 仓库执行普通 Bash bootstrap：

```bash
cd /Users/admin/Desktop/Apple-AutoMation
/bin/bash -lc 'source scripts/bootstrap-macos.sh; bootstrap_macos_runtime'
.runtime/node/bin/node --version
.runtime/node/bin/npm --version
.runtime/ruyipage-venv/bin/python --version
.runtime/ruyipage-venv/bin/python -c 'import importlib.metadata as m; print(m.version("ruyipage"))'
```

这里调用 `bootstrap_macos_runtime`，只安装项目本地 Node，不触发系统 Python 的 sudo
安装。完整首次安装仍使用 `./install.sh`，并在 Mac 本机按提示输入管理员密码和处理
macOS 权限。

辅助功能、屏幕录制以及“自动化 -> 系统设置”属于 macOS TCC 权限，必须在实际运行
终端应用的 Mac 图形界面中授权；SSH 和 `sudo` 不能可靠代替用户完成这些授权。

## 7. 在 Apple-AutoMation 的 Codex 任务中使用

从 Windows 打开 `D:\work\apple-automation` 作为任务根目录。根目录 `AGENTS.md` 会让
Codex 自动知道：Windows 改代码，Mac 只检查和测试，浏览器自动化只用 ruyiPage。

第一次测试前，在 Windows 完成：

```powershell
git status --short
npm.cmd run test:mac-codex
git add <本轮文件>
git commit -m "<本轮提交说明>"
git push origin codex/ruyipage-risk-reduction
git status --short
```

调度器要求 Windows worktree clean，确保 Mac 测到的是刚推送的精确提交。然后在任务
会话里直接要求 Codex 执行，或手工运行：

```powershell
npm.cmd run -s mac:codex -- --task "识别当前 macOS 环境，运行与本次修改相关的非交互测试，并给出结构化结论"
```

长任务避免 PowerShell 多层引号，写入 UTF-8 文本后运行：

```powershell
npm.cmd run -s mac:codex -- --task-file .\mac-test-task.txt --round 1
```

调度器会：

1. 检查 Windows 仓库 clean、读取当前分支和 HEAD。
2. 通过 SSH 要求 Mac 仓库 clean。
3. 在 Mac 执行 `fetch`、`switch`、`merge --ff-only` 并核对相同 SHA。
4. 以 `/Users/admin/.local/bin/codex exec -p automation` 启动 Mac Codex。
5. Mac Codex 说明任务理解和环境识别，运行相关非交互测试。
6. 下载全部产物到 Windows 并输出一行 JSON 摘要。

## 8. 阅读测试结果

Windows 产物目录：

```text
%LOCALAPPDATA%\CodexOrchestrator\runs\<runId>\mac\round-XX\
```

关键文件：

| 文件 | 用途 |
|---|---|
| `summary.json` | Windows 汇总状态、错误、事件统计、Git 前后状态和全部产物路径 |
| `final.json` | Mac 模型的任务理解、环境观察、命令、测试、发现和 Windows 建议 |
| `events.jsonl` | Codex 原始 JSONL 执行事件 |
| `stderr.log` | Codex/工具标准错误 |
| `codex-exit.txt` | Mac Codex 退出码 |
| `git-before.txt`, `git-after.txt` | Mac 执行前后工作区状态 |
| `head-before.txt`, `head-after.txt` | Mac 执行前后提交 SHA |

只有以下条件同时满足，顶层 `status` 才是 `passed`：SSH 和 scp 成功、Codex 退出 0、
JSONL 与 `final.json` 有效、报告状态通过、Mac Git 状态和 HEAD 未变化。

## 9. Windows 修复 -> Mac 重测循环

1. Windows Codex 读取 `final.json` 中的失败测试、findings 和
   `recommendedWindowsActions`。
2. 只在 Windows 修改；运行 Windows 可执行的覆盖测试。
3. 审查 diff，提交并推送当前分支。
4. 再运行调度器，使用 `--round 2` 标记第二轮；后续依次增加。
5. 比较各轮 `summary.json` 和 `final.json`，直到 Mac 返回 `passed`。

示例：

```powershell
npm.cmd run -s mac:codex -- --task-file .\mac-test-task.txt --round 2
```

每次命令会生成新的 `runId`；`round-XX` 用于标记该命令所属的修复轮次。Windows Codex
应把上一轮 `final.json` 的路径和本轮修改目标写进新任务，但不要粘贴秘密或整份原始日志。

## 10. 默认允许与禁止的测试

适合无人值守执行：

- `npm run check`
- `npm run test:python-bootstrap`
- `npm run test:release-copy-paths`
- ruyiPage/协议/sidecar/辅助功能 helper 的纯单元测试
- Swift helper 的 `xcrun swiftc -typecheck`

默认禁止：

- `npm run test:2fa-allow` 的人工模式
- 真实 Apple ID 登录、真实 2FA 和 `./run.sh` 账号流程
- 需要用户点击 macOS 权限弹窗或 GUI 确认的测试
- 任何会修改、提交或推送 Mac 仓库的操作

## 11. 常见故障

### SSH 连接失败

```powershell
Test-NetConnection 192.168.249.148 -Port 22
ssh -vv mac-codex 'printf SSH_OK'
```

检查 Mac Remote Login、IP、VMnet8 网络、Windows 防火墙、专用 key 和 known-hosts。

### SSH 中找不到 codex

非登录 SSH 不一定读取 `.zprofile`。自动化已经使用绝对路径；手工测试也执行：

```powershell
ssh mac-codex '/Users/admin/.local/bin/codex --version'
```

### Mac repository is not clean

调度器不会强制覆盖。登录 Mac，执行 `git status --short`，逐项判断文件来源；不要使用
`git clean` 或批量删除。处理完并保持 clean 后重试。

### Mac HEAD does not match the Windows HEAD

确认 Windows 提交已经推送到当前分支，Mac remote 可访问该私有分支，并且没有分叉。
调度器只允许 fast-forward，不会 reset。

### Codex 失败但 SSH 成功

查看 `codex-exit.txt`、`stderr.log`、`events.jsonl` 和 `final.json`。先区分配置/schema
错误、模型供应商限流、测试失败和超时，再在 Windows 修复或缩小测试任务。

### macOS GUI/TCC 权限失败

在 Mac 图形界面打开“系统设置 -> 隐私与安全性”，为实际运行命令的终端应用授予需要的
辅助功能、屏幕录制和自动化权限。授权后按系统提示彻底退出并重新打开终端，再测试。

## 12. 一次完整验收清单

```powershell
ssh mac-codex '/Users/admin/.local/bin/codex --version'
npm.cmd run test:python-bootstrap
npm.cmd run test:mac-codex
git diff --check
```

提交、推送后执行：

```powershell
npm.cmd run -s mac:codex -- --task "核对两端 HEAD，识别 Mac 环境，执行当前改动所需的非交互测试，并返回结构化报告"
```

验收 `summary.json`：顶层状态通过、Codex exit 0、JSONL 无非法行、Mac Git 未变化、
`final.json` 包含任务理解、环境识别、每条命令退出码、测试结果和 Windows 后续建议。
