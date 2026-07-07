#!/usr/bin/env node
/**
 * 仅测「允许」点击策略（需真实 2FA Allow 弹窗）
 *   node scripts/test-2fa-allow.mjs
 */

import { probe2FAState, tryAllowOnce, waitForAllowClick } from "./lib/mac-2fa-allow.js";

const state = await probe2FAState(3);
console.log("当前弹窗状态:", state);

if (state.action !== "has_allow_dialog") {
  console.log("未检测到「允许」弹窗，跳过点击测试（请先触发网页登录 2FA）");
  process.exit(0);
}

console.log("尝试自动点击…");
const once = await tryAllowOnce(5);
console.log("单轮结果:", once);

if (!once.clicked) {
  console.log("自动点击失败，进入手动等待（30s）…");
  const manual = await waitForAllowClick({ timeoutMs: 30_000 });
  console.log("等待结果:", manual);
  process.exit(manual.clicked ? 0 : 1);
}

process.exit(0);
