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
 * @param {number} [timeoutSec]
 * @returns {Promise<string|null>}
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

    if (process.env.DEBUG_2FA && stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) {
        console.log(`[2FA] ${line}`);
      }
    }

    let parsed = { ok: false, code: null };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return null;
    }

    if (!parsed.ok || !parsed.code) return null;
    const code = String(parsed.code).replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) return null;
    return {
      code,
      source: parsed.source ?? null,
      raw: parsed.raw ?? null,
    };
  } catch (err) {
    if (process.env.DEBUG_2FA) {
      const msg = err instanceof Error ? err.stderr || err.message : String(err);
      console.warn("[2FA] popup AX:", msg.slice(0, 200));
    }
    return null;
  }
}
