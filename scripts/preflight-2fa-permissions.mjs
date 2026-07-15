#!/usr/bin/env node
/**
 * 浏览器 2FA 权限预检（浏览器阶段启用时执行，不受 --skip-setup 影响）
 *   node scripts/preflight-2fa-permissions.mjs
 *   node scripts/preflight-2fa-permissions.mjs --quiet
 */

import {
  isAccessibilityGranted,
  isAccessibilityDeniedError,
  run2FAPermissionPreflight,
  triggerAccessibilityPrompt,
} from "./lib/accessibility.js";
import { is2FASettingsHelperAvailable } from "./lib/mac-settings-2fa.js";

const quiet = process.argv.includes("--quiet");
const supervised = process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
const settingsOnly = process.argv.includes("--settings-only");
const SUPERVISED_ACCESSIBILITY_WAIT_MS = 30_000;
const SUPERVISED_ACCESSIBILITY_POLL_MS = 750;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settingsHelperUnavailableError() {
  const error = new Error("System Settings 2FA helper is unavailable");
  error.code = "2FA_SETTINGS_HELPER_UNAVAILABLE";
  return error;
}

async function main() {
  if (settingsOnly) {
    if (!is2FASettingsHelperAvailable({ compileIfNeeded: true })) {
      throw settingsHelperUnavailableError();
    }
    if (supervised) {
      console.log("[2FA] status:settings_accessibility");
    } else if (!quiet) {
      console.log(
        "[2FA] System Settings helper is ready and will request its own Accessibility permission when a verification code is needed."
      );
    }
    return;
  }
  if (supervised) {
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
      return;
    }
    console.log(
      `[2FA] status:${state === "available" ? "permission_preflight_ready" : "permission_preflight_missing"}`
    );
    return;
  }
  await run2FAPermissionPreflight({
    quiet,
    timeoutMs: 120_000,
    compileIfNeeded: false,
  });
}

main().catch((e) => {
  if (e?.code === "2FA_SETTINGS_HELPER_UNAVAILABLE") {
    console.error("[2FA] status:settings_helper_unavailable");
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
