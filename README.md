# Apple-AutoMation（macOS）

> 先核验 Apple Developer 会员状态，再进入 Apple Account 个人信息采集的 macOS 自动化流程。

项目把浏览器动作统一交给 **Python ruyiPage**：Firefox 启动、标签页、导航、页面读取、BiDi 输入、2FA 网页交接和截图都没有第二套浏览器后端。Node 只负责流程编排、脱敏 JSONL 审计、报告与 macOS 2FA provider 生命周期。

## 当前流程

~~~mermaid
flowchart TD
    A[可选：macOS 系统设置登录] --> B[初始 Firefox 标签页]
    B --> C[Apple Developer 登录与 2FA]
    C --> D{会员状态}
    D -->|active| E[打开会员资格详情]
    E --> F[保存 03-developer-membership.png]
    D -->|not_enrolled / unknown| G[记录固定会员结果]
    F --> H{DEVELOPER_MEMBERSHIP_GATE}
    G --> H
    H -->|0：测试默认| I[新建 Account 标签页]
    H -->|1 且 active| I
    H -->|1 且非 active| J[正常 gate stop：不进入 Account]
    I --> K[Apple Account 登录与共享 2FA]
    K --> L[个人信息页 /section/information]
    L --> M[保存 02-account-information.png]
    M --> N[私有 .env 写入 name、birthday]
~~~

## 快速开始

~~~bash
# 首次或 native helper 更新后执行
./install.sh

# 完整流程：系统设置 + Developer-first 浏览器模块
./run.sh

# 常用浏览器验证：跳过 macOS 系统设置阶段
./run.sh --skip-mac
~~~

**./install.sh** 会检查/准备 Node、Python、项目内 **.runtime/ruyipage-venv**、Firefox 前置条件以及 native helper。若缺少 Python 3.10+，安装器会验证官方 Python 包的固定 SHA-256 和签名后再继续。日常 **./run.sh** 不会重复请求安装授权。

浏览器阶段需要实际运行主体拥有：

- **辅助功能**：Apple popup 与 System Settings AX helper；
- **屏幕与系统音频录制**：Vision OCR 自动读验证码的硬门槛；
- **自动化**：仅完整 macOS 系统设置登录阶段需要；**./run.sh --skip-mac** 不需要该权限。

## 运行模式

| 目标 | 命令 / 配置 | 结果 |
| --- | --- | --- |
| 默认测试 | **DEVELOPER_MEMBERSHIP_GATE=0** | 无论 Developer 为 **active**、**not_enrolled**、**unknown**，或 Developer 模块给出固定 partial，都会继续 Account。 |
| 业务 gate | **DEVELOPER_MEMBERSHIP_GATE=1** | 只有 **active** 才新建 Account 标签页；其余结果作为成功的 gate stop 结束。 |
| 浏览器单独验证 | **./run.sh --skip-mac** | 不进入 macOS 系统设置；仍执行 Developer-first 与 Account 模块。 |
| 系统设置单独验证 | **./run.sh --skip-browser** | 不启动 Firefox / ruyiPage。 |
| 终端诊断镜像 | **APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac** | 终端额外显示脱敏固定状态；该开关只接受 shell/export，不从 .env 读取。 |

> **DEVELOPER_MEMBERSHIP_GATE=1** 的正常 gate stop **不是 Account 登录失败**。它会记录会员结果、保留 Developer 页面（及已生成的详情截图），并让 Account 模块显示为 **skipped**；因此不会写 Account home acceptance marker。

## 会员与截图契约

| Developer 内部状态 | 私有 .env 值 | 后续行为 | 截图 |
| --- | --- | --- | --- |
| **active** | **developer_membership=已加入** | 可进入 Account；gate=1 时允许进入。 | 详情页确认后保存 **screenshots/03-developer-membership.png**。 |
| **not_enrolled** | **developer_membership=未加入** | gate=0 继续 Account；gate=1 正常跳过 Account。 | 不生成会员详情截图。 |
| **unknown** / Developer 固定失败 | **developer_membership=未确认** | gate=0 继续 Account；gate=1 正常跳过 Account。 | 不生成会员详情截图。 |

Account 模块只在个人信息页面稳定后访问：

~~~text
https://account.apple.com/account/manage/section/information
~~~

它先读取生日，再打开姓名弹窗读取名与姓；姓名的显示与落盘遵循 **名在前、姓在后**。页面就绪后保存唯一个人信息截图：

~~~text
screenshots/02-account-information.png
~~~

