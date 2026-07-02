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
export async function tryFetchMac2FACode(timeoutSec = 8) {
  try {
    const { stdout } = await execFileAsync(SCPT, [`--timeout=${timeoutSec}`], {
      timeout: (timeoutSec + 5) * 1000,
    });
    const code = stdout.trim().match(/\d{6}/)?.[0];
    return code ?? null;
  } catch {
    return null;
  }
}

/**
 * 在后台持续轮询，直到拿到 6 位验证码
 * @param {object} [options]
 */
export async function waitForMac2FACode(options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  console.log("[2FA] 监听 macOS FollowUpUI 弹窗…");

  while (Date.now() < deadline) {
    const code = await tryFetchMac2FACode(6);
    if (code) {
      console.log("[2FA] 已获取 6 位验证码");
      return code;
    }
    await sleep(intervalMs);
  }

  throw new Error("macOS 2FA 验证码获取超时");
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
