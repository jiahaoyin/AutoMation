import {
  normalizeMacSettingsPostSmsFailureReason,
  normalizeMacSettingsPostSmsBinding,
  runMacSettingsPostSmsHelper,
} from "./mac-settings-post-sms-finalization-ax.js";

const VALID_STAGES = new Set(["waiting", "terms", "mac_password", "iphone_unlock", "location"]);
const ACTION_BY_STAGE = new Map([
  ["terms", "terms"],
  ["mac_password", "mac-password"],
  ["iphone_unlock", "unlock-code"],
  ["location", "location"],
]);
const TERMINAL_STAGE_LABELS = Object.freeze({
  terms: "条款确认",
  mac_password: "Mac 密码确认",
  iphone_unlock: "iPhone 解锁码确认",
  location: "定位/查找 Mac 确认",
});
// iPhone unlock still requires a device-local secret that is intentionally not
// kept in the automation runtime. The Mac password prompt is a fixed supervised
// zero-password surface: the target Mac uses either four or six zeroes.
const MANUAL_STAGES = new Set(["iphone_unlock"]);
const FIXED_MAC_PASSWORDS = Object.freeze(["000000", "0000"]);

function normalizeFixedMacPassword(value) {
  return typeof value === "string" && /^(?:0{4}|0{6})$/.test(value) ? value : null;
}

function macPasswordCandidates(options) {
  const preferred = normalizeFixedMacPassword(options?.macPassword);
  return preferred ? [preferred] : FIXED_MAC_PASSWORDS;
}

function terminalStageLabel(stage) {
  return TERMINAL_STAGE_LABELS[stage] ?? "后置确认页面";
}

function boundedPositive(value, fallback) {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : fallback;
}

function resultFor(status, state = null, details = {}) {
  const result = { status, ...details };
  if (state?.stage && ACTION_BY_STAGE.has(state.stage) && state.binding) {
    result.stage = state.stage;
    result.binding = state.binding;
  }
  return result;
}

export function isMacSettingsPostSmsFinalizationEnabled(env = process.env) {
  // The dynamic follow-up scan is independent of provider configuration and
  // remains on unless it is explicitly disabled.
  return env.APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED !== "0";
}

export function normalizeMacSettingsPostSmsState(value) {
  if (!value || value.ok !== true || !VALID_STAGES.has(value.stage)) {
    return { ok: false, stage: "invalid", digits: null, binding: null };
  }
  if (value.stage === "waiting") {
    return { ok: true, stage: "waiting", digits: null, binding: null };
  }
  if (["terms", "mac_password", "location"].includes(value.stage)) {
    const binding = normalizeMacSettingsPostSmsBinding(value.binding);
    return binding
      ? { ok: true, stage: value.stage, digits: null, binding }
      : { ok: false, stage: "invalid", digits: null, binding: null };
  }
  const binding = normalizeMacSettingsPostSmsBinding(value.binding);
  return (value.digits === 4 || value.digits === 6) && binding
    ? { ok: true, stage: "iphone_unlock", digits: value.digits, binding }
    : { ok: false, stage: "invalid", digits: null, binding: null };
}

/**
 * Stable, non-secret identity for one trusted post-SMS surface.  The stage is
 * included deliberately: a later Terms/Location sheet in the same Settings
 * window is a different module and gets its own bounded retry budget.
 */
export function macSettingsPostSmsModuleIdentity(value) {
  const stage = value?.stage;
  const binding = normalizeMacSettingsPostSmsBinding(value?.binding);
  if (!ACTION_BY_STAGE.has(stage) || !binding) return null;
  return `${stage}:${binding.axOwnerPid}:${binding.visualOwnerPid}:${binding.windowId}`;
}

/**
 * Resolve one optional post-SMS System Settings module at a time. The outer
 * login loop owns retry policy; this controller does exactly one short state
 * probe, invokes its optional pre-action policy, and then performs at most one
 * already-bound native action.
 */
