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
```

macOS 测试机拉取新版本后建议依次运行：

```bash
./install.sh
npm run check
npm run test:python-bootstrap
./run.sh
```

## 安全

- `.env` 含账号密码，**勿提交 git**
- `data/` 含 Firefox Profile 与报告，注意保管

## 版本

当前 `package.json` 版本即发布版本；`npm run release` 默认 patch +1 后上传 GitHub Releases。
