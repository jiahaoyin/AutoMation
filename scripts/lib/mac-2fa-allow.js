/**
 * 统一「允许」点击策略阶梯：AppleScript → CG → cliclick → 手动等待
 * AppleScript 通过 System Events 遍历全部进程，比 Swift 仅扫 priorityApps 更可靠
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";
import { readPopupCodeViaOcr } from "./mac-2fa-ocr.js";

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

async function runAppleScriptPhase(phase, timeoutSec = 3) {
  if (process.platform !== "darwin" || !fs.existsSync(AS_SCRIPT)) {
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [AS_SCRIPT, `--phase=${phase}`, `--timeout=${timeoutSec}`],
      { timeout: (timeoutSec + 12) * 1000, maxBuffer: 256 * 1024 }
    );
    return parsePhaseJson(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) return parsePhaseJson(stdout);
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
}

function cliclickAvailable() {
  const r = spawnSync("which", ["cliclick"], { encoding: "utf-8" });
  return r.status === 0;
}

async function releaseMouseButtons() {
  if (!cliclickAvailable()) return;
  try {
    await execFileAsync("cliclick", ["du:."], { timeout: 3000 });
  } catch {
    /* ignore */
  }
}

async function probe2FAStateSwift(timeoutSec = 2) {
  if (!ensureBin(SWIFT_SRC, SWIFT_BIN)) return { action: "idle" };
  try {
    const { stdout } = await execFileAsync(
      SWIFT_BIN,
      ["--phase", "probe", "--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 5) * 1000, maxBuffer: 128 * 1024 }
    );
    const parsed = parseJson(stdout);
    if (parsed?.action) {
      return { action: parsed.action, source: parsed.source ?? undefined, code: parsed.code ?? undefined };
    }
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    const parsed = stdout.trim() ? parseJson(stdout) : null;
    if (parsed?.action) {
      return { action: parsed.action, source: parsed.source ?? undefined, code: parsed.code ?? undefined };
    }
  }
  return { action: "idle" };
}

/**
 * @returns {Promise<{ action: string, source?: string, code?: string }>}
 */
export async function probe2FAState(timeoutSec = 2) {
  const as = await runAppleScriptPhase("probe", timeoutSec);
  if (as.action !== "none" && as.action !== "idle") {
    return { action: as.action, source: as.source ?? undefined, code: as.code ?? undefined };
  }
  return probe2FAStateSwift(timeoutSec);
}

async function tryCgClickAllow(timeoutSec = 3) {
  if (!ensureBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) return { action: "none" };
  try {
    const { stdout, stderr } = await execFileAsync(
      CLICK_ALLOW_BIN,
      ["--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 8) * 1000, maxBuffer: 128 * 1024 }
    );
    if (stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) console.log(`[2FA] ${line}`);
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

async function tryReturnKeyAllow(timeoutSec = 3) {
  const r = await runAppleScriptPhase("allow_return", timeoutSec);
  if (r.action === "clicked_allow") {
    return { action: "clicked_allow", source: r.source ?? undefined, strategy: "return_key" };
  }
  return { action: "none" };
}

async function tryAppleScriptAllow(timeoutSec = 4) {
  const r = await runAppleScriptPhase("pre_allow", timeoutSec);
  if (r.action === "clicked_allow") {
    return { action: "clicked_allow", source: r.source ?? undefined, strategy: "applescript" };
  }
  return { action: "none" };
}

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
      const coord = `${parsed.x},${parsed.y}`;
      await execFileAsync("cliclick", [`m:${coord}`, `dd:${coord}`], { timeout: 3000 });
      await sleep(320);
      await execFileAsync("cliclick", [`du:${coord}`], { timeout: 3000 });
      console.log(`[2FA] cliclick 点击允许 (${coord}) source=${parsed.source ?? "?"}`);
      return { action: "clicked_allow", source: parsed.source, strategy: "cliclick" };
    }
  } catch {
    await releaseMouseButtons();
  }
  return { action: "none" };
}

export async function confirmAllowSuccess() {
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 1500 : 800);
    const state = await probe2FAState(2);
    if (state.action === "has_code_dialog") return true;
    if (state.action === "has_allow_dialog") continue;
  }
  return false;
}

