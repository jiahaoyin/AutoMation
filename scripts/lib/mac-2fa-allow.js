/**
 * 统一「允许」点击策略：受限 Swift 原子动作 → 原生状态确认 → 手动等待
 */

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";
import { readPopupCodeViaOcr } from "./mac-2fa-ocr.js";
import { runPopupPhase } from "./mac-2fa-popup.js";
import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLICK_ALLOW_SRC = path.resolve(__dirname, "../swift/mac-2fa-click-allow.swift");
const CLICK_ALLOW_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-2fa-click-allow"
);
const HELPER_EXIT_GRACE_MS = 2_000;
const AX_READ_TIMEOUT_SEC = 2;
const OCR_PREFLIGHT_TIMEOUT_SEC = 2;
const MIN_OCR_STABILITY_TIMEOUT_SEC = 4;
const OCR_STABILITY_SCHEDULING_SLACK_SEC = 1;
const MIN_POPUP_READ_TIMEOUT_SEC =
  AX_READ_TIMEOUT_SEC + MIN_OCR_STABILITY_TIMEOUT_SEC + OCR_STABILITY_SCHEDULING_SLACK_SEC;
const MAX_POPUP_READ_TIMEOUT_SEC = 12;

function isAbortFailure(error, signal) {
  return (
    signal?.aborted === true ||
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR"
  );
}

function unavailablePopupCode() {
  return { code: null, source: "vision", capability: "unavailable" };
}

function rejectedPopupCode() {
  return { code: null, rejected: true };
}

function popupReadBudget(timeoutSec, now, absoluteDeadline) {
  const requested = Number(timeoutSec);
  const requestedSeconds = Number.isFinite(requested)
    ? Math.max(1, Math.ceil(requested))
    : 10;
  const requestedOcrTimeoutSec = Math.max(
    MIN_OCR_STABILITY_TIMEOUT_SEC,
    requestedSeconds - AX_READ_TIMEOUT_SEC - OCR_PREFLIGHT_TIMEOUT_SEC
  );
  const totalTimeoutSec = Math.min(
    MAX_POPUP_READ_TIMEOUT_SEC,
    Math.max(
      MIN_POPUP_READ_TIMEOUT_SEC,
      AX_READ_TIMEOUT_SEC +
        OCR_PREFLIGHT_TIMEOUT_SEC +
        requestedOcrTimeoutSec +
        OCR_STABILITY_SCHEDULING_SLACK_SEC
    )
  );
  const ocrTimeoutSec = Math.min(
    requestedOcrTimeoutSec,
    totalTimeoutSec -
      AX_READ_TIMEOUT_SEC -
      OCR_PREFLIGHT_TIMEOUT_SEC -
      OCR_STABILITY_SCHEDULING_SLACK_SEC
  );
  const startedAt = now();
  const requestedDeadline = startedAt + totalTimeoutSec * 1_000;
  const deadline = Number.isFinite(absoluteDeadline)
    ? Math.min(requestedDeadline, absoluteDeadline)
    : requestedDeadline;
  return {
    deadline,
    swiftTimeoutSec: AX_READ_TIMEOUT_SEC,
    ocrTimeoutSec,
    totalTimeoutSec,
  };
}

function createDeadlineSignal(parentSignal, deadline, now, runtime = {}) {
  const controller = new AbortController();
  const setTimer = runtime.setTimer ?? setTimeout;
  const clearTimer = runtime.clearTimer ?? clearTimeout;
  let timer = null;
  const abort = () => controller.abort();
  const remainingMs = deadline - now();
  if (parentSignal?.aborted || remainingMs <= 0) {
    abort();
  } else {
    parentSignal?.addEventListener?.("abort", abort, { once: true });
    timer = setTimer(abort, remainingMs);
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer != null) clearTimer(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    },
  };
}

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
    if (r.status !== 0 || !binaryIsExecutable(temporaryBin, options)) return false;
    fs.renameSync(temporaryBin, bin);
    return binaryIsExecutable(bin, options);
  } catch {
    return false;
  } finally {
    try {
      if (fs.existsSync(temporaryBin)) fs.unlinkSync(temporaryBin);
    } catch {
      /* best-effort cleanup of one failed compiler output */
    }
  }
}