export async function completeMacSettingsPostSmsFinalization(options = {}) {
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const emitEvent = (event, details = {}) => {
    if (!onEvent) return;
    try {
      onEvent({ module: "post_sms", event, ...details });
    } catch {
      // Diagnostic delivery is strictly best effort.
    }
  };
  const platform = options.platform ?? process.platform;
  const supervised = options.supervised ?? process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const isTTY = options.isTTY ?? Boolean(
    process.stdin?.isTTY === true && (process.stdout?.isTTY === true || supervised === true)
  );
  if (platform !== "darwin" || supervised !== true || isTTY !== true) {
    emitEvent("supervision_unavailable");
    return resultFor("manual_required");
  }

  const nativeRunner = options.nativeRunner ?? runMacSettingsPostSmsHelper;
  // A missing modal must never starve regular signed-in detection. The caller
  // polls this one-shot probe again on its normal cadence.
  const scanTimeoutMs = boundedPositive(options.scanTimeoutMs, 5_000);
  const actionTimeoutMs = boundedPositive(options.actionTimeoutMs, 90_000);
  emitEvent("state_probe_started", { timeoutMs: scanTimeoutMs, probeOnly: options.probeOnly === true });
  let rawState;
  try {
    rawState = await nativeRunner("state", { timeoutMs: scanTimeoutMs });
  } catch {
    // A helper timeout is inconclusive. Let the outer loop retry before
    // offering a generic manual handoff.
    emitEvent("state_probe_failed");
    return resultFor("retryable", null, { reason: "state_probe_failed" });
  }
  const state = normalizeMacSettingsPostSmsState(rawState);
  if (!state.ok) {
    const reason = normalizeMacSettingsPostSmsFailureReason(rawState?.reason ?? rawState?.stage);
    emitEvent("state_probe_invalid", { reason });
    return resultFor("retryable", null, { reason });
  }
  emitEvent("state_observed", { stage: state.stage });
  if (state.stage === "waiting") return resultFor("not_required");
  if (options.probeOnly === true) {
    // A manual handoff just acknowledged by the operator can remain visible
    // briefly. Observe it during the outer grace window instead of prompting
    // again before the same sheet has had time to transition.
    emitEvent("state_observed_probe_only", { stage: state.stage });
    return resultFor("state_observed", state);
  }
  if (MANUAL_STAGES.has(state.stage)) {
    emitEvent("manual_required", { stage: state.stage });
    return resultFor("manual_required", state);
  }

  const phase = ACTION_BY_STAGE.get(state.stage);
  if (!phase || !state.binding) {
    emitEvent("manual_required", { stage: state.stage });
    return resultFor("manual_required", state);
  }
  if (typeof options.beforeSubmit === "function") {
    let accepted = false;
    try {
      accepted = (await options.beforeSubmit(state)) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      emitEvent("action_not_authorized", { stage: state.stage });
      return resultFor("manual_required", state);
    }
  }

  const expectedStage = {
    terms: "terms_submitted",
    mac_password: "mac_password_submitted",
    iphone_unlock: "iphone_unlock_submitted",
    location: "location_submitted",
  }[state.stage];
  const passwords = state.stage === "mac_password" ? macPasswordCandidates(options) : [null];
  let submitted = null;
  for (let attempt = 0; attempt < passwords.length; attempt += 1) {
    const password = passwords[attempt];
    const actionOptions = {
      binding: state.binding,
      timeoutMs: actionTimeoutMs,
    };
    if (password !== null) actionOptions.password = password;
    try {
      emitEvent("action_started", {
        stage: state.stage,
        phase,
        timeoutMs: actionTimeoutMs,
        attempt: attempt + 1,
        ...(password === null ? {} : { passwordLength: password.length }),
      });
      submitted = await nativeRunner(phase, actionOptions);
    } catch {
      submitted = null;
    }
    if (submitted?.ok === true && submitted.stage === expectedStage) break;
    if (attempt + 1 < passwords.length) {
      emitEvent("action_retry", {
        stage: state.stage,
        phase,
        attempt: attempt + 1,
        nextPasswordLength: passwords[attempt + 1].length,
      });
    }
  }
  if (submitted?.ok === true && submitted.stage === expectedStage) {
    console.log(`[Mac 设置] 已处理后置弹窗：${terminalStageLabel(state.stage)}`);
    emitEvent("action_completed", { stage: state.stage, phase });
    return resultFor("submitted", state);
  }

  console.warn(`[Mac 设置] ${terminalStageLabel(state.stage)}处理失败，保留页面供人工核对。`);
  const reason = normalizeMacSettingsPostSmsFailureReason(submitted?.reason ?? submitted?.stage);
  emitEvent("action_unconfirmed", { stage: state.stage, phase, reason });
  return resultFor("retryable", state, { reason });
}
