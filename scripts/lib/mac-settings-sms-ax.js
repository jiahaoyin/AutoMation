import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMS_AX_HELPER_NAME = "mac-settings-sms-verification";
const SMS_AX_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  SMS_AX_HELPER_NAME
);
const VALID_PHASES = new Set(["sms-state", "sms-select", "sms-continue", "sms-code"]);
const VALID_STAGES = new Set(["phone_selection", "code_entry", "code_pending", "waiting"]);
const SAFE_STATE_REASONS = new Set([
  "no_trusted_surface",
  "phone_code_transition",
  "code_surface_unready",
  "ambiguous_sms_surface",
  "surface_unclassified",
  "code_value_unreadable",
]);
const SUCCESS_STAGES_BY_PHASE = new Map([
  ["sms-select", "selected"],
  ["sms-continue", "continued"],
  ["sms-code", "code_submitted"],
]);

const NATIVE_FAILURE_REASONS = new Set([
  "invalid",
  "suffix_invalid",
  "phone_selection_unavailable",
  "phone_not_matched",
  "phone_not_unique",
  "selection_not_confirmed",
  "continue_failed",
  "code_entry_unavailable",
  "manual_code_invalid",
  "code_write_failed",
  "accessibility_unavailable",
  "helper_exit",
]);

function nativeFailure(reason = "invalid") {
  return {
    ok: false,
    stage: "invalid",
    reason: NATIVE_FAILURE_REASONS.has(reason) ? reason : "invalid",
  };
}

function hasSafeOwnership(stat, uid) {
  return (
    stat &&
    typeof stat.mode === "number" &&
    (stat.mode & 0o022) === 0 &&
    (!Number.isInteger(uid) || stat.uid === uid)
  );
}

/**
 * A helper-directory override is only valid when it matches the locked-down
 * location created by the supervised terminal bridge. Normal installations
 * use the repository-local helper and do not enter this branch.
 */
export function isTrustedMacSettingsSmsHelperOverride(env = process.env, dependencies = {}) {
  const configuredDirectory = env.APPLE_AUTOMATION_HELPER_DIR?.trim();
  if (!configuredDirectory) return true;
  const home = env.HOME;
  const token = env.APPLE_AUTOMATION_SUPERVISED_TOKEN ?? "";
  if (
    env.APPLE_AUTOMATION_SUPERVISED_GUI !== "1" ||
    !/^[0-9a-f]{32}$/.test(token) ||
    typeof home !== "string" ||
    !path.isAbsolute(home) ||
    !path.isAbsolute(configuredDirectory)
  ) {
    return false;
  }

  const helperDirectory = path.resolve(configuredDirectory);
  const expectedDirectory = path.join(
    path.resolve(home),
    ".apple-automation",
    "supervised-helpers"
  );
  if (helperDirectory !== expectedDirectory) return false;

  const fsApi = dependencies.fs ?? fs;
  const getUid = dependencies.getuid ?? process.getuid;
  const uid = typeof getUid === "function" ? getUid() : undefined;
  const helperPath = path.join(helperDirectory, SMS_AX_HELPER_NAME);
  try {
    const directoryStat = fsApi.lstatSync(helperDirectory);
    const helperStat = fsApi.lstatSync(helperPath);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !helperStat.isFile() ||
      helperStat.isSymbolicLink() ||
      !hasSafeOwnership(directoryStat, uid) ||
      !hasSafeOwnership(helperStat, uid)
    ) {
      return false;
    }
    return (
      fsApi.realpathSync(helperDirectory) === helperDirectory &&
      fsApi.realpathSync(helperPath) === helperPath
    );
  } catch {
    return false;
  }
}

function execFileWithStdin(file, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });

    if (!child.stdin) {
      child.kill();
      reject(new Error("native helper stdin is unavailable"));
      return;
    }

    // A short-lived helper can exit before the pipe is flushed. Its callback
    // carries the failure; this listener prevents an unhandled stream error.
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}

export function isMacSettingsSmsHelperAvailable() {
  if (process.platform !== "darwin") return false;
  if (!isTrustedMacSettingsSmsHelperOverride()) return false;
  try {
    const stat = fs.statSync(SMS_AX_BIN);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function sanitizeMacSettingsSmsNativeResult(phase, value) {
  if (!value || typeof value !== "object") return nativeFailure();
  if (phase === "sms-state") {
    if (value.ok !== true || !VALID_STAGES.has(value.stage)) return nativeFailure(value.stage);
    const reason = SAFE_STATE_REASONS.has(value.reason) ? value.reason : undefined;
    return { ok: true, stage: value.stage, ...(reason ? { reason } : {}) };
  }
  const expectedStage = SUCCESS_STAGES_BY_PHASE.get(phase);
  return value.ok === true && value.stage === expectedStage
    ? { ok: true, stage: expectedStage }
    : nativeFailure(value.stage);
}

/**
 * Invoke the narrow SMS-verification AX helper. OTP is sent over the helper's
 * short-lived standard-input pipe rather than through argv or its environment.
 *
 * @param {"sms-state"|"sms-select"|"sms-continue"|"sms-code"} phase
 * @param {{ suffix?: string, code?: string, timeoutMs?: number }} [options]
 */
export async function runMacSettingsSmsHelper(phase, options = {}) {
  if (!VALID_PHASES.has(phase)) return nativeFailure();
  if (!isMacSettingsSmsHelperAvailable()) return nativeFailure();

  const args = ["--phase", phase];
  if (
    phase === "sms-state" ||
    phase === "sms-select" ||
    phase === "sms-continue" ||
    phase === "sms-code"
  ) {
    if (!/^[0-9]{2}$/.test(options.suffix ?? "")) return nativeFailure();
    args.push("--suffix", options.suffix);
  }
  const env = { ...process.env };
  delete env.APPLE_AUTOMATION_MANUAL_SMS_CODE;
  delete env.APPLE_AUTOMATION_SMS_PHONE;
  delete env.APPLE_AUTOMATION_SMS_API_URL;
  let input;
  if (phase === "sms-code") {
    if (!/^[0-9]{6}$/.test(options.code ?? "")) return nativeFailure();
    input = `${options.code}\n`;
  }
  const timeoutMs = Math.trunc(options.timeoutMs ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return nativeFailure();

  try {
    const executionOptions = {
      timeout: timeoutMs,
      env,
      maxBuffer: 16 * 1024,
    };
    const { stdout } =
      input === undefined
        ? await execFileAsync(SMS_AX_BIN, args, executionOptions)
        : await execFileWithStdin(SMS_AX_BIN, args, input, executionOptions);
    return sanitizeMacSettingsSmsNativeResult(phase, JSON.parse(stdout));
  } catch {
    return nativeFailure();
  }
}

export function macSettingsSmsHelperPath() {
  return SMS_AX_BIN;
}
