/**
 * 2FA 弹窗：AppleScript（System Events）为主，Swift AX 为辅
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AS_SCRIPT = path.resolve(__dirname, "../apple-2fa-phase.applescript");
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-read.swift");
const SWIFT_BIN = path.resolve(__dirname, "../bin/mac-2fa-popup-read");

/** @typedef {"dismiss_stale"|"pre_allow"|"read_code"} PopupPhase */

function swiftNeedsRecompile() {
  if (!fs.existsSync(SWIFT_BIN)) return true;
  if (!fs.existsSync(SWIFT_SRC)) return false;
  return fs.statSync(SWIFT_SRC).mtimeMs > fs.statSync(SWIFT_BIN).mtimeMs;
}

export function compile2FAPopupHelper(options = {}) {
  const { quiet = false } = options;
  if (process.platform !== "darwin") return { ok: false, reason: "non-darwin" };
  if (!fs.existsSync(SWIFT_SRC)) return { ok: false, reason: "missing swift source" };

  fs.mkdirSync(path.dirname(SWIFT_BIN), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", SWIFT_BIN, SWIFT_SRC, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    if (!quiet) console.warn("[2FA] Swift popup helper 编译失败:", r.stderr?.trim() || r.error);
    return { ok: false, reason: r.stderr?.trim() || String(r.error) };
  }
  try {
    fs.chmodSync(SWIFT_BIN, 0o755);
  } catch {
    /* ignore */
  }
  return { ok: true, bin: SWIFT_BIN };
}

function ensureSwiftHelper() {
  if (swiftNeedsRecompile()) {
    return compile2FAPopupHelper({ quiet: true }).ok;
  }
  return fs.existsSync(SWIFT_BIN);
}

/**
 * @param {string} stdout
 */
function parsePhaseJson(stdout) {
  const line = stdout.trim().split("\n").pop() || "";
  try {
    const parsed = JSON.parse(line);
    const code =
      parsed.code != null && String(parsed.code).length > 0
        ? String(parsed.code).replace(/\D/g, "").slice(0, 6)
        : null;
    return {
      ok: Boolean(parsed.ok),
      action: parsed.action ?? "none",
      code: code?.length === 6 ? code : null,
      source: parsed.source ? String(parsed.source) : null,
      raw: parsed.raw ? String(parsed.raw) : null,
    };
  } catch {
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
}

/**
 * @param {PopupPhase} phase
 * @param {number} timeoutSec
 */
export async function runAppleScriptPhase(phase, timeoutSec = 6) {
  if (process.platform !== "darwin" || !fs.existsSync(AS_SCRIPT)) {
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [AS_SCRIPT, `--phase=${phase}`, `--timeout=${timeoutSec}`],
      { timeout: (timeoutSec + 10) * 1000, maxBuffer: 256 * 1024 }
    );
    return parsePhaseJson(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) return parsePhaseJson(stdout);
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
}

async function runSwiftPhase(phase, timeoutSec) {
  if (!ensureSwiftHelper()) return { ok: false, action: "none", code: null, source: null, raw: null };
  try {
    const { stdout } = await execFileAsync(
      SWIFT_BIN,
      ["--phase", phase, "--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 10) * 1000, maxBuffer: 256 * 1024 }
    );
    return parsePhaseJson(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) return parsePhaseJson(stdout);
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
}

function logPhaseResult(phase, r) {
  if (r.action === "clicked_allow") {
    console.log(`[2FA] ✓ 已点击「允许」(${r.source || "System Events"})`);
  } else if (r.action === "dismissed_stale") {
    const old = r.code ? ` 旧码=${r.code}` : "";
    console.log(`[2FA] 已关闭残留验证码窗${old}`);
  } else if (r.action === "read_code" && r.code) {
    const raw = r.raw ? ` 原文="${String(r.raw).slice(0, 40)}"` : "";
    console.log(`[2FA] 读到验证码 ${r.code}${raw}`);
  } else if (phase === "pre_allow" && r.action === "none" && process.env.DEBUG_2FA) {
    console.log("[2FA] 未检测到允许按钮（继续轮询）");
  }
}

/**
 * @param {PopupPhase} phase
 * @param {number} [timeoutSec]
 */
export async function runPopupPhase(phase, timeoutSec = 6) {
  if (process.platform !== "darwin") return { ok: false, action: "none", code: null, source: null, raw: null };

  const as = await runAppleScriptPhase(phase, timeoutSec);
  if (as.ok || as.action === "clicked_allow" || as.action === "dismissed_stale") {
    logPhaseResult(phase, as);
    return as;
  }

  if (phase === "pre_allow") {
    const swift = await runSwiftPhase(phase, Math.min(timeoutSec, 3));
    if (swift.action === "clicked_allow" || swift.action === "dismissed_stale") {
      logPhaseResult(phase, swift);
      return swift;
    }
    return as;
  }

  const swift = await runSwiftPhase(phase, timeoutSec);
  if (swift.ok || swift.action !== "none") {
    logPhaseResult(phase, swift);
  }
  return swift;
}

/** @returns {Promise<{ count: number, codes: string[] }>} */
export async function dismissStale2FAPopups(maxRounds = 6) {
  let dismissed = 0;
  /** @type {string[]} */
  const codes = [];
  for (let i = 0; i < maxRounds; i++) {
    const r = await runPopupPhase("dismiss_stale", 2);
    if (r.action === "dismissed_stale") {
      dismissed += 1;
      if (r.code) codes.push(r.code);
      await new Promise((res) => setTimeout(res, 500));
    } else {
      break;
    }
  }
  return { count: dismissed, codes };
}

export async function tryFetchMac2FAPopupAx(timeoutSec = 12) {
  const r = await runPopupPhase("read_code", timeoutSec);
  if (!r.code) return null;
  return { code: r.code, source: r.source, raw: r.raw, action: r.action };
}

export function is2FAPopupHelperAvailable() {
  return ensureSwiftHelper();
}