async function dismissStaleCodeDialogOnce() {
  const r = await runAppleScriptPhase("dismiss_stale", 3);
  if (r.action === "dismissed_stale") {
    const old = r.code ? ` 旧码=${r.code}` : "";
    console.log(`[2FA] 已关闭残留验证码窗${old}`);
    await sleep(400);
    return r.code ?? null;
  }
  return null;
}

export async function tryAllowOnce(timeoutSec = 4, options = {}) {
  const strategies = [tryReturnKeyAllow, tryAppleScriptAllow, tryCliclickAllow, tryCgClickAllow];
  const offset = Math.max(0, options.strategyOffset ?? 0) % strategies.length;
  const maxStrategies = Math.max(
    1,
    Math.min(strategies.length, options.maxStrategies ?? strategies.length)
  );
  for (let index = 0; index < maxStrategies; index += 1) {
    const fn = strategies[(offset + index) % strategies.length];
    const r = await fn(timeoutSec);
    if (r.action === "clicked_allow") {
      const ok = options.confirmClick === false ? true : await confirmAllowSuccess();
      if (ok) {
        await releaseMouseButtons();
        return { clicked: true, source: r.source, strategy: r.strategy };
      }
      console.log(`[2FA] 点击后未确认成功 (${r.strategy})，尝试下一策略…`);
    }
    await releaseMouseButtons();
  }
  return { clicked: false };
}

export async function waitForManualAllow(options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let prompted = false;
  let sawAllowDialog = false;

  while (Date.now() < deadline) {
    const state = await probe2FAState(2);
    if (state.action === "has_allow_dialog") sawAllowDialog = true;
    if (state.action === "has_code_dialog" && sawAllowDialog) {
      return { clicked: true, source: state.source, strategy: "manual" };
    }
    if (state.action === "has_allow_dialog") {
      if (!prompted) {
        console.log(
          "[2FA] 检测到「允许」弹窗 — 请手动点击「允许」，脚本将自动继续（最长等待 120 秒）"
        );
        prompted = true;
      }
    }
    await sleep(800);
  }
  return { clicked: false };
}

export function shouldDismissCodeBeforeAllow({
  staleBoundaryEstablished = false,
  sawAllowDialog = false,
  allowExplicitlyClicked = false,
} = {}) {
  return !staleBoundaryEstablished && !sawAllowDialog && !allowExplicitlyClicked;
}

