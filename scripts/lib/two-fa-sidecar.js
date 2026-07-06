import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetch2FACodeFromSystemSettings } from "./mac-settings-2fa.js";
import { sleep } from "./prompt.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCPT = path.resolve(__dirname, "../apple-2fa-wait.scpt");

function get2FAConfig() {
  const num = (key, fallback) => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    popupFirstMs: num("BROWSER_2FA_POPUP_WAIT_MS", 45_000),
    settingsFallback: process.env.BROWSER_2FA_SETTINGS_FALLBACK !== "0",
    pollIntervalMs: num("BROWSER_2FA_POLL_MS", 1500),
  };
}

/**
 * 单次轮询 macOS 系统弹窗 2FA
 * @param {number} [timeoutSec]
 */
export async function tryFetchMac2FACode(timeoutSec = 12) {
  try {
    const { stdout } = await execFileAsync(SCPT, [`--timeout=${timeoutSec}`], {
      timeout: (timeoutSec + 8) * 1000,
    });
    const digits = stdout.trim().replace(/\D/g, "");
    const code = digits.length >= 6 ? digits.slice(0, 6) : null;
    return code ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.stderr || err.message : String(err);
    if (process.env.DEBUG_2FA) console.warn("[2FA] 扫描:", msg.slice(0, 200));
    return null;
  }
}

/**
 * 等待 2FA：先扫系统弹窗，超时后从系统设置获取验证码
 * @param {object} [options]
 */
export async function waitForMac2FACode(options = {}) {
  const cfg = get2FAConfig();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const popupFirstMs = options.popupFirstMs ?? cfg.popupFirstMs;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let settingsTried = false;

  console.log("[2FA] 扫描系统弹窗（允许 / 验证码）…");

  while (Date.now() < deadline) {
    polls += 1;
    const elapsed = timeoutMs - (deadline - Date.now());
    const inPopupPhase = elapsed < popupFirstMs;

    if (polls === 1 || polls % 8 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const phase = inPopupPhase ? "弹窗" : "弹窗+设置";
      console.log(`[2FA] 轮询中（${phase}）… 剩余约 ${left}s`);
    }

    const code = await tryFetchMac2FACode(10);
    if (code) {
      console.log("[2FA] 已获取 6 位验证码（系统弹窗）");
      return code;
    }

    if (
      cfg.settingsFallback &&
      !settingsTried &&
      !inPopupPhase &&
      process.platform === "darwin"
    ) {
      settingsTried = true;
      const leftMs = deadline - Date.now();
      if (leftMs > 25_000) {
        console.log(
          "[2FA] 弹窗未及时出现，改从 系统设置 → 登录与安全性 → 双重认证 → 获取验证码…"
        );
        try {
          const settingsCode = await fetch2FACodeFromSystemSettings({
            timeoutMs: Math.min(leftMs - 5000, 120_000),
          });
          console.log("[2FA] 已获取 6 位验证码（系统设置）");
          return settingsCode;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[2FA] 系统设置获取验证码失败: ${msg}`);
          console.log("[2FA] 继续轮询系统弹窗…");
        }
      }
    }

    await sleep(cfg.pollIntervalMs);
  }

  throw new Error(
    "macOS 2FA 验证码获取超时：请确认弹窗已出现或系统设置中可手动获取验证码，并检查辅助功能/自动化权限"
  );
}

/**
 * @param {object} [options]
 */
export function startMac2FAWait(options = {}) {
  const promise = waitForMac2FACode(options);
  return {
    promise,
    async getCode() {
      return promise;
    },
  };
}
