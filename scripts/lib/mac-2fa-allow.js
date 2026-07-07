/**
 * 统一「允许」点击策略阶梯：CG → AppleScript → cliclick → 手动等待
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AS_SCRIPT = path.resolve(__dirname, "../apple-2fa-phase.applescript");
const CLICK_ALLOW_SRC = path.resolve(__dirname, "../swift/mac-2fa-click-allow.swift");
const CLICK_ALLOW_BIN = path.resolve(__dirname, "../bin/mac-2fa-click-allow");
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-read.swift");
const SWIFT_BIN = path.resolve(__dirname, "../bin/mac-2fa-popup-read");

function needsRecompile(src, bin) {
  if (!fs.existsSync(bin)) return true;
  if (!fs.existsSync(src)) return false;
  return fs.statSync(src).mtimeMs > fs.statSync(bin).mtimeMs;
}

function compileSwift(src, bin) {
  if (process.platform !== "darwin" || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", bin, src, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) return false;
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    /* ignore */
  }
  return true;
}

function ensureBin(src, bin) {
  if (needsRecompile(src, bin)) compileSwift(src, bin);
  return fs.existsSync(bin);
}

function parseJson(stdout) {
  const line = stdout.trim().split("\n").pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function cliclickAvailable() {
  const r = spawnSync("which", ["cliclick"], { encoding: "utf-8" });
  return r.status === 0;
}

/**
 * @returns {Promise<{ action: string, source?: string, strategy?: string }>}
 */
async function tryCgClickAllow(timeoutSec = 3) {
  if (!ensureBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) {
    return { action: "none" };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      CLICK_ALLOW_BIN,
      ["--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 8) * 1000, maxBuffer: 128 * 1024 }
    );
    if (stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) {
        console.log(`[2FA] ${line}`);
      }
    }
    const parsed = parseJson(stdout);
    if (parsed?.action === "clicked_allow") {
      return { action: "clicked_allow", source: parsed.source, strategy: "cg_ax" };
    }
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    const parsed = stdout.trim() ? parseJson(stdout) : null;
    if (parsed?.action === "clicked_allow") {
      return { action: "clicked_allow", source: parsed.source, strategy: "cg_ax" };
    }
  }
  return { action: "none" };
}

function parsePhaseJson(stdout) {
  const line = stdout.trim().split("\n").pop() || "";
  try {
    const parsed = JSON.parse(line);
    return {
      ok: Boolean(parsed.ok),
      action: parsed.action ?? "none",
      source: parsed.source ? String(parsed.source) : null,
    };
  } catch {
    return { ok: false, action: "none", source: null };
  }
}

async function runAppleScriptAllow(timeoutSec = 3) {
  if (process.platform !== "darwin" || !fs.existsSync(AS_SCRIPT)) {
    return { action: "none" };
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [AS_SCRIPT, "--phase=pre_allow", `--timeout=${timeoutSec}`],
      { timeout: (timeoutSec + 10) * 1000, maxBuffer: 256 * 1024 }
    );
    const r = parsePhaseJson(stdout);
    if (r.action === "clicked_allow") {
      return { action: "clicked_allow", source: r.source ?? undefined, strategy: "applescript" };
    }
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) {
      const r = parsePhaseJson(stdout);
      if (r.action === "clicked_allow") {
        return { action: "clicked_allow", source: r.source ?? undefined, strategy: "applescript" };
      }
    }
  }
  return { action: "none" };
}

/**
 * @returns {Promise<{ action: string, source?: string, strategy?: string }>}
 */
async function tryAppleScriptAllow(timeoutSec = 3) {
  return runAppleScriptAllow(timeoutSec);
}

/**
 * @returns {Promise<{ action: string, source?: string, strategy?: string }>}
 */