**name**、**birthday** 与 **developer_membership** 只写入本机私有 .env；报告与 JSONL 只保留固定状态、布尔值、分类和截图文件名，不保存账号、密码、验证码、Cookie、原始页面文本或个人资料值。

## 2FA 运行原则

1. 密码提交前，ruyiPage 先与 Node 完成 **prepare_2fa** 握手。
2. Apple popup 的 AX 读取优先；同一可信窗口上才允许内存 Vision OCR 回退。
3. popup 主窗口到期后才串行进入 System Settings；Settings 最多两次。
4. Settings 结束且超过最小等待窗口后，真实 TTY 才允许隐藏手输。
5. 有效验证码立即交给 ruyiPage；后续来源不再竞争。网页只允许明确的 invalid/expired/rejected 状态触发第二代验证码。

终端、**report.json**、**flow-audit.jsonl**、**2fa-audit.jsonl**、截图和错误文本都不会输出 OTP。完整手接链路见 [2FA 交接诊断](docs/2FA_HANDOFF_DIAGNOSTICS.md)。

## macOS 设置动态验证

这部分只在未使用 `--skip-mac` 的受监督 macOS 会话中运行。浏览器 2FA 与
System Settings SMS 是两条独立链路，后者不复用浏览器验证码。

1. 短信接收号码页是可选的：出现时只匹配已配置号码末两位，并以最多三次
   已绑定动作处理。没有号码页时直接继续扫描。
2. 六位验证码页是必经页：连续两次识别到稳定的空六码输入格后，才开始轮询
   provider 并写入验证码。同一已验证验证码只会在页面重新确认为空时最多重试三次；
   写入后必须先看到 `code_pending` 消失，再得到两次 `waiting` 观察，才会进入后置
   页面扫描。
3. provider 默认使用普通浏览器兼容请求头、同源重定向与内存 Cookie 会话；单次请求
   最多保持 20 秒，随后继续轮询。返回 JSON、HTML 表格/列表和页面内
   `application/json` 状态均可解析；多个匹配记录按可解析时间字段选择最新一条。
   请求 URL、Cookie、号码和验证码不会写入终端或审计日志。
4. 验证码页刚消失后，后置扫描会保留一个最长 90 秒的初始观察窗口；在这段时间内
   即使登录态探测已经为真，也会继续等待动态条款、定位等页面实际出现。AX 短暂空白、
   hydration 和网络慢加载只会延长观察，不会被当作已登录。
   自动动作达到三次仍未推进时，终端保留当前页面并提示人工完成。
   人工按 Enter 仅恢复观察，不重置同一页面的自动动作额度。
5. 后置页面按实际出现顺序处理。条款和定位页只会在可信 PID/window 绑定下
   自动提交；Mac 密码和 iPhone 解锁页始终保留给人工输入。每次成功点击后有
   转场宽限窗口，避免慢页面重复点击。

### 设置阶段日志

终端只显示当前业务进度。完整的脱敏诊断写入 `flow-audit.jsonl` 的
`source=mac_settings` 条目，字段只包含固定 `event`、`stage`、`phase`、次数、
超时、布尔状态，以及受限的 PID/window 数字。不会记录号码、验证码、Apple ID、
密码、原始 AX/OCR 或页面文本。

关键收口事件如下：

~~~text
sms_provider_config_failed     -> failureCode
sms_module_failed              -> failureCode
mac_settings_login_wait_failed -> failureCode
~~~

`failureCode` 仅会是固定的 `mac_settings_*` 分类；结合同一 run 的前序事件就能
定位在 provider 配置、短信状态/写码，还是后置页面/最终登录确认。反馈问题时提供
对应 run 的 `flow-audit.jsonl`、`launcher-audit.jsonl`、`report.json`，不要提供
`.env`、截图正文、账号、密码或验证码。

## 运行产物与排错入口

每次运行生成同一 **runId** 对应的报告目录：

~~~text
data/reports/apple-id-flow-<timestamp>/
├── report.json
├── flow-audit.jsonl
├── 2fa-audit.jsonl              # 浏览器请求过 2FA 时存在
├── launcher-audit.jsonl
└── screenshots/
    ├── 03-developer-membership.png  # 仅 active
    └── 02-account-information.png   # 仅个人信息页稳定后
~~~

