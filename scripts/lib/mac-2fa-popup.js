/**
 * macOS 系统 2FA 弹窗：Swift AX 全树扫描（允许 + 读码）
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

/**
 * 登录前关闭残留的验证码弹窗（避免读到上次的 609574）
 */
export async function dismissStale2FAPopups() {
  if (process.platform !== "darwin") return false;
  if (!is2FAPopupHelperAvailable()) {
    const built = compile2FAPopupHelper({ quiet: true });
    if (!built.ok) return false;
  }
  try {
    await execFileAsync(BIN, ["--dismiss-stale", "--timeout", "2"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} [timeoutSec]
 * @returns {Promise<{ code: string, source?: string|null, raw?: string|null, action?: string }|null>}
 */
export async function tryFetchMac2FAPopupAx(timeoutSec = 4) {
  if (process.platform !== "darwin") return null;

  if (!is2FAPopupHelperAvailable()) {
    const built = compile2FAPopupHelper({ quiet: true });
    if (!built.ok) return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync(BIN, ["--timeout", String(timeoutSec)], {
      timeout: (timeoutSec + 6) * 1000,
      maxBuffer: 256 * 1024,
    });

    if (stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) {
        if (/clicked Allow|dismissed|code=/.test(line)) {
          console.log(`[2FA] ${line.replace(/^\[2FA-popup \d+\] /, "")}`);
        }
      }
    }

    let parsed = { ok: false, code: null };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return null;
    }

    if (!parsed.ok || !parsed.code) {
      if (parsed.action && parsed.action !== "none" && process.env.DEBUG_2FA) {
        console.log(`[2FA] popup AX action=${parsed.action}`);
      }
      return null;
    }
    const code = String(parsed.code).replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) return null;
    return {
      code,
      source: parsed.source ?? null,
      raw: parsed.raw ?? null,
      action: parsed.action ?? null,
    };
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr || "") : "";
    if (stderr.trim()) {
      for (const line of stderr.trim().split("\n")) {
        if (/clicked Allow|dismissed|code=/.test(line)) {
          console.log(`[2FA] ${line.replace(/^\[2FA-popup \d+\] /, "")}`);
        }
      }
    }
    if (process.env.DEBUG_2FA) {
      const msg = err instanceof Error ? err.stderr || err.message : String(err);
      console.warn("[2FA] popup AX:", msg.slice(0, 200));
    }
    return null;
  }
}
