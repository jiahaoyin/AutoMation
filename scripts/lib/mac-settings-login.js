import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitForEnter, waitUntil } from "./prompt.js";
import {
  withAccessibilityRetry,
  ensureAutomation,
  checkAutomationGranted,
  openAutomationSettings,
  isAutomationDeniedError,
  getAccessibilityHostApp,
} from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion, openAppleAccountSettings } from "./macos.js";
import {
  compileAxFillHelper,
  fillViaSwiftAx,
  isAxFillAvailable,
} from "./mac-settings-ax-fill.js";
import { saveMacSettingsSmsProviderConfig } from "./credentials.js";
import { completeSupervisedMacSettingsSmsVerification } from "./mac-settings-sms-verification.js";
import { isMacSettingsSmsHelperAvailable } from "./mac-settings-sms-ax.js";
import { createSmsProviderCodePoller, resolveMacSettingsSmsProviderConfig } from "./mac-settings-sms-provider.js";
import {
  completeMacSettingsPostSmsFinalization,
  isMacSettingsPostSmsFinalizationEnabled,
  macSettingsPostSmsModuleIdentity,
} from "./mac-settings-post-sms-finalization.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const DUMP_SCPT = path.resolve(__dirname, "../mac-settings-ui-dump.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];
const MAC_LOGIN_STATUS_ROUTES = new Set(["swift_ax", "applescript"]);
const MAC_LOGIN_STATUS_PHASES = new Set([
  "preflight",
  "dump",
  "email",
  "continue",
  "password",
  "state",
  "fallback_recovery",
]);
const MAC_LOGIN_STATUS_OUTCOMES = new Set(["started", "succeeded", "failed", "fallback"]);
const MAC_LOGIN_STATUS_REASONS = new Set([
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
  "preflight_unavailable",
  "fallback_recovery_failed",
  "applescript_failed",
  "applescript_invalid_output",
]);
const MAC_LOGIN_STATES = new Set(["email", "password", "unknown"]);
const MAC_LOGIN_INPUT_ROUTES = new Set(["ax_value", "keyboard", "existing_value", "unknown"]);
const MAC_LOGIN_PREWRITE_FAILURE_REASONS = new Set([
  "target_unavailable_before_write",
  "target_focus_unavailable",
  "target_changed_before_write",
  "login_state_unknown",
  "login_window_not_found",
  "exact_username_field_not_found",
  "exact_password_field_not_found",
  "settings_process_not_found",
]);
const MAX_MAC_LOGIN_TEXT_FIELDS = 32;
const MAX_POST_SMS_MODULE_ROUNDS = 3;
const MAC_SETTINGS_FAILURE_CODE_RE = /^MAC_SETTINGS_[A-Z0-9_]{1,96}$/;

function boundedPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function postSmsStageLabel(stage) {
  return (
    {
      terms: "条款确认",
      mac_password: "Mac 密码确认",
      iphone_unlock: "iPhone 解锁码确认",
      location: "定位/查找 Mac 确认",
    }[stage] ?? "后置确认页面"
  );
}

function smsStageLabel(stage) {
  return (
    {
      phone_selection: "验证码接收方式",
      code_entry: "验证码输入",
      waiting: "验证码页面",
      surface_unavailable: "验证码页面识别",
    }[stage] ?? "验证码页面"
  );
}

function macLoginToken(value, allowed, fallback = "unknown") {
  return allowed.has(value) ? value : fallback;
}

function normalizeMacLoginReason(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return MAC_LOGIN_STATUS_REASONS.has(normalized) ? normalized : fallback;
}

function sanitizeMacLoginStatus(status = {}) {
  return {
    route: macLoginToken(status.route, MAC_LOGIN_STATUS_ROUTES),
    phase: macLoginToken(status.phase, MAC_LOGIN_STATUS_PHASES),
    outcome: macLoginToken(status.outcome, MAC_LOGIN_STATUS_OUTCOMES, "failed"),
    reason: normalizeMacLoginReason(status.reason),
    loginState: macLoginToken(status.loginState, MAC_LOGIN_STATES),
    inputRoute: macLoginToken(status.inputRoute, MAC_LOGIN_INPUT_ROUTES),
    textFieldCount:
      Number.isInteger(status.textFieldCount) &&
      status.textFieldCount >= 0 &&
      status.textFieldCount <= MAX_MAC_LOGIN_TEXT_FIELDS
        ? status.textFieldCount
        : null,
  };
}

