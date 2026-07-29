#!/usr/bin/env node
/**
 * 打包 Apple ID 自动化流程为可分发目录 + zip（适用于其他 macOS 机器测试）
 *
 * 用法:
 *   node scripts/build-release.mjs [--no-bump] [--upload] [--clean]
 *   npm run release          # patch+1 → 打包 → 上传 GitHub Release → 清理本地 dist
 *   npm run package          # 仅本地打包（保留 dist）
 *
 * 默认打包前自动 patch +1（1.0.0 → 1.0.1）；--no-bump 跳过递增
 * --upload  创建/更新 GitHub Release 并上传 zip（需 gh CLI）
 * --clean   上传后删除本地 dist 目录与 zip（常与 --upload 联用）
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpPatchVersion, readPkgVersion, writePkgVersion } from "./bump-patch-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
let VERSION = null;
let RELEASE_NAME = null;
let OUT_DIR = null;
let ZIP_PATH = null;
let uploadRelease = false;
let cleanLocal = false;

/** @type {string[]} 相对仓库根目录 */
export const COPY_PATHS = [
  "scripts/apple-id-full-flow.mjs",
  "scripts/mac-settings-apple-login.applescript",
  "scripts/mac-settings-ui-dump.applescript",
  "scripts/mac-settings-signed-in.applescript",
  "scripts/swift/mac-settings-ax-fill.swift",
  "scripts/swift/mac-settings-sms-verification.swift",
  "scripts/swift/mac-settings-post-sms-finalization.swift",
  "scripts/swift/mac-settings-2fa-code.swift",
  "scripts/swift/mac-2fa-click-allow.swift",
  "scripts/swift/mac-2fa-popup-read.swift",
  "scripts/swift/mac-2fa-popup-ocr.swift",
  "scripts/fill-debug.mjs",
  "scripts/lib/mac-settings-ax-fill.js",
  "scripts/lib/mac-settings-sms-ax.js",
  "scripts/lib/mac-settings-sms-verification.js",
  "scripts/lib/mac-settings-post-sms-finalization-ax.js",
  "scripts/lib/mac-settings-post-sms-finalization.js",
  "scripts/lib/mac-settings-sms-provider.js",
  "scripts/lib/mac-settings-2fa.js",
  "scripts/lib/browser-backend.js",
  "scripts/lib/firefox-runtime.js",
  "scripts/lib/mac-settings-login.js",
  "scripts/lib/account-browser-flow.js",
  "scripts/lib/flow-audit.js",
  "scripts/lib/credentials.js",
  "scripts/lib/prompt.js",
  "scripts/lib/ruyipage-backend-runner.js",
  "scripts/lib/ruyipage-runtime.js",
  "scripts/lib/two-fa-sidecar.js",
  "scripts/lib/2fa-audit.js",
  "scripts/lib/mac-2fa-allow.js",
  "scripts/lib/mac-2fa-ocr.js",
  "scripts/lib/mac-2fa-popup.js",
  "scripts/lib/native-helper-path.js",
  "scripts/lib/manual-verification-prompt.js",
  "scripts/lib/manual-2fa-prompt.js",
  "scripts/lib/report.js",
  "scripts/ruyipage/apple_account_flow.py",
  "scripts/test-2fa-settings-code.mjs",
  "scripts/test-mac-settings-sms-verification.mjs",
  "scripts/test-mac-settings-sms-provider.mjs",
  "scripts/test-mac-settings-sms-provider-coordinator.mjs",
  "scripts/test-mac-settings-sms-provider-config.mjs",
  "scripts/test-mac-settings-post-sms-finalization.mjs",
  "scripts/check-environment.mjs",
  "scripts/setup-environment.mjs",
  "scripts/preflight-2fa-permissions.mjs",
  "scripts/bootstrap-macos.sh",
  "scripts/lib/env-setup.js",
  "scripts/lib/macos.js",
  "scripts/bump-patch-version.mjs",
  "scripts/automation-check.applescript",
  "scripts/lib/accessibility.js",
];

