# Windows -> Mac Codex 测试编排设计

## 目标

把 `admin@MacBook-Pro` 作为 Windows Codex 的独立 macOS 测试执行机。Windows
负责开发和修复；Mac Codex 负责理解任务、识别环境、执行非交互检查与测试，并把
完整、可审计的结果回传给 Windows，供下一轮修改和重测使用。

## 已知环境

- Windows SSH 别名：`mac-codex`，目标 `admin@192.168.249.148`。
- Mac 仓库：`/Users/admin/Desktop/Apple-AutoMation`。
- Mac Codex：`/Users/admin/.local/bin/codex`，版本 `0.144.3`。
- Mac Codex 自动化 profile：`automation`，来自
  `/Users/admin/.codex/automation.config.toml`。
- Windows 和 Mac 使用相同的模型、provider、推理强度、service tier、上下文和
  Responses API 配置；Mac 调度必须显式传入 `-p automation`。
- Mac 是 Intel `x86_64`；Node 官方产物架构名必须映射为 `x64`。

## 架构

新增一个 Windows 侧 Node.js 调度器。Node 负责参数解析、UTF-8/Base64 prompt
封装、无交互 SSH、远端仓库同步、Mac Codex 调用、超时、产物下载和结果汇总。
选择 Node 而不是 PowerShell 拼接远端命令，是为了消除 PowerShell/zsh 多层引号和
中文编码的不稳定性，并复用本项目现有 Node 测试方式。

Mac Codex 默认只做检查和测试，不修改源码。Windows 工作区必须先提交并推送；调度器
再要求 Mac 仓库 clean，执行 `git fetch`、`git switch` 和 `git merge --ff-only`，并
核对 Mac HEAD 与 Windows HEAD 完全一致。禁止使用 `git reset --hard`、`git clean` 或
批量删除。

## 调用接口

项目提供：

```powershell
npm.cmd run -s mac:codex -- --task "检查当前改动并运行相关 macOS 测试"
```

长任务可写入普通 UTF-8 文本，再使用 `--task-file <path>`。可选参数包括
`--round`、`--timeout-ms`、`--ssh-alias`、`--remote-repo` 和 `--no-sync`。
`--no-sync` 只用于已经确认两端 HEAD 相同的诊断场景。

## Mac Codex 行为合同

调度器生成固定系统化 prompt，要求 Mac Codex：

1. 先说明对任务的理解和识别到的环境。
2. 读取仓库指令；Apple-AutoMation 的浏览器操作只能使用 ruyiPage。
3. 不读取或输出 `.env`、Codex auth、API Key、GitHub PAT 等秘密。
4. 不修改、提交或推送源码；只执行与任务相关的非交互测试。
5. 不自动执行人工 2FA、真实账号流程或需要 GUI 人工确认的测试。
6. 对每条命令记录目的、退出码和关键结果。
7. 最终输出符合仓库内 JSON Schema 的结构化报告。

## 产物与回传

每次运行使用唯一 `runId` 和轮次目录。Mac 原始产物保存在
`~/.codex-orchestrator/runs/<runId>/mac/round-XX`，并通过 `scp` 下载到 Windows
`%LOCALAPPDATA%/CodexOrchestrator/runs/<runId>/mac/round-XX`。

至少包含：

- `events.jsonl`：Codex JSONL 事件流。
- `stderr.log`：Codex 标准错误。
- `final.json`：结构化最终报告。
- `git-before.txt` / `git-after.txt`：执行前后状态。
- `head-before.txt` / `head-after.txt`：执行前后提交。
- `codex-exit.txt`：Codex 退出码。
- Windows 生成的 `summary.json`：事件统计、Git 是否变化、报告内容和全部路径。

调度器 stdout 只输出最终 JSON 摘要，进度写入 stderr，使 Windows Codex 能稳定读取。
以下任一条件都视为失败：SSH/scp 失败、同步失败、Mac HEAD 不匹配、Codex 非零退出、
`final.json` 缺失或无效、Mac Git 状态发生变化、最终报告不是 `passed`。

## 配置与安全边界

- SSH 继续使用固定 ED25519 主机指纹、专用密钥和来源限制。
- Codex 使用 `approval_policy = "never"`、`sandbox_mode = "workspace-write"`、
  `web_search = "disabled"`，模型 shell 网络关闭。
- Git 同步由调度器在 Codex 外完成；Codex 本身不得访问网络。
- 自动化调用使用绝对 Codex 路径，不能依赖非登录 SSH 的 PATH。
- 任务文本和日志不得包含秘密；文档不记录任何真实密钥。

## 验收

1. Intel Node 映射回归测试先红后绿，`x86_64 -> x64`。
2. Windows 单元测试覆盖参数、prompt、shell 引用、事件汇总和失败判定。
3. Windows 当前提交推送后，Mac 以 fast-forward 同步到同一 SHA。
4. Mac 本地 Node 22.14.0 安装成功。
5. Mac Codex smoke 返回结构化任务理解、环境识别、命令和测试结果。
6. Mac 运行相关非交互测试，Git 前后保持 clean。
7. 至少三路只读审查通过；发现问题则修改、重测并重新审查。
