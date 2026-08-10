/**
 * 环境检测（Node 来自 nodejs.org；Firefox 手动安装）
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveFirefoxExecutable,
  resolveFirefoxProfileOptions,
  DEFAULT_FIREFOX,
} from "./firefox-runtime.js";
import {
  buildEnvironmentSummary,
  selectBrowserBackend,
} from "./browser-backend.js";
import {
  detectRuyiPageRuntime,
  installRuyiPage,
} from "./ruyipage-runtime.js";
import {
  ensureAccessibility,
  ensureAutomation,
  getAccessibilityHostApp,
  isAccessibilityGranted,
  checkAutomationGranted,
} from "./accessibility.js";
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

export function getBrowserEnvironmentSummary() {
  const runtime = detectRuyiPageRuntime();
  const backend = selectBrowserBackend(process.env, {
    camoufoxAvailable: runtime.available,
    camoufoxError: runtime.error,
    ruyipageAvailable: runtime.available,
    ruyipageError: runtime.error,
  });
  const profile = resolveFirefoxProfileOptions(process.env, "next-run");
  return buildEnvironmentSummary({
    platform: process.platform,
    backend,
    runtime,
    profile: {
      mode: profile.mode,
      dir: profile.profileDir,
    },
  });
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
    log(
      `✓ Firefox (系统安装，供默认 profile): ${resolveFirefoxExecutable()}`,
      quiet
    );
    return;
  }

  throw new Error(
    "未检测到 Firefox。Camoufox 使用系统 Firefox 的默认 profile，请先从 https://www.mozilla.org/firefox/ 安装并手动打开一次后关闭，或设置 FIREFOX_EXECUTABLE=/Applications/Firefox.app/Contents/MacOS/firefox"
  );
}

export function ensureRuyiPage({ quiet, install = false } = {}) {
  let runtime = detectRuyiPageRuntime();
  if (runtime.available) {
    log(`✓ camoufox: ${runtime.version ?? "installed"} (${runtime.python})`, quiet);
    if (runtime.browserVersion) {
      log(`✓ camoufox browser: ${runtime.browserVersion}`, quiet);
    }
    return runtime;
  }

  if (!install) {
    throw new Error(`camoufox 未就绪: ${runtime.error}。请先运行 ./install.sh`);
  }

  if (process.platform !== "darwin") {
    log("⚠ 当前不是 macOS，跳过 camoufox 自动安装；Windows 仅用于逻辑测试", quiet);
    return runtime;
  }

  log(
    "==> 安装 Python Camoufox：camoufox[geoip] → 项目 venv，再 sync/set/fetch official/prerelease（FF152 dev 源）",
    quiet
  );
  const installed = installRuyiPage({ quiet });
  if (installed?.python) log(`  Python: ${installed.python}`, quiet);
  runtime = detectRuyiPageRuntime();
  if (!runtime.available) {
    throw new Error(`camoufox 安装后仍不可用: ${runtime.error}`);
  }
  log(`✓ camoufox: ${runtime.version ?? "installed"} (${runtime.python})`, quiet);
  if (runtime.browserVersion) {
    log(`✓ camoufox browser: ${runtime.browserVersion}`, quiet);
  }
  return runtime;
}

export function ensureProjectLayout({ quiet } = {}) {
  const scripts = [
    "run.sh",
    "install.sh",
    "scripts/bootstrap-macos.sh",
    "scripts/apple-id-full-flow.mjs",
    "scripts/setup-environment.mjs",
    "scripts/automation-check.applescript",
    "scripts/preflight-2fa-permissions.mjs",
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
 * @param {boolean} [options.skipRuyiPage]
 * @param {boolean} [options.skipAccessibility]
 * @param {boolean} [options.skipAutomation]
 * @param {boolean} [options.installRuyiPage]
 */
export async function ensureEnvironment(options = {}) {
  const {
    quiet = false,
    skipFirefox = false,
    skipRuyiPage = false,
    skipAccessibility = false,
    skipAutomation = false,
    installRuyiPage: shouldInstallRuyiPage = false,
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
  if (!skipRuyiPage) {
    ensureRuyiPage({ quiet, install: shouldInstallRuyiPage });
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

  if (!options.skipFirefox && !firefoxInstalled()) {
    issues.push("Firefox 未安装");
  }

  let browserSummary = null;
  if (!options.skipRuyiPage) {
    try {
      browserSummary = getBrowserEnvironmentSummary();
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }

  const host = getAccessibilityHostApp();
  const accessibilityOk = await isAccessibilityGranted();
  if (!accessibilityOk) {
    issues.push(`辅助功能未授权（需勾选 ${host.name}）`);
  }

  let automation = { granted: true, skipped: true };
  if (!options.skipAutomation) {
    automation = await checkAutomationGranted();
    if (!automation.granted) {
      issues.push(
        `自动化未授权（${host.name} → 系统设置${automation.code ? `，${automation.code}` : ""}）`
      );
    }
  }

  const envPath = path.join(PACKAGE_ROOT, ".env");

  if (!options.quiet) {
    console.log("环境自检:");
    console.log("  node:", nodeMajor ? `v${nodeMajor}` : "缺失");
    console.log(
      "  firefox:",
      options.skipFirefox ? "跳过（浏览器阶段已禁用）" : firefoxInstalled() ? "ok" : "缺失"
    );
    if (browserSummary) {
      console.log("  browser backend:", `${browserSummary.backend} (${browserSummary.backendReason})`);
      console.log(
        "  python/camoufox:",
        browserSummary.camoufoxAvailable || browserSummary.ruyipageAvailable
          ? `${browserSummary.python} / camoufox ${browserSummary.camoufoxVersion ?? browserSummary.ruyipageVersion ?? "unknown"}`
          : "未就绪（请运行 ./install.sh）"
      );
      console.log("  profile:", `${browserSummary.profileMode} ${browserSummary.profileDir}`);
      for (const warning of browserSummary.warnings) {
        console.log("  提示:", warning);
      }
    } else if (options.skipRuyiPage) {
      console.log("  browser backend: 跳过（浏览器阶段已禁用）");
    }
    if (process.platform === "darwin") {
      console.log(
        "  辅助功能:",
        accessibilityOk ? `ok（${host.name}）` : `未授权（请勾选 ${host.name}）`
      );
      console.log(
        "  自动化:",
        options.skipAutomation
          ? "跳过（Mac 设置登录阶段已禁用）"
          : automation.granted
            ? `ok（${host.name} → 系统设置）`
            : `未授权（请勾选 ${host.name} → 系统设置）`
      );
    } else {
      console.log("  辅助功能/自动化: 跳过（仅 macOS 运行机检测）");
    }
    console.log("  .env:", fs.existsSync(envPath) ? "ok" : "首次运行 ./run.sh 时自动创建");
    if (issues.length) {
      console.log("  待处理:", issues.join("; "));
    } else {
      console.log("  全部通过");
    }
  }

  return { ok: issues.length === 0, issues };
}