export async function waitForAllowClick(options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let autoAttempts = 0;
  let manualStarted = false;
  let sawAllowDialog = options.sawAllowDialog === true;
  let allowExplicitlyClicked = false;
  const staleBoundaryEstablished = options.staleBoundaryEstablished === true;
  const allowManual = options.allowManual !== false;
  const strategyOffset = options.strategyOffset ?? 0;
  const maxStrategiesPerAttempt = options.maxStrategiesPerAttempt;
  const confirmClick = options.confirmClick;

  while (Date.now() < deadline) {
    polls += 1;
    const state = await probe2FAState(3);

    if (state.action === "has_allow_dialog") {
      sawAllowDialog = true;
    }

    if (state.action === "has_code_dialog") {
      if (shouldDismissCodeBeforeAllow({
        staleBoundaryEstablished,
        sawAllowDialog,
        allowExplicitlyClicked,
      })) {
        console.log("[2FA] 验证码窗在「允许」之前出现，视为残留窗并关闭…");
        await dismissStaleCodeDialogOnce();
        continue;
      }
      console.log("[2FA] ✓ 验证码窗已出现（允许已生效）");
      return { clicked: true, source: state.source, strategy: "code_visible" };
    }

    if (state.action === "has_allow_dialog" || state.action === "idle") {
      autoAttempts += 1;
      const r = await tryAllowOnce(
        Math.max(1, Math.ceil(Math.min(5_000, timeoutMs) / 1000)),
        {
          strategyOffset: strategyOffset + autoAttempts - 1,
          maxStrategies: maxStrategiesPerAttempt,
          confirmClick,
        }
      );
      if (r.clicked) {
        allowExplicitlyClicked = true;
        console.log(
          `[2FA] ✓ 已点击「允许」(${r.strategy || "auto"}${r.source ? ` / ${r.source}` : ""})`
        );
        return { clicked: true, source: r.source, strategy: r.strategy };
      }

      if (
        allowManual &&
        state.action === "has_allow_dialog" &&
        autoAttempts >= 4 &&
        !manualStarted
      ) {
        manualStarted = true;
        console.log("[2FA] 自动点击未成功，等待手动点击「允许」…");
        const manual = await waitForManualAllow({ timeoutMs: deadline - Date.now() });
        if (manual.clicked) {
          allowExplicitlyClicked = true;
          console.log("[2FA] ✓ 用户已手动点击「允许」");
          return { clicked: true, source: manual.source, strategy: "manual" };
        }
      }
    }

    if (polls === 1 || polls % 6 === 0) {
      const hint =
        state.action === "has_allow_dialog"
          ? "已检测到允许弹窗，正在尝试点击…"
          : "等待允许弹窗出现…";
      console.log(`[2FA] ${hint}（请确认终端已获辅助功能 + System Events 自动化）`);
    }
    await sleep(600);
  }

  const last = await probe2FAState(2);
  if (last.action === "has_code_dialog" && (sawAllowDialog || allowExplicitlyClicked)) {
    return { clicked: true, source: last.source, strategy: "code_visible_late" };
  }

  return { clicked: false, reason: "timeout" };
}

/** 通过 AppleScript 直接读弹窗验证码 */
export async function readPopupCodeViaAppleScript(timeoutSec = 12) {
  const r = await runAppleScriptPhase("read_code", timeoutSec);
  if (r.code) {
    return { code: r.code, raw: r.raw, source: r.source ?? "applescript" };
  }
  return null;
}

/**
 * 并行读码：code 窗已出现时优先 OCR，避免每轮空等 AppleScript
 * @param {number} [timeoutSec]
 * @param {{ preferOcr?: boolean, debugDir?: string, rejectCodes?: Set<string>, requireFormattedRaw?: boolean }} [options]
 */
export async function readPopupCode(timeoutSec = 10, options = {}) {
  const preferOcr = options.preferOcr ?? false;
  const rejectCodes = options.rejectCodes;
  const ocrOpts = {
    debugDir: options.debugDir,
    requireFormattedRaw: options.requireFormattedRaw ?? true,
  };
  const asTimeout = preferOcr ? Math.min(2, timeoutSec) : Math.min(timeoutSec, 8);
  const ocrTimeout = preferOcr ? timeoutSec : timeoutSec;

  const accept = (hit) => {
    if (!hit?.code) return null;
    if (rejectCodes?.has(hit.code)) {
      console.log(`[2FA] 跳过旧/无效验证码 ${hit.code}`);
      return null;
    }
    return hit;
  };

  if (preferOcr) {
    const [ocr, as] = await Promise.all([
      readPopupCodeViaOcr(ocrTimeout, ocrOpts),
      readPopupCodeViaAppleScript(asTimeout),
    ]);
    const hit = accept(ocr) ?? accept(as);
    if (hit) {
      if (hit.source?.includes("vision")) {
        console.log(`[2FA] Vision OCR 读到验证码 ${hit.code} 原文="${hit.raw ?? ""}"`);
      }
      return hit;
    }
    console.log("[2FA] 并行 OCR/AppleScript 均未读到验证码");
    return null;
  }

  const as = accept(await readPopupCodeViaAppleScript(asTimeout));
  if (as?.code) return as;
  console.log("[2FA] AX/AppleScript 未读到验证码，尝试 Vision OCR…");
  const ocr = accept(await readPopupCodeViaOcr(ocrTimeout, ocrOpts));
  if (ocr?.code) {
    console.log(`[2FA] Vision OCR 读到验证码 ${ocr.code} 原文="${ocr.raw ?? ""}"`);
    return ocr;
  }
  return null;
}
