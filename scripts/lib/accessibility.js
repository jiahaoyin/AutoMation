/**
 * macOS 辅助功能（Accessibility）检测与授权引导
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkNativeAccessibilityCapability,
  promptNativeAccessibilityPermission,
} from "./mac-2fa-popup.js";
import { sleep } from "./prompt.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);

const AUTOMATION_URLS = [
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
];
const NATIVE_HELPER_ACCESSIBILITY_CLIENT = "macOS 原生提示中列出的 2FA helper";

function psField(pid, field) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return "";
  return r.stdout.trim();
}

/**
 * 推断需要在「辅助功能」中勾选的宿主 App。
 *
 * A supervised production run is launched from Terminal but executes through
 * the Codex sandbox. Treating its inherited TERM_PROGRAM as the TCC client
 * sends the user to the wrong Privacy entry, so inspect the real parent chain
 * before falling back to the terminal label.
 * @returns {{ name: string }}
 */
export function getAccessibilityHostApp(options = {}) {
  const env = options.env ?? process.env;
  const readPsField = options.psField ?? psField;
  const supervised =
    options.supervised ?? env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const term = env.TERM_PROGRAM?.trim();

  if (options.nativeHelper === true) {
    return { name: NATIVE_HELPER_ACCESSIBILITY_CLIENT };
  }

  if (!supervised && term === "Apple_Terminal") return { name: "Terminal" };
  if (!supervised && term === "iTerm.app") return { name: "iTerm" };
  if (!supervised && term && /vscode|Visual Studio Code/i.test(term)) {
    return { name: "Visual Studio Code" };
  }
  if (!supervised && term && /cursor/i.test(term)) return { name: "Cursor" };
  if (!supervised && (env.CURSOR_TRACE_ID || env.CURSOR_SESSION)) {
    return { name: "Cursor" };
  }

  let pid = options.pid ?? process.pid;
  for (let i = 0; i < 20; i++) {
    const comm = readPsField(pid, "comm");
    const args = readPsField(pid, "command") || comm;

    if (
      /(?:^|[\\/\s])codex(?:\s|$)/i.test(comm) ||
      /(?:^|[\\/\s])codex(?:\s|$)/i.test(args)
    ) {
      return { name: "Codex" };
    }

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

    const ppid = parseInt(readPsField(pid, "ppid"), 10);
    if (!ppid || ppid <= 1) break;
    pid = ppid;
  }

  return { name: supervised ? "Codex" : "Terminal" };
}

/** 是否为 macOS 自动化未授权错误（-1743 等） */
export function isAutomationDeniedError(err) {
  const parts = [
    err instanceof Error ? err.message : "",
    err?.stderr ?? "",
    err?.stdout ?? "",
    String(err),
  ];
  return /-1743|not authorized to send|未授权|自动化|AUTOMATION_DENIED|READ_DENIED|Automation permission/i.test(
    parts.join("\n")
  );
}

/** 是否为 macOS 辅助功能未授权错误（-25211 等） */
export function isAccessibilityDeniedError(err) {
  const parts = [
    err?.code ?? "",
    err instanceof Error ? err.message : "",
    err?.stderr ?? "",
    err?.stdout ?? "",
    String(err),
  ];
  return /-25211|ACCESSIBILITY_DENIED|requires Accessibility permission|assistive access|辅助访问|不允许辅助|not allowed assist/i.test(
    parts.join("\n")
  );
}

function resolveAccessibilityRuntime(options = {}) {
  return {
    platform: options.runtime?.platform ?? process.platform,
    checkCapability:
      options.runtime?.checkCapability ?? checkNativeAccessibilityCapability,
    promptPermission:
      options.runtime?.promptPermission ?? promptNativeAccessibilityPermission,
    sleep: options.runtime?.sleep ?? sleep,
  };
}

/** 是否已获得辅助功能权限（通过原生 AX API 探测） */
export async function isAccessibilityGranted(options = {}) {
  const runtime = resolveAccessibilityRuntime(options);
  if (runtime.platform !== "darwin") return true;
  const result = await runtime.checkCapability({
    signal: options.signal,
    // Runtime permission checks must use the helper prepared by setup.
    compileIfNeeded: false,
  });
  if (result.capability === "unavailable") {
    const error = new Error("Accessibility capability probe is unavailable");
    error.code = "2FA_ACCESSIBILITY_UNAVAILABLE";
    throw error;
  }
  return result.capability === "available";
}

