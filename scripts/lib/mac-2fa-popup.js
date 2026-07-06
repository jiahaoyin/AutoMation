/**
 * macOS 系统 2FA 弹窗：分阶段 Swift AX（dismiss → allow → read）
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-read.swift");
const BIN = path.resolve(__dirname, "../bin/mac-2fa-popup-read");

/** @typedef {"dismiss_stale"|"pre_allow"|"read_code"} PopupPhase */

export function compile2FAPopupHelper(options = {}) {
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
    if (!quiet) console.warn("[2FA] Swift popup helper 编译失败:", r.stderr?.trim() || r.error);
    return { ok: false, reason: r.stderr?.trim() || String(r.error) };
  }
  try {
    fs.chmodSync(BIN, 0o755);
  } catch {
    /* ignore */
  }
  return { ok: true, bin: BIN };
}

export function is2FAPopupHelperAvailable() {
  return process.platform === "darwin" && fs.existsSync(BIN) && fs.statSync(BIN).isFile();
}

async function ensurePopupHelper() {
  if (!is2FAPopupHelperAvailable()) {
    const built = compile2FAPopupHelper({ quiet: true });
    if (!built.ok) return false;
  }
  return true;
}

function logStderrActions(stderr) {
  if (!stderr?.trim()) return;
  for (const line of stderr.trim().split("\n")) {
    if (/clicked Allow|dismissed|code=/.test(line)) {
      console.log(`[2FA] ${line.replace(/^\[2FA-popup \d+\] /, "")}`);
    }
  }
}

/**
 * @param {PopupPhase} phase
 * @param {number} [timeoutSec]
 */
export async function runPopupPhase(phase, timeoutSec = 6) {
  if (process.platform !== "darwin") return { ok: false, action: "none" };
  if (!(await ensurePopupHelper())) return { ok: false, action: "none" };

  try {
    const { stdout, stderr } = await execFileAsync(
      BIN,
      ["--phase", phase, "--timeout", String(timeoutSec)],
      { timeout: (timeoutSec + 8) * 1000, maxBuffer: 256 * 1024 }
    );
    logStderrActions(stderr);
    let parsed = { ok: false, code: null, action: "none" };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return { ok: false, action: "none" };
    }
    const code =
      parsed.code != null ? String(parsed.code).replace(/\D/g, "").slice(0, 6) : null;
    return {
      ok: Boolean(parsed.ok),
      action: parsed.action ?? "none",
      code: code?.length === 6 ? code : null,
      source: parsed.source ?? null,
      raw: parsed.raw ?? null,
    };
  } catch (err) {
    logStderrActions(err instanceof Error && "stderr" in err ? String(err.stderr || "") : "");
    return { ok: false, action: "none" };
  }
}

/** 多次尝试关闭残留验证码窗；返回被关闭的旧码列表 */
export async function dismissStale2FAPopups(maxRounds = 6) {
  if (!(await ensurePopupHelper())) return { count: 0, codes: [] };
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

/**
 * @deprecated 使用 runPopupPhase + 分阶段 waitForMac2FACode
 * @param {number} [timeoutSec]
 */
export async function tryFetchMac2FAPopupAx(timeoutSec = 12) {
  const r = await runPopupPhase("read_code", timeoutSec);
  if (!r.code) return null;
  return { code: r.code, source: r.source, raw: r.raw, action: r.action };
}
