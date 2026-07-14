#!/usr/bin/env node
/**
 * 浏览器 2FA 权限预检（浏览器阶段启用时执行，不受 --skip-setup 影响）
 *   node scripts/preflight-2fa-permissions.mjs
 *   node scripts/preflight-2fa-permissions.mjs --quiet
 */

import {
  isAccessibilityDeniedError,
  run2FAPermissionPreflight,
} from "./lib/accessibility.js";

const quiet = process.argv.includes("--quiet");
const supervised = process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";

async function main() {
  if (supervised) console.log("[2FA] status:permission_preflight_start");
  await run2FAPermissionPreflight({ quiet, timeoutMs: 120_000 });
  if (supervised) console.log("[2FA] status:permission_preflight_ready");
}

main().catch((e) => {
  if (supervised && isAccessibilityDeniedError(e)) {
    console.warn("[2FA] status:permission_preflight_missing");
    return;
  }
  console.error("[2FA 权限]", e.message || e);
  process.exit(1);
});