function emitMacLoginStatus(onStatus, status) {
  const safeStatus = sanitizeMacLoginStatus(status);
  if (typeof onStatus === "function") {
    try {
      onStatus(safeStatus);
    } catch {
      /* Audit delivery cannot alter credential submission. */
    }
  }
  return safeStatus;
}

function emitMacSettingsEvent(onEvent, event, details = {}) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent({ event, ...details });
  } catch {
    // Audit delivery must not alter a credential or verification action.
  }
}

function macSettingsFailureCode(error) {
  const candidate = typeof error?.code === "string"
    ? error.code
    : typeof error?.message === "string"
      ? error.message
      : "";
  return MAC_SETTINGS_FAILURE_CODE_RE.test(candidate)
    ? candidate.toLowerCase()
    : "unknown";
}

function createMacLoginError(status) {
  const error = new Error("MAC_SETTINGS_LOGIN_FAILED");
  error.code = "MAC_SETTINGS_LOGIN_FAILED";
  error.macSettingsStatus = sanitizeMacLoginStatus(status);
  return error;
}

export function appleScriptPhaseFromStep(step) {
  if (!Number.isInteger(step) || step < 1) return "state";
  if (step <= 3) return "state";
  if (step <= 6) return "email";
  if (step <= 8) return "continue";
  return "password";
}

export function sanitizedMacSettingsChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete childEnv[key];
  return childEnv;
}

function clearMacSettingsSmsRuntimeSecrets(env = process.env) {
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) delete env[key];
}

/** 自动化预检：激活系统设置并尝试读取 UI 属性 */
export async function preflightMacSettingsAutomation(options = {}) {
  emitMacSettingsEvent(options.onEvent, "automation_preflight_started", { module: "login" });
  const host = getAccessibilityHostApp();
  const check = await checkAutomationGranted();
  if (check.granted) {
    console.log(`[Mac 设置] ✓ 自动化预检通过（${host.name} → 系统设置）`);
    emitMacSettingsEvent(options.onEvent, "automation_preflight_completed", {
      module: "login",
      outcome: "granted",
    });
    return { ok: true, host: host.name };
  }

  console.warn(`[Mac 设置] 自动化预检未通过: ${check.reason ?? check.code ?? "unknown"}`);
  console.warn(
    `[Mac 设置] 请在 系统设置 → 隐私与安全性 → 自动化 中展开「${host.name}」并勾选「系统设置」`
  );
  openAutomationSettings();

  await ensureAutomation({ quiet: false, timeoutMs: 120_000 });
  emitMacSettingsEvent(options.onEvent, "automation_preflight_completed", {
    module: "login",
    outcome: "prompted",
  });
  return { ok: true, host: host.name };
}