async function tryCliclickAllow(timeoutSec = 3) {
  if (!cliclickAvailable() || !ensureBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) {
    return { action: "none" };
  }
  try {
    const { stdout } = await execFileAsync(
      CLICK_ALLOW_BIN,
      ["--probe-coords", "--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 8) * 1000, maxBuffer: 128 * 1024 }
    );
    const parsed = parseJson(stdout);
    if (parsed?.action === "coords" && parsed.x != null && parsed.y != null) {
      await execFileAsync("cliclick", [`c:${parsed.x},${parsed.y}`], { timeout: 5000 });
      console.log(`[2FA] cliclick 点击允许 (${parsed.x},${parsed.y})`);
      return { action: "clicked_allow", source: parsed.source, strategy: "cliclick" };
    }
  } catch {
    /* ignore */
  }
  return { action: "none" };
}

/**
 * @returns {Promise<{ action: string, source?: string }>}
 */
export async function probe2FAState(timeoutSec = 2) {
  if (!ensureBin(SWIFT_SRC, SWIFT_BIN)) {
    return { action: "idle" };
  }
  try {
    const { stdout } = await execFileAsync(
      SWIFT_BIN,
      ["--phase", "probe", "--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 5) * 1000, maxBuffer: 128 * 1024 }
    );
    const parsed = parseJson(stdout);
    if (parsed?.action) {
      return { action: parsed.action, source: parsed.source ?? undefined };
    }
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    const parsed = stdout.trim() ? parseJson(stdout) : null;
    if (parsed?.action) {
      return { action: parsed.action, source: parsed.source ?? undefined };
    }
  }
  return { action: "idle" };
}

/**
 * 点击后确认：Allow 窗消失或出现验证码窗
 */
export async function confirmAllowSuccess() {
  await sleep(2000);
  const state = await probe2FAState(3);
  if (state.action === "has_code_dialog") return true;
  if (state.action === "has_allow_dialog") return false;
  return false;
}

/**
 * 单轮尝试所有自动策略
 * @returns {Promise<{ clicked: boolean, source?: string, strategy?: string }>}
 */
export async function tryAllowOnce(timeoutSec = 3) {
  const strategies = [tryCgClickAllow, tryAppleScriptAllow, tryCliclickAllow];
  for (const fn of strategies) {
    const r = await fn(timeoutSec);
    if (r.action === "clicked_allow") {
      const ok = await confirmAllowSuccess();
      if (ok) {
        return { clicked: true, source: r.source, strategy: r.strategy };
      }
    }
  }
  return { clicked: false };
}

/**
 * 等待用户手动点击「允许」
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
export async function waitForManualAllow(options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let prompted = false;

  while (Date.now() < deadline) {
    const state = await probe2FAState(2);
    if (state.action === "has_code_dialog") {
      return { clicked: true, source: state.source, strategy: "manual" };
    }
    if (state.action === "has_allow_dialog") {
      if (!prompted) {
        console.log(
          "[2FA] 检测到「允许」弹窗 — 请手动点击「允许」，脚本将自动继续（最长等待 120 秒）"
        );
        prompted = true;
      }
    } else if (state.action === "idle" && !prompted) {
      // 弹窗可能刚消失（用户已点允许），再等一轮确认是否出现验证码窗
      await sleep(1200);
      const again = await probe2FAState(2);
      if (again.action === "has_code_dialog") {
        return { clicked: true, source: again.source, strategy: "manual" };
      }
    }
    await sleep(800);
  }
  return { clicked: false };
}

/**
 * 完整 Allow 等待：自动策略轮询 + 手动回退
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
export async function waitForAllowClick(options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let autoAttempts = 0;
  let manualStarted = false;

  while (Date.now() < deadline) {
    polls += 1;
    const state = await probe2FAState(2);

    if (state.action === "has_code_dialog") {
      return { clicked: true, source: state.source, strategy: "already_allowed" };
    }

    if (state.action === "has_allow_dialog" || state.action === "idle") {
      autoAttempts += 1;
      const r = await tryAllowOnce(3);
      if (r.clicked) {
        console.log(
          `[2FA] ✓ 已点击「允许」(${r.strategy || "auto"}${r.source ? ` / ${r.source}` : ""})`
        );
        return { clicked: true, source: r.source, strategy: r.strategy };
      }
      if (state.action === "has_allow_dialog" && autoAttempts >= 8 && !manualStarted) {
        manualStarted = true;
        const manual = await waitForManualAllow({ timeoutMs: deadline - Date.now() });
        if (manual.clicked) {
          console.log("[2FA] ✓ 用户已手动点击「允许」");
          return { clicked: true, source: manual.source, strategy: "manual" };
        }
      }
    }

    if (polls === 1 || polls % 6 === 0) {
      console.log("[2FA] 仍在查找「允许」按钮…（请确认终端已获 System Events 自动化权限）");
    }
    await sleep(500);
  }

  return { clicked: false, reason: "timeout" };
}