/** 尝试触发系统辅助功能授权弹窗 */
export async function triggerAccessibilityPrompt(options = {}) {
  const runtime = resolveAccessibilityRuntime(options);
  if (runtime.platform !== "darwin") return { capability: "available" };
  const result = await runtime.promptPermission({
    signal: options.signal,
    waitTimeoutMs: options.waitTimeoutMs,
    // The native prompt is still a runtime operation, never a build step.
    compileIfNeeded: false,
  });
  if (result.capability === "unavailable") {
    const error = new Error("Accessibility permission prompt is unavailable");
    error.code = "2FA_ACCESSIBILITY_UNAVAILABLE";
    throw error;
  }
  return result;
}

/**
 * 检测 Terminal/Cursor 对「系统设置」的自动化权限
 * @returns {Promise<{ granted: boolean, reason?: string, code?: string }>}
 */
export async function checkAutomationGranted() {
  if (process.platform !== "darwin") return { granted: true };
  if (!fs.existsSync(AUTOMATION_CHECK_SCPT)) {
    return { granted: false, reason: "missing automation-check script" };
  }

  try {
    const { stdout } = await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], {
      timeout: 20_000,
    });
    const line = stdout.trim();
    if (line === "yes") return { granted: true };
    if (line.startsWith("no:partial:")) {
      return {
        granted: false,
        code: "partial",
        reason:
          "可枚举 UI 节点但无法读取属性（辅助功能已开，自动化未授予 Terminal→系统设置）",
      };
    }
    const m = line.match(/^no:(-?\d+):(.*)$/);
    if (m) {
      const code = m[1];
      const detail = m[2]?.trim() || line;
      if (code === "-1743") {
        return {
          granted: false,
          code,
          reason: "自动化未授权（-1743）：需允许终端 App 控制「系统设置」",
        };
      }
      if (code === "-25211") {
        return {
          granted: false,
          code,
          reason: "辅助功能未授权（-25211）",
        };
      }
      return { granted: false, code, reason: detail };
    }
    return { granted: false, reason: line || "unknown" };
  } catch (err) {
    return {
      granted: false,
      reason: String(err?.stderr ?? err?.message ?? err),
    };
  }
}

/** 打开系统设置 → 隐私与安全性 → 自动化 */
export function openAutomationSettings() {
  if (process.platform !== "darwin") return false;

  for (const url of AUTOMATION_URLS) {
    const r = spawnSync("open", [url], { encoding: "utf-8" });
    if (r.status === 0) return true;
  }
  return false;
}

/** 尝试触发系统自动化授权弹窗 */
export async function triggerAutomationPrompt() {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "osascript",
      [
        "-e",
        'tell application "System Settings" to activate',
        "-e",
        "delay 0.5",
        "-e",
        'tell application "System Events" to tell process "System Settings" to get name of window 1',
      ],
      { timeout: 15_000 }
    );
  } catch {
    /* 预期可能失败，用于唤起授权提示 */
  }
}

/**
 * 检测自动化权限；未授权时打开系统设置并等待用户勾选
 * @param {object} [options]
 * @param {boolean} [options.quiet]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 */
export async function ensureAutomation(options = {}) {
  const { quiet = false, timeoutMs = 180_000, pollMs = 2000 } = options;

  if (process.platform !== "darwin") {
    return { granted: true, skipped: true };
  }

  const host = getAccessibilityHostApp();

  const first = await checkAutomationGranted();
  if (first.granted) {
    log(`✓ 自动化已授权（${host.name} → 系统设置）`, quiet);
    return { granted: true, host: host.name };
  }

  log(">>> 自动化权限未就绪，正在引导开启…", quiet);
  if (first.reason) log(`    原因: ${first.reason}`, quiet);
  log(
    `    需要允许「${host.name}」控制「系统设置」（AppleScript 填表与粘贴依赖此项）`,
    quiet
  );

  await triggerAutomationPrompt();
  const opened = openAutomationSettings();
  if (opened) {
    log("    已打开：系统设置 → 隐私与安全性 → 自动化", quiet);
  } else {
    log("    请手动打开：系统设置 → 隐私与安全性 → 自动化", quiet);
  }
  log(
    `    请展开「${host.name}」并勾选「系统设置」，完成后脚本将自动继续…`,
    quiet
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const check = await checkAutomationGranted();
    if (check.granted) {
      log(`✓ 自动化已授权（${host.name} → 系统设置）`, quiet);
      return { granted: true, host: host.name };
    }
  }

  throw new Error(
    `自动化未授权：请在 系统设置 → 隐私与安全性 → 自动化 中展开「${host.name}」并勾选「系统设置」，完成后重新运行 ./run.sh`
  );
}

function log(msg, quiet) {
  if (!quiet) console.log(msg);
}

function throwIfAccessibilityCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Accessibility authorization was cancelled");
  error.code = "2FA_ACCESSIBILITY_CANCELLED";
  throw error;
}

