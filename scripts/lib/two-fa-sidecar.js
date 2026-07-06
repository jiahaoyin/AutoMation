import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCPT = path.resolve(__dirname, "../apple-2fa-wait.scpt");

/**
 * 单次轮询 macOS FollowUpUI 2FA（短超时，供循环调用）
 * @param {number} [timeoutSec]
 */
export async function tryFetchMac2FACode(timeoutSec = 12) {
  try {
    const { stdout } = await execFileAsync(SCPT, [`--timeout=${timeoutSec}`], {
      timeout: (timeoutSec + 8) * 1000,
    });
    const code = stdout.trim().match(/\d{6}/)?.[0];
    return code ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.stderr || err.message : String(err);
    if (process.env.DEBUG_2FA) console.warn("[2FA] 扫描:", msg.slice(0, 200));
    return null;
  }
}

/**
 * 在后台持续轮询，直到拿到 6 位验证码
 * @param {object} [options]
 */
export async function waitForMac2FACode(options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;

  console.log("[2FA] 扫描系统弹窗（允许 / 验证码）…");

  while (Date.now() < deadline) {
    polls += 1;
    if (polls === 1 || polls % 8 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`[2FA] 轮询中… 剩余约 ${left}s（需辅助功能 + 自动化权限）`);
    }
    const code = await tryFetchMac2FACode(10);
    if (code) {
      console.log("[2FA] 已获取 6 位验证码");
      return code;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    "macOS 2FA 验证码获取超时：请确认弹窗已出现，且终端已授予「辅助功能」与「自动化→System Events」权限"
  );
}

/**
 * 启动并行等待（在提交密码前调用）
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
