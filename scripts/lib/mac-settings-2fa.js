/**
 * 系统设置 → 双重认证 → 获取验证码（2FA 弹窗未及时出现时的回退）
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-settings-2fa-code.swift");
const BIN = path.resolve(__dirname, "../bin/mac-settings-2fa-code");

function swiftNeedsRecompile() {
  if (!fs.existsSync(BIN)) return true;
  if (!fs.existsSync(SWIFT_SRC)) return false;
  return fs.statSync(SWIFT_SRC).mtimeMs > fs.statSync(BIN).mtimeMs;
}

export function compile2FASettingsHelper(options = {}) {
  const { quiet = false } = options;
  if (process.platform !== "darwin") return { ok: false, reason: "non-darwin" };
  if (!fs.existsSync(SWIFT_SRC)) return { ok: false, reason: "missing swift source" };

  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", BIN, SWIFT_SRC, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    if (!quiet) console.warn("[2FA] Swift settings helper 编译失败:", r.stderr?.trim() || r.error);
    return { ok: false, reason: r.stderr?.trim() || String(r.error) };
  }
  try {
    fs.chmodSync(BIN, 0o755);
  } catch {
    /* ignore */
  }
  return { ok: true, bin: BIN };
}

export function is2FASettingsHelperAvailable() {
  if (swiftNeedsRecompile()) {
    compile2FASettingsHelper({ quiet: true });
  }
  return process.platform === "darwin" && fs.existsSync(BIN) && fs.statSync(BIN).isFile();
}

function removeCancelFile(cancelFile) {
  try {
    if (fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile);
  } catch {
    /* best effort after the helper exits */
  }
}

function cancelledError(message = "系统设置验证码请求已取消") {
  const error = new Error(message);
  error.code = "2FA_SETTINGS_CANCELLED";
  return error;
}

function resolveHelperPath(runtime) {
  if (runtime.helperPath) return runtime.helperPath;
  if (!is2FASettingsHelperAvailable()) {
    const built = compile2FASettingsHelper({ quiet: true });
    if (!built.ok) {
      throw new Error(`2FA 系统设置 helper 不可用: ${built.reason}`);
    }
  }
  return BIN;
}

/**
 * @param {{
 *   timeoutMs?: number,
 *   verbose?: boolean,
 *   screenshotPath?: string,
 *   reportDir?: string,
 *   cancelFile?: string,
 *   runtime?: { platform?: string, helperPath?: string, spawn?: typeof spawn }
 * }} [opts]
 * @returns {{
 *   promise: Promise<{ code: string, raw: string|null, screenshot: string|null }>,
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
    throw new Error("2FA 系统设置 helper 不可用: non-darwin");
  }

  const helperPath = resolveHelperPath(runtime);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const timeoutSec = Math.max(30, Math.ceil(timeoutMs / 1000));
  const markerDir = opts.reportDir || os.tmpdir();
  fs.mkdirSync(markerDir, { recursive: true });
  const cancelFile =
    opts.cancelFile ||
    path.join(markerDir, `.2fa-settings-cancel-${process.pid}-${randomUUID()}`);
  removeCancelFile(cancelFile);

  const args = ["--timeout", String(timeoutSec), "--cancel-file", cancelFile];
  if (opts.screenshotPath) {
    fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true });
    args.push("--screenshot", opts.screenshotPath);
  }

  const spawnProcess = runtime.spawn ?? spawn;
  let child;
  try {
    child = spawnProcess(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    removeCancelFile(cancelFile);
    throw error;
  }

  let stdout = "";
  let stderr = "";
  let settled = false;
  let cancelRequested = false;
  let timeoutRequested = false;
  let terminalError = null;
  let timeoutTimer = null;
  let resolveResult;
  let rejectResult;

  const promise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer != null) cancelScheduled(timeoutTimer);
    removeCancelFile(cancelFile);
    if (error) rejectResult(error);
    else resolveResult(value);
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

  child.stdout.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk, "stdout");
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendOutput(stderr, chunk, "stderr");
  });
  child.once("error", (error) => finish(error));
  child.once("close", (exitCode, signal) => {
    if (settled) return;

    if (opts.verbose !== false && stderr.trim()) {
      for (const line of stderr.trim().split(/\r?\n/)) {
        console.log(`[2FA] ${line}`);
      }
    }

    if (terminalError) {
      finish(terminalError);
      return;
    }
    if (timeoutRequested) {
      finish(new Error(`系统设置获取验证码超时 (${timeoutMs}ms)`));
      return;
    }

    let parsed = null;
    try {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      parsed = JSON.parse(lines.at(-1) || "{}");
    } catch {
      parsed = null;
    }

    if (cancelRequested || parsed?.message === "cancelled") {
      finish(cancelledError());
      return;
    }
    if (!parsed?.ok || parsed.code == null) {
      const detail = parsed?.message || stdout.trim() || stderr.trim();
      const suffix = signal ? ` (signal ${signal})` : ` (exit ${exitCode})`;
      finish(new Error(`${detail || "系统设置获取验证码失败"}${suffix}`));
      return;
    }

    const code = String(parsed.code).replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      finish(new Error(`验证码格式异常: ${parsed.code}`));
      return;
    }

    const screenshot =
      parsed.screenshot && fs.existsSync(parsed.screenshot)
        ? String(parsed.screenshot)
        : null;
    finish(null, {
      code,
      raw: parsed.raw ? String(parsed.raw) : null,
      screenshot,
    });
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

  const forceStop = () => {
    if (settled) return false;
    cancel();
    try {
      return child.kill("SIGKILL");
    } catch {
      return false;
    }
  };

  timeoutTimer = schedule(() => {
    timeoutRequested = true;
    forceStop();
  }, timeoutMs + 15_000);

  return { promise, cancel, forceStop };
}

/**
 * @param {{ timeoutMs?: number, verbose?: boolean, screenshotPath?: string }} [opts]
 * @returns {Promise<{ code: string, screenshot: string|null }>}
 */
export async function fetch2FACodeFromSystemSettings(opts = {}) {
  return start2FASettingsCodeRequest(opts).promise;
}
