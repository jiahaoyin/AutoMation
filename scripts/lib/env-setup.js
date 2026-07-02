/**
 * 环境检测（Node 来自 nodejs.org；Firefox 手动安装）
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFirefoxExecutable, DEFAULT_FIREFOX } from "./bidi-client.js";
import { ensureAccessibility, ensureAutomation, getAccessibilityHostApp, isAccessibilityGranted, checkAutomationGranted } from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion } from "./macos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

const MIN_NODE_MAJOR = 18;

function log(msg, quiet) {
  if (!quiet) console.log(msg);
}

function augmentPath(env = process.env) {
  const extra = [
    path.join(PACKAGE_ROOT, ".runtime", "node", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const current = env[pathKey] ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const p of extra) {
    if (!parts.includes(p)) parts.unshift(p);
  }
  return { ...env, [pathKey]: parts.join(path.delimiter) };
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.inherit ? "inherit" : "pipe",
    encoding: "utf-8",
    env: augmentPath(options.env),
    shell: false,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function commandExists(cmd, env) {
  const name = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(name, [cmd], { encoding: "utf-8", env: augmentPath(env) });
  return r.status === 0;
}

function getNodeMajor() {
  if (!commandExists("node")) return 0;
  try {
    const v = execSync("node -p process.versions.node", {
      encoding: "utf-8",
      env: augmentPath(),
    }).trim();
    return parseInt(v.split(".")[0], 10) || 0;
  } catch {
    return 0;
  }
}

function firefoxInstalled() {
  const resolved = resolveFirefoxExecutable();
  if (resolved !== "firefox" && fs.existsSync(resolved)) return true;
  if (fs.existsSync(DEFAULT_FIREFOX)) return true;
  return commandExists("firefox");
}

export function ensureNode({ quiet } = {}) {
  const major = getNodeMajor();
  if (major >= MIN_NODE_MAJOR) {
    log(`✓ Node ${execSync("node -v", { encoding: "utf-8", env: augmentPath() }).trim()}`, quiet);
    return;
  }

  if (major > 0) {
    throw new Error(
      `需要 Node ${MIN_NODE_MAJOR}+，当前 v${major}。请从 https://nodejs.org 升级，或运行 ./install.sh`
    );
  }
  throw new Error(
    `未检测到 Node.js。请从 https://nodejs.org 安装，或运行 ./install.sh 自动下载官方二进制`
  );
}

export function ensureFirefox({ quiet } = {}) {
  if (firefoxInstalled()) {
    log(`✓ Firefox: ${resolveFirefoxExecutable()}`, quiet);
    return;
  }

  throw new Error(
    "未检测到 Firefox。请从 https://www.mozilla.org/firefox/ 安装，或设置 FIREFOX_EXECUTABLE=/Applications/Firefox.app/Contents/MacOS/firefox"
  );
}

export function ensureProjectLayout({ quiet } = {}) {
  const scripts = [
    "run.sh",
    "install.sh",
    "scripts/bootstrap-macos.sh",
    "scripts/apple-id-full-flow.mjs",
    "scripts/setup-environment.mjs",
    "scripts/apple-2fa-wait.scpt",
    "scripts/accessibility-check.applescript",
    "scripts/automation-check.applescript",
    "scripts/mac-settings-apple-login.applescript",
    "scripts/mac-settings-signed-in.applescript",
  ];

  for (const rel of scripts) {
    const p = path.join(PACKAGE_ROOT, rel);
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {
        /* ignore */
      }
    }
  }

  const envPath = path.join(PACKAGE_ROOT, ".env");
  const envExample = path.join(PACKAGE_ROOT, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
    log("提示: 首次运行 ./run.sh 时将在终端输入账号密码并自动写入 .env", quiet);
  }

  fs.mkdirSync(path.join(PACKAGE_ROOT, "data", "reports"), { recursive: true });
}

/**
 * @param {object} [options]
 * @param {boolean} [options.quiet]
 * @param {boolean} [options.skipFirefox]
 * @param {boolean} [options.skipAccessibility]
 * @param {boolean} [options.skipAutomation]
 */
export async function ensureEnvironment(options = {}) {
  const {
    quiet = false,
    skipFirefox = false,
    skipAccessibility = false,
    skipAutomation = false,
  } = options;

  if (process.platform !== "darwin") {
    throw new Error("仅支持 macOS");
  }

  const mac = getMacOSVersion();
  log(`  macOS ${mac.productVersion}`, quiet);
  ensureMacOS15({ strict: false });

  log("==> 环境检测与自动安装", quiet);
  ensureNode({ quiet });
  if (!skipFirefox) {
    ensureFirefox({ quiet });
  }
  ensureProjectLayout({ quiet });
  if (!skipAccessibility) {
    await ensureAccessibility({ quiet });
  }
  if (!skipAutomation) {
    await ensureAutomation({ quiet });
  }
  log("==> 环境就绪", quiet);
}

/**
 * @returns {Promise<{ ok: boolean, issues: string[] }>}
 */
export async function checkEnvironment(options = {}) {
  const issues = [];

  if (process.platform !== "darwin") {
    issues.push("非 macOS");
  }

  const nodeMajor = getNodeMajor();
  if (nodeMajor < MIN_NODE_MAJOR) {
    issues.push(`Node ${MIN_NODE_MAJOR}+ 未满足（当前 ${nodeMajor || "无"}）`);
  }

  if (!firefoxInstalled()) {
    issues.push("Firefox 未安装");
  }

  const host = getAccessibilityHostApp();
  const accessibilityOk = await isAccessibilityGranted();
  if (!accessibilityOk) {
    issues.push(`辅助功能未授权（需勾选 ${host.name}）`);
  }

  const automation = await checkAutomationGranted();
  if (!automation.granted) {
    issues.push(
      `自动化未授权（${host.name} → 系统设置${automation.code ? `，${automation.code}` : ""}）`
    );
  }

  const envPath = path.join(PACKAGE_ROOT, ".env");

  if (!options.quiet) {
    console.log("环境自检:");
    console.log("  node:", nodeMajor ? `v${nodeMajor}` : "缺失");
    console.log("  firefox:", firefoxInstalled() ? "ok" : "缺失");
    console.log(
      "  辅助功能:",
      accessibilityOk ? `ok（${host.name}）` : `未授权（请勾选 ${host.name}）`
    );
    console.log(
      "  自动化:",
      automation.granted
        ? `ok（${host.name} → 系统设置）`
        : `未授权（请勾选 ${host.name} → 系统设置）`
    );
    console.log("  .env:", fs.existsSync(envPath) ? "ok" : "首次运行 ./run.sh 时自动创建");
    if (issues.length) {
      console.log("  待处理:", issues.join("; "));
    } else {
      console.log("  全部通过");
    }
  }

  return { ok: issues.length === 0, issues };
}
