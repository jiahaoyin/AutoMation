#!/usr/bin/env node
/**
 * 2FA 权限预检（run.sh 始终执行，不受 --skip-setup 影响）
 *   node scripts/preflight-2fa-permissions.mjs
 *   node scripts/preflight-2fa-permissions.mjs --quiet
 */

import { run2FAPermissionPreflight } from "./lib/accessibility.js";

const quiet = process.argv.includes("--quiet");

async function main() {
  await run2FAPermissionPreflight({ quiet, timeoutMs: 120_000 });
}

main().catch((e) => {
  console.error("[2FA 权限]", e.message || e);
  process.exit(1);
});
