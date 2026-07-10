#!/usr/bin/env node
/**
 * 环境自检；加 --install 时自动安装缺失依赖
 *   node scripts/check-environment.mjs
 *   node scripts/check-environment.mjs --install
 */

import { loadEnvFile } from "./lib/credentials.js";
import { resolveFirefoxExecutable } from "./lib/firefox-runtime.js";
import { checkEnvironmentOk } from "./lib/browser-backend.js";
import { isMacSettingsSignedIn } from "./lib/mac-settings-login.js";
import {
  checkEnvironment,
  ensureEnvironment,
  getBrowserEnvironmentSummary,
} from "./lib/env-setup.js";
import { ensureMacOS15, getMacOSVersion } from "./lib/macos.js";

const install = process.argv.includes("--install");
const strictPlatform = process.argv.includes("--strict-platform");

loadEnvFile();

const mac = getMacOSVersion();
console.log("环境自检:");
console.log("  macOS:", mac.productVersion, mac.major === 15 ? "(Sequoia ✓)" : "(非 15，系统设置脚本未保证)");
if (process.platform === "darwin") {
  ensureMacOS15({ strict: false });
} else {
  console.log("  运行模式: 当前仅做逻辑/依赖检查，完整自动化需在 macOS 测试机运行");
}
if (install) {
  if (process.platform === "darwin") {
    await ensureEnvironment({ quiet: false, installRuyiPage: true });
  } else {
    console.log("  --install: 当前不是 macOS，跳过 macOS 权限与 ruyipage 自动安装");
  }
}

const result = await checkEnvironment({ quiet: false });
const ok = checkEnvironmentOk({
  issues: result.issues,
  platform: process.platform,
  strictPlatform,
});

console.log("  firefox path:", resolveFirefoxExecutable());
try {
  const browser = getBrowserEnvironmentSummary();
  console.log("  browser backend:", `${browser.backend} (${browser.backendReason})`);
  console.log("  profile:", `${browser.profileMode} ${browser.profileDir}`);
} catch (e) {
  console.log("  browser backend:", e instanceof Error ? e.message : String(e));
}
console.log("  APPLE_ID:", process.env.APPLE_ID ? "已设置" : "未设置");
console.log("  APPLE_PASSWORD:", process.env.APPLE_PASSWORD ? "已设置" : "未设置");

try {
  const signedIn = await isMacSettingsSignedIn();
  console.log("  mac 系统设置 Apple ID 已登录:", signedIn ? "是" : "否");
} catch (e) {
  console.log("  mac 登录检测:", e instanceof Error ? e.message : String(e));
}

if (!ok && !install) {
  console.log("\n提示: 运行 ./install.sh 安装环境；账号密码在 ./run.sh 时终端输入");
}

console.log("\n完成");
process.exit(ok || install ? 0 : 1);