function ensureBin(src, bin, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  if (options.compileIfNeeded !== true) {
    return !needsRecompile(src, bin) && binaryIsExecutable(bin, options);
  }
  if (needsRecompile(src, bin)) return compileSwift(src, bin, options);
  return binaryIsExecutable(bin, options);
}

export function is2FAAllowHelperAvailable(options = {}) {
  return ensureBin(
    options.sourcePath ?? CLICK_ALLOW_SRC,
    options.binaryPath ?? CLICK_ALLOW_BIN,
    options
  );
}

function parseJson(stdout) {
  const line = stdout.trim().split("\n").pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function releaseLeftMouseButton(timeoutSec = 1, runtime = {}) {
  const ensureReleaseBin = runtime.ensureBin ?? ensureBin;
  if (
    !ensureReleaseBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN, { compileIfNeeded: false })
  ) {
    return false;
  }
  const runHelper = runtime.execFileAsync ?? execFileAsync;
  try {
    await runHelper(CLICK_ALLOW_BIN, ["--release-left-button"], {
      timeout: Math.max(500, Math.min(3_000, (timeoutSec + 1) * 1_000)),
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ action: string, source?: string, code?: string }>}
 */
export async function probe2FAState(timeoutSec = 2, options = {}) {
  if (options.signal?.aborted) return { action: "probe_error" };
  let result;
  try {
    result = await runPopupPhase("probe", timeoutSec, {
      ...options,
      compileIfNeeded: false,
    });
  } catch (error) {
    if (isAbortFailure(error, options.signal)) return { action: "probe_error" };
    return { action: "probe_error" };
  }
  if (options.signal?.aborted) return { action: "probe_error" };
  if (result.action === "accessibility_unavailable") {
    return { action: "accessibility_unavailable" };
  }
  if (!result.action || result.action === "none") return { action: "probe_error" };
  return {
    action: result.action,
    source: result.source ?? undefined,
    code: result.code ?? undefined,
  };
}

async function tryCgClickAllow(timeoutSec = 3, options = {}) {
  if (options.signal?.aborted) return { action: "none", strategy: "cg_ax" };
  const runtime = options.runtime ?? {};
  const ensureHelper = runtime.ensureBin ?? ensureBin;
  if (
    !ensureHelper(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN, { compileIfNeeded: false })
  ) {
    return { action: "none", strategy: "cg_ax" };
  }
  const runHelper = runtime.execFileAsync ?? execFileAsync;
  try {
    const boundedTimeoutSec = Math.max(1, Math.min(4, Math.ceil(Number(timeoutSec) || 1)));
    const execOptions = {
      timeout: boundedTimeoutSec * 1_000 + HELPER_EXIT_GRACE_MS,
      maxBuffer: 128 * 1024,
    };
    if (options.signal) execOptions.signal = options.signal;
    const { stdout, stderr } = await runHelper(
      CLICK_ALLOW_BIN,
      ["--timeout", String(boundedTimeoutSec)],
      execOptions
    );
    if (options.signal?.aborted) return { action: "none", strategy: "cg_ax" };
    if (stderr?.trim()) console.log("[2FA] native Allow helper reported diagnostics");
    const parsed = parseJson(stdout);
    if (parsed?.action === "attempted_allow") {
      return { action: "attempted_allow", source: parsed.source, strategy: "cg_ax" };
    }
  } catch (err) {
    if (isAbortFailure(err, options.signal)) return { action: "none", strategy: "cg_ax" };
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    const parsed = stdout.trim() ? parseJson(stdout) : null;
    if (parsed?.action === "attempted_allow") {
      return { action: "attempted_allow", source: parsed.source, strategy: "cg_ax" };
    }
  }
  return { action: "none" };
}

function resolveAllowRuntime(overrides = {}) {
  return {
    strategies: overrides.strategies ?? [tryCgClickAllow],
    probe2FAState: overrides.probe2FAState ?? probe2FAState,
    releaseMouseButtons:
      overrides.releaseMouseButtons ??
      ((releaseOptions = {}) =>
        releaseLeftMouseButton(1, { ...overrides, ...releaseOptions })),
    sleep: overrides.sleep ?? sleep,
    now: overrides.now ?? Date.now,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
  };
}

async function probeWithinDeadline(runtime, deadline, timeoutSec, signal) {
  if (signal?.aborted) return null;
  if (!Number.isFinite(deadline)) return runtime.probe2FAState(timeoutSec, { signal });
  const remainingMs = deadline - runtime.now();
  if (remainingMs <= 0) return null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      runtime.clearTimer(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = runtime.setTimer(() => {
      finish(null);
    }, remainingMs);
    const onAbort = () => finish(null);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    Promise.resolve()
      .then(() => runtime.probe2FAState(timeoutSec, { signal }))
      .then(
        (state) => {
          finish(state);
        },
        (error) => {
          if (isAbortFailure(error, signal)) {
            finish(null);
            return;
          }
          finish(null, error);
        }
      );
  });
}

export async function tryAllowOnce(timeoutSec = 4, options = {}) {
  const runtime = resolveAllowRuntime(options.runtime);
  const strategies = runtime.strategies;
  const offset = Math.max(0, options.strategyOffset ?? 0) % strategies.length;
  const strategy = strategies[offset];
  let result;
  try {
    if (!options.signal?.aborted) {
      result = await strategy(timeoutSec, {
        signal: options.signal,
        runtime: options.runtime,
        compileIfNeeded: false,
      });
    }
  } catch (error) {
    if (!isAbortFailure(error, options.signal)) throw error;
  } finally {
    await runtime.releaseMouseButtons({ compileIfNeeded: false });
  }
  if (options.signal?.aborted) result = null;
  return {
    attempted:
      result?.attempted === true || result?.action === "attempted_allow",
    source: result?.source,
    strategy: result?.strategy,
  };
}

export async function waitForManualAllow(options = {}) {
  const runtime = resolveAllowRuntime(options.runtime);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = runtime.now() + timeoutMs;
  let prompted = false;
  let sawAllowDialog = options.initialSawAllowDialog === true;

  while (runtime.now() < deadline) {
    if (options.signal?.aborted) break;
    const state = await probeWithinDeadline(runtime, deadline, 2, options.signal);
    if (!state) break;
    if (state.action === "has_allow_dialog") sawAllowDialog = true;
    if (state.action === "has_code_dialog" && sawAllowDialog) {
      return { clicked: true, source: state.source, strategy: "manual" };
    }
    if (state.action === "accessibility_unavailable") {
      return { clicked: false, reason: "accessibility_missing" };
    }
    if (state.action === "has_allow_dialog") {
      if (!prompted) {
        console.log(
          "[2FA] 检测到「允许」弹窗 — 请手动点击「允许」，脚本将自动继续（辅助功能请以 macOS 弹窗或权限列表实际显示的原生 helper 条目为准）"
        );
        prompted = true;
      }
    }
    await runtime.sleep(800);
  }
  return { clicked: false };
}

/** Read the popup code through the constrained native helper. */
export async function readPopupCodeViaSwift(timeoutSec = 12, options = {}) {
  if (options.signal?.aborted) {
    return { code: null, source: "swift_ax", capability: "unavailable" };
  }
  let r;
  try {
    r = await runPopupPhase("read_code", timeoutSec, {
      ...options,
      compileIfNeeded: false,
    });
  } catch (error) {
    if (isAbortFailure(error, options.signal)) {
      return { code: null, source: "swift_ax", capability: "unavailable" };
    }
    return { code: null, source: "swift_ax", capability: "unavailable" };
  }
  if (options.signal?.aborted) {
    return { code: null, source: "swift_ax", capability: "unavailable" };
  }
  if (r.action === "accessibility_unavailable") {
    return { code: null, source: "swift_ax", capability: "accessibility_missing" };
  }
  if (r.code) {
    return { code: r.code, source: r.source ?? "swift_ax" };
  }
  return null;
}

/**
 * Read from constrained native AX and window-targeted OCR helpers.
 * @param {number} [timeoutSec]
 * @param {{ rejectCodes?: Set<string>, runtime?: object, signal?: AbortSignal, now?: () => number, deadlineMs?: number }} [options]
 */
export async function readPopupCode(timeoutSec = 10, options = {}) {
  const runtime = options.runtime ?? {};
  const readViaAx = runtime.readPopupCodeViaSwift ?? readPopupCodeViaSwift;
  const readViaOcr = runtime.readPopupCodeViaOcr ?? readPopupCodeViaOcr;
  const rejectCodes = options.rejectCodes;
  if (options.signal?.aborted) return unavailablePopupCode();
  const now = typeof options.now === "function" ? options.now : Date.now;
  const budget = popupReadBudget(timeoutSec, now, options.deadlineMs);
  const deadlineScope = createDeadlineSignal(options.signal, budget.deadline, now, runtime);
  const signal = deadlineScope.signal;
  if (signal.aborted) {
    deadlineScope.dispose();
    return unavailablePopupCode();
  }

  const accept = (hit) => {
    if (typeof hit?.code !== "string" || !/^\d{6}$/.test(hit.code)) {
      return null;
    }
    if (rejectCodes?.has(hit.code)) {
      return rejectedPopupCode();
    }
    return hit;
  };

  try {
    let swiftResult = null;
    try {
      swiftResult = await readViaAx(budget.swiftTimeoutSec, {
        signal,
        compileIfNeeded: false,
      });
    } catch (error) {
      if (isAbortFailure(error, signal)) return unavailablePopupCode();
    }
    if (signal.aborted || now() >= budget.deadline) return unavailablePopupCode();
    const swift = accept(swiftResult);
    if (swift?.rejected || swift?.code) return swift;
    if (swiftResult?.capability === "accessibility_missing") {
      console.log("[2FA] Native AX reader unavailable; trying Vision OCR fallback");
    } else {
      console.log("[2FA] Native AX reader found no code; trying Vision OCR");
    }
    const remainingOcrMs = budget.deadline - now();
    const remainingOcrReadMs =
      remainingOcrMs -
      OCR_PREFLIGHT_TIMEOUT_SEC * 1_000;
    if (remainingOcrReadMs < MIN_OCR_STABILITY_TIMEOUT_SEC * 1_000) {
      return unavailablePopupCode();
    }
    const ocrTimeoutSec = Math.min(
      budget.ocrTimeoutSec,
      Math.floor(remainingOcrReadMs / 1_000)
    );
    if (ocrTimeoutSec < MIN_OCR_STABILITY_TIMEOUT_SEC) return unavailablePopupCode();
    let ocrResult = null;
    try {
      ocrResult = await readViaOcr(ocrTimeoutSec, {
        signal,
        now,
        deadlineMs: budget.deadline,
        compileIfNeeded: false,
        // The launcher already requires Screen Recording. Recheck once here in
        // case macOS changes its TCC decision between preflight and capture.
        requestPermission: true,
      });
    } catch (error) {
      if (isAbortFailure(error, signal)) return unavailablePopupCode();
    }
    if (signal.aborted || now() >= budget.deadline) return unavailablePopupCode();
    const ocr = accept(ocrResult);
    if (ocr?.rejected) return ocr;
    if (ocr?.code) {
      console.log("[2FA] Vision OCR 已识别验证码");
      return ocr;
    }
    if (
      ocrResult?.capability === "permission_missing" ||
      ocrResult?.capability === "unavailable"
    ) {
      return {
        code: null,
        source: "vision",
        capability: ocrResult.capability,
      };
    }
    return {
      code: null,
      source: ocrResult?.source ?? "vision",
      capability:
        ocrResult?.capability ??
        (swiftResult?.capability === "accessibility_missing"
          ? "accessibility_missing"
          : "available"),
    };
  } finally {
    deadlineScope.dispose();
  }
}
