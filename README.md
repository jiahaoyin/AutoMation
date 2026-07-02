# Apple ID Automation (macOS)

在 **macOS 15 Sequoia** 上自动化完成 Apple ID 登录与信息采集：

1. **系统设置** → Apple Account 自动填表（手机验证码人工）
2. **Firefox** + WebDriver BiDi → `account.apple.com` 登录与 2FA
3. 采集**姓名、生日**，输出报告与截图

与 [ChromeTest](https://github.com) 探针项目**完全独立**，本仓库单独维护。

## 快速开始

```bash
./install.sh    # Node 检测、辅助功能授权引导
./run.sh        # 终端输入账号密码 → 自动备份 .env → 执行流程
```

## 环境

- macOS 15（推荐）
- Node.js 18+（[nodejs.org](https://nodejs.org) 或 `install.sh` 下载官方包）
- Firefox（[mozilla.org/firefox](https://www.mozilla.org/firefox/)）
- 终端「辅助功能」权限（`install.sh` 会引导）

## 命令

| 命令 | 说明 |
|------|------|
| `./install.sh` | 环境安装与辅助功能检测 |
| `./run.sh` | 完整流程 |
| `./run.sh --skip-mac` | 仅浏览器 |
| `./run.sh --skip-browser` | 仅系统设置 |
| `npm run check` | 环境自检 |
| `npm run package` | 打包 `dist/apple-id-automation-{version}-macos.zip` |

## 文档

- **[docs/PROJECT.md](docs/PROJECT.md)** — 架构、文件说明、故障排查（新会话必读）

## 安全

- `.env` 含账号密码，**勿提交 git**
- `data/` 含 Firefox Profile 与报告，注意保管

## 版本

当前 `package.json` 版本即发布版本；`npm run package` 默认 patch +1 后打包。
