/**
 * Vision OCR reads a verified native Apple code dialog when AX text is unavailable.
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
const OCR_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-ocr.swift");
const OCR_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-2fa-popup-ocr"
);
const OCR_CAPABILITIES = new Set([
  "available",
  "permission_missing",
  "accessibility_missing",
  "unavailable",
]);
const defaultCapabilityCache = {};
const HELPER_EXIT_GRACE_MS = 2_000;
const MAX_OCR_TIMEOUT_SEC = 10;
const MAX_PREFLIGHT_TIMEOUT_MS = 2_000;
const PERMISSION_RECHECK_INTERVAL_MS = 2_000;

function isAbortFailure(error, signal) {
  return (
    signal?.aborted === true ||
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR"
  );
}

function boundedOcrTimeoutSec(timeoutSec) {
  const value = Number(timeoutSec);
  const requested = Number.isFinite(value) ? Math.ceil(value) : MAX_OCR_TIMEOUT_SEC;
  return Math.min(MAX_OCR_TIMEOUT_SEC, Math.max(1, requested));
}

function remainingDeadlineMs(options = {}) {
  const deadlineMs = Number(options.deadlineMs);
  if (!Number.isFinite(deadlineMs)) return null;
  const now = typeof options.now === "function" ? Number(options.now()) : Date.now();
  const currentTimeMs = Number.isFinite(now) ? now : Date.now();
  return Math.max(0, Math.floor(deadlineMs - currentTimeMs));
}

function boundedExecutionTimeout(timeoutMs, options = {}) {
  const remainingMs = remainingDeadlineMs(options);
  if (remainingMs == null) return timeoutMs;
  return Math.max(0, Math.min(timeoutMs, remainingMs));
}

function needsRecompile(sourcePath, binaryPath) {
  if (!fs.existsSync(sourcePath)) return true;
  if (!fs.existsSync(binaryPath)) return true;
  return fs.statSync(sourcePath).mtimeMs > fs.statSync(binaryPath).mtimeMs;
}

function binaryIsExecutable(binaryPath, options = {}) {
  const statSync = options.statSync ?? fs.statSync;
  const accessSync = options.accessSync ?? fs.accessSync;
  try {
    if (!statSync(binaryPath).isFile()) return false;
    accessSync(binaryPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compileOcrHelper(sourcePath, binaryPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCompiler = options.spawnSync ?? spawnSync;
  if (platform !== "darwin" || !fs.existsSync(sourcePath)) return false;

  const temporaryBin = `${binaryPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const r = runCompiler(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        "-o",
        temporaryBin,
        sourcePath,
        "-framework",
        "ApplicationServices",
        "-framework",
        "AppKit",
        "-framework",
        "Vision",
        "-framework",
        "CoreGraphics",
        "-framework",
        "ScreenCaptureKit",
      ],
      { encoding: "utf-8" }
    );
    if (r.status !== 0 || !binaryIsExecutable(temporaryBin, options)) {
      if (options.quiet !== true) console.warn("[2FA] Vision OCR 编译失败");
      return false;
    }
    fs.renameSync(temporaryBin, binaryPath);
    return binaryIsExecutable(binaryPath, options);
  } catch {
    if (options.quiet !== true) console.warn("[2FA] Vision OCR 编译失败");
    return false;
  } finally {
    try {
      if (fs.existsSync(temporaryBin)) fs.unlinkSync(temporaryBin);
    } catch {
      /* best-effort cleanup of one failed compiler output */
    }
  }
}

export function is2FAOcrHelperAvailable(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourcePath = options.sourcePath ?? OCR_SRC;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  if (platform !== "darwin") return false;
  if (needsRecompile(sourcePath, binaryPath)) {
    // Runtime callers must only consume the helper prepared by install/startup.
    // Only an explicit installation/preparation caller may compile synchronously.
    if (options.compileIfNeeded !== true) return false;
    return compileOcrHelper(sourcePath, binaryPath, options);
  }
  return binaryIsExecutable(binaryPath, options);
}

