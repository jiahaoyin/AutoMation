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
import { saveMacSettingsSmsProviderConfig } from "./credentials.js";
import { completeSupervisedMacSettingsSmsVerification } from "./mac-settings-sms-verification.js";
import { isMacSettingsSmsHelperAvailable } from "./mac-settings-sms-ax.js";
import { createSmsProviderCodePoller, resolveMacSettingsSmsProviderConfig } from "./mac-settings-sms-provider.js";
import {
  completeMacSettingsPostSmsFinalization,
  isMacSettingsPostSmsFinalizationEnabled,
} from "./mac-settings-post-sms-finalization.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const DUMP_SCPT = path.resolve(__dirname, "../mac-settings-ui-dump.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];

export function sanitizedMacSettingsChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

function clearMacSettingsSmsRuntimeSecrets(env = process.env) {
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete env[key];
}

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
    const { stdout } = await execFileAsync("osascript", [DUMP_SCPT], {
      timeout: 25_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    const text = stdout.trim();
    if (/login window found/.test(text) && /deep=[1-9]/.test(text)) {
      console.log("[Mac 设置] ✓ 预检：登录窗口已就绪");
      return true;
    }
    console.warn("[Mac 设置] 预检：登录窗口或输入框未就绪");
    return false;
  } catch {
    console.warn("[Mac 设置] 预检 AX probe 失败");
    return false;
  }
}

/** AppleScript 回退（索引式 BFS，不缓存元素引用） */
async function fillViaAppleScript(creds) {
  console.log("[Mac 设置] AppleScript 回退填表…");
  const { stdout, stderr } = await execFileAsync("osascript", [LOGIN_SCPT], {
    timeout: 180_000,
    env: {
      ...sanitizedMacSettingsChildEnv(),
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
      APPLE_SCRIPT_PASSWORD: creds.password,
      APPLE_SCRIPT_PANE_OPENED: "1",
    },
  });

  if (stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      const match = /^\[step\s+(\d+)\]/.exec(line.trim());
      if (match) console.log("[Mac 设置] AppleScript step " + match[1] + " complete");
    }
  }
  return stdout?.trim() || "ok";
}

