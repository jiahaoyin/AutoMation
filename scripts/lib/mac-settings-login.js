import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitUntil } from "./prompt.js";
import {
  withAccessibilityRetry,
  ensureAutomation,
  checkAutomationGranted,
  openAutomationSettings,
  isAutomationDeniedError,
  getAccessibilityHostApp,
} from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion, openAppleAccountSettings } from "./macos.js";
import {
  compileAxFillHelper,
  fillViaSwiftAx,
  isAxFillAvailable,
} from "./mac-settings-ax-fill.js";
import { completeSupervisedMacSettingsSmsVerification } from "./mac-settings-sms-verification.js";
import { createSmsProviderCodePoller, resolveMacSettingsSmsProviderConfig } from "./mac-settings-sms-provider.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const DUMP_SCPT = path.resolve(__dirname, "../mac-settings-ui-dump.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);

/** 自动化预检：激活系统设置并尝试读取 UI 属性 */
export async function preflightMacSettingsAutomation() {
  const host = getAccessibilityHostApp();
  const check = await checkAutomationGranted();
  if (check.granted) {
    console.log(`[Mac 设置] ✓ 自动化预检通过（${host.name} → 系统设置）`);
    return { ok: true, host: host.name };
  }

  console.warn(`[Mac 设置] 自动化预检未通过: ${check.reason ?? check.code ?? "unknown"}`);
  console.warn(
    `[Mac 设置] 请在 系统设置 → 隐私与安全性 → 自动化 中展开「${host.name}」并勾选「系统设置」`
  );
  openAutomationSettings();

  await ensureAutomation({ quiet: false, timeoutMs: 120_000 });
  return { ok: true, host: host.name };
}

/** 预检：登录窗口是否可见（解析 dump 脚本输出） */
async function preflightLoginWindowVisible() {
  try {
    const { stdout } = await execFileAsync("osascript", [DUMP_SCPT], { timeout: 25_000 });
    const text = stdout.trim();
    if (/login window found/.test(text) && /deep=[1-9]/.test(text)) {
      console.log("[Mac 设置] ✓ 预检：登录窗口已就绪");
      return true;
    }
    console.warn("[Mac 设置] 预检：登录窗口或输入框未就绪，dump 摘要:\n" + text.split("\n").slice(-5).join("\n"));
    return false;
  } catch (err) {
    console.warn("[Mac 设置] 预检 dump 失败:", err.message);
    return false;
  }
}

/** AppleScript 回退（索引式 BFS，不缓存元素引用） */
async function fillViaAppleScript(creds) {
  console.log("[Mac 设置] AppleScript 回退填表…");
  const { stdout, stderr } = await execFileAsync("osascript", [LOGIN_SCPT], {
    timeout: 180_000,
    env: {
      ...process.env,
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
      APPLE_SCRIPT_PASSWORD: creds.password,
      APPLE_SCRIPT_PANE_OPENED: "1",
    },
  });

  if (stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(`[Mac 设置] ${line}`);
    }
  }
  return stdout?.trim() || "ok";
}

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

  await preflightMacSettingsAutomation();
  compileAxFillHelper({ quiet: true });

  await withAccessibilityRetry(
    async () => {
      console.log("[Mac 设置] 打开 Apple Account 深链…");
      openAppleAccountSettings();
      await sleep(3500);

      try {
        await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], { timeout: 20_000 });
      } catch (err) {
        const msg = String(err?.stderr ?? err?.message ?? err);
        if (isAutomationDeniedError({ message: msg })) {
          openAutomationSettings();
          throw new Error(
            "缺少自动化权限：请在 系统设置 → 隐私与安全性 → 自动化 中允许当前终端 App 控制「系统设置」，然后重试。"
          );
        }
      }

      await preflightLoginWindowVisible();

      // 主路径：Swift AX API
      if (isAxFillAvailable()) {
        try {
          await fillViaSwiftAx(creds);
          return;
        } catch (swiftErr) {
          console.warn(
            `[Mac 设置] Swift AX 主路径失败: ${swiftErr.message}，回退 AppleScript…`
          );
        }
      } else {
        console.warn("[Mac 设置] Swift AX helper 不可用，使用 AppleScript 回退");
      }

      const result = await fillViaAppleScript(creds);
      if (result !== "ok") {
        throw new Error(`AppleScript 填表异常: ${result}`);
      }
    },
    { label: "Mac 系统设置填表", maxAttempts: 2 }
  );

  console.log("[Mac 设置] 填表结果: ok");
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
  const hasSmsPhone = Boolean(process.env.APPLE_AUTOMATION_SMS_PHONE?.trim());
  const hasSmsApiUrl = Boolean(process.env.APPLE_AUTOMATION_SMS_API_URL?.trim());
  const supervisedSmsEnabled =
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1" &&
    (process.env.APPLE_AUTOMATION_SMS_ENABLED === "1" || hasSmsPhone || hasSmsApiUrl);
  if (supervisedSmsEnabled) {
    const config = await resolveMacSettingsSmsProviderConfig();
    await completeSupervisedMacSettingsSmsVerification({
      phoneNumber: config.phoneNumber,
      codeProvider: createSmsProviderCodePoller(config),
      supervised: true,
    });
    console.log("[Mac Settings] SMS verification code submitted.");
  } else {
    console.log("\n[Mac Settings] Credentials submitted. Complete SMS verification manually if shown.");
  }
  await waitForMacSettingsLoginComplete();
  return { skipped: false, signedIn: true };
}