/** 预检：登录窗口是否可见（解析 dump 脚本输出） */
async function preflightLoginWindowVisible(options = {}) {
  const route = options.route ?? "swift_ax";
  const phase = options.phase ?? "preflight";
  emitMacLoginStatus(options.onStatus, { route, phase, outcome: "started", reason: "ok" });
  emitMacSettingsEvent(options.onEvent, "login_window_preflight_started", { module: "login" });
  try {
    const { stdout } = await execFileAsync("osascript", [DUMP_SCPT], {
      timeout: 25_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    const text = stdout.trim();
    if (/login window found/.test(text) && /deep=[1-9]/.test(text)) {
      console.log("[Mac 设置] ✓ 预检：登录窗口已就绪");
      emitMacLoginStatus(options.onStatus, { route, phase, outcome: "succeeded", reason: "ok" });
      emitMacSettingsEvent(options.onEvent, "login_window_preflight_completed", {
        module: "login",
        outcome: "ready",
      });
      return true;
    }
    console.warn("[Mac 设置] 预检：登录窗口或输入框未就绪");
    emitMacLoginStatus(options.onStatus, {
      route,
      phase,
      outcome: "failed",
      reason: "preflight_unavailable",
    });
      emitMacSettingsEvent(options.onEvent, "login_window_preflight_completed", {
        module: "login",
        outcome: "unavailable",
        reason: "preflight_unavailable",
      });
    return false;
  } catch {
    console.warn("[Mac 设置] 预检 AX probe 失败");
    emitMacLoginStatus(options.onStatus, {
      route,
      phase,
      outcome: "failed",
      reason: "preflight_unavailable",
    });
      emitMacSettingsEvent(options.onEvent, "login_window_preflight_completed", {
        module: "login",
        outcome: "probe_failed",
        reason: "preflight_unavailable",
      });
    return false;
  }
}

/** AppleScript 回退（索引式 BFS，不缓存元素引用） */
async function fillViaAppleScript(creds, options = {}) {
  console.log("[Mac 设置] AppleScript 回退填表…");
  emitMacLoginStatus(options.onStatus, {
    route: "applescript",
    phase: "state",
    outcome: "started",
    reason: "ok",
  });
  emitMacSettingsEvent(options.onEvent, "applescript_fill_started", { module: "login" });
  let stdout = "";
  let stderr = "";
  let executionFailed = false;
  let lastStep = 0;
  try {
    ({ stdout, stderr } = await execFileAsync("osascript", [LOGIN_SCPT], {
      timeout: 180_000,
      env: {
        ...sanitizedMacSettingsChildEnv(),
        APPLE_SCRIPT_APPLE_ID: creds.appleId,
        APPLE_SCRIPT_PASSWORD: creds.password,
        APPLE_SCRIPT_PANE_OPENED: "1",
      },
    }));
  } catch (error) {
    executionFailed = true;
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
  }

  if (stderr?.trim()) {
    for (const line of stderr.trim().split("\n")) {
      const match = /^\[step\s+(\d+)\]/.exec(line.trim());
      if (match) {
        lastStep = Math.max(lastStep, Number.parseInt(match[1], 10) || 0);
        console.log("[Mac 设置] AppleScript step " + match[1] + " complete");
        emitMacSettingsEvent(options.onEvent, "applescript_step_completed", {
          module: "login",
          step: lastStep,
        });
      }
    }
  }
  const ok = !executionFailed && stdout?.trim() === "ok";
  const status = emitMacLoginStatus(options.onStatus, {
    route: "applescript",
    phase: ok ? "password" : appleScriptPhaseFromStep(lastStep),
    outcome: ok ? "succeeded" : "failed",
    reason: ok ? "ok" : executionFailed ? "applescript_failed" : "applescript_invalid_output",
  });
  emitMacSettingsEvent(options.onEvent, "applescript_fill_completed", {
    module: "login",
    outcome: status.outcome,
    phase: status.phase,
    reason: status.reason,
  });
  if (!ok) throw createMacLoginError(status);
  return status;
}

export function mayUseAppleScriptFallback(status) {
  if (status?.route !== "swift_ax" || status?.inputRoute !== "unknown") {
    return false;
  }
  if (status?.phase === "dump" || status?.phase === "state") {
    return true;
  }
  if (status?.phase !== "email" && status?.phase !== "password") {
    return false;
  }
  return MAC_LOGIN_PREWRITE_FAILURE_REASONS.has(status?.reason);
}

export async function probeMacSettingsSignedIn() {
  try {
    const { stdout } = await execFileAsync("osascript", [SIGNED_IN_SCPT], {
      timeout: 15_000,
      env: sanitizedMacSettingsChildEnv(),
    });
    return {
      signedIn: stdout.trim().toLowerCase() === "yes",
      outcome: "completed",
    };
  } catch {
    return { signedIn: false, outcome: "probe_failed" };
  }
}

export async function isMacSettingsSignedIn() {
  return (await probeMacSettingsSignedIn()).signedIn;
}

export function isMacSettingsSmsRuntimeEnabled(env = process.env) {
  if (env.APPLE_AUTOMATION_SMS_RECONFIGURE === "1") return true;
  if (env.APPLE_AUTOMATION_SMS_ENABLED === "0") return false;
  if (env.APPLE_AUTOMATION_SMS_ENABLED === "1") return true;
  return (
    Boolean(env.APPLE_AUTOMATION_SMS_PHONE?.trim()) ||
    Boolean(env.APPLE_AUTOMATION_SMS_API_URL?.trim())
  );
}

/**
 * 打开系统设置 Apple ID 并填入账号密码（手机验证码人工完成）
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillMacSettingsAppleLogin(creds, options = {}) {
  console.log("\n[Mac 设置] 打开 Apple ID 并填入账号密码…");
  emitMacSettingsEvent(options.onEvent, "login_fill_started", { module: "login" });

  try {
    await preflightMacSettingsAutomation({ onEvent: options.onEvent });
  } catch (error) {
    emitMacSettingsEvent(options.onEvent, "automation_preflight_failed", { module: "login" });
    throw error;
  }
  const built = compileAxFillHelper({ quiet: true });
  emitMacSettingsEvent(options.onEvent, "swift_ax_helper_checked", {
    module: "login",
    outcome: built.ok ? "ready" : "unavailable",
    reason: built.ok ? "ok" : "compile_failed",
  });
  if (!built.ok) {
    emitMacLoginStatus(options.onStatus, {
      route: "swift_ax",
      phase: "preflight",
      outcome: "failed",
      reason: "compile_failed",
    });
  }

  await withAccessibilityRetry(
    async () => {
      console.log("[Mac 设置] 打开 Apple Account 深链…");
      emitMacSettingsEvent(options.onEvent, "apple_account_deep_link_opened", { module: "login" });
      openAppleAccountSettings({ env: sanitizedMacSettingsChildEnv() });
      await sleep(3500);

      try {
        await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], {
          timeout: 20_000,
          env: sanitizedMacSettingsChildEnv(),
        });
        emitMacSettingsEvent(options.onEvent, "automation_control_check_completed", {
          module: "login",
          outcome: "succeeded",
        });
      } catch (err) {
        emitMacSettingsEvent(options.onEvent, "automation_control_check_failed", {
          module: "login",
          reason: "automation_control_unavailable",
        });
        const msg = String(err?.stderr ?? err?.message ?? err);
        if (isAutomationDeniedError({ message: msg })) {
          openAutomationSettings();
          throw new Error(
            "缺少自动化权限：请在 系统设置 → 隐私与安全性 → 自动化 中允许当前终端 App 控制「系统设置」，然后重试。"
          );
        }
      }

      await preflightLoginWindowVisible({ onStatus: options.onStatus, onEvent: options.onEvent });

      // 主路径：Swift AX API
      if (isAxFillAvailable()) {
        try {
          emitMacSettingsEvent(options.onEvent, "swift_ax_fill_started", { module: "login" });
          await fillViaSwiftAx(creds, { onStatus: options.onStatus });
          emitMacSettingsEvent(options.onEvent, "swift_ax_fill_completed", {
            module: "login",
            outcome: "succeeded",
          });
          return;
        } catch (swiftErr) {
          const swiftStatus = sanitizeMacLoginStatus(swiftErr?.macSettingsStatus);
          if (!mayUseAppleScriptFallback(swiftStatus)) {
            emitMacSettingsEvent(options.onEvent, "swift_ax_fill_completed", {
              module: "login",
              outcome: "failed",
              phase: swiftStatus.phase,
              reason: swiftStatus.reason,
            });
            throw createMacLoginError(swiftStatus);
          }
          emitMacLoginStatus(options.onStatus, {
            ...swiftStatus,
            outcome: "fallback",
          });
          console.warn("[Mac 设置] Swift AX 主路径失败，回退 AppleScript…");
          emitMacSettingsEvent(options.onEvent, "swift_ax_fallback_started", {
            module: "login",
            phase: swiftStatus.phase,
            reason: swiftStatus.reason,
          });
          await fillViaAppleScript(creds, { onStatus: options.onStatus, onEvent: options.onEvent });
          return;
        }
      } else {
        console.warn("[Mac 设置] Swift AX helper 不可用，使用 AppleScript 回退");
        emitMacLoginStatus(options.onStatus, {
          route: "swift_ax",
          phase: "preflight",
          outcome: "fallback",
          reason: "helper_unavailable",
        });
      }

      // The fallback resolves the same exact identifiers and can begin from a
      // fresh email page or an already advanced password page.
      await fillViaAppleScript(creds, { onStatus: options.onStatus, onEvent: options.onEvent });
    },
    { label: "Mac 系统设置填表", maxAttempts: 2 }
  );

  console.log("[Mac 设置] 填表结果: ok");
  emitMacSettingsEvent(options.onEvent, "login_fill_completed", {
    module: "login",
    outcome: "succeeded",
  });
}

/**
 * 等待 Mac 设置中 Apple ID 完全登录（手机验证码人工 + 自动轮询 Sign Out / 邮箱）
 */
export async function waitForMacSettingsLoginComplete(options = {}) {
  const isSignedIn = options.isSignedIn ?? isMacSettingsSignedIn;
  const signedInProbe = options.isSignedIn
    ? async () => ({ signedIn: await isSignedIn(), outcome: "external" })
    : probeMacSettingsSignedIn;
  const pause = options.sleep ?? sleep;
  const postSmsFinalization = options.postSmsFinalization;
  const manualContinuation = options.manualContinuation ?? options.postSmsManualContinuation;
  const onEvent = options.onEvent;
  const postSmsIntervalMs = options.postSmsIntervalMs ?? 1_500;
  const postSmsTransitionGraceMs = boundedPositiveInteger(
    options.postSmsTransitionGraceMs,
    45_000
  );
  const postSmsProbeGraceMs = boundedPositiveInteger(
    options.postSmsProbeGraceMs,
    90_000
  );
  const now = options.now ?? Date.now;
  const maxPostSmsModuleRounds = boundedPositiveInteger(
    options.maxPostSmsModuleRounds,
    MAX_POST_SMS_MODULE_ROUNDS
  );
  const postSmsRounds = new Map();
  const blockedPostSmsModules = new Set();
  const promptedPostSmsModules = new Set();
  let pendingPostSmsTransition = null;
  let unboundPostSmsProbeFailures = 0;
  let unboundPostSmsProbeStartedAt = 0;
  let postSmsDisabled = false;
  let nextPostSmsAt = 0;

  const schedulePostSms = (delayMs = postSmsIntervalMs) => {
    nextPostSmsAt = now() + Math.max(250, delayMs);
  };
  const resumeManualObservation = (identity, manualKey) => {
    if (identity) {
      // A supervised Enter means the operator handled this exact module.
      // Keep its action budget blocked and observe only its transition; a
      // still-visible sheet must never receive another three automatic clicks.
      pendingPostSmsTransition = {
        identity,
        until: now() + postSmsTransitionGraceMs,
      };
    } else {
      unboundPostSmsProbeFailures = 0;
      unboundPostSmsProbeStartedAt = 0;
    }
    promptedPostSmsModules.delete(manualKey);
    schedulePostSms();
  };
  const requestManualContinuation = async (result, identity, manualKey) => {
    if (promptedPostSmsModules.has(manualKey)) return false;
    promptedPostSmsModules.add(manualKey);
    console.warn(
      `[Mac Settings] ${postSmsStageLabel(result?.stage)} requires manual completion; press Enter after that step to resume dynamic scanning.`
    );
    emitMacSettingsEvent(onEvent, "post_sms_manual_required", {
      module: "post_sms",
      stage: result?.stage ?? "unidentified",
      reason: result?.reason ?? "unknown",
      identity: identity ?? "unidentified",
      rounds: identity ? postSmsRounds.get(identity) ?? 0 : unboundPostSmsProbeFailures,
    });
    if (typeof manualContinuation !== "function") return false;
    let resumed = false;
    try {
      resumed = (await manualContinuation({
        module: "post_sms",
        stage: result?.stage ?? null,
        binding: result?.binding ?? null,
        identity,
        rounds: identity ? postSmsRounds.get(identity) ?? 0 : unboundPostSmsProbeFailures,
        reason: result?.reason ?? null,
      })) === true;
    } catch {
      resumed = false;
    }
    emitMacSettingsEvent(onEvent, "post_sms_manual_continuation", {
      module: "post_sms",
      stage: result?.stage ?? "unidentified",
      outcome: resumed ? "resumed" : "not_resumed",
    });
    if (resumed) resumeManualObservation(identity, manualKey);
    return resumed;
  };

  await waitUntil(
    "[Mac Settings] Complete any remaining System Settings verification steps. The script will keep scanning until the signed-in state is confirmed.",
    async () => {
      if (
        typeof postSmsFinalization === "function" &&
        !postSmsDisabled &&
        now() >= nextPostSmsAt
      ) {
        const pending = pendingPostSmsTransition && now() < pendingPostSmsTransition.until
          ? pendingPostSmsTransition
          : null;
        if (!pending) pendingPostSmsTransition = null;

        let result;
        try {
          emitMacSettingsEvent(onEvent, "post_sms_probe_started", {
            module: "post_sms",
            probeOnly: Boolean(pending),
          });
          result = await postSmsFinalization({
            probeOnly: Boolean(pending),
            beforeSubmit: (state) => {
              const identity = macSettingsPostSmsModuleIdentity(state);
              if (!identity || blockedPostSmsModules.has(identity)) {
                emitMacSettingsEvent(onEvent, "post_sms_action_blocked", {
                  module: "post_sms",
                  stage: state?.stage ?? "waiting",
                  identity: identity ?? "unidentified",
                });
                return false;
              }
              const rounds = postSmsRounds.get(identity) ?? 0;
              if (rounds >= maxPostSmsModuleRounds) {
                emitMacSettingsEvent(onEvent, "post_sms_action_limit_reached", {
                  module: "post_sms",
                  stage: state?.stage ?? "waiting",
                  identity,
                  rounds,
                });
                return false;
              }
              // Count before native input so a lost helper response cannot turn
              // a fourth click into an untracked attempt.
              postSmsRounds.set(identity, rounds + 1);
              emitMacSettingsEvent(onEvent, "post_sms_action_authorized", {
                module: "post_sms",
                stage: state?.stage ?? "waiting",
                identity,
                attempts: rounds + 1,
              });
              return true;
            },
          });
        } catch {
          result = { status: "retryable", reason: "controller_failed" };
        }

        const identity = macSettingsPostSmsModuleIdentity(result);
        emitMacSettingsEvent(onEvent, "post_sms_probe_result", {
          module: "post_sms",
          status: result?.status ?? "invalid",
          stage: result?.stage ?? "waiting",
          reason: result?.reason ?? "ok",
          identity: identity ?? "unidentified",
          probeOnly: Boolean(pending),
        });
        if (pending) {
          if (result?.status === "state_observed" && identity === pending.identity) {
            // During the grace window only observe the same modal. No duplicate
            // Terms/Location click is sent while a slow page is transitioning.
            schedulePostSms();
            emitMacSettingsEvent(onEvent, "post_sms_transition_waiting", {
              module: "post_sms",
              identity,
            });
            return false;
          }
          if (
            (result?.status === "retryable" && !identity) ||
            result?.status === "not_required"
          ) {
            // AX can be temporarily blank while the same modal is animating
            // away, and a no-modal `waiting` read can precede the next
            // network-loaded surface. Keep the old identity in probe-only
            // mode for the rest of its grace period so the next scan cannot
            // submit it again or let signed-in detection skip it.
            schedulePostSms();
            emitMacSettingsEvent(onEvent, "post_sms_transition_waiting", {
              module: "post_sms",
              identity: pending.identity,
            });
            return false;
          } else {
            pendingPostSmsTransition = null;
            if (result?.status === "state_observed") {
              // A different optional module appeared. Re-enter normally so it
              // receives its own identity and bounded action budget.
              nextPostSmsAt = 0;
              return false;
            }
          }
        }

        if (result?.status === "submitted") {
          unboundPostSmsProbeFailures = 0;
          unboundPostSmsProbeStartedAt = 0;
          // Native success proves the click was accepted, not that the sheet
          // has finished loading away. Re-enter in probe-only mode for one
          // bounded grace window before any later optional module can act.
          pendingPostSmsTransition = identity
            ? { identity, until: now() + postSmsTransitionGraceMs }
            : null;
          schedulePostSms();
          emitMacSettingsEvent(onEvent, "post_sms_transition_waiting", {
            module: "post_sms",
            identity: identity ?? "unidentified",
          });
          return false;
        }

        if (result?.status === "retryable") {
          if (identity) {
            pendingPostSmsTransition = {
              identity,
              until: now() + postSmsTransitionGraceMs,
            };
            schedulePostSms();
            emitMacSettingsEvent(onEvent, "post_sms_retry_scheduled", {
              module: "post_sms",
              identity,
              rounds: postSmsRounds.get(identity) ?? 0,
            });
          } else {
            unboundPostSmsProbeFailures += 1;
            if (unboundPostSmsProbeStartedAt === 0) {
              unboundPostSmsProbeStartedAt = now();
            }
            if (now() - unboundPostSmsProbeStartedAt < postSmsProbeGraceMs) {
              schedulePostSms();
            } else {
                result = {
                status: "manual_required",
                reason: result.reason ?? "state_probe_unavailable",
                };
                emitMacSettingsEvent(onEvent, "post_sms_probe_limit_reached", {
                  module: "post_sms",
                  attempts: unboundPostSmsProbeFailures,
                });
            }
          }
        } else if (result?.status === "not_required") {
          unboundPostSmsProbeFailures = 0;
          unboundPostSmsProbeStartedAt = 0;
        }

        if (result?.status === "manual_required") {
          const manualKey = identity ?? "unidentified";
          if (identity) blockedPostSmsModules.add(identity);
          await requestManualContinuation(result, identity, manualKey);
        }

        if (result?.status !== "submitted") schedulePostSms();
      }
      // A confirmed post-SMS action can reveal another optional surface after
      // the account probe already says signed in. Complete one bounded
      // probe-only transition observation before accepting that signed-in
      // result, otherwise slow Settings hydration truncates the next module.
      if (pendingPostSmsTransition && now() < pendingPostSmsTransition.until) {
        emitMacSettingsEvent(onEvent, "signed_in_probe", {
          module: "login",
          signedIn: false,
          outcome: "deferred",
        });
        return false;
      }
      // Enter only resumes the scanner. It never acts as a signed-in marker.
      const signedInResult = await signedInProbe();
      const signedIn = signedInResult.signedIn === true;
      emitMacSettingsEvent(onEvent, "signed_in_probe", {
        module: "login",
        signedIn,
        outcome: signedInResult.outcome,
      });
      return signedIn;
    },
    {
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      intervalMs: options.intervalMs ?? 2500,
      timeoutCode: "MAC_SETTINGS_LOGIN_WAIT_TIMEOUT",
      allowManualContinuation: false,
    }
  );

  await pause(options.settleMs ?? 1500);
  const settled = await signedInProbe();
  const ok = settled.signedIn === true;
  emitMacSettingsEvent(onEvent, "signed_in_settle_probe", {
    module: "login",
    signedIn: ok,
    outcome: settled.outcome,
  });
  if (!ok) {
    throw new Error("MAC_SETTINGS_LOGIN_NOT_CONFIRMED");
  }
  console.log("[Mac Settings] Signed-in state confirmed.");
  return { signedIn: true };
}
/**
 * @param {{ appleId: string, password: string }} creds
 * @param {{ smsEnv?: Record<string, string | undefined>, onStatus?: (status: object) => void }} [options]
 */
export async function runMacSettingsLoginPhase(creds, options = {}) {
  emitMacSettingsEvent(options.onEvent, "mac_settings_phase_started", { module: "login" });
  const version = ensureMacOS15({
    strict: false,
    env: sanitizedMacSettingsChildEnv(),
  });
  console.log(
    `[Mac 设置] macOS ${version.productVersion}（目标 macOS 15 Sequoia）`
  );

  const initialSignedInProbe = await probeMacSettingsSignedIn();
  emitMacSettingsEvent(options.onEvent, "initial_signed_in_probe", {
    module: "login",
    signedIn: initialSignedInProbe.signedIn === true,
    outcome: initialSignedInProbe.outcome,
  });
  if (initialSignedInProbe.signedIn === true) {
    emitMacSettingsEvent(options.onEvent, "mac_settings_already_signed_in", { module: "login" });
    emitMacSettingsEvent(options.onEvent, "mac_settings_phase_completed", {
      module: "login",
      outcome: "skipped",
    });
    console.log("[Mac 设置] 检测到已登录 Apple ID，跳过填表");
    return { skipped: true, signedIn: true };
  }

  const smsEnv = { ...process.env, ...(options.smsEnv ?? {}) };
  let smsConfig = null;
  if (isMacSettingsSmsRuntimeEnabled(smsEnv)) {
    try {
      smsConfig = await resolveMacSettingsSmsProviderConfig({ env: smsEnv });
    } catch (error) {
      emitMacSettingsEvent(options.onEvent, "sms_provider_config_failed", {
        module: "sms",
        failureCode: macSettingsFailureCode(error),
      });
      throw error;
    }
  }
  if (!smsConfig) {
    emitMacSettingsEvent(options.onEvent, "sms_provider_not_configured", {
      module: "sms",
      outcome: "unavailable",
    });
  }
  if (smsConfig?.source === "terminal") {
    try {
      saveMacSettingsSmsProviderConfig(smsConfig);
      emitMacSettingsEvent(options.onEvent, "sms_provider_config_saved", { module: "sms" });
      console.log("[Mac Settings][SMS] SMS provider configuration saved to .env.");
    } catch {
      emitMacSettingsEvent(options.onEvent, "sms_provider_config_failed", {
        module: "sms",
        failureCode: "mac_settings_sms_config_save_failed",
      });
      throw new Error("MAC_SETTINGS_SMS_CONFIG_SAVE_FAILED");
    }
  }
  if (smsConfig) clearMacSettingsSmsRuntimeSecrets();
  const canConfirmMacSettingsManually =
    process.stdin?.isTTY === true && process.stdout?.isTTY === true;

  await fillMacSettingsAppleLogin(creds, {
    onStatus: options.onStatus,
    onEvent: options.onEvent,
  });
  if (smsConfig) {
    if (!isMacSettingsSmsHelperAvailable()) {
      emitMacSettingsEvent(options.onEvent, "sms_helper_unavailable", { module: "sms" });
      console.warn(
        "[Mac Settings][SMS] Native SMS helper is unavailable; complete SMS verification manually in System Settings."
      );
      if (!canConfirmMacSettingsManually) {
        const error = new Error("MAC_SETTINGS_SMS_HELPER_UNAVAILABLE");
        error.code = "MAC_SETTINGS_SMS_HELPER_UNAVAILABLE";
        emitMacSettingsEvent(options.onEvent, "sms_module_failed", {
          module: "sms",
          failureCode: macSettingsFailureCode(error),
        });
        throw error;
      }
      await waitForEnter(
        "\n[Mac Settings][SMS] Complete the mandatory six-digit verification page, then press Enter to begin post-SMS scanning…"
      );
      emitMacSettingsEvent(options.onEvent, "sms_manual_handoff_acknowledged", { module: "sms" });
    } else {
      console.log("[Mac Settings][SMS] Waiting for the trusted destination and code entry.");
      emitMacSettingsEvent(options.onEvent, "sms_module_started", { module: "sms" });
      let smsResult;
      try {
        smsResult = await completeSupervisedMacSettingsSmsVerification({
        phoneNumber: smsConfig.phoneNumber,
        codeProvider: createSmsProviderCodePoller(smsConfig),
        supervised: true,
        manualContinuation:
          canConfirmMacSettingsManually
            ? async ({ stage }) => {
                await waitForEnter(
                  `\n[Mac 设置] 已保留当前系统设置页面（${smsStageLabel(stage)}）。请人工完成后按 Enter 继续…`
                );
                return true;
              }
            : undefined,
        onProgress: ({ event }) => {
          const message = {
            phone_selection_detected: "检测到验证码接收方式，正在匹配已配置号码",
            phone_selection_submitted: "验证码接收方式已提交，等待验证码输入页加载",
            code_entry_detected: "验证码输入页已就绪",
            code_polling_started: "正在轮询验证码",
            code_written: "验证码已写入，等待页面切换确认",
            code_transition_waiting: "验证码页面仍在处理，等待切换确认",
            code_submitted: "验证码已写入，等待下一确认模块",
            code_transition_observed: "验证码页面已跳转，继续后续确认",
          }[event];
          if (message) console.log(`[Mac 设置][SMS] ${message}`);
        },
          onEvent: options.onEvent,
        });
      } catch (error) {
        emitMacSettingsEvent(options.onEvent, "sms_module_failed", {
          module: "sms",
          failureCode: macSettingsFailureCode(error),
        });
        throw error;
      }
      emitMacSettingsEvent(options.onEvent, "sms_module_completed", {
        module: "sms",
        status: smsResult?.status ?? "invalid",
        stage: smsResult?.stage ?? "waiting",
      });
      if (smsResult?.status === "manual_completed") {
        console.log(
          "[Mac Settings][SMS] Manual step acknowledged; SMS state advanced. Re-scanning before post-SMS."
        );
      } else {
        console.log(
          "[Mac Settings][SMS] Verification code submitted. Apple will continue automatically; finish any remaining screens in System Settings."
        );
      }
    }
  } else {
    console.log("\n[Mac Settings] Credentials submitted. Complete SMS verification manually if shown.");
  }
  const postSmsEnabled = isMacSettingsPostSmsFinalizationEnabled(smsEnv);
  if (!postSmsEnabled) {
    emitMacSettingsEvent(options.onEvent, "post_sms_module_disabled", {
      module: "post_sms",
      outcome: "unavailable",
    });
  }
  try {
    await waitForMacSettingsLoginComplete({
    postSmsFinalization: postSmsEnabled
      ? ({ beforeSubmit, probeOnly } = {}) =>
          completeMacSettingsPostSmsFinalization({
            supervised: true,
            scanTimeoutMs: 5_000,
            actionTimeoutMs: 90_000,
            probeOnly,
            beforeSubmit,
            onEvent: options.onEvent,
          })
      : undefined,
    manualContinuation:
      postSmsEnabled && canConfirmMacSettingsManually
        ? async ({ stage }) => {
            await waitForEnter(
              `\n[Mac 设置] 请人工完成${postSmsStageLabel(stage)}，然后按 Enter 继续自动扫描…`
            );
            return true;
          }
        : undefined,
      onEvent: options.onEvent,
    });
  } catch (error) {
    emitMacSettingsEvent(options.onEvent, "mac_settings_login_wait_failed", {
      module: "login",
      failureCode: macSettingsFailureCode(error),
    });
    throw error;
  }
  emitMacSettingsEvent(options.onEvent, "mac_settings_phase_completed", { module: "login" });
  return { skipped: false, signedIn: true };
}
