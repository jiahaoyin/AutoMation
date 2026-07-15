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

const quiet = process.argv.includes("--quiet");
const supervised = process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
const SUPERVISED_ACCESSIBILITY_WAIT_MS = 30_000;
const SUPERVISED_ACCESSIBILITY_POLL_MS = 750;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (supervised) {
    console.log("[2FA] status:permission_preflight_start");
    let granted = await isAccessibilityGranted().catch(() => false);
    if (!granted) {
      console.log("[2FA] status:permission_preflight_prompted");
      const promptResult = await triggerAccessibilityPrompt().catch(() => null);
      granted = promptResult?.capability === "available";
      const deadline = Date.now() + SUPERVISED_ACCESSIBILITY_WAIT_MS;
      while (!granted && Date.now() < deadline) {
        await wait(SUPERVISED_ACCESSIBILITY_POLL_MS);
        granted = await isAccessibilityGranted().catch(() => false);
      }
    }
    console.log(
      `[2FA] status:${granted ? "permission_preflight_ready" : "permission_preflight_missing"}`
    );
    return;
  }
  await run2FAPermissionPreflight({ quiet, timeoutMs: 120_000 });
}

main().catch((e) => {
  if (supervised && isAccessibilityDeniedError(e)) {
    console.warn("[2FA] status:permission_preflight_missing");
    return;
  }
  console.error("[2FA 权限]", e.message || e);
  process.exit(1);
});
