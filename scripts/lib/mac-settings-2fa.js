/**
 * 系统设置 → 双重认证 → 获取验证码（2FA 弹窗未及时出现时的回退）
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-settings-2fa-code.swift");
const BIN = path.resolve(__dirname, "../bin/mac-settings-2fa-code");

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
  return process.platform === "darwin" && fs.existsSync(BIN) && fs.statSync(BIN).isFile();
}

/**
 * @param {{ timeoutMs?: number, verbose?: boolean }} [opts]
 */
export async function fetch2FACodeFromSystemSettings(opts = {}) {
  if (!is2FASettingsHelperAvailable()) {
    const built = compile2FASettingsHelper({ quiet: true });
    if (!built.ok) {
      throw new Error(`2FA 系统设置 helper 不可用: ${built.reason}`);
    }
  }

  const timeoutMs = opts.timeoutMs ?? 90_000;
  const timeoutSec = Math.max(30, Math.ceil(timeoutMs / 1000));

  const { stdout, stderr } = await execFileAsync(BIN, ["--timeout", String(timeoutSec)], {
    timeout: timeoutMs + 15_000,
    maxBuffer: 512 * 1024,
  });

  if (opts.verbose !== false && stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(`[2FA] ${line}`);
    }
  }

  let parsed = { ok: false, code: null, message: stdout?.trim() || "empty" };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    /* keep default */
  }

  if (!parsed.ok || !parsed.code) {
    throw new Error(parsed.message || "系统设置获取验证码失败");
  }

  const code = String(parsed.code).replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) {
    throw new Error(`验证码格式异常: ${parsed.code}`);
  }
  return code;
}
