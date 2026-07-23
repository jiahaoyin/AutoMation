#!/usr/bin/env node
/**
 * 调试 Mac 设置填表 — 逐步日志
 * 用法: npm run fill:debug
 * 需 .env 中 APPLE_ID / APPLE_PASSWORD 或环境变量
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileAxFillHelper, fillViaSwiftAx, runAxFill } from "./lib/mac-settings-ax-fill.js";
import { preflightMacSettingsAutomation } from "./lib/mac-settings-login.js";
import { openAppleAccountSettings } from "./lib/macos.js";
import { sleep } from "./lib/prompt.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "mac-settings-apple-login.applescript");
const DUMP_SCPT = path.resolve(__dirname, "mac-settings-ui-dump.applescript");

function loadCreds() {
  const envPath = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const appleId = process.env.APPLE_ID || process.env.APPLE_SCRIPT_APPLE_ID || "";
  const password = process.env.APPLE_PASSWORD || process.env.APPLE_SCRIPT_PASSWORD || "";
  if (!appleId || !password) {
    console.error("请设置 APPLE_ID 与 APPLE_PASSWORD（.env 或环境变量）");
    process.exit(1);
  }
  return { appleId, password };
}

async function main() {
  const creds = loadCreds();
  console.log("═══ fill:debug v1.0.27 ═══\n");

  console.log("[debug] 编译 Swift AX helper…");
  const built = compileAxFillHelper({ quiet: false });
  if (!built.ok) console.warn("[debug] Swift 编译失败，将仅用 AppleScript 回退");

  await preflightMacSettingsAutomation();

  console.log("\n[debug] 打开 Apple Account 页…");
  openAppleAccountSettings();
  await sleep(3500);

  console.log("\n[debug] dump:mac-ui 预检…");
  try {
    const { stdout } = await execFileAsync("osascript", [DUMP_SCPT], { timeout: 30_000 });
    const ready = /login window found/.test(stdout) && /deep=[1-9]/.test(stdout);
    console.log("[debug] AX 登录窗口状态:", ready ? "ready" : "not_ready");
  } catch {
    console.warn("[debug] AX 预检失败");
  }

  if (built.ok) {
    console.log("\n[debug] Swift AX dump…");
    try {
      const dump = await runAxFill("dump");
      console.log("[debug] Swift AX 输入框数量:", dump.textFieldCount ?? 0);
    } catch {
      console.warn("[debug] Swift AX 预检失败");
    }

    console.log("\n[debug] Swift AX 两阶段填表…");
    try {
      await fillViaSwiftAx(creds);
      console.log("\n[debug] ✓ Swift 路径完成");
      return;
    } catch {
      console.warn("[debug] Swift 填表失败");
      console.log("[debug] 回退 AppleScript…");
    }
  }

  console.log("\n[debug] AppleScript 填表（stderr 含 [step N]）…");
  const { stdout, stderr } = await execFileAsync("osascript", [LOGIN_SCPT], {
    timeout: 180_000,
    env: {
      ...process.env,
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
      APPLE_SCRIPT_PASSWORD: creds.password,
      APPLE_SCRIPT_PANE_OPENED: "1",
    },
  });
  if (stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      const match = /^\[step\s+(\d+)\]/.exec(line.trim());
      if (match) console.log("[debug] AppleScript step " + match[1] + " complete");
    }
  }
  console.log("[debug] 结果:", stdout.trim() === "ok" ? "ok" : "failed");
}

main().catch(() => {
  console.error("\n[debug 失败]");
  process.exit(1);
});
