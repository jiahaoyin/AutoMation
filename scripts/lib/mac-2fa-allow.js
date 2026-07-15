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
  if (!ensureReleaseBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) return false;
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
  const result = await runPopupPhase("probe", timeoutSec, options);
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
  if (!ensureBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) return { action: "none" };
  try {
    const execOptions = { timeout: (timeoutSec + 8) * 1000, maxBuffer: 128 * 1024 };
    if (options.signal) execOptions.signal = options.signal;
    const { stdout, stderr } = await execFileAsync(
      CLICK_ALLOW_BIN,
      ["--timeout", String(timeoutSec)],
      execOptions
    );
    if (stderr?.trim()) console.log("[2FA] native Allow helper reported diagnostics");
    const parsed = parseJson(stdout);
    if (parsed?.action === "attempted_allow") {
      return { action: "attempted_allow", source: parsed.source, strategy: "cg_ax" };
    }
  } catch (err) {
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
      overrides.releaseMouseButtons ?? (() => releaseLeftMouseButton(1, overrides)),
    sleep: overrides.sleep ?? sleep,
    now: overrides.now ?? Date.now,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
  };
}

async function probeWithinDeadline(runtime, deadline, timeoutSec) {
  if (!Number.isFinite(deadline)) return runtime.probe2FAState(timeoutSec);
  const remainingMs = deadline - runtime.now();
  if (remainingMs <= 0) return null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = runtime.setTimer(() => {
      settled = true;
      resolve(null);
    }, remainingMs);

    Promise.resolve()
      .then(() => runtime.probe2FAState(timeoutSec))
      .then(
        (state) => {
          if (settled) return;
          settled = true;
          runtime.clearTimer(timer);
          resolve(state);
        },
        (error) => {
          if (settled) return;
          settled = true;
          runtime.clearTimer(timer);
          reject(error);
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
    result = await strategy(timeoutSec, { signal: options.signal });
  } finally {
    await runtime.releaseMouseButtons();
  }
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
    const state = await probeWithinDeadline(runtime, deadline, 2);
    if (!state) break;
    if (state.action === "has_allow_dialog") sawAllowDialog = true;
    if (state.action === "has_code_dialog" && sawAllowDialog) {
      return { clicked: true, source: state.source, strategy: "manual" };
    }
    if (state.action === "has_allow_dialog") {
      if (!prompted) {
        console.log(
          "[2FA] 检测到「允许」弹窗 — 请手动点击「允许」，脚本将自动继续（请确认终端已获辅助功能）"
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
  const r = await runPopupPhase("read_code", timeoutSec, options);
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
 * @param {{ rejectCodes?: Set<string>, runtime?: object }} [options]
 */
export async function readPopupCode(timeoutSec = 10, options = {}) {
  const runtime = options.runtime ?? {};
  const readViaAx = runtime.readPopupCodeViaSwift ?? readPopupCodeViaSwift;
  const readViaOcr = runtime.readPopupCodeViaOcr ?? readPopupCodeViaOcr;
  const rejectCodes = options.rejectCodes;
  const totalTimeout = Math.max(1, Number(timeoutSec) || 10);
  const swiftTimeout = Math.min(2, totalTimeout);
  const ocrTimeout = Math.max(1, totalTimeout - swiftTimeout);

  const accept = (hit) => {
    if (typeof hit?.code !== "string" || !/^\d{6}$/.test(hit.code)) {
      return null;
    }
    if (rejectCodes?.has(hit.code)) {
      console.log("[2FA] 跳过旧/无效验证码");
      return null;
    }
    return hit;
  };

  const swiftResult = await readViaAx(swiftTimeout, { signal: options.signal });
  const swift = accept(swiftResult);
  if (swift?.code) return swift;
  if (swiftResult?.capability === "accessibility_missing") {
    console.log("[2FA] Native AX reader unavailable; trying Vision OCR fallback");
  } else {
    console.log("[2FA] Native AX reader found no code; trying Vision OCR");
  }
  const ocrResult = await readViaOcr(ocrTimeout, { signal: options.signal });
  const ocr = accept(ocrResult);
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
}