function is2FAOcrHelperPrepared(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourcePath = options.sourcePath ?? OCR_SRC;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  return (
    platform === "darwin" &&
    !needsRecompile(sourcePath, binaryPath) &&
    binaryIsExecutable(binaryPath, options)
  );
}

export function parseOcrResult(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (parsed?.capability === "accessibility_missing") {
      return { code: null, source: "vision", capability: "accessibility_missing" };
    }
    if (parsed.ok !== true || typeof parsed.code !== "string") return null;
    if (!/^\d{6}$/.test(parsed.code)) return null;
    return {
      code: parsed.code,
      source: parsed.source ? String(parsed.source) : "vision",
    };
  } catch {
    return null;
  }
}

export function parseOcrCapability(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (parsed.ok !== true || !OCR_CAPABILITIES.has(parsed.capability)) {
      return "unavailable";
    }
    return parsed.capability;
  } catch {
    return "unavailable";
  }
}

export async function get2FAOcrCapability(options = {}) {
  if (options.signal?.aborted) return "unavailable";
  if (remainingDeadlineMs(options) === 0) return "unavailable";
  const capabilityCache = options.capabilityCache ?? defaultCapabilityCache;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const currentTime = Number(now());
  const currentTimeMs = Number.isFinite(currentTime) ? currentTime : Date.now();
  const recheckAt = Number(capabilityCache.permissionRecheckAt);
  const requestPermission =
    options.requestPermission === true && capabilityCache.permissionPrompted !== true;
  if (options.requestPermission === true && capabilityCache.permissionPromptInFlight === true) {
    return "permission_missing";
  }
  const retryPermissionPreflight =
    capabilityCache.permissionPrompted === true &&
    (capabilityCache.capability === "permission_missing" ||
      capabilityCache.capability === "unavailable") &&
    (!Number.isFinite(recheckAt) || currentTimeMs >= recheckAt);
  if (
    capabilityCache.capability === "permission_missing" &&
    !requestPermission &&
    !retryPermissionPreflight
  ) {
    return "permission_missing";
  }
  if (
    capabilityCache.capability === "unavailable" &&
    capabilityCache.permissionPrompted === true &&
    !requestPermission &&
    !retryPermissionPreflight
  ) {
    return "unavailable";
  }

  const isHelperAvailable = options.isHelperAvailable ?? is2FAOcrHelperPrepared;
  if (!isHelperAvailable(options)) return "unavailable";
  if (options.signal?.aborted) return "unavailable";
  if (remainingDeadlineMs(options) === 0) return "unavailable";

  const runHelper = options.execFileAsync ?? execFileAsync;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  let capability = "unavailable";
  if (retryPermissionPreflight) {
    capabilityCache.permissionRecheckAt = currentTimeMs + PERMISSION_RECHECK_INTERVAL_MS;
  }
  let permissionPromptStarted = false;
  try {
    const timeout = boundedExecutionTimeout(MAX_PREFLIGHT_TIMEOUT_MS, options);
    if (timeout <= 0) return "unavailable";
    if (requestPermission) {
      // A started native request can outlive its IPC response. Do not re-prompt
      // during this process if the helper later exits or times out.
      capabilityCache.permissionPrompted = true;
      capabilityCache.permissionPromptInFlight = true;
      permissionPromptStarted = true;
    }
    const execOptions = { timeout, maxBuffer: 64 * 1024 };
    if (options.signal) execOptions.signal = options.signal;
    const args = ["--preflight-screen-capture"];
    if (requestPermission) args.push("--prompt-screen-capture");
    const { stdout } = await runHelper(
      binaryPath,
      args,
      execOptions
    );
    if (options.signal?.aborted) return "unavailable";
    capability = parseOcrCapability(stdout);
  } catch (err) {
    if (isAbortFailure(err, options.signal)) return "unavailable";
    const stdout =
      err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) capability = parseOcrCapability(stdout);
  } finally {
    if (permissionPromptStarted) {
      delete capabilityCache.permissionPromptInFlight;
    }
  }

  if (
    capability === "permission_missing" ||
    (capability === "unavailable" && capabilityCache.permissionPrompted === true)
  ) {
    capabilityCache.capability = capability;
    if (capabilityCache.permissionPrompted === true) {
      capabilityCache.permissionRecheckAt = currentTimeMs + PERMISSION_RECHECK_INTERVAL_MS;
    }
  } else if (capability === "available") {
    delete capabilityCache.capability;
    delete capabilityCache.permissionRecheckAt;
  }
  return capability;
}

