/**
 * 系统设置 → 双重认证 → 获取验证码（2FA 弹窗未及时出现时的回退）
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-settings-2fa-code.swift");
const BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-settings-2fa-code"
);
const FORCE_STOP_CLEANUP_GRACE_MS = 4_000;
const SETTINGS_HELPER_COMPILE_TIMEOUT_MS = 120_000;
const HELPER_SUCCESS_REASON = "ok";
const HELPER_ACCESSIBILITY_READY_REASON = "accessibility_ready";
const HELPER_ALERT_READY_EVENT = "verification_alert_ready";
const HELPER_FAILURES = Object.freeze({
  cancelled: ["2FA_SETTINGS_CANCELLED", "2FA settings request was cancelled"],
  accessibility_unavailable: [
    "2FA_SETTINGS_ACCESSIBILITY_DENIED",
    "2FA settings helper requires Accessibility permission",
  ],
  two_factor_not_found: [
    "2FA_SETTINGS_TWO_FACTOR_NOT_FOUND",
    "2FA settings helper could not find Two-Factor Authentication",
  ],
  verification_alert_not_opened: [
    "2FA_SETTINGS_ALERT_NOT_OPENED",
    "2FA settings helper did not open the verification code alert",
  ],
  verification_alert_not_found: [
    "2FA_SETTINGS_ALERT_NOT_FOUND",
    "2FA settings helper did not find the verification code alert",
  ],
  verification_alert_cleanup_failed: [
    "2FA_SETTINGS_ALERT_CLEANUP_FAILED",
    "2FA settings helper could not close the verification code alert",
  ],
  settings_unavailable: [
    "2FA_SETTINGS_UI_UNAVAILABLE",
    "2FA settings helper could not access Apple Account settings",
  ],
});

function swiftNeedsRecompile(sourcePath = SWIFT_SRC, binaryPath = BIN) {
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

export function compile2FASettingsHelper(options = {}) {
  const { quiet = false } = options;
  const platform = options.platform ?? process.platform;
  const sourcePath = options.sourcePath ?? SWIFT_SRC;
  const binaryPath = options.binaryPath ?? BIN;
  const runCompiler = options.spawnSync ?? spawnSync;
  const compileTimeoutMs = Number.isFinite(options.compileTimeoutMs)
    ? Math.max(1_000, options.compileTimeoutMs)
    : SETTINGS_HELPER_COMPILE_TIMEOUT_MS;
  if (platform !== "darwin") return { ok: false, reason: "non-darwin" };
  if (!fs.existsSync(sourcePath)) return { ok: false, reason: "missing swift source" };

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
      ],
      { encoding: "utf-8", timeout: compileTimeoutMs }
    );
    if (r.status !== 0 || !binaryIsExecutable(temporaryBin, options)) {
      if (!quiet) console.warn("[2FA] Swift settings helper compilation failed");
      return { ok: false, reason: "compilation failed" };
    }
    fs.renameSync(temporaryBin, binaryPath);
    if (!binaryIsExecutable(binaryPath, options)) {
      return { ok: false, reason: "compilation failed" };
    }
    return { ok: true, bin: binaryPath };
  } catch {
    if (!quiet) console.warn("[2FA] Swift settings helper compilation failed");
    return { ok: false, reason: "compilation failed" };
  } finally {
    try {
      if (fs.existsSync(temporaryBin)) fs.unlinkSync(temporaryBin);
    } catch {
      /* best-effort cleanup of one failed compiler output */
    }
  }
}

export function is2FASettingsHelperAvailable(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourcePath = options.sourcePath ?? SWIFT_SRC;
  const binaryPath = options.binaryPath ?? BIN;
  if (platform !== "darwin") return false;
  if (swiftNeedsRecompile(sourcePath, binaryPath)) {
    // Runtime callers may only consume a helper prepared during setup.
    if (options.compileIfNeeded !== true) return false;
    return compile2FASettingsHelper({ ...options, quiet: true }).ok;
  }
  return binaryIsExecutable(binaryPath, options);
}

function removeCancelFile(cancelFile) {
  try {
    if (fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile);
  } catch {
    /* best effort after the helper exits */
  }
}

function cancelledError(message = "系统设置验证码请求已取消", options = {}) {
  const error = new Error(message);
  error.code = "2FA_SETTINGS_CANCELLED";
  if (options.alertCleanupConfirmed === true) {
    error.alertCleanupConfirmed = true;
  }
  return error;
}

function codedSettingsError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function helperReasonError(reason) {
  const fixed = HELPER_FAILURES[reason];
  return fixed ? codedSettingsError(fixed[1], fixed[0]) : null;
}

function resolveHelperPath(runtime) {
  if (runtime.helperPath) return runtime.helperPath;
  const binaryPath = runtime.binaryPath ?? BIN;
  const helperOptions = {
    ...runtime,
    binaryPath,
    compileIfNeeded: runtime.compileIfNeeded === true,
  };
  if (!is2FASettingsHelperAvailable(helperOptions)) {
    throw new Error("2FA settings helper is unavailable");
  }
  return binaryPath;
}

