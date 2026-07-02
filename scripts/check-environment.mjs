#!/usr/bin/env node
/**
 * 环境自检；加 --install 时自动安装缺失依赖
 *   node scripts/check-environment.mjs
 *   node scripts/check-environment.mjs --install
 */

import { loadEnvFile } from "./lib/credentials.js";
import { resolveFirefoxExecutable } from "./lib/bidi-client.js";
import { isMacSettingsSignedIn } from "./lib/mac-settings-login.js";
import { checkEnvironment, ensureEnvironment } from "./lib/env-setup.js";
import { ensureMacOS15, getMacOSVersion } from "./lib/macos.js";

const install = process.argv.includes("--install");

loadEnvFile();

const mac = getMacOSVersion();
console.log("环境自检:");
console.log("  macOS:", mac.productVersion, mac.major === 15 ? "(Sequoia ✓)" : "(非 15，系统设置脚本未保证)");
ensureMacOS15({ strict: false });
if (install) {
  await ensureEnvironment({ quiet: false });
}

const result = await checkEnvironment({ quiet: false });

console.log("  firefox path:", resolveFirefoxExecutable());
console.log("  APPLE_ID:", process.env.APPLE_ID ? "已设置" : "未设置");
console.log("  APPLE_PASSWORD:", process.env.APPLE_PASSWORD ? "已设置" : "未设置");

try {
  const signedIn = await isMacSettingsSignedIn();
  console.log("  mac 系统设置 Apple ID 已登录:", signedIn ? "是" : "否");
} catch (e) {
  console.log("  mac 登录检测:", e instanceof Error ? e.message : String(e));
}

if (!result.ok && !install) {
  console.log("\n提示: 运行 ./install.sh 安装环境；账号密码在 ./run.sh 时终端输入");
}

console.log("\n完成");
process.exit(result.ok || install ? 0 : 1);
