#!/usr/bin/env node
/**
 * 2FA 权限三项探测
 */

import {
  isAccessibilityGranted,
  checkAutomationGranted,
  check2FAAutomationGranted,
  getAccessibilityHostApp,
} from "./lib/accessibility.js";

const host = getAccessibilityHostApp();
const ax = await isAccessibilityGranted();
const automation = await checkAutomationGranted();
const twoFa = await check2FAAutomationGranted();

console.log("2FA 权限探测:");
console.log(`  宿主: ${host.name}`);
console.log(`  辅助功能: ${ax ? "ok" : "未授权"}`);
console.log(
  `  自动化(系统设置): ${automation.granted ? "ok" : `未授权 ${automation.reason ?? ""}`}`
);
console.log(
  `  2FA 自动化(System Events): ${twoFa.granted ? `ok (${twoFa.mode ?? ""})` : `未通过 ${twoFa.reason ?? ""}`}`
);
if (!twoFa.granted && (twoFa.kind === "accessibility" || twoFa.code === "-25211")) {
  console.log("  提示: -25211 表示「辅助功能」未开，不是「自动化」问题");
  console.log("  请打开: 系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Terminal");
}

const ok = ax && automation.granted && twoFa.granted;
process.exit(ok ? 0 : 1);