function normalizeRelPath(relPath) {
  return relPath.replace(/\\/g, "/");
}

function resolveRelativeImport(importerRel, specifier) {
  const importerDir = path.dirname(importerRel);
  const candidate = normalizeRelPath(path.normalize(path.join(importerDir, specifier)));
  const candidates = path.extname(candidate)
    ? [candidate]
    : [`${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, `${candidate}/index.js`];

  return candidates.find((rel) => fs.existsSync(path.join(ROOT, rel))) ?? candidate;
}

/** 从入口脚本递归收集 runtime 相对 import，打包前校验 COPY_PATHS 无遗漏 */
export function collectRuntimeImports(entryRelPaths) {
  const runtimeFiles = new Set();
  const scanned = new Set();
  const queue = entryRelPaths.map(normalizeRelPath);
  const importRe =
    /(?:from\s+["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["'])/g;

  while (queue.length) {
    const rel = normalizeRelPath(queue.pop());
    if (scanned.has(rel)) continue;
    scanned.add(rel);

    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !/\.(?:js|mjs)$/i.test(rel)) continue;

    const src = fs.readFileSync(abs, "utf-8");
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(src))) {
      const specifier = m[1] || m[2] || m[3];
      const importedRel = resolveRelativeImport(rel, specifier);
      if (!importedRel.startsWith("scripts/")) continue;
      if (!runtimeFiles.has(importedRel)) {
        runtimeFiles.add(importedRel);
        queue.push(importedRel);
      }
    }
  }

  return runtimeFiles;
}

function validateCopyPaths() {
  const entries = [
    "scripts/apple-id-full-flow.mjs",
    "scripts/setup-environment.mjs",
    "scripts/check-environment.mjs",
  ];
  const requiredLibs = collectRuntimeImports(entries);
  const copySet = new Set(COPY_PATHS);
  const missing = [...requiredLibs].filter((p) => !copySet.has(p));

  if (missing.length) {
    console.error("COPY_PATHS 缺少以下依赖文件:");
    for (const p of missing) console.error(`  - ${p}`);
    process.exit(1);
  }

  for (const rel of COPY_PATHS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`打包源文件不存在: ${rel}`);
      process.exit(1);
    }
  }
}

function rimraf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyFile(srcRel, destRoot) {
  const src = path.join(ROOT, srcRel);
  const dest = path.join(destRoot, srcRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function buildPackageJson(destRoot) {
  const pkg = {
    name: "apple-id-automation",
    version: VERSION,
    private: true,
    description:
      "macOS 系统设置 Apple ID 登录 + ruyiPage-only account.apple.com 采集（独立分发包）",
    type: "module",
    engines: { node: ">=18" },
    scripts: {
      flow: "node scripts/apple-id-full-flow.mjs",
      "flow:browser-only": "node scripts/apple-id-full-flow.mjs --skip-mac",
      "flow:mac-only": "node scripts/apple-id-full-flow.mjs --skip-browser",
      check: "node scripts/check-environment.mjs",
      setup: "node scripts/setup-environment.mjs",
      install: "./install.sh",
      "check:automation": "osascript scripts/automation-check.applescript",
      "dump:mac-ui": "osascript scripts/mac-settings-ui-dump.applescript",
      "fill:debug": "node scripts/fill-debug.mjs",
      "test:2fa-settings": "node scripts/test-2fa-settings-code.mjs",
      "test:mac-settings-sms-verification": "node scripts/test-mac-settings-sms-verification.mjs",
      "test:mac-settings-post-sms-finalization": "node scripts/test-mac-settings-post-sms-finalization.mjs",
    },
  };
  fs.writeFileSync(
    path.join(destRoot, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n"
  );
}

function buildReadme(destRoot) {
  const readme = `# Apple ID 自动化测试包 (macOS)

版本: ${VERSION}

## 目标系统

- **macOS 15 (Sequoia)** — 系统设置 Apple Account 脚本按此版本调优
- 其他 macOS 版本可能可用，但不保证系统设置 UI 自动化正常

## 环境要求

- **macOS 15 Sequoia**（推荐 / 测试平台）
- **Node.js 18+**（[nodejs.org](https://nodejs.org) 官方安装包，或 \`./install.sh\` 自动下载官方二进制）
- **Python**：\`./install.sh\` 会自动检测 Python 3.10+；缺失时请求管理员授权，核对 Python.org Python 3.12.10 universal2 PKG 的固定 SHA-256 与 Python Software Foundation Developer ID 签名，再把 ruyiPage 安装到项目内 \`.runtime/ruyipage-venv\`
- **Firefox**（[mozilla.org/firefox](https://www.mozilla.org/firefox/) 手动安装）
- **辅助功能权限**：\`./install.sh\` 会自动检测；未授权时会请求当前运行主体的系统授权（本地通常为 Terminal / iTerm；受监督验收会提示 Codex / 原生 helper）
- **屏幕与系统音频录制**：Vision OCR 自动取码的必需权限；install.sh 会在编译 exact native helper 后请求并确认，run.sh 会在 Firefox 启动前复核。未授权时浏览器不会启动或提交账号密码

## 快速开始

\`\`\`bash
# 1. 解压后进入目录
cd apple-id-automation-${VERSION}

# 2. 立即授权并自动安装缺失的 Python/Node、ruyiPage 与辅助工具
./install.sh

# 3. 运行（终端按提示输入账号密码，自动备份至 .env）
./run.sh
\`\`\`

\`./install.sh\` 启动后会立即请求一次管理员授权；密码仅由 \`sudo\` 读取。
安装完成后的日常 \`./run.sh\` 不会再次请求管理员密码。

## 流程说明

1. **Mac 系统设置**：自动填入 Apple ID / 密码；配置 `.env` 的短信 provider 后可自动完成手机验证码，未启用时在系统界面人工完成
2. **等待**：脚本轮询直至检测到系统设置已登录
3. **Firefox**：启动、导航、页面读取、输入、截图与关闭全部由 ruyiPage 完成，不提供其他浏览器后端
4. **account.apple.com**：登录 → \`need_2fa\` 后 popup AX/OCR 优先 30 秒；确认 Allow 后再给 30 秒；无新码才串行回退到系统设置，最后才可隐藏终端手输
5. **个人信息**：精确访问 \`/account/manage/section/information\`，姓名/生日卡稳定后保存 \`02-account-information.png\`，先读取生日，再打开姓名弹窗
6. **输出**：姓名、生日写入私有 \`.env\` 的 \`name\`、\`birthday\`；完整脱敏事件写入 \`flow-audit.jsonl\`

2FA 按严格串行顺序处理：popup 主阶段拿到有效新码后会立即交给 ruyiPage，Settings 和
手输不会启动；Settings 最多两次（每次最多 60 秒、间隔 5 秒），手输只会在 Settings
有界尝试结束后且不早于首次取码 90 秒出现。两代验证码共享 240 秒期限和 Settings 总预算。
终端不显示 OTP；验证码绝不写入 audit、报告、截图或错误文本。取码后的交接阶段通过固定
状态记录，便于定位 stdin 投递、目标解析、输入、提交或登录状态确认失败。
普通终端只显示简洁业务进度；使用
\`APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac\` 可额外镜像脱敏机器协议。该开关
只接受 shell/export 运行时值，\`.env\` 中的同名项会忽略。
姓名和生日只出现在私有 \`.env\` 与直接交互终端，report/audit 仅记录落盘状态。

## 命令

| 命令 | 说明 |
|------|------|
| \`./install.sh\` | 前置管理员授权；自动安装缺失的 Python/Node、ruyiPage，并确认辅助功能与屏幕录制 |
| \`./run.sh\` | 完整流程；**终端输入**账号密码并备份至 \`.env\` |
| \`./run.sh --skip-mac\` | 跳过 Mac 设置（仅浏览器）；仍需辅助功能和屏幕录制，不要求自动化 |
| \`./run.sh --skip-browser\` | 仅 Mac 设置登录 |
| \`npm run check\` | 环境自检 |
| \`npm run check:automation\` | 检测终端对「系统设置」的自动化权限 |
| \`npm run dump:mac-ui\` | 导出系统设置 Apple Account 页 AX 树（调试） |

## 环境变量（.env）

运行 \`./run.sh\` 时会在终端提示输入，并**自动备份**到 \`.env\`（也可手动编辑）：

| 变量 | 说明 |
|------|------|
| \`APPLE_ID\` | Apple ID 邮箱 |
| \`APPLE_PASSWORD\` | 密码 |
| \`FIREFOX_EXECUTABLE\` | 可选，非默认 Firefox 路径 |
| \`FIREFOX_PROFILE_DIR\` | 可选，默认 \`./data/firefox-apple-automation\` |
| \`BROWSER_BACKEND\` | 可选，固定为 \`ruyipage\`；\`auto\` 仅作旧配置兼容别名 |
| \`RUYIPAGE_PYTHON\` | 可选，自定义 Python；默认优先项目内隔离虚拟环境 |
| \`BROWSER_PROFILE_MODE\` | 可选，\`persistent\` / \`fresh\` |
| \`BROWSER_2FA_SETTINGS_AFTER_MS\` | 可选，默认 \`30000\`；从 \`need_2fa\` 起等待 popup 主窗口，确认 Allow 后另有固定 30 秒宽限，之后才启动系统设置 |
| \`BROWSER_2FA_SETTINGS_FALLBACK\` | 可选，默认 \`1\`；设为 \`0\` 禁用系统设置取码 |
| \`BROWSER_2FA_MANUAL_FALLBACK\` | 可选，默认 \`1\`；仅在 Settings 有界尝试结束后、且不早于首次取码 90 秒时允许在真实 TTY 隐藏手输验证码 |
| \`BROWSER_2FA_POLL_MS\` | 可选，默认 \`800\`；FollowUpUI 轮询间隔 |
| \`BROWSER_PRESERVE_ON_FAILURE\` | 可选，直接运行默认 \`1\`；失败后保留 Firefox 供人工检查当前页面，设为 \`0\` 才关闭；受监督 broker 会话仍严格清理 |
| \`BROWSER_PRESERVE_ON_SUCCESS\` | 可选，默认 \`1\`；成功后保留已登录 Firefox 窗口、标签页和持久 Profile |
| \`DEVELOPER_MEMBERSHIP_GATE\` | 可选，默认 \`0\` 测试模式始终继续 Account；设为 \`1\` 时仅已加入 Developer Program 的账号继续 |
| \`APPLE_AUTOMATION_TERMINAL_DEBUG\` | shell/export 运行时开关，设为 \`1\` 时终端镜像脱敏机器协议；不从 \`.env\` 读取，完整日志始终写入 \`flow-audit.jsonl\` |
| \`name\` / \`birthday\` | 个人信息页成功采集后自动写入；不要手动放入日志或报告 |

### 系统设置短信验证

在私有 `.env` 中配置：

\`\`\`bash
APPLE_AUTOMATION_SMS_ENABLED=1
APPLE_AUTOMATION_SMS_PHONE=+8613800130051
APPLE_AUTOMATION_SMS_API_URL='https://provider.example/record?token=private'
APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1
\`\`\`

有效的完整 pair 会直接复用，不再询问。缺失、partial 或无效时，终端会重录完整 pair 并在格式校验通过后以 \`0600\` 权限原子写回 \`.env\`。设 \`APPLE_AUTOMATION_SMS_RECONFIGURE=1\` 可替换已保存 pair；成功保存后自动改回 \`0\`。设 \`APPLE_AUTOMATION_SMS_ENABLED=0\` 可保留 pair 但禁用短信自动化。验证码不会保存到 \`.env\` 或任何诊断产物。

将 \`APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1\` 打开后，短信提交后的条款、Mac 密码、iPhone 解锁和位置弹窗会使用同一受信 AX/CGWindow 绑定逐个处理：条款勾选后点“同意”，Mac 密码写入固定测试值 \`000000\`，iPhone 用 Vision 确认 4/6 格后自动填入同长度的 \`0\`，位置只点 \`action-button-2\` 的“以后”。输入只经 stdin，不写入 \`.env\`、日志、报告、参数或环境；任何识别不稳定会保留页面供人工处理。

## 故障排查

- **安装 ruyiPage 时出现 PyPI TLS 证书错误**：\`install.sh\` 始终保持 HTTPS 证书校验；仅项目管理的 macOS 虚拟环境且 pip 支持 \`truststore\` 时优先使用系统信任库，显式 \`RUYIPAGE_PYTHON\` 不承诺该行为。如处于企业代理环境，请先将代理根证书安装到 macOS 系统钥匙串，再重新执行 \`./install.sh\`。
- **辅助功能未授权**：运行 \`./install.sh\`，按 macOS 原生提示允许实际运行主体；受监督验收不是只勾选 Terminal
- **系统设置填表失败（macOS 15）**：确认已打开 Apple Account 页；辅助功能已授权 Terminal
- **邮箱未填入**：在 系统设置 → 隐私与安全性 → **自动化** 中允许 Terminal 控制「系统设置」；运行 \`npm run dump:mac-ui\` 查看 AX 树（v1.0.22 修复 tell 上下文 + 自动化预检）
- **调试 UI 结构**：\`osascript scripts/mac-settings-ui-dump.applescript\`（登录页打开后运行）
- **AppleScript 填表失败**：确认辅助功能已授权；在 Sequoia 上从侧边栏进入「Apple Account」
- **ruyiPage 不可用**：运行 \`./install.sh\`；项目会明确停止，不会回退到其他页面自动化方案
- **Firefox 启动失败**：安装 Firefox 或设置 \`FIREFOX_EXECUTABLE\`
- **屏幕录制未授权**：在「隐私与安全性 -> 屏幕与系统音频录制」允许实际运行主体；按 macOS 提示重开终端或 Codex 后重新运行 \`./install.sh\`
- **2FA 超时**：确认 Mac 已登录同一 Apple ID，实际运行主体已获辅助功能和屏幕录制权限，并查看 \`2fa-audit.jsonl\` 中各来源的固定失败原因；仅 Mac 设置登录阶段需要自动化权限
- **姓名/生日为空**：查看 \`screenshots/02-account-information.png\` 和 \`flow-audit.jsonl\`；需要同步机器协议时设置 \`APPLE_AUTOMATION_TERMINAL_DEBUG=1\`

## 安全

- \`.env\` 含敏感信息，勿分享、勿上传
- \`data/\` 含 Firefox Profile 与报告，注意保管
`;
  fs.writeFileSync(path.join(destRoot, "README.md"), readme);
}

function buildEnvExample(destRoot) {
  fs.writeFileSync(
    path.join(destRoot, ".env.example"),
    `\uFEFF# 复制为 .env 后填写
APPLE_ID=your@email.com
APPLE_PASSWORD=your_password

# 可选
# FIREFOX_EXECUTABLE=/Applications/Firefox.app/Contents/MacOS/firefox
# FIREFOX_PROFILE_DIR=./data/firefox-apple-automation
# BROWSER_BACKEND=ruyipage
# RUYIPAGE_PYTHON=python3
# BROWSER_PROFILE_MODE=persistent
# RUYIPAGE_BACKEND_TIMEOUT_MS=720000
# RUYIPAGE_KILL_GRACE_MS=5000
# BROWSER_2FA_SETTINGS_AFTER_MS=30000
# BROWSER_2FA_SETTINGS_FALLBACK=1
# BROWSER_2FA_MANUAL_FALLBACK=1
# BROWSER_2FA_POLL_MS=800
# BROWSER_PRESERVE_ON_FAILURE=1
# BROWSER_PRESERVE_ON_SUCCESS=1
# BROWSER_ATTACH_EXISTING=1
# BROWSER_ATTACH_ADDRESS=127.0.0.1:9222
# DEVELOPER_MEMBERSHIP_GATE=0
# 终端诊断仅接受 shell/export 运行时开关，不从 .env 读取：
# APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac
# name=                              # 已登录个人信息页采集后写入
# birthday=                          # 已登录个人信息页采集后写入
# developer_membership=              # 已加入 | 未加入 | 未确认（采集后写入）

# Mac 系统设置短信验证：完整 pair 已保存时直接复用。
APPLE_AUTOMATION_SMS_ENABLED=0
APPLE_AUTOMATION_SMS_PHONE=
APPLE_AUTOMATION_SMS_API_URL=
# 设为 1 可在下一次运行时重录 pair；保存成功后自动改回 0。
APPLE_AUTOMATION_SMS_RECONFIGURE=0
# 可选：短信后处理条款、Mac 密码、iPhone 解锁和位置弹窗；iPhone 自动填 4/6 个 0，Mac 密码使用 000000。
APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=0
`
  );
}

function buildGitignore(destRoot) {
  fs.writeFileSync(
    path.join(destRoot, ".gitignore"),
    `.env
data/
.runtime/
.DS_Store
`
  );
}

export function renderInstallSh(_version) {
  return fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
}

function buildInstallSh(destRoot) {
  writeExecutable(path.join(destRoot, "install.sh"), renderInstallSh(VERSION));
}

export function renderRunSh() {
  return fs.readFileSync(path.join(ROOT, "run.sh"), "utf8");
}

function buildRunSh(destRoot) {
  writeExecutable(path.join(destRoot, "run.sh"), renderRunSh());
}

function createZip(sourceDir, zipPath) {
  rimraf(zipPath);
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  execSync(`cd "${parent}" && zip -r "${zipPath}" "${name}"`, {
    stdio: "inherit",
  });
}

function getGitHubRepo() {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    const m =
      remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i) ??
      remote.match(/github\.com[:/](.+)$/i);
    if (!m) {
      throw new Error(`无法从 origin 解析 GitHub 仓库: ${remote}`);
    }
    return m[1];
  } catch (err) {
    throw new Error(`读取 git remote 失败: ${err.message}`);
  }
}

