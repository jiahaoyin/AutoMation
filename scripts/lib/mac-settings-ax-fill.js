/**
 * Swift AX 填表 helper — 主路径（绕过 AppleScript 元素引用失效）
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const AX_FILL_PHASES = new Set(["dump", "email", "continue", "password", "state"]);
const AX_FILL_REASONS = new Set([
  "ok",
  "target_unavailable_before_write",
  "target_focus_unavailable",
  "target_changed_before_write",
  "ax_value_unconfirmed",
  "keyboard_fallback_unsafe",
  "keyboard_target_changed",
  "keyboard_unconfirmed",
  "login_state_unknown",
  "login_window_not_found",
  "exact_username_field_not_found",
  "exact_password_field_not_found",
  "enabled_login_button_not_found",
  "enabled_login_button_not_found_after_password",
  "missing_email_value",
  "missing_password_value",
  "settings_process_not_found",
  "helper_invalid_output",
  "helper_exit",
  "helper_unavailable",
  "compile_failed",
]);
const AX_FILL_LOGIN_STATES = new Set(["email", "password", "unknown"]);
const AX_FILL_INPUT_ROUTES = new Set(["ax_value", "keyboard", "existing_value", "unknown"]);
const MAX_AX_TEXT_FIELD_COUNT = 32;

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
    if (!quiet) console.warn("[Mac 设置] Swift AX helper 编译失败（详情已隐藏）");
    return { ok: false, reason: "compile_failed" };
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

function safeAxFillPhase(value, fallback = "state") {
  return AX_FILL_PHASES.has(value) ? value : fallback;
}

function safeAxFillReason(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return AX_FILL_REASONS.has(normalized) ? normalized : fallback;
}

function safeAxFillLoginState(value) {
  return AX_FILL_LOGIN_STATES.has(value) ? value : "unknown";
}

function safeAxFillInputRoute(value) {
  return AX_FILL_INPUT_ROUTES.has(value) ? value : "unknown";
}

function safeAxFillTextFieldCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_AX_TEXT_FIELD_COUNT
    ? value
    : null;
}

export function normalizeAxFillResult(stdout, phase, options = {}) {
  const normalizedPhase = safeAxFillPhase(phase);
  const fallbackReason = options.reason ?? "helper_invalid_output";
  try {
    const parsed = JSON.parse(String(stdout ?? "").trim());
    const ok = parsed?.ok === true;
    return {
      ok,
      route: "swift_ax",
      phase: safeAxFillPhase(parsed?.phase, normalizedPhase),
      reason: ok ? "ok" : safeAxFillReason(parsed?.message),
      loginState: safeAxFillLoginState(parsed?.loginState),
      inputRoute: safeAxFillInputRoute(parsed?.inputRoute),
      textFieldCount: safeAxFillTextFieldCount(parsed?.textFieldCount),
    };
  } catch {
    return {
      ok: false,
      route: "swift_ax",
      phase: normalizedPhase,
      reason: safeAxFillReason(fallbackReason, "helper_invalid_output"),
      loginState: "unknown",
      inputRoute: "unknown",
      textFieldCount: null,
    };
  }
}

function emitAxFillStatus(onStatus, status) {
  if (typeof onStatus !== "function") return;
  try {
    onStatus({
      route: "swift_ax",
      phase: safeAxFillPhase(status?.phase),
      outcome:
        status?.outcome === "started" ||
        status?.outcome === "succeeded" ||
        status?.outcome === "fallback"
          ? status.outcome
          : "failed",
      reason: safeAxFillReason(status?.reason, "unknown"),
      loginState: safeAxFillLoginState(status?.loginState),
      inputRoute: safeAxFillInputRoute(status?.inputRoute),
      textFieldCount: safeAxFillTextFieldCount(status?.textFieldCount),
    });
  } catch {
    /* Observability must not change the login result. */
  }
}

function createAxFillError(result) {
  const error = new Error("MAC_SETTINGS_AX_FILL_FAILED");
  error.code = "MAC_SETTINGS_AX_FILL_FAILED";
  error.macSettingsStatus = { ...result, outcome: "failed" };
  return error;
}

/**
 * @param {string} phase email | continue | password | dump | all
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env]
 * @param {boolean} [opts.verbose]
 * @param {(status: object) => void} [opts.onStatus]
 */
export async function runAxFill(phase, opts = {}) {
  const normalizedPhase = safeAxFillPhase(phase);
  emitAxFillStatus(opts.onStatus, { phase: normalizedPhase, outcome: "started", reason: "ok" });
  if (!isAxFillAvailable()) {
    const built = compileAxFillHelper({ quiet: true });
    if (!built.ok) {
      const unavailable = {
        ok: false,
        route: "swift_ax",
        phase: normalizedPhase,
        reason: built.reason === "compile_failed" ? "compile_failed" : "helper_unavailable",
        loginState: "unknown",
        inputRoute: "unknown",
        textFieldCount: null,
      };
      emitAxFillStatus(opts.onStatus, { ...unavailable, outcome: "failed" });
      return unavailable;
    }
  }

  const args = ["--phase", phase];
  let stdout = "";
  let stderr = "";
  let helperExited = false;
  try {
    ({ stdout, stderr } = await execFileAsync(AX_BIN, args, {
      timeout: 120_000,
      env: sanitizedAxFillChildEnv({ ...process.env, ...(opts.env ?? {}) }),
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    helperExited = true;
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
  }
  emitSafeAxHelperProgress(stderr, opts.verbose);
  const result = normalizeAxFillResult(stdout, normalizedPhase, {
    reason: helperExited ? "helper_exit" : "helper_invalid_output",
  });
  emitAxFillStatus(opts.onStatus, { ...result, outcome: result.ok ? "succeeded" : "failed" });
  return result;
}

/**
 * 两阶段登录：邮箱 → 继续 → 密码
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillViaSwiftAx(creds, options = {}) {
  console.log("[Mac 设置] 使用 Swift AX API 填表（主路径）…");

  const dump = await runAxFill("dump", { onStatus: options.onStatus });
  if (!dump.ok) {
    throw createAxFillError(dump);
  }
  console.log("[Mac 设置] 登录窗口已就绪，发现 " + (dump.textFieldCount ?? 0) + " 个输入框");

  if (dump.loginState === "email") {
    const email = await runAxFill("email", {
      env: {
        APPLE_SCRIPT_APPLE_ID: creds.appleId,
      },
      onStatus: options.onStatus,
    });
    if (!email.ok) {
      throw createAxFillError(email);
    }
    console.log("[Mac 设置] ✓ 邮箱已填入");

    const cont = await runAxFill("continue", { onStatus: options.onStatus });
    if (!cont.ok) {
      throw createAxFillError(cont);
    }
    console.log("[Mac 设置] ✓ 已点击「继续」");
  } else if (dump.loginState !== "password") {
    throw createAxFillError({
      ...dump,
      ok: false,
      phase: "state",
      reason: "login_state_unknown",
    });
  }

  const pwd = await runAxFill("password", {
    env: {
      APPLE_SCRIPT_PASSWORD: creds.password,
    },
    onStatus: options.onStatus,
  });
  if (!pwd.ok) {
    throw createAxFillError(pwd);
  }
  console.log("[Mac 设置] ✓ 密码已填入并提交");

  return { emailOk: true, continueOk: true, passwordOk: true };
}
