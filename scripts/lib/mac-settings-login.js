import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitUntil } from "./prompt.js";
import { withAccessibilityRetry } from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion, openAppleAccountSettings } from "./macos.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");

export async function isMacSettingsSignedIn() {
  try {
    const { stdout } = await execFileAsync("osascript", [SIGNED_IN_SCPT], { timeout: 15_000 });
    return stdout.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

/**
 * 打开系统设置 Apple ID 并填入账号密码（手机验证码人工完成）
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillMacSettingsAppleLogin(creds) {
  console.log("\n[Mac 设置] 打开 Apple ID 并填入账号密码…");

  const { stdout, stderr } = await withAccessibilityRetry(
    async () => {
      // 辅助功能引导可能停在「隐私→辅助功能」页，填表前强制切回 Apple 登录页
      openAppleAccountSettings();
      await sleep(2500);
      return execFileAsync("osascript", [LOGIN_SCPT], {
        timeout: 120_000,
        env: {
          ...process.env,
          APPLE_SCRIPT_APPLE_ID: creds.appleId,
          APPLE_SCRIPT_PASSWORD: creds.password,
        },
      });
    },
    { label: "Mac 系统设置填表", maxAttempts: 3 }
  );

  if (stderr?.trim()) {
    console.warn("[Mac 设置] AppleScript stderr:", stderr.trim());
  }
  console.log("[Mac 设置] 填表结果:", stdout.trim() || "ok");
}

/**
 * 等待 Mac 设置中 Apple ID 完全登录（手机验证码人工 + 自动轮询 Sign Out / 邮箱）
 */
export async function waitForMacSettingsLoginComplete(options = {}) {
  await waitUntil(
    "[Mac 设置] 请在系统设置中完成手机验证码（人工），脚本将等待直至检测到已登录…",
    async () => isMacSettingsSignedIn(),
    {
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      intervalMs: options.intervalMs ?? 2500,
      manualHint:
        "\n[Mac 设置] 若已确认 Apple ID 在系统设置中登录成功，按 Enter 继续…",
    }
  );

  await sleep(1500);
  const ok = await isMacSettingsSignedIn();
  if (!ok) {
    console.warn("[Mac 设置] 自动检测未确认登录，但已手动继续");
  } else {
    console.log("[Mac 设置] ✓ 已检测到 Apple ID 登录完成");
  }
}

/**
 * @param {{ appleId: string, password: string }} creds
 */
export async function runMacSettingsLoginPhase(creds) {
  const version = ensureMacOS15({ strict: false });
  console.log(
    `[Mac 设置] macOS ${version.productVersion}（目标 macOS 15 Sequoia）`
  );

  const already = await isMacSettingsSignedIn();
  if (already) {
    console.log("[Mac 设置] 检测到已登录 Apple ID，跳过填表");
    return { skipped: true, signedIn: true };
  }

  await fillMacSettingsAppleLogin(creds);
  console.log(
    "\n[Mac 设置] 账号密码已提交。若出现手机验证码，请在系统界面人工输入。"
  );
  await waitForMacSettingsLoginComplete();
  return { skipped: false, signedIn: true };
}
