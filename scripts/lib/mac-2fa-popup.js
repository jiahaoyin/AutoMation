/**
 * Native 2FA dialogs: constrained Swift probing, code reading, and cleanup.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-read.swift");
const SWIFT_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-2fa-popup-read"
);

/** @typedef {"dismiss_stale"|"read_code"|"dismiss_done"|"probe"} PopupPhase */

const SAFE_PHASES = new Set([
  "dismiss_stale",
  "read_code",
  "dismiss_done",
  "probe",
]);

function needsRecompile(src, bin) {
  if (!fs.existsSync(src)) return true;
  if (!fs.existsSync(bin)) return true;
  return fs.statSync(src).mtimeMs > fs.statSync(bin).mtimeMs;
}

function binaryIsExecutable(bin, options = {}) {
  const statSync = options.statSync ?? fs.statSync;
  const accessSync = options.accessSync ?? fs.accessSync;
  try {
    if (!statSync(bin).isFile()) return false;
    accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compileSwift(src, bin, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCompiler = options.spawnSync ?? spawnSync;
  const quiet = options.quiet !== false;
  if (platform !== "darwin" || !fs.existsSync(src)) return false;

  const temporaryBin = `${bin}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const r = runCompiler(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        "-o",
        temporaryBin,
        src,
        "-framework",
        "ApplicationServices",
        "-framework",
        "AppKit",
      ],
      { encoding: "utf-8" }
    );
    if (r.status !== 0 || !binaryIsExecutable(temporaryBin, options)) {
      if (!quiet) console.warn(`[2FA] 编译失败 ${path.basename(src)}`);
      return false;
    }
    fs.renameSync(temporaryBin, bin);
    return binaryIsExecutable(bin, options);
  } catch {
    if (!quiet) console.warn(`[2FA] 编译失败 ${path.basename(src)}`);
    return false;
  } finally {
    try {
      if (fs.existsSync(temporaryBin)) fs.unlinkSync(temporaryBin);
    } catch {
      /* best-effort cleanup of one failed compiler output */
    }
  }
}

export function compile2FAPopupHelper(options = {}) {
  const sourcePath = options.sourcePath ?? SWIFT_SRC;
  const binaryPath = options.binaryPath ?? SWIFT_BIN;
  const ok = compileSwift(sourcePath, binaryPath, options);
  return ok ? { ok: true, bin: binaryPath } : { ok: false, reason: "compile failed" };
}

function ensureBin(src, bin, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  if (needsRecompile(src, bin)) return compileSwift(src, bin, options);
  return binaryIsExecutable(bin, options);
}

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
    };
  } catch {
    return { ok: false, action: "none", code: null, source: null };
  }
}

function parseAccessibilityCapability(stdout) {
  const line = String(stdout ?? "").trim().split("\n").pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (parsed?.capability === "available") {
      return { capability: "available" };
    }
    if (parsed?.capability === "permission_missing") {
      return { capability: "permission_missing" };
    }
  } catch {
    /* fixed fail-closed capability below */
  }
  return { capability: "unavailable" };
}

async function runAccessibilityCapability(flag, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { capability: "unavailable" };

  const sourcePath = options.sourcePath ?? SWIFT_SRC;
  const binaryPath = options.binaryPath ?? SWIFT_BIN;
  const ensureHelper = options.ensureHelper ?? (() => ensureBin(sourcePath, binaryPath, options));
  try {
    if (!ensureHelper()) return { capability: "unavailable" };
  } catch {
    return { capability: "unavailable" };
  }

  const runHelper = options.execFile ?? execFileAsync;
  try {
    const execOptions = {
      timeout: 15_000,
      maxBuffer: 16 * 1024,
    };
    if (options.signal) execOptions.signal = options.signal;
    const { stdout } = await runHelper(binaryPath, [flag], execOptions);
    return parseAccessibilityCapability(stdout);
  } catch (error) {
    const parsed = parseAccessibilityCapability(error?.stdout);
    return parsed.capability === "permission_missing"
      ? parsed
      : { capability: "unavailable" };
  }
}

export async function checkNativeAccessibilityCapability(options = {}) {
  return runAccessibilityCapability("--preflight-accessibility", options);
}

export async function promptNativeAccessibilityPermission(options = {}) {
  return runAccessibilityCapability("--prompt-accessibility", options);
}

async function runSwiftPhase(phase, timeoutSec, options = {}) {
  if (!ensureBin(SWIFT_SRC, SWIFT_BIN)) {
    return { ok: false, action: "none", code: null, source: null };
  }
  try {
    const execOptions = { timeout: (timeoutSec + 10) * 1000, maxBuffer: 256 * 1024 };
    if (options.signal) execOptions.signal = options.signal;
    const { stdout } = await execFileAsync(
      SWIFT_BIN,
      ["--phase", phase, "--timeout", String(timeoutSec)],
      execOptions
    );
    return parsePhaseJson(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) return parsePhaseJson(stdout);
    return { ok: false, action: "none", code: null, source: null };
  }
}

function logPhaseResult(phase, r) {
  if (r.action === "dismissed_stale") {
    console.log("[2FA] 已关闭残留验证码窗");
  } else if (r.action === "dismissed_done") {
    console.log("[2FA] 已点击「完成」关闭验证码窗，便于填入网页");
  } else if (r.action === "read_code" && r.code) {
    console.log("[2FA] 已读取候选验证码，等待关闭验证码窗");
  }
}

export async function runPopupPhase(phase, timeoutSec = 6, options = {}) {
  if (process.platform !== "darwin") return { ok: false, action: "none", code: null, source: null };
  if (!SAFE_PHASES.has(phase)) {
    return { ok: false, action: "none", code: null, source: null };
  }

  const swift = await runSwiftPhase(phase, timeoutSec, options);
  if (swift.ok || swift.action !== "none") {
    logPhaseResult(phase, swift);
  }
  return swift;
}

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

/** 读码后点「完成」关闭系统弹窗，避免遮挡 Firefox 输入 */
export async function dismissCodePopupForWebFill(timeoutSec = 4, options = {}) {
  if (process.platform !== "darwin") return false;
  const r = await runPopupPhase("dismiss_done", timeoutSec, options);
  if (r.action === "dismissed_done") {
    await new Promise((res) => setTimeout(res, 400));
    return true;
  }
  return false;
}

export async function tryFetchMac2FAPopupAx(timeoutSec = 12) {
  const r = await runPopupPhase("read_code", timeoutSec);
  if (r.action === "accessibility_unavailable") {
    return { code: null, source: null, action: r.action, capability: "accessibility_missing" };
  }
  if (!r.code) return null;
  return { code: r.code, source: r.source, action: r.action };
}

export function is2FAPopupHelperAvailable(options = {}) {
  return ensureBin(
    options.sourcePath ?? SWIFT_SRC,
    options.binaryPath ?? SWIFT_BIN,
    options
  );
}
