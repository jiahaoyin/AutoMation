#!/usr/bin/env node
/**
 * 打包 Apple ID 自动化流程为可分发目录 + zip（适用于其他 macOS 机器测试）
 *
 * 用法: node scripts/build-apple-id-release.mjs [--no-bump]
 * 默认打包前自动 patch +1（1.0.0 → 1.0.1）；--no-bump 跳过递增
 * 输出: dist/apple-id-automation-{version}/ 与 dist/apple-id-automation-{version}-macos.zip
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpPatchVersion, readPkgVersion, writePkgVersion } from "./bump-patch-version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const noBump = process.argv.includes("--no-bump");
if (!noBump && !process.env.RELEASE_VERSION) {
  const current = readPkgVersion();
  const next = bumpPatchVersion(current);
  writePkgVersion(next);
  console.log(`版本递增: ${current} → ${next}`);
}

const VERSION = process.env.RELEASE_VERSION ?? readPkgVersion();
const RELEASE_NAME = `apple-id-automation-${VERSION}`;
const OUT_DIR = path.join(ROOT, "dist", RELEASE_NAME);
const ZIP_PATH = path.join(ROOT, "dist", `${RELEASE_NAME}-macos.zip`);

/** @type {string[]} 相对仓库根目录 */
const COPY_PATHS = [
  "scripts/apple-id-full-flow.mjs",
  "scripts/apple-2fa-wait.scpt",
  "scripts/mac-settings-apple-login.applescript",
  "scripts/mac-settings-signed-in.applescript",
  "scripts/lib/bidi-client.js",
  "scripts/lib/human-input-bidi.js",
  "scripts/lib/mac-settings-login.js",
  "scripts/lib/account-browser-flow.js",
  "scripts/lib/credentials.js",
  "scripts/lib/prompt.js",
  "scripts/lib/two-fa-sidecar.js",
  "scripts/lib/report.js",
  "scripts/check-environment.mjs",
  "scripts/setup-environment.mjs",
  "scripts/bootstrap-macos.sh",
  "scripts/lib/env-setup.js",
  "scripts/lib/macos.js",
  "scripts/bump-patch-version.mjs",
  "scripts/accessibility-check.applescript",
  "scripts/lib/accessibility.js",
];

/** 从入口脚本递归收集 ./lib/*.js 依赖，打包前校验 COPY_PATHS 无遗漏 */
function collectLibImports(entryRelPaths) {
  const libFiles = new Set();
  const queue = [...entryRelPaths];
  const importRe = /from\s+["']\.\/lib\/([^"']+)["']/g;

  while (queue.length) {
    const rel = queue.pop();
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, "utf-8");
    let m;
    while ((m = importRe.exec(src))) {
      const libRel = `scripts/lib/${m[1]}`;
      if (!libFiles.has(libRel)) {
        libFiles.add(libRel);
        queue.push(libRel);
      }
    }
  }
  return libFiles;
}

function validateCopyPaths() {
  const entries = [
    "scripts/apple-id-full-flow.mjs",
    "scripts/setup-environment.mjs",
    "scripts/check-environment.mjs",
  ];
  const requiredLibs = collectLibImports(entries);
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
      "macOS 系统设置 Apple ID 登录 + Firefox BiDi account.apple.com 采集（独立分发包）",
    type: "module",
    engines: { node: ">=18" },
    scripts: {
      flow: "node scripts/apple-id-full-flow.mjs",
      "flow:browser-only": "node scripts/apple-id-full-flow.mjs --skip-mac",
      "flow:mac-only": "node scripts/apple-id-full-flow.mjs --skip-browser",
      check: "node scripts/check-environment.mjs",
      setup: "node scripts/setup-environment.mjs",
      install: "./install.sh",
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
- **Firefox**（[mozilla.org/firefox](https://www.mozilla.org/firefox/) 手动安装）
- **辅助功能权限**：\`./install.sh\` 会自动检测；未授权时将打开系统设置并等待你勾选终端 App（如 Terminal / iTerm）

## 快速开始

\`\`\`bash
# 1. 解压后进入目录
cd apple-id-automation-${VERSION}

# 2. 安装 Node（若尚未安装）：从 nodejs.org 安装，或运行 ./install.sh 下载官方包
./install.sh

# 3. 运行（终端按提示输入账号密码，自动备份至 .env）
./run.sh
\`\`\`

## 流程说明

1. **Mac 系统设置**：自动填入 Apple ID / 密码；**手机验证码需人工**在系统界面完成
2. **等待**：脚本轮询直至检测到系统设置已登录（或按 Enter 手动确认）
3. **Firefox**：独立 Profile + WebDriver BiDi + 人工模拟输入
4. **account.apple.com**：登录 → macOS 2FA 弹窗自动读码 → 采集姓名、生日
5. **输出**：\`data/reports/apple-id-flow-*/report.json\` 与 \`screenshots/\`

## 命令

| 命令 | 说明 |
|------|------|
| \`./install.sh\` | 检测 Node；配置辅助功能；缺失 Node 时下载官方包 |
| \`./run.sh\` | 完整流程；**终端输入**账号密码并备份至 \`.env\` |
| \`./run.sh --skip-mac\` | 跳过 Mac 设置（仅浏览器） |
| \`./run.sh --skip-browser\` | 仅 Mac 设置登录 |
| \`npm run check\` | 环境自检 |

## 环境变量（.env）

运行 \`./run.sh\` 时会在终端提示输入，并**自动备份**到 \`.env\`（也可手动编辑）：

| 变量 | 说明 |
|------|------|
| \`APPLE_ID\` | Apple ID 邮箱 |
| \`APPLE_PASSWORD\` | 密码 |
| \`FIREFOX_EXECUTABLE\` | 可选，非默认 Firefox 路径 |
| \`FIREFOX_PROFILE_DIR\` | 可选，默认 \`./data/firefox-apple-automation\` |

## 故障排查

- **辅助功能未授权**：运行 \`./install.sh\`，按提示在系统设置中勾选对应终端 App
- **系统设置填表失败（macOS 15）**：确认已打开 Apple Account 页；辅助功能已授权 Terminal
- **AppleScript 填表失败**：确认辅助功能已授权；在 Sequoia 上从侧边栏进入「Apple Account」
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

function buildInstallSh(destRoot) {
  writeExecutable(
    path.join(destRoot, "install.sh"),
    `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Apple ID 自动化包 环境安装 (v${VERSION})"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

exec node scripts/setup-environment.mjs "$@"
`
  );
}

function buildRunSh(destRoot) {
  writeExecutable(
    path.join(destRoot, "run.sh"),
    `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

if [[ "\${SKIP_ENV_SETUP:-}" != "1" ]]; then
  node scripts/setup-environment.mjs --quiet
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec node scripts/apple-id-full-flow.mjs --skip-setup "$@"
`
  );
}

function createZip(sourceDir, zipPath) {
  rimraf(zipPath);
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  execSync(`cd "${parent}" && zip -r "${zipPath}" "${name}"`, {
    stdio: "inherit",
  });
}

function main() {
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

  console.log("");
  console.log("完成:");
  console.log(`  目录: ${OUT_DIR}`);
  console.log(`  压缩包: ${ZIP_PATH}`);
  console.log("");
  console.log("分发到其他 Mac:");
  console.log(`  1. 复制 ${path.basename(ZIP_PATH)}`);
  console.log("  2. unzip 后 ./install.sh && ./run.sh");
}

main();
