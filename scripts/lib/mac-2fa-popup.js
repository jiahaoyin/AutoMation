/**
 * 2FA 弹窗：CG 点击允许 → AppleScript → Swift AX
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForAllowClick } from "./mac-2fa-allow.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AS_SCRIPT = path.resolve(__dirname, "../apple-2fa-phase.applescript");
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-read.swift");
const SWIFT_BIN = path.resolve(__dirname, "../bin/mac-2fa-popup-read");
const CLICK_ALLOW_SRC = path.resolve(__dirname, "../swift/mac-2fa-click-allow.swift");
const CLICK_ALLOW_BIN = path.resolve(__dirname, "../bin/mac-2fa-click-allow");

/** @typedef {"dismiss_stale"|"pre_allow"|"read_code"} PopupPhase */

function needsRecompile(src, bin) {
  if (!fs.existsSync(bin)) return true;
  if (!fs.existsSync(src)) return false;
  return fs.statSync(src).mtimeMs > fs.statSync(bin).mtimeMs;
}

function compileSwift(src, bin, quiet = true) {
  if (process.platform !== "darwin" || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", bin, src, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    if (!quiet) console.warn(`[2FA] 编译失败 ${path.basename(src)}:`, r.stderr?.trim());
    return false;
  }
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    /* ignore */
  }
  return true;
}

export function compile2FAPopupHelper(options = {}) {
  const ok = compileSwift(SWIFT_SRC, SWIFT_BIN, options.quiet !== false);
  return ok ? { ok: true, bin: SWIFT_BIN } : { ok: false, reason: "compile failed" };
}

function ensureBin(src, bin) {
  if (needsRecompile(src, bin)) compileSwift(src, bin);
  return fs.existsSync(bin);
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
  if (!ensureBin(SWIFT_SRC, SWIFT_BIN)) {
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
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

async function runClickAllowCg(timeoutSec = 3) {
  if (!ensureBin(CLICK_ALLOW_SRC, CLICK_ALLOW_BIN)) {
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
  try {
    const { stdout, stderr } = await execFileAsync(CLICK_ALLOW_BIN, ["--timeout", String(timeoutSec)], {
      timeout: (timeoutSec + 8) * 1000,
      maxBuffer: 128 * 1024,
    });
    if (stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) {
        console.log(`[2FA] ${line}`);
      }
    }
    return parsePhaseJson(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) return parsePhaseJson(stdout);
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }
}

function logPhaseResult(phase, r) {
  if (r.action === "clicked_allow") {
    console.log(`[2FA] ✓ 已点击「允许」(${r.source || "弹窗"})`);
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

export async function runPopupPhase(phase, timeoutSec = 6) {
  if (process.platform !== "darwin") return { ok: false, action: "none", code: null, source: null, raw: null };

  if (phase === "pre_allow") {
    const allow = await waitForAllowClick({ timeoutMs: timeoutSec * 1000 });
    if (allow.clicked) {
      const r = {
        ok: true,
        action: "clicked_allow",
        code: null,
        source: allow.source ?? allow.strategy ?? null,
        raw: null,
      };
      logPhaseResult(phase, r);
      return r;
    }
    return { ok: false, action: "none", code: null, source: null, raw: null };
  }

  const as = await runAppleScriptPhase(phase, timeoutSec);
  if (as.ok || as.action === "clicked_allow" || as.action === "dismissed_stale") {
    logPhaseResult(phase, as);
    return as;
  }

  const swift = await runSwiftPhase(phase, timeoutSec);
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

export async function tryFetchMac2FAPopupAx(timeoutSec = 12) {
  const r = await runPopupPhase("read_code", timeoutSec);
  if (!r.code) return null;
  return { code: r.code, source: r.source, raw: r.raw, action: r.action };
}

export function is2FAPopupHelperAvailable() {
  return ensureBin(SWIFT_SRC, SWIFT_BIN);
}
