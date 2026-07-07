#!/usr/bin/env node
/**
 * 仅测系统设置读码路径
 *   node scripts/test-2fa-settings-code.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetch2FACodeFromSystemSettings } from "./lib/mac-settings-2fa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../data/reports/test-2fa-settings");
const screenshotPath = path.join(outDir, "screenshots", "2fa-settings-code.png");

console.log("开始系统设置读码测试…");
const { code, raw, screenshot } = await fetch2FACodeFromSystemSettings({
  timeoutMs: 90_000,
  screenshotPath,
  verbose: true,
});

console.log(`结果: code=${code} raw="${raw ?? ""}" screenshot=${screenshot ?? "无"}`);
if (!/^\d{6}$/.test(code)) {
  console.error("验证码格式错误");
  process.exit(1);
}
if (raw && !/^\d{3}\s\d{3}$/.test(raw.trim())) {
  console.error(`原文非 NNN NNN 格式: "${raw}"`);
  process.exit(1);
}
process.exit(0);