/**
 * 检测辅助功能；未授权时触发系统原生提示并等待用户授权
 * @param {object} [options]
 * @param {boolean} [options.quiet]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 */
export async function ensureAccessibility(options = {}) {
  const { quiet = false, timeoutMs = 180_000, pollMs = 2000, signal } = options;
  const runtime = resolveAccessibilityRuntime(options);

  throwIfAccessibilityCancelled(signal);
  if (runtime.platform !== "darwin") {
    return { granted: true, skipped: true };
  }

  const host = getAccessibilityHostApp({ nativeHelper: true });

  if (await isAccessibilityGranted({ runtime, signal, compileIfNeeded: false })) {
    throwIfAccessibilityCancelled(signal);
    log(`✓ 辅助功能已授权（${host.name}）`, quiet);
    return { granted: true, host: host.name };
  }
  throwIfAccessibilityCancelled(signal);

  log(">>> 辅助功能未授权，正在引导开启…", quiet);
  log(`    需要允许「${host.name}」控制此电脑（原生 AX 操作依赖此项）`, quiet);

  const deadline = Date.now() + timeoutMs;
  const promptResult = await triggerAccessibilityPrompt({
    runtime,
    signal,
    compileIfNeeded: false,
    // Keep the same native helper alive while macOS displays the prompt. This
    // avoids a one-shot child disappearing before TCC records the decision.
    waitTimeoutMs: Math.min(timeoutMs, 30_000),
  });
  throwIfAccessibilityCancelled(signal);
  if (promptResult.capability === "available") {
    log(`✓ 辅助功能已授权（${host.name}）`, quiet);
    return { granted: true, host: host.name };
  }
  log(`    请按 macOS 原生提示授权「${host.name}」（等待授权中…）`, quiet);
  console.log(
    `    若未出现提示，请立即打开：系统设置 → 隐私与安全性 → 辅助功能，并勾选「${host.name}」`,
  );

  while (Date.now() < deadline) {
    await runtime.sleep(pollMs);
    throwIfAccessibilityCancelled(signal);
    if (await isAccessibilityGranted({ runtime, signal, compileIfNeeded: false })) {
      throwIfAccessibilityCancelled(signal);
      log(`✓ 辅助功能已授权（${host.name}）`, quiet);
      return { granted: true, host: host.name };
    }
  }

  const error = new Error(
    `辅助功能未授权：请在 系统设置 → 隐私与安全性 → 辅助功能 中勾选「${host.name}」，完成后重新运行 ./run.sh`
  );
  error.code = "2FA_ACCESSIBILITY_DENIED";
  throw error;
}

/**
 * 执行依赖辅助功能的操作；未授权时引导开启，授权后自动重试
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.maxAttempts]
 * @param {string} [options.label]
 */
export async function withAccessibilityRetry(fn, options = {}) {
  const { maxAttempts = 3, label = "操作" } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await ensureAccessibility({ quiet: false, compileIfNeeded: false });
    await sleep(500);

    try {
      return await fn();
    } catch (err) {
      const canRetry = isAccessibilityDeniedError(err) && attempt < maxAttempts;
      if (!canRetry) throw err;

      console.warn(
        `[辅助功能] ${label} 失败（尝试 ${attempt}/${maxAttempts}），请在系统设置中勾选后脚本将自动重试…`
      );
      await ensureAccessibility({
        quiet: false,
        timeoutMs: 180_000,
        compileIfNeeded: false,
      });
      await sleep(1000);
    }
  }

  throw new Error(`${label} 失败：辅助功能未授权`);
}

/**
 * 浏览器 2FA 原生 sidecar 只需要辅助功能权限。
 * @param {object} [options]
 */
export async function run2FAPermissionPreflight(options = {}) {
  const { quiet = false, timeoutMs = 120_000, pollMs = 2000 } = options;
  const runtime = resolveAccessibilityRuntime(options);

  if (runtime.platform !== "darwin") {
    return { ok: true, skipped: true };
  }

  const host = getAccessibilityHostApp({ nativeHelper: true });
  if (!quiet) {
    console.log("==> 2FA 权限预检");
  }

  try {
    await ensureAccessibility({
      quiet,
      timeoutMs,
      pollMs,
      runtime,
      compileIfNeeded: false,
    });
  } catch (error) {
    if (error?.code === "2FA_ACCESSIBILITY_UNAVAILABLE") {
      return {
        ok: false,
        host: host.name,
        capability: "unavailable",
      };
    }
    throw error;
  }

  if (!quiet) {
    console.log(`==> 2FA 权限就绪（${host.name}：辅助功能）`);
  }

  return {
    ok: true,
    host: host.name,
  };
}
