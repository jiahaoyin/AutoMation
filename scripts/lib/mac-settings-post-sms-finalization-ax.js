import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_NAME = "mac-settings-post-sms-finalization";
const HELPER_PATH = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  HELPER_NAME
);
const VALID_PHASES = new Set(["state", "terms", "mac-password", "unlock-code", "location"]);
const ACTION_STAGE_BY_PHASE = new Map([
  ["terms", "terms_submitted"],
  ["mac-password", "mac_password_submitted"],
  ["unlock-code", "iphone_unlock_submitted"],
  ["location", "location_submitted"],
]);
const MAX_PID = 0x7fffffff;
const MAX_CG_WINDOW_ID = 0xffffffff;
const NATIVE_FAILURE_REASONS = new Set([
  "invalid",
  "visual_unavailable",
  "binding_invalid",
  "helper_exit",
  "invalid_request",
  "timeout",
  "manual_required",
]);
const CHILD_SECRET_ENV_KEYS = [
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_SCRIPT_APPLE_ID",
  "APPLE_SCRIPT_PASSWORD",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_SUPERVISED_TOKEN",
];

export function normalizeMacSettingsPostSmsFailureReason(value) {
  return typeof value === "string" && NATIVE_FAILURE_REASONS.has(value)
    ? value
    : "invalid";
}

function invalidResult(reason = "invalid") {
  return {
    ok: false,
    stage: "invalid",
    digits: null,
    binding: null,
    reason: normalizeMacSettingsPostSmsFailureReason(reason),
  };
}

function nativeExecutionFailureReason(error) {
  return error?.killed === true || error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM"
    ? "timeout"
    : "helper_exit";
}

/**
 * Preserve only a valid fixed failure token emitted by the helper when its
 * process exits non-zero. Raw stdout stays process-local and is discarded.
 */
export function sanitizeMacSettingsPostSmsProcessFailure(phase, error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  if (stdout) {
    try {
      const result = sanitizeMacSettingsPostSmsResult(phase, JSON.parse(stdout));
      if (result.ok === false) return result;
    } catch {
      // Fall through to the fixed process-level reason.
    }
  }
  return invalidResult(nativeExecutionFailureReason(error));
}

function isValidActionPhase(phase) {
  return ACTION_STAGE_BY_PHASE.has(phase);
}

function isPositiveIntegerInRange(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/**
 * Normalize the non-secret identity established during the visual state
 * phase. The native helper independently re-resolves and compares it before
 * it can emit any input event.
 */
export function normalizeMacSettingsPostSmsBinding(value) {
  if (!value || typeof value !== "object") return null;
  const { axOwnerPid, visualOwnerPid, windowId } = value;
  if (
    !isPositiveIntegerInRange(axOwnerPid, MAX_PID) ||
    !isPositiveIntegerInRange(visualOwnerPid, MAX_PID) ||
    !isPositiveIntegerInRange(windowId, MAX_CG_WINDOW_ID)
  ) {
    return null;
  }
  return { axOwnerPid, visualOwnerPid, windowId };
}

function hasSafeOwnership(stat, uid) {
  return (
    stat &&
    typeof stat.mode === "number" &&
    (stat.mode & 0o022) === 0 &&
    (!Number.isInteger(uid) || stat.uid === uid)
  );
}

function stdinExec(file, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout) => {
      if (error) {
        // The Swift helper emits a fixed JSON failure before its non-zero exit.
        // Preserve that private in-memory payload for the sanitizer below; it
        // is never logged or returned verbatim.
        if (typeof stdout === "string" && typeof error === "object" && error !== null) {
          error.stdout ??= stdout;
        }
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
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}

/** A supervised helper override must stay in the owner-only fixed directory. */
export function isTrustedMacSettingsPostSmsHelperOverride(env = process.env, dependencies = {}) {
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
  const helperPath = path.join(helperDirectory, HELPER_NAME);
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

export function isMacSettingsPostSmsHelperAvailable() {
  if (process.platform !== "darwin") return false;
  if (!isTrustedMacSettingsPostSmsHelperOverride()) return false;
  try {
    const stat = fs.statSync(HELPER_PATH);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function sanitizeMacSettingsPostSmsResult(phase, value) {
  if (!value || typeof value !== "object") return invalidResult();
  if (value.ok !== true) {
    return invalidResult(value.reason ?? value.stage);
  }
  if (phase === "state") {
    if (value.stage === "waiting") {
      return { ok: true, stage: "waiting", digits: null, binding: null };
    }
    if (value.stage === "iphone_unlock" && (value.digits === 4 || value.digits === 6)) {
      const binding = normalizeMacSettingsPostSmsBinding(value.binding);
      return binding
        ? { ok: true, stage: "iphone_unlock", digits: value.digits, binding }
        : invalidResult("binding_invalid");
    }
    if (["terms", "mac_password", "location"].includes(value.stage)) {
      const binding = normalizeMacSettingsPostSmsBinding(value.binding);
      return binding
        ? { ok: true, stage: value.stage, digits: null, binding }
        : invalidResult("binding_invalid");
    }
    return invalidResult();
  }
  if (isValidActionPhase(phase) && value.stage === ACTION_STAGE_BY_PHASE.get(phase)) {
    return { ok: true, stage: value.stage, digits: null, binding: null };
  }
  return invalidResult();
}

/**
 * Run the narrow visual post-SMS helper. Values for password/code phases are
 * accepted only over stdin and never appear in argv or the child environment.
 */
export async function runMacSettingsPostSmsHelper(phase, options = {}) {
  if (!VALID_PHASES.has(phase)) return invalidResult("invalid_request");
  if (!isMacSettingsPostSmsHelperAvailable()) return invalidResult("helper_exit");
  const timeoutMs = Math.trunc(options.timeoutMs ?? 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return invalidResult("invalid_request");

  let input;
  const args = ["--phase", phase];
  if (isValidActionPhase(phase)) {
    const binding = normalizeMacSettingsPostSmsBinding(options.binding);
    if (!binding) return invalidResult("binding_invalid");
    args.push(
      "--ax-owner-pid",
      String(binding.axOwnerPid),
      "--visual-owner-pid",
      String(binding.visualOwnerPid),
      "--window-id",
      String(binding.windowId)
    );
  }
  if (phase === "unlock-code") {
    if (!/^[0-9]{4}(?:[0-9]{2})?$/.test(options.passcode ?? "")) {
      return invalidResult("invalid_request");
    }
    input = `${options.passcode}\n`;
  } else if (phase === "mac-password") {
    if (!/^(?:0{4}|0{6})$/.test(options.password ?? "")) return invalidResult("invalid_request");
    input = `${options.password}\n`;
  }

  const env = { ...process.env };
  for (const key of CHILD_SECRET_ENV_KEYS) delete env[key];
  const executionOptions = { timeout: timeoutMs, env, maxBuffer: 16 * 1024 };
  try {
    const { stdout } =
      input === undefined
        ? await execFileAsync(HELPER_PATH, args, executionOptions)
        : await stdinExec(HELPER_PATH, args, input, executionOptions);
    return sanitizeMacSettingsPostSmsResult(phase, JSON.parse(stdout));
  } catch (error) {
    return sanitizeMacSettingsPostSmsProcessFailure(phase, error);
  }
}

export function macSettingsPostSmsHelperPath() {
  return HELPER_PATH;
}