function requiredOcrPermissionError(capability) {
  const error = new Error("Screen Recording permission is required for the 2FA OCR helper");
  error.code =
    capability === "permission_missing"
      ? "2FA_OCR_PERMISSION_DENIED"
      : "2FA_OCR_HELPER_UNAVAILABLE";
  error.capability = capability;
  return error;
}

/**
 * Prompt and verify Screen Recording for the exact OCR helper before browser
 * work begins. The first capability call may request macOS permission; later
 * calls only recheck until the user decision is visible to TCC.
 */
export async function ensure2FAOcrScreenRecording(options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 120_000);
  const pollMs = Math.max(250, Number(options.pollMs) || PERMISSION_RECHECK_INTERVAL_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const wait =
    typeof options.wait === "function"
      ? options.wait
      : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const deadline = Number(now()) + timeoutMs;
  const capabilityCache = options.capabilityCache ?? {};
  let requestPermission = true;

  while (true) {
    const capability = await get2FAOcrCapability({
      ...options,
      capabilityCache,
      requestPermission,
    });
    if (capability === "available") return { granted: true };
    if (capability !== "permission_missing") {
      throw requiredOcrPermissionError(capability);
    }

    const remainingMs = Math.max(0, Number(deadline) - Number(now()));
    if (remainingMs <= 0) throw requiredOcrPermissionError(capability);
    await wait(Math.min(pollMs, remainingMs));
    requestPermission = false;
  }
}

function unavailableOcrResult(capability) {
  return { code: null, source: "vision", capability };
}

/**
 * @param {number} [timeoutSec]
 * @param {object} [options]
 * @returns {Promise<{ code: string, source: string }|null>}
 */
export async function readPopupCodeViaOcr(timeoutSec = 10, options = {}) {
  if (options.signal?.aborted) return unavailableOcrResult("unavailable");
  const capability = await get2FAOcrCapability(options);
  if (options.signal?.aborted) return unavailableOcrResult("unavailable");
  if (capability !== "available") return unavailableOcrResult(capability);

  const remainingMs = remainingDeadlineMs(options);
  if (remainingMs === 0) return unavailableOcrResult("unavailable");

  const runHelper = options.execFileAsync ?? execFileAsync;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  const boundedTimeoutSec = Math.min(
    boundedOcrTimeoutSec(timeoutSec),
    remainingMs == null ? MAX_OCR_TIMEOUT_SEC : Math.max(0, Math.floor(remainingMs / 1_000))
  );
  if (boundedTimeoutSec < 1) return unavailableOcrResult("unavailable");
  const args = ["--timeout", String(boundedTimeoutSec)];
  try {
    const timeout = boundedExecutionTimeout(
      boundedTimeoutSec * 1_000 + HELPER_EXIT_GRACE_MS,
      options
    );
    if (timeout <= 0) return unavailableOcrResult("unavailable");
    const execOptions = {
      timeout,
      maxBuffer: 256 * 1024,
    };
    if (options.signal) execOptions.signal = options.signal;
    const { stdout, stderr } = await runHelper(binaryPath, args, execOptions);
    if (options.signal?.aborted) return unavailableOcrResult("unavailable");
    if (stderr?.trim()) {
      console.log("[2FA] Vision OCR helper reported diagnostics");
    }
    return parseOcrResult(stdout) ?? unavailableOcrResult("available");
  } catch (err) {
    if (isAbortFailure(err, options.signal)) return unavailableOcrResult("unavailable");
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) {
      return parseOcrResult(stdout) ?? unavailableOcrResult("available");
    }
  }
  return unavailableOcrResult("unavailable");
}
