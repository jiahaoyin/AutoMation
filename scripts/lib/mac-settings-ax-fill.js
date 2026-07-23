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
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];

export function sanitizedAxFillChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

/** 编译 Swift helper（install.sh 也会调用） */
export function compileAxFillHelper(options = {}) {
  const { quiet = false } = options;
  if (process.platform !== "darwin") return { ok: false, reason: "non-darwin" };
  if (!fs.existsSync(SWIFT_SRC)) return { ok: false, reason: "missing swift source" };

  fs.mkdirSync(path.dirname(AX_BIN), { recursive: true });
  const r = spawnSync(
    "swiftc",
    ["-O", "-o", AX_BIN, SWIFT_SRC, "-framework", "ApplicationServices", "-framework", "AppKit"],
    { encoding: "utf-8", env: sanitizedAxFillChildEnv() }
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

function emitSafeAxHelperProgress(stderr, verbose) {
  if (verbose === false || typeof stderr !== "string") return;
  for (const line of stderr.split("\n")) {
    const match = /^\[step\s+(\d+)\]/.exec(line.trim());
    if (match) console.log("[Mac 设置] Swift AX step " + match[1] + " complete");
  }
}

function normalizeAxFillResult(stdout, phase) {
  try {
    const parsed = JSON.parse(String(stdout ?? "").trim());
    return {
      ok: parsed?.ok === true,
      phase,
      message: parsed?.ok === true ? "ok" : "swift_ax_" + phase + "_failed",
      textFieldCount: Number.isInteger(parsed?.textFieldCount)
        ? parsed.textFieldCount
        : null,
    };
  } catch {
    return {
      ok: false,
      phase,
      message: "swift_ax_" + phase + "_failed",
      textFieldCount: null,
    };
  }
}

/**
 * @param {string} phase email | continue | password | dump | all
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env]
 * @param {boolean} [opts.verbose]
 */
export async function runAxFill(phase, opts = {}) {
  if (!isAxFillAvailable()) {
    const built = compileAxFillHelper({ quiet: true });
    if (!built.ok) {
      throw new Error("Swift AX helper unavailable");
    }
  }

  const args = ["--phase", phase];
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(AX_BIN, args, {
      timeout: 120_000,
      env: sanitizedAxFillChildEnv({ ...process.env, ...(opts.env ?? {}) }),
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
  }
  emitSafeAxHelperProgress(stderr, opts.verbose);
  return normalizeAxFillResult(stdout, phase);
}

/**
 * 两阶段登录：邮箱 → 继续 → 密码
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillViaSwiftAx(creds) {
  console.log("[Mac 设置] 使用 Swift AX API 填表（主路径）…");

  const dump = await runAxFill("dump");
  if (!dump.ok) {
    throw new Error("Swift AX login preflight failed");
  }
  console.log("[Mac 设置] 登录窗口已就绪，发现 " + (dump.textFieldCount ?? 0) + " 个输入框");

  const email = await runAxFill("email", {
    env: {
      APPLE_SCRIPT_APPLE_ID: creds.appleId,
    },
  });
  if (!email.ok) {
    throw new Error("Swift AX email input failed");
  }
  console.log("[Mac 设置] ✓ 邮箱已填入");

  await sleep(600);
  const cont = await runAxFill("continue");
  if (!cont.ok) {
    throw new Error("Swift AX continue action failed");
  }
  console.log("[Mac 设置] ✓ 已点击「继续」");

  await sleep(2500);
  const pwd = await runAxFill("password", {
    env: {
      APPLE_SCRIPT_PASSWORD: creds.password,
    },
  });
  if (!pwd.ok) {
    throw new Error("Swift AX password input failed");
  }
  console.log("[Mac 设置] ✓ 密码已填入并提交");

  return { emailOk: true, continueOk: true, passwordOk: true };
}