export async function isMacSettingsSignedIn() {
  try {
    const { stdout } = await execFileAsync("osascript", [SIGNED_IN_SCPT], {
      timeout: 15_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    return stdout.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

export function isMacSettingsSmsRuntimeEnabled(env = process.env) {
  if (env.APPLE_AUTOMATION_SMS_RECONFIGURE === "1") return true;
  if (env.APPLE_AUTOMATION_SMS_ENABLED === "0") return false;
  if (env.APPLE_AUTOMATION_SMS_ENABLED === "1") return true;
  return (
    Boolean(env.APPLE_AUTOMATION_SMS_PHONE?.trim()) ||
    Boolean(env.APPLE_AUTOMATION_SMS_API_URL?.trim())
  );
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
      openAppleAccountSettings({ env: sanitizedMacSettingsChildEnv() });
      await sleep(3500);

      try {
        await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], {
          timeout: 20_000,
          env: sanitizedMacSettingsChildEnv(),
        });
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
          console.warn("[Mac 设置] Swift AX 主路径失败，回退 AppleScript…");
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
  const isSignedIn = options.isSignedIn ?? isMacSettingsSignedIn;
  const pause = options.sleep ?? sleep;
  const postSmsFinalization = options.postSmsFinalization;
  const postSmsIntervalMs = options.postSmsIntervalMs ?? 1_500;
  let postSmsDisabled = false;
  let nextPostSmsAt = 0;
  await waitUntil(
    "[Mac 设置] 请在系统设置中完成手机验证码（人工），脚本将等待直至检测到已登录…",
    async () => {
      if (
        typeof postSmsFinalization === "function" &&
        !postSmsDisabled &&
        Date.now() >= nextPostSmsAt
      ) {
        let result;
        try {
          result = await postSmsFinalization();
        } catch {
          result = { status: "manual_required" };
        }
        if (result?.status === "submitted") {
          // One invocation handles one stable modal. Keep polling so a later
          // terms/password/location sheet is processed by the same chain.
          postSmsDisabled = false;
          // Do not let the signed-in probe short-circuit the next modal. The
          // native helper is the only source that can prove no post-SMS sheet
          // remains; scan again immediately after a successful submission.
          nextPostSmsAt = 0;
          return false;
        } else if (result?.status === "complete") {
          postSmsDisabled = true;
        } else if (result?.status === "manual_required") {
          postSmsDisabled = true;
          console.warn("[Mac 设置] 后置弹窗未能稳定识别，保留页面供人工完成。");
        }
        if (result?.status !== "submitted") {
          nextPostSmsAt = Date.now() + Math.max(250, postSmsIntervalMs);
        }
      }
      if (await isSignedIn()) return true;
      return false;
    },
    {
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      intervalMs: options.intervalMs ?? 2500,
      allowManualContinuation: false,
    }
  );

  await pause(options.settleMs ?? 1500);
  const ok = await isSignedIn();
  if (!ok) {
    throw new Error("MAC_SETTINGS_LOGIN_NOT_CONFIRMED");
  }
  console.log("[Mac 设置] ✓ 已检测到 Apple ID 登录完成");
  return { signedIn: true };
}

/**
 * @param {{ appleId: string, password: string }} creds
 * @param {{ smsEnv?: Record<string, string | undefined> }} [options]
 */
export async function runMacSettingsLoginPhase(creds, options = {}) {
  const version = ensureMacOS15({
    strict: false,
    env: sanitizedMacSettingsChildEnv(),
  });
  console.log(
    `[Mac 设置] macOS ${version.productVersion}（目标 macOS 15 Sequoia）`
  );

  const already = await isMacSettingsSignedIn();
  if (already) {
    console.log("[Mac 设置] 检测到已登录 Apple ID，跳过填表");
    return { skipped: true, signedIn: true };
  }

  const smsEnv = { ...process.env, ...(options.smsEnv ?? {}) };
  const smsConfig = isMacSettingsSmsRuntimeEnabled(smsEnv)
    ? await resolveMacSettingsSmsProviderConfig({ env: smsEnv })
    : null;
  if (smsConfig?.source === "terminal") {
    try {
      saveMacSettingsSmsProviderConfig(smsConfig);
      console.log("[Mac Settings][SMS] SMS provider configuration saved to .env.");
    } catch {
      throw new Error("MAC_SETTINGS_SMS_CONFIG_SAVE_FAILED");
    }
  }
  if (smsConfig) clearMacSettingsSmsRuntimeSecrets();

  await fillMacSettingsAppleLogin(creds);
  if (smsConfig) {
    if (!isMacSettingsSmsHelperAvailable()) {
      console.warn(
        "[Mac Settings][SMS] Native SMS helper is unavailable; complete SMS verification manually in System Settings."
      );
    } else {
      console.log("[Mac Settings][SMS] Waiting for the trusted destination and code entry.");
      await completeSupervisedMacSettingsSmsVerification({
        phoneNumber: smsConfig.phoneNumber,
        codeProvider: createSmsProviderCodePoller(smsConfig),
        supervised: true,
      });
      console.log(
        "[Mac Settings][SMS] Verification code submitted. Apple will continue automatically; finish any remaining screens in System Settings."
      );
    }
  } else {
    console.log("\n[Mac Settings] Credentials submitted. Complete SMS verification manually if shown.");
  }
  const postSmsEnabled = isMacSettingsPostSmsFinalizationEnabled(smsEnv);
  await waitForMacSettingsLoginComplete({
    postSmsFinalization: postSmsEnabled
      ? () =>
          completeMacSettingsPostSmsFinalization({
            supervised: true,
            scanTimeoutMs: 30_000,
            pollIntervalMs: 150,
          })
      : undefined,
  });
  return { skipped: false, signedIn: true };
}