function releaseExists(repo, tag) {
  try {
    execSync(`gh release view "${tag}" -R "${repo}"`, {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function uploadToGitHubRelease(version, zipPath) {
  const repo = getGitHubRepo();
  const tag = `v${version}`;
  const assetName = path.basename(zipPath);
  const customNotes = process.env.RELEASE_NOTES?.trim();
  const notes = customNotes
    ? [
        `## 更新说明`,
        "",
        customNotes,
        "",
        `- 版本: **${version}**`,
        `- 附件: \`${assetName}\``,
        "",
        "### 使用",
        "",
        "```bash",
        `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/fetch-latest.sh | bash`,
        `cd apple-id-automation-latest/apple-id-automation-${version}`,
        "./install.sh && ./run.sh",
        "```",
      ].join("\n")
    : [
    `## Apple ID 自动化 macOS 分发包`,
    "",
    `- 版本: **${version}**`,
    `- 附件: \`${assetName}\``,
    "",
    "### 使用",
    "",
    "```bash",
    "# 下载并解压（需 gh CLI）",
    `gh release download -R ${repo} --pattern '*-macos.zip'`,
    `unzip ${assetName}`,
    `cd apple-id-automation-${version}`,
    "./install.sh && ./run.sh",
    "```",
  ].join("\n");

  const notesFile = path.join(ROOT, "dist", `.release-notes-${version}.md`);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, notes);

  console.log(`上传 GitHub Release ${tag} (${repo}) …`);

  try {
    if (releaseExists(repo, tag)) {
      execSync(
        `gh release upload "${tag}" "${zipPath}" --clobber -R "${repo}"`,
        { cwd: ROOT, stdio: "inherit" }
      );
      console.log(`已更新 Release 附件: ${assetName}`);
      return;
    }

    execSync(
      `gh release create "${tag}" "${zipPath}" --title "${tag}" --notes-file "${notesFile}" -R "${repo}"`,
      { cwd: ROOT, stdio: "inherit" }
    );
    console.log(`已创建 Release: https://github.com/${repo}/releases/tag/${tag}`);
  } finally {
    rimraf(notesFile);
  }
}

function cleanLocalArtifacts(outDir, zipPath) {
  rimraf(outDir);
  rimraf(zipPath);
  const distDir = path.join(ROOT, "dist");
  if (fs.existsSync(distDir)) {
    for (const entry of fs.readdirSync(distDir)) {
      const abs = path.join(distDir, entry);
      if (
        entry.startsWith("apple-id-automation-") ||
        entry.endsWith("-macos.zip")
      ) {
        rimraf(abs);
      }
    }
    if (fs.readdirSync(distDir).length === 0) {
      fs.rmdirSync(distDir);
    }
  }
  console.log("已清理本地打包产物");
}

function main(argv = process.argv.slice(2)) {
  const noBump = argv.includes("--no-bump");
  uploadRelease = argv.includes("--upload");
  cleanLocal = argv.includes("--clean");
  if (!noBump && !process.env.RELEASE_VERSION) {
    const current = readPkgVersion();
    const next = bumpPatchVersion(current);
    writePkgVersion(next);
    console.log(`版本递增: ${current} → ${next}`);
  }

  VERSION = process.env.RELEASE_VERSION ?? readPkgVersion();
  RELEASE_NAME = `apple-id-automation-${VERSION}`;
  OUT_DIR = path.join(ROOT, "dist", RELEASE_NAME);
  ZIP_PATH = path.join(ROOT, "dist", `${RELEASE_NAME}-macos.zip`);

  validateCopyPaths();
  console.log(`打包 ${RELEASE_NAME} …`);
  rimraf(OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const rel of COPY_PATHS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`缺少文件: ${rel}`);
      process.exit(1);
    }
    copyFile(rel, OUT_DIR);
  }

  buildPackageJson(OUT_DIR);
  buildReadme(OUT_DIR);
  buildEnvExample(OUT_DIR);
  buildGitignore(OUT_DIR);
  buildInstallSh(OUT_DIR);
  buildRunSh(OUT_DIR);

  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  createZip(OUT_DIR, ZIP_PATH);

  if (uploadRelease) {
    uploadToGitHubRelease(VERSION, ZIP_PATH);
  }

  if (cleanLocal) {
    cleanLocalArtifacts(OUT_DIR, ZIP_PATH);
  }

  console.log("");
  console.log("完成:");
  if (!cleanLocal) {
    console.log(`  目录: ${OUT_DIR}`);
    console.log(`  压缩包: ${ZIP_PATH}`);
  }
  if (uploadRelease) {
    console.log(`  GitHub Release: v${VERSION}`);
    console.log("");
    console.log("其他 Mac 拉取最新版:");
    console.log("  ./scripts/fetch-latest.sh");
    console.log("  或: gh release download -R $(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\\1#') --pattern '*-macos.zip'");
  } else {
    console.log("");
    console.log("分发到其他 Mac:");
    console.log(`  1. npm run release   # 上传至 GitHub Releases`);
    console.log(`  2. 或手动复制 ${path.basename(ZIP_PATH)}`);
    console.log("  3. unzip 后 ./install.sh && ./run.sh");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