| 现象 | 首选证据 | 首先确认什么 |
| --- | --- | --- |
| Developer 未完成 | **flow-audit.jsonl** | **developer_account_***、**developer_membership_checked** 或 **developer_account_failed**。 |
| 被 gate 正常停止 | **flow-audit.jsonl** + **report.json** 固定字段 | **developer_membership_gate_blocked**、**accountModule.skipped=true**。 |
| Account 没有新标签页 | **flow-audit.jsonl** | **account_module_started**、**account_module_tab_created**。 |
| 登录成功但资料采集 partial | **flow-audit.jsonl** | **account_home_confirmed** 后的 **profile_capture_*** 固定阶段。 |
| 未生成个人信息截图 | **flow-audit.jsonl** | 先检查个人信息页是否真正 ready，勿把认证页当截图目标。 |
| 2FA 取到码但网页未确认 | **2fa-audit.jsonl** + **flow-audit.jsonl** | **target_resolved → input_completed → submit_sent → transition_confirmed**。 |

请只在本机核对 .env 和截图；需要反馈时优先提供脱敏 JSONL 固定状态，不上传账号、密码、OTP、Cookie、完整个人信息截图或 URL query。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| **./install.sh** | 安装/更新项目运行环境与 native helper。 |
| **./run.sh** | 完整系统设置 + Developer-first + Account 流程。 |
| **./run.sh --skip-mac** | 跳过 macOS 系统设置，执行浏览器两个模块。 |
| **npm run check** | 环境自检。 |
| **npm run test:account-browser-flow** | Node 浏览器编排、会员持久化、gate 与报告契约。 |
| **npm run test:ruyipage-protocol** | JSONL 协议契约。 |
| **npm run test:ruyipage-flow** | Python ruyiPage 流程回归。 |
| **npm run test:flow-audit** | 脱敏审计格式回归。 |
| **npm run test:release-copy-paths** | 分发包与文档合同回归。 |
| **npm run package** | 本地构建 macOS 分发包。 |

## 配置速查

~~~bash
BROWSER_BACKEND=ruyipage
BROWSER_PROFILE_MODE=persistent     # persistent | fresh
RUYIPAGE_BACKEND_TIMEOUT_MS=720000
BROWSER_PRESERVE_ON_FAILURE=1
BROWSER_PRESERVE_ON_SUCCESS=1
DEVELOPER_MEMBERSHIP_GATE=0         # 测试默认；业务 gate 设为 1
BROWSER_2FA_SETTINGS_AFTER_MS=30000
BROWSER_2FA_SETTINGS_FALLBACK=1
BROWSER_2FA_MANUAL_FALLBACK=1
BROWSER_2FA_POLL_MS=800
# Mac 系统设置：SMS 与后置动态接续默认开启；1=开启，0=关闭。
# 只有需要关闭时才在 .env 中写入：
# APPLE_AUTOMATION_SMS_ENABLED=0
# APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=0
APPLE_AUTOMATION_SMS_RECONFIGURE=0 # 1=重新录入号码与服务地址；0=沿用已有配置
~~~

旧 `.env` 中已有的这两个 `=0` 会继续按明确关闭处理；删除对应行或改为 `1` 即恢复默认开启。

切换账号时优先用 **BROWSER_PROFILE_MODE=fresh**；连续调试同一会话时可使用默认 persistent profile。**BROWSER_ATTACH_EXISTING=1** 可接管已有 Firefox 会话，但执行顺序仍然是 Developer 判定在前、Account 资料采集在后。

## 文档索引

- [运行手册](docs/RUNTIME_RUNBOOK.md) — 当前流程、状态机、日志、gate、人工验收与故障矩阵。
- [项目参考](docs/PROJECT.md) — 架构、模块边界、数据与测试契约。
- [2FA 交接诊断](docs/2FA_HANDOFF_DIAGNOSTICS.md) — OTP 获取到网页提交的固定检查点。
- [Mac 交接](docs/MAC_CODEX_HANDOFF.md) — Mac verify/implementation 双模式与安全证据反馈。
- [Windows → Mac 调度](docs/WINDOWS_MAC_CODEX.md) — 精确 SHA 同步、受监督 GUI 与证据回传。

## 安全与发布

- .env、data/、.runtime/、dist/ 不提交 Git；data/ 含 Firefox profile、私有报告和截图。
- 不在 JS 中合成敏感输入事件；浏览器敏感输入只走 ruyiPage BiDi。
- 认证失败不保存认证页全页截图；Vision 只在内存处理，不落临时 OCR 图片。
- 发布分发包使用 **npm run package**；其他 Mac 使用 **./install.sh && ./run.sh**。
# Mac collaboration note (2026-08-02)

Mac is supported for controlled implementation and browser annotation through
`npm.cmd run -s mac:codex -- --mac-mode implementation ...`; the default mode remains read-only
verification for compatibility.
