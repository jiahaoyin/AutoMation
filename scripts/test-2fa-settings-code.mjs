#!/usr/bin/env node
/**
 * 仅测系统设置读码路径
 *   node scripts/test-2fa-settings-code.mjs
 */

import { fetch2FACodeFromSystemSettings } from "./lib/mac-settings-2fa.js";

console.log("开始系统设置读码测试…");
try {
  const { code } = await fetch2FACodeFromSystemSettings({
    timeoutMs: 90_000,
    verbose: true,
  });
  if (!/^\d{6}$/.test(code)) throw new Error("invalid verification code");
  console.log("系统设置验证码测试成功");
} catch {
  console.error("系统设置验证码测试失败");
  process.exitCode = 1;
}
