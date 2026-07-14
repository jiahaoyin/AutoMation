/**
 * Swift AX 填表 helper — 主路径（绕过 AppleScript 元素引用失效）
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./prompt.js";
import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.resolve(__dirname, "../swift/mac-settings-ax-fill.swift");
const AX_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-settings-ax-fill"
);

/** 编译 Swift helper（install.sh 也会调用） */
export function compileAxFillHelper(options = {}) {
  const { quiet = false } = options;
  if (process.platform !== "darwin") return { ok: false, reason: "non-darwin" };
  if (!fs.existsSync(SWIFT_SRC)) return { ok: false, reason: "missing swift source" };

  fs.mkdirSync(path.dirname(AX_BIN), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", AX_BIN, SWIFT_SRC, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    if (!quiet) console.warn("[Mac 设置] Swift AX helper 编译失败:", r.stderr?.trim() || r.error);
    return { ok: false, reason: r.stderr?.trim() || String(r.error) };
  }
  try {
    fs.chmodSync(AX_BIN, 0o755);
  } catch {
    /* ignore */
  }
  if (!quiet) console.log("[Mac 设置] ✓ Swift AX helper 已编译");
  return { ok: true, bin: AX_BIN };
}

export function axFillBinPath() {
  return AX_BIN;
}

export function isAxFillAvailable() {
  return process.platform === "darwin" && fs.existsSync(AX_BIN) && fs.statSync(AX_BIN).isFile();
}

/**
 * @param {string} phase email | continue | password | dump | all
 * @param {object} [opts]
 * @param {string} [opts.value]
 * @param {Record<string,string>} [opts.env]
 * @param {boolean} [opts.verbose]
 */
export async function runAxFill(phase, opts = {}) {
  if (!isAxFillAvailable()) {
    const built = compileAxFillHelper({ quiet: true });
    if (!built.ok) {
      throw new Error(`Swift AX helper unavailable: ${built.reason}`);
    }
  }

  const args = ["--phase", phase];
  if (opts.value) args.push("--value", opts.value);

  const { stdout, stderr } = await execFileAsync(AX_BIN, args, {
    timeout: 120_000,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 2 * 1024 * 1024,
  });

  if (opts.verbose !== false && stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(`[Mac 设置] ${line}`);
    }
  }

  let parsed = { ok: false, message: stdout?.trim() || "empty" };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = { ok: false, message: stdout?.trim() || "invalid json" };
  }
  return { ...parsed, stderr: stderr?.trim() ?? "" };
}

/**
 * 两阶段登录：邮箱 → 继续 → 密码
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillViaSwiftAx(creds) {
  console.log("[Mac 设置] 使用 Swift AX API 填表（主路径）…");

  const dump = await runAxFill("dump");
  if (!dump.ok) {
    throw new Error(`Swift AX 预检失败: ${dump.message}`);
  }
  console.log(
    `[Mac 设置] 登录窗口「${dump.windowTitle ?? "?"}」发现 ${dump.textFieldCount ?? 0} 个输入框`
  );

  const email = await runAxFill("email", {
    value: creds.appleId,
    env: {
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
      APPLE_SCRIPT_PASSWORD: creds.password,
    },
  });
  if (!email.ok) {
    throw new Error(`Swift AX 填邮箱失败: ${email.message}`);
  }
  console.log("[Mac 设置] ✓ 邮箱已填入");

  await sleep(600);
  const cont = await runAxFill("continue");
  if (cont.ok) {
    console.log("[Mac 设置] ✓ 已点击「继续」");
  } else {
    console.warn("[Mac 设置] 「继续」按钮未找到或未启用，尝试直接填密码…");
  }

  await sleep(2500);
  const pwd = await runAxFill("password", {
    value: creds.password,
    env: {
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
      APPLE_SCRIPT_PASSWORD: creds.password,
    },
  });
  if (!pwd.ok) {
    console.warn(`[Mac 设置] Swift AX 填密码: ${pwd.message}（可能需人工完成密码步）`);
  } else {
    console.log("[Mac 设置] ✓ 密码已填入并提交");
  }

  return { emailOk: true, passwordOk: pwd.ok };
}
