#!/usr/bin/env node
/**
 * 浏览器 2FA 权限预检（浏览器阶段启用时执行，不受 --skip-setup 影响）
 *   node scripts/preflight-2fa-permissions.mjs
 *   node scripts/preflight-2fa-permissions.mjs --quiet
 *   node scripts/preflight-2fa-permissions.mjs --all
 */

import {
  isAccessibilityGranted,
  isAccessibilityDeniedError,
  run2FAPermissionPreflight,
  triggerAccessibilityPrompt,
} from "./lib/accessibility.js";
import {
  ensure2FASettingsAccessibility,
  is2FASettingsHelperAvailable,
} from "./lib/mac-settings-2fa.js";
import { ensure2FAOcrScreenRecording } from "./lib/mac-2fa-ocr.js";

const quiet = process.argv.includes("--quiet");
const supervised = process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
const settingsOnly = process.argv.includes("--settings-only");
const allHelpers = process.argv.includes("--all");
const SUPERVISED_ACCESSIBILITY_WAIT_MS = 30_000;
const SUPERVISED_ACCESSIBILITY_POLL_MS = 750;
const SETTINGS_ACCESSIBILITY_WAIT_MS = 120_000;
let activePreflightHelper = "none";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settingsHelperUnavailableError() {
  const error = new Error("System Settings 2FA helper is unavailable");
  error.code = "2FA_SETTINGS_HELPER_UNAVAILABLE";
  return error;
}

async function preflightOcrPermission() {
  activePreflightHelper = "ocr";
  await ensure2FAOcrScreenRecording({
    timeoutMs: supervised
      ? SUPERVISED_ACCESSIBILITY_WAIT_MS
      : SETTINGS_ACCESSIBILITY_WAIT_MS,
    pollMs: supervised ? SUPERVISED_ACCESSIBILITY_POLL_MS : 2_000,
    compileIfNeeded: false,
  });

  if (supervised) {
    console.log("[2FA] status:screen_recording_ready");
  } else if (!quiet) {
    console.log("[2FA] Screen Recording for the native OCR helper is ready.");
  }
}

async function main() {
  if (settingsOnly || allHelpers) {
    activePreflightHelper = "settings";
    const timeoutMs = supervised
      ? SUPERVISED_ACCESSIBILITY_WAIT_MS
      : SETTINGS_ACCESSIBILITY_WAIT_MS;
    if (
      !is2FASettingsHelperAvailable({
        compileIfNeeded: true,
        compileTimeoutMs: timeoutMs,
      })
    ) {
      throw settingsHelperUnavailableError();
    }
    await ensure2FASettingsAccessibility({
      timeoutMs,
      verbose: !quiet,
    });
    if (supervised) {
      console.log("[2FA] status:settings_accessibility_ready");
    } else if (!quiet) {
      console.log(
        "[2FA] System Settings helper Accessibility permission is ready."
      );
    }
    if (settingsOnly) return;
  }
  if (supervised) {
    activePreflightHelper = "popup";
    console.log("[2FA] status:permission_preflight_start");
    const deadline = Date.now() + SUPERVISED_ACCESSIBILITY_WAIT_MS;
    const capability = async () => {
      try {
        return (await isAccessibilityGranted({ compileIfNeeded: false }))
          ? "available"
          : "permission_missing";
      } catch {
        return "unavailable";
      }
    };
    let state = await capability();
    if (state === "unavailable") {
      console.log("[2FA] status:native_helper_accessibility_probe_unavailable");
      if (allHelpers) await preflightOcrPermission();
      activePreflightHelper = "complete";
      return;
    }
    if (state !== "available") {
      console.log("[2FA] status:permission_preflight_prompted");
      const promptResult = await triggerAccessibilityPrompt({
        waitTimeoutMs: SUPERVISED_ACCESSIBILITY_WAIT_MS,
        compileIfNeeded: false,
      }).catch(() => null);
      state = promptResult?.capability ?? "unavailable";
      while (state === "permission_missing" && Date.now() < deadline) {
        await wait(SUPERVISED_ACCESSIBILITY_POLL_MS);
        state = await capability();
      }
    }
    if (state === "unavailable") {
      console.log("[2FA] status:native_helper_accessibility_probe_unavailable");
      if (allHelpers) await preflightOcrPermission();
      activePreflightHelper = "complete";
      return;
    }
    console.log(
      `[2FA] status:${state === "available" ? "permission_preflight_ready" : "permission_preflight_missing"}`
    );
    if (allHelpers) await preflightOcrPermission();
    activePreflightHelper = "complete";
    return;
  }
  activePreflightHelper = "popup";
  await run2FAPermissionPreflight({
    quiet,
    timeoutMs: 120_000,
    compileIfNeeded: false,
  });
  if (allHelpers) await preflightOcrPermission();
  activePreflightHelper = "complete";
}

main().catch((e) => {
  if (e?.code === "2FA_SETTINGS_HELPER_UNAVAILABLE") {
    console.error("[2FA] status:settings_helper_unavailable");
    process.exitCode = 1;
    return;
  }
  if (settingsOnly || activePreflightHelper === "settings") {
    console.error(
      `[2FA] status:${isAccessibilityDeniedError(e) ? "settings_accessibility_missing" : "settings_accessibility_failed"}`
    );
    process.exitCode = 1;
    return;
  }
  if (allHelpers && activePreflightHelper === "popup") {
    console.error(
      `[2FA] status:${isAccessibilityDeniedError(e) ? "popup_accessibility_missing" : "popup_accessibility_failed"}`
    );
    process.exitCode = 1;
    return;
  }
  if (allHelpers && activePreflightHelper === "ocr") {
    const status =
      e?.code === "2FA_OCR_PERMISSION_DENIED"
        ? "screen_recording_missing"
        : "screen_recording_unavailable";
    console.log(`[2FA] status:${status}`);
    if (!supervised) {
      console.error(
        status === "screen_recording_missing"
          ? "[2FA] 请在“系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制”中允许实际运行主体，按 macOS 提示重开终端后重试。"
          : "[2FA] Vision OCR helper 不可用；请重新运行 ./install.sh 修复环境后重试。"
      );
    }
    process.exitCode = 1;
    return;
  }
  if (supervised) {
    console.warn(
      `[2FA] status:${isAccessibilityDeniedError(e) ? "permission_preflight_missing" : "native_helper_accessibility_probe_unavailable"}`
    );
    return;
  }
  console.error("[2FA 权限]", e.message || e);
  process.exit(1);
});
