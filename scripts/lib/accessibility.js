/**
 * macOS 辅助功能（Accessibility）检测与授权引导
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SCPT = path.resolve(__dirname, "../accessibility-check.applescript");

const ACCESSIBILITY_URLS = [
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity",
];

function psField(pid, field) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return "";
  return r.stdout.trim();
}

/**
 * 推断需要在「辅助功能」中勾选的宿主 App（运行脚本的终端）
 * @returns {{ name: string }}
 */
export function getAccessibilityHostApp() {
  const term = process.env.TERM_PROGRAM?.trim();
  if (term === "Apple_Terminal") return { name: "Terminal" };
  if (term === "iTerm.app") return { name: "iTerm" };
  if (term && /vscode|Visual Studio Code/i.test(term)) {
    return { name: "Visual Studio Code" };
  }
  if (term && /cursor/i.test(term)) return { name: "Cursor" };
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION) {
    return { name: "Cursor" };
  }

  let pid = process.pid;
  for (let i = 0; i < 20; i++) {
    const comm = psField(pid, "comm");
    const args = psField(pid, "command") || comm;

    if (/Terminal/i.test(comm) || /Terminal\.app/i.test(args)) {
      return { name: "Terminal" };
    }
    if (/iTerm/i.test(comm) || /iTerm/i.test(args)) {
      return { name: "iTerm" };
    }
    if (/Cursor/i.test(comm) || /Cursor\.app/i.test(args)) {
      return { name: "Cursor" };
    }
    if (/Code Helper|Visual Studio Code|Code\.app/i.test(args)) {
      return { name: "Visual Studio Code" };
    }

    const ppid = parseInt(psField(pid, "ppid"), 10);
    if (!ppid || ppid <= 1) break;
    pid = ppid;
  }

  return { name: "Terminal" };
}

/** 是否已获得辅助功能权限（通过 System Events 探测） */
export async function isAccessibilityGranted() {
  if (process.platform !== "darwin") return true;
  if (!fs.existsSync(CHECK_SCPT)) return false;

  try {
    const { stdout } = await execFileAsync("osascript", [CHECK_SCPT], {
      timeout: 10_000,
    });
    return stdout.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

/** 尝试触发系统辅助功能授权弹窗 */
export async function triggerAccessibilityPrompt() {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get name of first application process',
      ],
      { timeout: 10_000 }
    );
  } catch {
    /* 预期可能失败，用于唤起系统授权提示 */
  }
}

/** 打开系统设置 → 隐私与安全性 → 辅助功能 */
export function openAccessibilitySettings() {
  if (process.platform !== "darwin") return false;

  for (const url of ACCESSIBILITY_URLS) {
    const r = spawnSync("open", [url], { encoding: "utf-8" });
    if (r.status === 0) return true;
  }
  return false;
}

function log(msg, quiet) {
  if (!quiet) console.log(msg);
}

/**
 * 检测辅助功能；未授权时打开系统设置并等待用户勾选
 * @param {object} [options]
 * @param {boolean} [options.quiet]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 */
export async function ensureAccessibility(options = {}) {
  const { quiet = false, timeoutMs = 180_000, pollMs = 2000 } = options;

  if (process.platform !== "darwin") {
    return { granted: true, skipped: true };
  }

  const host = getAccessibilityHostApp();

  if (await isAccessibilityGranted()) {
    log(`✓ 辅助功能已授权（${host.name}）`, quiet);
    return { granted: true, host: host.name };
  }

  log(">>> 辅助功能未授权，正在引导开启…", quiet);
  log(`    需要允许「${host.name}」控制此电脑（AppleScript 填表依赖此项）`, quiet);

  await triggerAccessibilityPrompt();
  const opened = openAccessibilitySettings();
  if (opened) {
    log("    已打开：系统设置 → 隐私与安全性 → 辅助功能", quiet);
  } else {
    log("    请手动打开：系统设置 → 隐私与安全性 → 辅助功能", quiet);
  }
  log(`    请勾选「${host.name}」并确认（等待授权中…）`, quiet);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await isAccessibilityGranted()) {
      log(`✓ 辅助功能已授权（${host.name}）`, quiet);
      return { granted: true, host: host.name };
    }
  }

  throw new Error(
    `辅助功能未授权：请在 系统设置 → 隐私与安全性 → 辅助功能 中勾选「${host.name}」，完成后重新运行 ./install.sh`
  );
}