/**
 * @param {{
 *   timeoutMs?: number,
 *   verbose?: boolean,
 *   reportDir?: string,
 *   cancelFile?: string,
 *   preflightAccessibility?: boolean,
 *   runtime?: { platform?: string, helperPath?: string, sourcePath?: string, binaryPath?: string, spawn?: typeof spawn, spawnSync?: typeof spawnSync, compileIfNeeded?: boolean }
 * }} [opts]
 * @returns {{
 *   promise: Promise<{ code: string }>,
 *   alertReady: Promise<boolean>,
 *   cancel: () => boolean,
 *   forceStop: () => boolean
 * }}
 */
export function start2FASettingsCodeRequest(opts = {}) {
  const runtime = opts.runtime ?? {};
  const platform = runtime.platform ?? process.platform;
  const schedule = runtime.setTimeout ?? globalThis.setTimeout;
  const cancelScheduled = runtime.clearTimeout ?? globalThis.clearTimeout;
  if (platform !== "darwin") {
    throw codedSettingsError(
      "2FA 系统设置 helper 不可用: non-darwin",
      "2FA_SETTINGS_UNAVAILABLE"
    );
  }

  let helperPath;
  try {
    helperPath = resolveHelperPath(runtime);
  } catch {
    throw codedSettingsError(
      "2FA settings helper is unavailable",
      "2FA_SETTINGS_UNAVAILABLE"
    );
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const timeoutSec = Math.max(30, Math.ceil(timeoutMs / 1000));
  const preflightAccessibility = opts.preflightAccessibility === true;
  const markerDir = opts.reportDir || os.tmpdir();
  fs.mkdirSync(markerDir, { recursive: true });
  const cancelFile =
    opts.cancelFile ||
    path.join(markerDir, `.2fa-settings-cancel-${process.pid}-${randomUUID()}`);
  removeCancelFile(cancelFile);

  const args = [
    ...(preflightAccessibility ? ["--preflight-accessibility"] : []),
    "--timeout",
    String(timeoutSec),
    "--cancel-file",
    cancelFile,
  ];

  const spawnProcess = runtime.spawn ?? spawn;
  let child;
  try {
    child = spawnProcess(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    removeCancelFile(cancelFile);
    throw codedSettingsError(
      "2FA settings helper failed to start",
      "2FA_SETTINGS_START_FAILED"
    );
  }

  let stdout = "";
  let stderrBytes = 0;
  let helperReportedDiagnostics = false;
  let settled = false;
  let cancelRequested = false;
  let timeoutRequested = false;
  let terminalError = null;
  let timeoutTimer = null;
  let forceKillTimer = null;
  let resolveResult;
  let rejectResult;
  let alertReadySettled = false;
  let resolveAlertReady;
  let helperOutputRemainder = "";

  const promise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const alertReady = new Promise((resolve) => {
    resolveAlertReady = resolve;
  });
  const settleAlertReady = (value) => {
    if (alertReadySettled) return;
    alertReadySettled = true;
    resolveAlertReady(value === true);
  };

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer != null) {
      cancelScheduled(timeoutTimer);
      timeoutTimer = null;
    }
    if (forceKillTimer != null) {
      cancelScheduled(forceKillTimer);
      forceKillTimer = null;
    }
    removeCancelFile(cancelFile);
    settleAlertReady(false);
    if (error) rejectResult(error);
    else resolveResult(value);
  };

  const observeHelperEvents = (chunk) => {
    helperOutputRemainder += chunk.toString();
    const lines = helperOutputRemainder.split(/\r?\n/);
    helperOutputRemainder = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.event === HELPER_ALERT_READY_EVENT) settleAlertReady(true);
      } catch {
        // Only the fixed event is useful before final helper completion.
      }
    }
  };

  const appendOutput = (current, chunk, label) => {
    const next = current + chunk.toString();
    if (Buffer.byteLength(next) > 512 * 1024) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* finish below */
      }
      terminalError = new Error(`2FA 系统设置 helper ${label} 输出过大`);
      return current;
    }
    return next;
  };

  const annotateHelperError = (error, parsed = null) => {
    if (!error.code) error.code = "2FA_SETTINGS_HELPER_EXIT";
    if (stderrBytes > 0) error.hasHelperStderr = true;
    if (parsed && typeof parsed.message === "string") error.hasHelperMessage = true;
    return error;
  };

  child.stdout.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk, "stdout");
    observeHelperEvents(chunk);
  });
  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.byteLength(chunk);
    helperReportedDiagnostics ||= bytes > 0;
    if (stderrBytes + bytes > 512 * 1024) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* finish below */
      }
      terminalError = codedSettingsError(
        "2FA settings helper stderr output exceeded the limit",
        "2FA_SETTINGS_OUTPUT_LIMIT"
      );
      return;
    }
    stderrBytes += bytes;
  });
  child.once("error", () =>
    finish(
      annotateHelperError(
        codedSettingsError(
          "2FA settings helper failed to run",
          "2FA_SETTINGS_START_FAILED"
        )
      )
    )
  );
  child.once("close", (exitCode, signal) => {
    if (settled) return;

    if (opts.verbose !== false && helperReportedDiagnostics) {
      console.log("[2FA] helper reported diagnostics");
    }

    if (terminalError) {
      finish(annotateHelperError(terminalError));
      return;
    }
    if (timeoutRequested) {
      finish(
        annotateHelperError(
          codedSettingsError("2FA settings helper 超时", "2FA_SETTINGS_TIMEOUT")
        )
      );
      return;
    }

    let parsed = null;
    let parsedOutput = false;
    try {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      parsed = JSON.parse(lines.at(-1));
      parsedOutput = parsed != null && typeof parsed === "object";
    } catch {
      parsed = null;
    }

    const helperReason =
      parsedOutput && typeof parsed?.reason === "string" ? parsed.reason : null;
    const reasonError = helperReasonError(helperReason);
    if (reasonError) {
      finish(annotateHelperError(reasonError, parsed));
      return;
    }
    if (helperReason === "cancelled") {
      finish(cancelledError(undefined, { alertCleanupConfirmed: true }));
      return;
    }
    if (cancelRequested && helperReason == null) {
      finish(cancelledError());
      return;
    }
    const suffix =
      typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal)
        ? ` (signal ${signal})`
        : Number.isInteger(exitCode)
          ? ` (exit ${exitCode})`
          : "";
    if (!parsedOutput) {
      finish(
        annotateHelperError(
          codedSettingsError(
            `2FA settings helper returned invalid output${suffix}`,
            "2FA_SETTINGS_INVALID_OUTPUT"
          )
        )
      );
      return;
    }
    if (preflightAccessibility) {
      if (
        parsed?.ok !== true ||
        parsed?.reason !== HELPER_ACCESSIBILITY_READY_REASON ||
        parsed.code != null
      ) {
        finish(
          annotateHelperError(
            codedSettingsError(
              `2FA settings helper failed${suffix}`,
              "2FA_SETTINGS_HELPER_EXIT"
            ),
            parsed
          )
        );
        return;
      }
      finish(null, { granted: true });
      return;
    }
    if (
      parsed?.ok !== true ||
      parsed?.reason !== HELPER_SUCCESS_REASON ||
      parsed.code == null
    ) {
      finish(
        annotateHelperError(
          codedSettingsError(
            `2FA settings helper failed${suffix}`,
            "2FA_SETTINGS_HELPER_EXIT"
          ),
          parsed
        )
      );
      return;
    }

    const code = String(parsed.code).replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      finish(
        annotateHelperError(
          codedSettingsError(
            "2FA settings helper returned an invalid verification code",
            "2FA_SETTINGS_INVALID_CODE"
          ),
          parsed
        )
      );
      return;
    }

    finish(null, { code });
  });

  const cancel = () => {
    if (settled || cancelRequested) return false;
    cancelRequested = true;
    try {
      fs.writeFileSync(cancelFile, "cancelled\n", { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return true;
      return false;
    }
  };

  const beginForceStop = (graceMs) => {
    if (settled) return false;
    cancel();
    if (forceKillTimer != null) return false;
    const boundedGraceMs = Math.max(
      0,
      Math.min(FORCE_STOP_CLEANUP_GRACE_MS, graceMs)
    );
    forceKillTimer = schedule(() => {
      forceKillTimer = null;
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* child close/error remains the settlement boundary */
      }
    }, boundedGraceMs);
    if (typeof forceKillTimer?.unref === "function") forceKillTimer.unref();
    return true;
  };

  const forceStop = () => beginForceStop(FORCE_STOP_CLEANUP_GRACE_MS);

  const timeoutCleanupGraceMs = Math.min(FORCE_STOP_CLEANUP_GRACE_MS, timeoutMs);
  timeoutTimer = schedule(() => {
    timeoutRequested = true;
    beginForceStop(timeoutCleanupGraceMs);
  }, Math.max(0, timeoutMs - timeoutCleanupGraceMs));

  return { promise, alertReady, cancel, forceStop };
}

/**
 * @param {{ timeoutMs?: number, verbose?: boolean }} [opts]
 * @returns {Promise<{ code: string }>}
 */
export async function fetch2FACodeFromSystemSettings(opts = {}) {
  return start2FASettingsCodeRequest(opts).promise;
}

/**
 * Prompt and verify Accessibility for the exact System Settings helper that
 * will later navigate to and read the verification-code alert.
 *
 * @param {{ timeoutMs?: number, verbose?: boolean, runtime?: object }} [opts]
 * @returns {Promise<{ granted: true }>}
 */
export async function ensure2FASettingsAccessibility(opts = {}) {
  return start2FASettingsCodeRequest({
    ...opts,
    preflightAccessibility: true,
  }).promise;
}
