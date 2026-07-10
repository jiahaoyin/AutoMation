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
  "scripts/apple-2fa-wait.scpt",
  "scripts/apple-2fa-phase.applescript",
  "scripts/mac-settings-apple-login.applescript",
  "scripts/mac-settings-ui-dump.applescript",
  "scripts/mac-settings-signed-in.applescript",
  "scripts/swift/mac-settings-ax-fill.swift",
  "scripts/swift/mac-settings-2fa-code.swift",
  "scripts/swift/mac-2fa-click-allow.swift",
  "scripts/swift/mac-2fa-popup-read.swift",
  "scripts/swift/mac-2fa-popup-ocr.swift",
  "scripts/fill-debug.mjs",
  "scripts/lib/mac-settings-ax-fill.js",
  "scripts/lib/mac-settings-2fa.js",
  "scripts/lib/browser-backend.js",
  "scripts/lib/firefox-runtime.js",
  "scripts/lib/mac-settings-login.js",
  "scripts/lib/account-browser-flow.js",
  "scripts/lib/credentials.js",
  "scripts/lib/prompt.js",
  "scripts/lib/ruyipage-backend-runner.js",
  "scripts/lib/ruyipage-runtime.js",
  "scripts/lib/two-fa-sidecar.js",
  "scripts/lib/2fa-audit.js",
  "scripts/lib/mac-2fa-allow.js",
  "scripts/lib/mac-2fa-ocr.js",
  "scripts/lib/mac-2fa-popup.js",
  "scripts/lib/report.js",
  "scripts/ruyipage/apple_account_flow.py",
  "scripts/check-environment.mjs",
  "scripts/setup-environment.mjs",
  "scripts/preflight-2fa-permissions.mjs",
  "scripts/bootstrap-macos.sh",
  "scripts/lib/env-setup.js",
  "scripts/lib/macos.js",
  "scripts/bump-patch-version.mjs",
  "scripts/accessibility-check.applescript",
  "scripts/automation-check.applescript",
  "scripts/2fa-automation-check.applescript",
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
- **辅助功能权限**：\`./install.sh\` 会自动检测；未授权时将打开系统设置并等待你勾选终端 App（如 Terminal / iTerm）

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

1. **Mac 系统设置**：自动填入 Apple ID / 密码；**手机验证码需人工**在系统界面完成
2. **等待**：脚本轮询直至检测到系统设置已登录（或按 Enter 手动确认）
3. **Firefox**：启动、导航、页面读取、输入、截图与关闭全部由 ruyiPage 完成，不提供其他浏览器后端
4. **account.apple.com**：登录 → macOS 2FA 弹窗自动读码 → 采集姓名、生日
5. **输出**：\`data/reports/apple-id-flow-*/report.json\` 与 \`screenshots/\`

## 命令

| 命令 | 说明 |
|------|------|
| \`./install.sh\` | 前置管理员授权；自动安装缺失的 Python/Node、ruyiPage，并配置辅助功能 |
| \`./run.sh\` | 完整流程；**终端输入**账号密码并备份至 \`.env\` |
| \`./run.sh --skip-mac\` | 跳过 Mac 设置（仅浏览器） |
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

## 故障排查

- **辅助功能未授权**：运行 \`./install.sh\`，按提示在系统设置中勾选对应终端 App
- **系统设置填表失败（macOS 15）**：确认已打开 Apple Account 页；辅助功能已授权 Terminal
- **邮箱未填入**：在 系统设置 → 隐私与安全性 → **自动化** 中允许 Terminal 控制「系统设置」；运行 \`npm run dump:mac-ui\` 查看 AX 树（v1.0.22 修复 tell 上下文 + 自动化预检）
- **调试 UI 结构**：\`osascript scripts/mac-settings-ui-dump.applescript\`（登录页打开后运行）
- **AppleScript 填表失败**：确认辅助功能已授权；在 Sequoia 上从侧边栏进入「Apple Account」
- **ruyiPage 不可用**：运行 \`./install.sh\`；项目会明确停止，不会回退到其他页面自动化方案
- **Firefox 启动失败**：安装 Firefox 或设置 \`FIREFOX_EXECUTABLE\`
- **2FA 超时**：确认 Mac 已登录同一 Apple ID，且弹窗为 FollowUpUI 设备验证
- **姓名/生日为空**：查看 \`screenshots/03-account-manage.png\`，可能需更新页面解析

## 安全

- \`.env\` 含敏感信息，勿分享、勿上传
- \`data/\` 含 Firefox Profile 与报告，注意保管
`;
  fs.writeFileSync(path.join(destRoot, "README.md"), readme);
}

function buildEnvExample(destRoot) {
  fs.writeFileSync(
    path.join(destRoot, ".env.example"),
    `# 复制为 .env 后填写
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

export function renderInstallSh(version) {
  return `#!/bin/bash
set -euo pipefail
cd "$(/usr/bin/dirname "$0")"

echo "==> Apple ID 自动化包 环境安装"

# shellcheck disable=SC1091
source "$(/usr/bin/dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_install_runtime

echo "==> 编译 Swift AX 填表 helper"
if command -v swiftc >/dev/null 2>&1; then
  mkdir -p scripts/bin
  if swiftc -O -o scripts/bin/mac-settings-ax-fill \\
    scripts/swift/mac-settings-ax-fill.swift \\
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-settings-ax-fill
    echo "✓ mac-settings-ax-fill 已编译"
  else
    echo "⚠ Swift 编译失败，将使用 AppleScript 回退"
  fi
  if swiftc -O -o scripts/bin/mac-settings-2fa-code \\
    scripts/swift/mac-settings-2fa-code.swift \\
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-settings-2fa-code
    echo "✓ mac-settings-2fa-code 已编译"
  else
    echo "⚠ mac-settings-2fa-code 编译失败，2FA 将仅依赖系统弹窗"
  fi
  if swiftc -O -o scripts/bin/mac-2fa-popup-read \
    scripts/swift/mac-2fa-popup-read.swift \
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-2fa-popup-read
    echo "✓ mac-2fa-popup-read 已编译"
  else
    echo "⚠ mac-2fa-popup-read 编译失败，2FA 弹窗将回退 AppleScript"
  fi
  if swiftc -O -o scripts/bin/mac-2fa-popup-ocr \
    scripts/swift/mac-2fa-popup-ocr.swift \
    -framework ApplicationServices -framework AppKit -framework Vision -framework CoreGraphics 2>/dev/null; then
    chmod +x scripts/bin/mac-2fa-popup-ocr
    echo "✓ mac-2fa-popup-ocr 已编译"
  else
    echo "⚠ mac-2fa-popup-ocr 编译失败，将回退 AppleScript 读码"
  fi
  if swiftc -O -o scripts/bin/mac-2fa-click-allow \
    scripts/swift/mac-2fa-click-allow.swift \
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-2fa-click-allow
    echo "✓ mac-2fa-click-allow 已编译"
  else
    echo "⚠ mac-2fa-click-allow 编译失败，将回退 AppleScript 点允许"
  fi
else
  echo "⚠ 未找到 swiftc，将使用 AppleScript 回退"
fi

if ! command -v cliclick >/dev/null 2>&1; then
  echo "提示: 可选安装 cliclick 以增强「允许」点击（brew install cliclick）"
fi

exec node scripts/setup-environment.mjs --install-ruyipage "$@"
`;
}

function buildInstallSh(destRoot) {
  writeExecutable(path.join(destRoot, "install.sh"), renderInstallSh(VERSION));
}

export function renderRunSh() {
  return `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

skip_browser=0
for arg in "$@"; do
  if [[ "\${arg}" == "--skip-browser" ]]; then
    skip_browser=1
    break
  fi
done

if [[ "\${SKIP_ENV_SETUP:-}" != "1" ]]; then
  setup_args=(--quiet)
  if [[ "\${skip_browser}" == "1" ]]; then
    setup_args+=(--skip-firefox --skip-ruyipage)
  fi
  node scripts/setup-environment.mjs "\${setup_args[@]}"
fi

if [[ "\${skip_browser}" != "1" ]]; then
  node scripts/preflight-2fa-permissions.mjs --quiet
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec node scripts/apple-id-full-flow.mjs --skip-setup "$@"
`;
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
