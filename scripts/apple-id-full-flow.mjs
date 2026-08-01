#!/usr/bin/env node
/**
 * Apple ID 完整流程：
 * 1) macOS 系统设置登录（自动填账号密码，手机验证码人工，等待登录完成）
 * 2) ruyiPage 控制 Firefox 访问 account.apple.com（拟人输入 + macOS 2FA Sidecar）
 * 3) 采集姓名、生日，输出 report.json + 截图
 *
 * 用法:
 *   node scripts/apple-id-full-flow.mjs
 *   # 启动后终端输入 Apple ID / 密码，自动备份至 .env
 *   node scripts/apple-id-full-flow.mjs --skip-mac    # 仅浏览器阶段（Mac 已登录）
 *   node scripts/apple-id-full-flow.mjs --skip-browser # 仅 Mac 设置阶段
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readBrowserAccountHomeConfirmed,
  readBrowserFailureCode,
  readBrowserFailureStage,
  runAccountBrowserPhase,
  shouldMirrorTerminalDiagnostics,
} from "./lib/account-browser-flow.js";
import { confirmOrPromptAppleCredentials } from "./lib/credentials.js";
import { runMacSettingsLoginPhase } from "./lib/mac-settings-login.js";
import { captureMacSettingsSmsRuntimeEnv } from "./lib/mac-settings-sms-provider.js";
import {
  createReportDir,
  writeAccountHomeAcceptanceMarker,
  writeReport,
} from "./lib/report.js";
import { ensureEnvironment } from "./lib/env-setup.js";
import { createFlowAudit, normalizeFlowRunId } from "./lib/flow-audit.js";

const skipMac = process.argv.includes("--skip-mac");
const skipBrowser = process.argv.includes("--skip-browser");
const skipSetup = process.argv.includes("--skip-setup");
const FAILURE_TOKEN_RE = /^[a-z0-9_]{1,96}$/;
const POST_LOGIN_FINALIZATION_CLASSES = new Set([
  "completed",
  "browser_connection_lost",
  "browser_quit_failed",
  "backend_cleanup_failed",
  "runner_post_login_failed",
  "collector_dispose_failed",
  "unknown",
]);
const POST_LOGIN_FINALIZATION_PARTIAL_CLASSES = new Set([
  "browser_connection_lost",
  "browser_quit_failed",
  "backend_cleanup_failed",
  "runner_post_login_failed",
  "collector_dispose_failed",
]);
const FLOW_PHASES = new Set([
  "flow",
  "environment_setup",
  "credential_resolution",
  "mac_settings",
  "account_browser",
  "report_write",
  "acceptance_marker",
]);
const FLOW_PHASE_STATES = new Set(["entered", "completed", "failed", "skipped", "partial"]);
const LAUNCHER_AUDIT_FILE = "launcher-audit.jsonl";
const LAUNCHER_AUDIT_DIR_RE = /^\.launcher-audit\.[A-Za-z0-9]+$/;
const MAX_LAUNCHER_AUDIT_BYTES = 256 * 1024;

function failureToken(value) {
  return typeof value === "string" && FAILURE_TOKEN_RE.test(value) ? value : "unknown";
}

function finalizationClassToken(value) {
  return POST_LOGIN_FINALIZATION_CLASSES.has(value) ? value : "unknown";
}

function finalizationClassRequiresPartial(value) {
  return POST_LOGIN_FINALIZATION_PARTIAL_CLASSES.has(value);
}

export function resolveFlowRunId(value = process.env.APPLE_AUTOMATION_RUN_ID) {
  const normalized = normalizeFlowRunId(value);
  return normalized === "standalone" ? `run-${randomUUID()}` : normalized;
}

export function archiveLauncherAudit(
  reportDir,
  runId,
  sourceValue = process.env.APPLE_AUTOMATION_LAUNCHER_AUDIT_PATH
) {
  const sourceText = typeof sourceValue === "string" ? sourceValue.trim() : "";
  if (!sourceText) return { state: "unavailable", file: null };

  const resolvedReportDir = path.resolve(reportDir);
  const reportRoot = path.dirname(resolvedReportDir);
  const sourcePath = path.resolve(sourceText);
  const sourceDir = path.dirname(sourcePath);
  const targetPath = path.join(resolvedReportDir, LAUNCHER_AUDIT_FILE);
  if (
    path.basename(sourcePath) !== LAUNCHER_AUDIT_FILE ||
    path.dirname(sourceDir) !== reportRoot ||
    !LAUNCHER_AUDIT_DIR_RE.test(path.basename(sourceDir))
  ) {
    return { state: "invalid", file: null };
  }

  try {
    const stat = fs.lstatSync(sourcePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_LAUNCHER_AUDIT_BYTES
    ) {
      return { state: "invalid", file: null };
    }
    const firstLine = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/, 1)[0];
    const firstEntry = JSON.parse(firstLine);
    if (
      firstEntry?.version !== 1 ||
      firstEntry?.runId !== normalizeFlowRunId(runId) ||
      firstEntry?.sequence !== 1 ||
      firstEntry?.stage !== "launcher_entered"
    ) {
      return { state: "invalid", file: null };
    }
    fs.linkSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o600);
    return { state: "linked", file: LAUNCHER_AUDIT_FILE };
  } catch {
    return { state: "failed", file: null };
  }
}

function recordFlowPhase(flowAudit, phase, state, details = {}) {
  if (!FLOW_PHASES.has(phase) || !FLOW_PHASE_STATES.has(state)) return;
  flowAudit?.write?.("flow", "phase", { phase, state, ...details });
}

function recordFlowPhaseError(flowAudit, phase, error, details = {}) {
  if (!FLOW_PHASES.has(phase)) return;
  flowAudit?.writeError?.("flow", "phase_failed", error, {
    phase,
    state: "failed",
    ...details,
  });
}

function sanitizeMacSettingsStatus(status = {}) {
  const routes = new Set(["swift_ax", "applescript"]);
  const phases = new Set([
    "preflight",
    "dump",
    "email",
    "continue",
    "password",
    "state",
    "fallback_recovery",
  ]);
  const outcomes = new Set(["started", "succeeded", "failed", "fallback"]);
  const reasons = new Set([
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
    "unknown",
  ]);
  const states = new Set(["email", "password", "unknown"]);
  const inputRoutes = new Set(["ax_value", "keyboard", "existing_value", "unknown"]);
  return {
    route: routes.has(status?.route) ? status.route : "unknown",
    phase: phases.has(status?.phase) ? status.phase : "unknown",
    outcome: outcomes.has(status?.outcome) ? status.outcome : "failed",
    reason: reasons.has(status?.reason) ? status.reason : "unknown",
    loginState: states.has(status?.loginState) ? status.loginState : "unknown",
    inputRoute: inputRoutes.has(status?.inputRoute) ? status.inputRoute : "unknown",
    textFieldCount:
      Number.isInteger(status?.textFieldCount) &&
      status.textFieldCount >= 0 &&
      status.textFieldCount <= 32
        ? status.textFieldCount
        : null,
  };
}

const MAC_SETTINGS_EVENT_NAMES = new Set([
  "automation_preflight_started",
  "automation_preflight_completed",
  "automation_preflight_failed",
  "automation_control_check_completed",
  "automation_control_check_failed",
  "login_window_preflight_started",
  "login_window_preflight_completed",
  "applescript_fill_started",
  "applescript_step_completed",
  "applescript_fill_completed",
  "login_fill_started",
  "swift_ax_helper_checked",
  "apple_account_deep_link_opened",
  "swift_ax_fill_started",
  "swift_ax_fill_completed",
  "swift_ax_fallback_started",
  "login_fill_completed",
  "mac_settings_phase_started",
  "initial_signed_in_probe",
  "mac_settings_already_signed_in",
  "mac_settings_phase_completed",
  "sms_provider_config_saved",
  "sms_provider_config_failed",
  "sms_provider_not_configured",
  "sms_module_started",
  "sms_module_completed",
  "sms_module_failed",
  "sms_helper_unavailable",
  "sms_manual_handoff_acknowledged",
  "native_call_started",
  "native_call_failed",
  "native_call_completed",
  "code_provider_poll_started",
  "code_provider_poll_empty",
  "code_provider_code_ready",
  "state_probe",
  "state_stable",
  "sms_surface_loading",
  "waiting_for_sms_surface",
  "phone_selection_detected",
  "phone_selection_submitted",
  "phone_selection_transition_waiting",
  "code_entry_detected",
  "code_polling_started",
  "code_write_started",
  "code_written",
  "code_transition_waiting",
  "code_transition_probe",
  "code_transition_observed",
  "code_surface_reset",
  "code_surface_returned_to_phone_selection",
  "manual_required",
  "manual_sms_step_confirmed",
  "manual_sms_step_advanced",
  "manual_sms_code_entry_waiting",
  "manual_code_transition_waiting",
  "manual_code_transition_probe",
  "manual_surface_reprobe_waiting",
  "code_transition_unreadable",
  "post_sms_probe_started",
  "post_sms_probe_result",
  "post_sms_transition_waiting",
  "post_sms_retry_scheduled",
  "post_sms_probe_limit_reached",
  "post_sms_action_blocked",
  "post_sms_action_limit_reached",
  "post_sms_action_authorized",
  "post_sms_manual_required",
  "post_sms_manual_continuation",
  "signed_in_probe",
  "signed_in_settle_probe",
  "mac_settings_login_wait_failed",
  "post_sms_supervision_unavailable",
  "post_sms_module_disabled",
  "state_probe_started",
  "state_probe_failed",
  "state_probe_invalid",
  "state_observed",
  "state_observed_probe_only",
  "action_not_authorized",
  "action_started",
  "action_retry",
  "action_completed",
  "action_unconfirmed",
  "supervision_unavailable",
]);
const MAC_SETTINGS_EVENT_MODULES = new Set(["login", "sms", "post_sms"]);
const MAC_SETTINGS_EVENT_STAGES = new Set([
  "phone_selection",
  "code_entry",
  "code_pending",
  "waiting",
  "surface_unavailable",
  "terms",
  "mac_password",
  "iphone_unlock",
  "location",
  "unidentified",
]);
const MAC_SETTINGS_EVENT_PHASES = new Set([
  "sms-state",
  "sms-select",
  "sms-continue",
  "sms-code",
  "terms",
  "mac-password",
  "unlock-code",
  "location",
  "email",
  "password",
  "dump",
  "continue",
  "state",
  "preflight",
  "fallback_recovery",
]);
const MAC_SETTINGS_EVENT_STATUSES = new Set([
  "submitted",
  "retryable",
  "manual_required",
  "not_required",
  "state_observed",
  "manual_completed",
  "invalid",
]);
const MAC_SETTINGS_EVENT_OUTCOMES = new Set([
  "granted",
  "prompted",
  "ready",
  "unavailable",
  "probe_failed",
  "succeeded",
  "failed",
  "fallback",
  "resumed",
  "not_resumed",
  "completed",
  "external",
  "skipped",
  "deferred",
]);
const MAC_SETTINGS_EVENT_REASONS = new Set([
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
  "helper_unavailable",
  "compile_failed",
  "preflight_unavailable",
  "automation_control_unavailable",
  "fallback_recovery_failed",
  "applescript_failed",
  "applescript_invalid_output",
  "state_unavailable",
  "state_waiting",
  "state_probe_failed",
  "state_probe_invalid",
  "state_probe_unavailable",
  "controller_failed",
  "visual_unavailable",
  "binding_invalid",
  "helper_exit",
  "invalid_request",
  "timeout",
  "manual_required",
  "invalid",
  "action_attempt_limit",
  "action_unconfirmed",
  "code_unavailable",
  "code_write_unconfirmed",
  "code_transition_timeout",
  "phone_not_matched",
  "phone_not_unique",
  "phone_selection_unavailable",
  "selection_not_confirmed",
  "continue_failed",
  "code_entry_unavailable",
  "code_write_failed",
  "manual_code_invalid",
  "no_trusted_surface",
  "phone_code_transition",
  "code_surface_unready",
  "ambiguous_sms_surface",
  "surface_unclassified",
  "code_value_unreadable",
  "timeout",
  "accessibility_unavailable",
  "helper_exit",
  "invalid",
  "unknown",
]);
const MAC_SETTINGS_FAILURE_CODES = new Set([
  "mac_settings_login_failed",
  "mac_settings_login_not_confirmed",
  "mac_settings_login_wait_timeout",
  "mac_settings_sms_config_save_failed",
  "mac_settings_sms_helper_unavailable",
  "mac_settings_sms_phone_invalid",
  "mac_settings_sms_phone_not_matched",
  "mac_settings_sms_unsupported_platform",
  "mac_settings_sms_supervision_required",
  "mac_settings_sms_tty_required",
  "mac_settings_sms_timeout_invalid",
  "mac_settings_sms_provider_timeout_invalid",
  "mac_settings_sms_manual_timeout_invalid",
  "mac_settings_sms_poll_interval_invalid",
  "mac_settings_sms_state_attempts_invalid",
  "mac_settings_sms_state_failure_windows_invalid",
  "mac_settings_sms_surface_unready_grace_invalid",
  "mac_settings_sms_stable_code_reads_invalid",
  "mac_settings_sms_action_attempts_invalid",
  "mac_settings_sms_action_retry_delay_invalid",
  "mac_settings_sms_phone_transition_grace_invalid",
  "mac_settings_sms_code_transition_grace_invalid",
  "mac_settings_sms_provider_poll_interval_invalid",
  "mac_settings_sms_manual_continuation_grace_invalid",
  "mac_settings_sms_state_probe_timeout_invalid",
  "mac_settings_sms_phone_select_timeout_invalid",
  "mac_settings_sms_phone_continue_timeout_invalid",
  "mac_settings_sms_code_write_timeout_invalid",
  "mac_settings_sms_timeout",
  "mac_settings_sms_native_failed",
  "mac_settings_sms_state_unavailable",
  "mac_settings_sms_manual_code_invalid",
  "mac_settings_sms_code_fill_failed",
  "mac_settings_sms_provider_config_invalid",
  "mac_settings_sms_provider_url_invalid",
  "mac_settings_sms_provider_unavailable",
]);

function safeMacSettingsEventNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_200_000 ? value : undefined;
}

export function sanitizeMacSettingsEvent(event = {}) {
  const safe = {
    module: MAC_SETTINGS_EVENT_MODULES.has(event?.module) ? event.module : "login",
    event: MAC_SETTINGS_EVENT_NAMES.has(event?.event) ? event.event : "unknown",
  };
  if (MAC_SETTINGS_EVENT_STAGES.has(event?.stage)) safe.stage = event.stage;
  if (MAC_SETTINGS_EVENT_PHASES.has(event?.phase)) safe.phase = event.phase;
  if (MAC_SETTINGS_EVENT_STATUSES.has(event?.status)) safe.status = event.status;
  if (MAC_SETTINGS_EVENT_OUTCOMES.has(event?.outcome)) safe.outcome = event.outcome;
  if (MAC_SETTINGS_EVENT_REASONS.has(event?.reason)) safe.reason = event.reason;
  if (MAC_SETTINGS_FAILURE_CODES.has(event?.failureCode)) {
    safe.failureCode = event.failureCode;
  }
  if (typeof event?.probeOnly === "boolean") safe.probeOnly = event.probeOnly;
  if (typeof event?.ok === "boolean") safe.ok = event.ok;
  if (typeof event?.signedIn === "boolean") safe.signedIn = event.signedIn;
  for (const key of ["step", "attempt", "attempts", "rounds", "polls", "probeAttempt", "stableReads", "observations", "elapsedMs", "timeoutMs", "nextPasswordLength", "axOwnerPid", "visualOwnerPid", "windowId"]) {
    const value = safeMacSettingsEventNumber(event?.[key]);
    if (value !== undefined) safe[key] = value;
  }
  if (typeof event?.identity === "string") {
    const identityMatch = /^([a-z_]+):([0-9]+):([0-9]+):([0-9]+)$/.exec(event.identity);
    if (identityMatch) {
      safe.stage = MAC_SETTINGS_EVENT_STAGES.has(identityMatch[1]) ? identityMatch[1] : safe.stage;
      for (const [key, raw] of [["axOwnerPid", identityMatch[2]], ["visualOwnerPid", identityMatch[3]], ["windowId", identityMatch[4]]]) {
        const value = safeMacSettingsEventNumber(Number(raw));
        if (value !== undefined) safe[key] = value;
      }
    }
  }
  return safe;
}

export function sanitizeMacSettingsFailureCode(error) {
  const candidate = typeof error?.code === "string"
    ? error.code
    : typeof error?.message === "string"
      ? error.message
      : "";
  const normalized = candidate.toLowerCase();
  return MAC_SETTINGS_FAILURE_CODES.has(normalized) ? normalized : "unknown";
}

export function resolveMacSettingsFailureStatus(error, lastStatus) {
  const directStatus =
    error?.macSettingsStatus && typeof error.macSettingsStatus === "object"
      ? error.macSettingsStatus
      : null;
  const inheritedStatus =
    !directStatus && lastStatus?.outcome === "failed" ? lastStatus : null;
  return sanitizeMacSettingsStatus({
    ...(directStatus ?? inheritedStatus ?? {}),
    outcome: "failed",
  });
}

export function createFlowFailureEnvelope(failureStage, failureCode, failedAt = new Date()) {
  return {
    failureStage: failureToken(failureStage),
    failureCode: failureToken(failureCode),
    failedAt: failedAt.toISOString(),
    auditFile: "flow-audit.jsonl",
  };
}

export function createFlowReport(runAt = new Date(), options = {}) {
  return {
    version: 1,
    runId: normalizeFlowRunId(options.runId),
    runAt: runAt.toISOString(),
    phases: {},
  };
}

export function recordAccountHomeAcceptanceMarker(
  accountHomeConfirmed,
  {
    writeMarker = writeAccountHomeAcceptanceMarker,
    flowAudit = null,
    logger = console,
    mirrorDiagnostics = shouldMirrorTerminalDiagnostics(),
  } = {}
) {
  if (accountHomeConfirmed !== true) {
    flowAudit?.write?.("flow", "acceptance_marker_skipped", {
      accountHomeConfirmed: false,
    });
    if (mirrorDiagnostics) {
      logger.log("[apple-automation] status:acceptance_marker_skipped:home:0");
    }
    return "skipped";
  }
  try {
    writeMarker();
    flowAudit?.write?.("flow", "acceptance_marker_completed", {
      accountHomeConfirmed: true,
    });
    logger.log(
      mirrorDiagnostics
        ? "[验收] REAL_ACCOUNT_HOME_CONFIRMED"
        : "[✓] 登录验收已确认"
    );
    return "completed";
  } catch {
    flowAudit?.write?.("flow", "acceptance_marker_partial", {
      accountHomeConfirmed: true,
    });
    if (mirrorDiagnostics) {
      logger.warn("[apple-automation] status:acceptance_marker_partial:home:1");
    } else {
      logger.warn("[!] 登录验收标记写入失败，详情已写入日志");
    }
    return "partial";
  }
}

export function summarizeAccountBrowserCompletion(accountBrowser) {
  const source = accountBrowser && typeof accountBrowser === "object" ? accountBrowser : {};
  const browserLogin =
    source.browserLogin && typeof source.browserLogin === "object" ? source.browserLogin : {};
  const profileCapture =
    source.postLoginProfileCapture && typeof source.postLoginProfileCapture === "object"
      ? source.postLoginProfileCapture
      : null;
  const finalization =
    source.postLoginFinalization && typeof source.postLoginFinalization === "object"
      ? source.postLoginFinalization
      : null;
  const accountModule =
    source.accountModule && typeof source.accountModule === "object"
      ? source.accountModule
      : {};
  const developerMembershipGateBlocked =
    accountModule.attempted !== true &&
    accountModule.skipped === true &&
    accountModule.skipReason === "developer_membership_gate" &&
    accountModule.membershipGateEnabled === true &&
    accountModule.membershipGatePassed !== true;
  const browserSkipped = source.skipped === true;
  const profileCaptureSkipped = browserSkipped || developerMembershipGateBlocked;
  const accountHomeConfirmed = browserLogin.accountHomeConfirmed === true;
  const finalizationClass = finalization
    ? finalizationClassToken(finalization.finalizationClass)
    : null;
  const classRequiresPartial = finalizationClassRequiresPartial(finalizationClass);
  const backendCleanupCompleted = finalization
    ? finalization.backendCleanupCompleted !== false &&
      finalizationClass !== "backend_cleanup_failed"
    : null;
  const collectorDisposed = finalization
    ? finalization.collectorDisposed !== false &&
      finalizationClass !== "collector_dispose_failed"
    : null;
  const browserFinalizationCompleted = finalization
    ? finalization.browserFinalizationCompleted === true &&
      finalizationClass !== "browser_connection_lost" &&
      finalizationClass !== "browser_quit_failed"
    : null;
  const browserPreservationRequested = finalization
    ? finalization.browserPreservationRequested === true
    : null;
  const browserSessionPreserved = finalization
    ? finalization.browserSessionPreserved === true
    : null;
  const browserPreservationSatisfied =
    browserPreservationRequested !== true || browserSessionPreserved === true;
  return {
    accountHomeConfirmed,
    accountModuleSkipped: developerMembershipGateBlocked,
    profileCaptureState: profileCaptureSkipped
      ? "skipped"
      : profileCapture?.success === true
        ? "succeeded"
        : accountHomeConfirmed
          ? "partial"
          : "unknown",
    postLoginFinalizationState: browserSkipped
      ? "skipped"
      : !finalization
        ? "unknown"
        : backendCleanupCompleted &&
            !classRequiresPartial &&
            collectorDisposed &&
            browserFinalizationCompleted &&
            browserPreservationSatisfied
          ? "completed"
          : "partial",
    backendCleanupCompleted,
    collectorDisposed,
    browserFinalizationCompleted,
    browserPreservationRequested,
    browserSessionPreserved,
    finalizationClass,
  };
}

function addSmsRuntimeSecrets(flowAudit, smsEnv) {
  flowAudit.addSecrets([
    smsEnv.APPLE_AUTOMATION_SMS_PHONE,
    smsEnv.APPLE_AUTOMATION_SMS_API_URL,
    smsEnv.APPLE_AUTOMATION_MANUAL_SMS_CODE,
  ]);
}

const SMS_PROVIDER_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
];

export function mergeMacSettingsSmsRuntimeEnv(initialEnv = {}, persistedEnv = {}) {
  const persisted = { ...persistedEnv };
  if (SMS_PROVIDER_ENV_KEYS.some((key) => Object.hasOwn(initialEnv, key))) {
    for (const key of SMS_PROVIDER_ENV_KEYS) delete persisted[key];
  }
  return { ...persisted, ...initialEnv };
}

export async function main() {
  let smsRuntimeEnv = captureMacSettingsSmsRuntimeEnv();
  const runId = resolveFlowRunId();
  const mirrorDiagnostics = shouldMirrorTerminalDiagnostics();
  if (mirrorDiagnostics) {
    console.log("[apple-automation] stage:flow_main_started");
  }
  console.log("═══════════════════════════════════════════");
  console.log(" Apple ID 流程：Mac 系统设置 → Firefox account");
  console.log("═══════════════════════════════════════════\n");

  const reportDir = createReportDir("apple-id-flow");
  const launcherAudit = archiveLauncherAudit(reportDir, runId);
  const flowAudit = createFlowAudit(reportDir, {
    runId,
    onWriteFailure() {
      console.warn("[报告] 统一诊断日志写入失败");
    },
  });
  addSmsRuntimeSecrets(flowAudit, smsRuntimeEnv);
  flowAudit.write("flow", "launcher_audit_archive", {
    state: launcherAudit.state,
    linked: launcherAudit.state === "linked",
  });
  if (
    process.env.APPLE_AUTOMATION_LAUNCHER_AUDIT_PATH &&
    launcherAudit.state !== "linked"
  ) {
    console.warn("[!] 启动日志未能归档到本次报告目录，原始日志仍保留");
  }
  console.log(`[报告] 统一诊断日志: ${flowAudit.path}`);
  const report = createFlowReport(new Date(), { runId });
  report.launcherAudit = launcherAudit;
  let reportFile = null;
  let creds = null;
  let failureStage = "unknown";
  let failureCode = "unknown";

  try {
    flowAudit.write("flow", "started", {
      skipMac,
      skipBrowser,
      skipSetup,
    });
    recordFlowPhase(flowAudit, "flow", "entered", {
      launcherAuditLinked: launcherAudit.state === "linked",
      launcherAuditState: launcherAudit.state,
    });

    if (!skipSetup) {
      failureStage = "environment_setup";
      failureCode = "environment_setup_failed";
      recordFlowPhase(flowAudit, "environment_setup", "entered");
      try {
        await ensureEnvironment({
          quiet: false,
          skipFirefox: skipBrowser,
          skipRuyiPage: skipBrowser,
          skipAutomation: skipMac,
        });
      } catch (error) {
        recordFlowPhaseError(flowAudit, "environment_setup", error, {
          failureStage,
          failureCode,
        });
        flowAudit.write("flow", "environment_setup_failed", {
          failureStage,
          failureCode,
        });
        throw error;
      }
      recordFlowPhase(flowAudit, "environment_setup", "completed");
      console.log("");
    } else {
      recordFlowPhase(flowAudit, "environment_setup", "skipped");
    }

    failureStage = "credential_resolution";
    failureCode = "credential_resolution_failed";
    recordFlowPhase(flowAudit, "credential_resolution", "entered");
    try {
      creds = await confirmOrPromptAppleCredentials();
      const persistedSmsRuntimeEnv = captureMacSettingsSmsRuntimeEnv();
      smsRuntimeEnv = mergeMacSettingsSmsRuntimeEnv(smsRuntimeEnv, persistedSmsRuntimeEnv);
      addSmsRuntimeSecrets(flowAudit, smsRuntimeEnv);
    } catch (error) {
      recordFlowPhaseError(flowAudit, "credential_resolution", error, {
        failureStage,
        failureCode,
      });
      flowAudit.write("flow", "credential_resolution_failed", {
        failureStage,
        failureCode,
      });
      throw error;
    }
    recordFlowPhase(flowAudit, "credential_resolution", "completed");
    flowAudit.addSecrets([creds.appleId, creds.password]);
    if (mirrorDiagnostics) {
      console.log("[apple-automation] stage:credentials_ready");
    }
    if (!skipMac) {
      failureStage = "mac_settings";
      failureCode = "mac_settings_failed";
      recordFlowPhase(flowAudit, "mac_settings", "entered");
      let lastMacSettingsStatus = null;
      const onMacSettingsStatus = (status) => {
        const safeStatus = sanitizeMacSettingsStatus(status);
        lastMacSettingsStatus = safeStatus;
        flowAudit.write("mac_settings", "login_status", safeStatus);
        if (mirrorDiagnostics) {
          console.log(
            `[mac-settings] status:route:${safeStatus.route}:phase:${safeStatus.phase}:outcome:${safeStatus.outcome}:reason:${safeStatus.reason}:state:${safeStatus.loginState}:input:${safeStatus.inputRoute}:fields:${safeStatus.textFieldCount ?? 0}`
          );
        }
      };
      const onMacSettingsEvent = (event) => {
        flowAudit.write("mac_settings", "event", sanitizeMacSettingsEvent(event));
      };
      try {
        flowAudit.write("mac_settings", "started");
        report.phases.macSettings = await runMacSettingsLoginPhase(creds, {
          smsEnv: smsRuntimeEnv,
          onStatus: onMacSettingsStatus,
          onEvent: onMacSettingsEvent,
        });
        flowAudit.write("mac_settings", "completed", { success: true });
        recordFlowPhase(flowAudit, "mac_settings", "completed");
      } catch (e) {
        const failureStatus = resolveMacSettingsFailureStatus(e, lastMacSettingsStatus);
        const diagnosticFailureCode = sanitizeMacSettingsFailureCode(e);
        flowAudit.write("mac_settings", "login_failure", failureStatus);
        recordFlowPhaseError(flowAudit, "mac_settings", e, { failureStage, failureCode });
        flowAudit.write("mac_settings", "failed", {
          failureStage,
          failureCode,
          diagnosticFailureCode,
          ...failureStatus,
        });
        report.phases.macSettings = {
          success: false,
          error: "Mac Settings phase failed",
          failureStage,
          failureCode,
          diagnosticFailureCode,
          diagnostics: failureStatus,
        };
        throw e;
      }
    } else {
      console.log("[Mac 设置] --skip-mac：跳过系统设置登录阶段\n");
      report.phases.macSettings = { skipped: true };
      flowAudit.write("mac_settings", "skipped");
      recordFlowPhase(flowAudit, "mac_settings", "skipped");
    }

    if (!skipBrowser) {
      failureStage = "unknown";
      failureCode = "account_browser_failed";
      recordFlowPhase(flowAudit, "account_browser", "entered");
      try {
        flowAudit.write("account_browser", "started");
        report.phases.accountBrowser = await runAccountBrowserPhase({
          creds,
          reportDir,
          flowAudit,
          runId,
        });
        const browserCompletion = summarizeAccountBrowserCompletion(
          report.phases.accountBrowser
        );
        const profileCapture = report.phases.accountBrowser?.postLoginProfileCapture;
        flowAudit.write("account_browser", "completed", {
          success: true,
          ...browserCompletion,
        });
        recordFlowPhase(flowAudit, "account_browser", "completed", {
          accountHomeConfirmed: browserCompletion.accountHomeConfirmed,
          profileCaptureState: browserCompletion.profileCaptureState,
          postLoginFinalizationState: browserCompletion.postLoginFinalizationState,
        });
        if (mirrorDiagnostics) {
          console.log(
            `[apple-automation] status:account_browser_completed:home:${browserCompletion.accountHomeConfirmed ? 1 : 0}:profile:${browserCompletion.profileCaptureState}:finalization:${browserCompletion.postLoginFinalizationState}`
          );
        }
        if (browserCompletion.profileCaptureState === "partial") {
          flowAudit.write("account_browser", "profile_capture_partial", {
            failureStage: profileCapture?.failureStage,
            failureClass: profileCapture?.failureClass,
            browserAlive: profileCapture?.browserAlive === true,
            browserPreserved: profileCapture?.browserPreserved === true,
          });
          if (mirrorDiagnostics) {
            console.warn(
              `[apple-automation] status:browser_login_succeeded_profile_capture_partial:stage:${profileCapture?.failureStage ?? "unknown"}:class:${profileCapture?.failureClass ?? "unknown"}:preserved:${profileCapture?.browserPreserved === true ? 1 : 0}`
            );
          }
        }
        if (browserCompletion.postLoginFinalizationState === "partial") {
          flowAudit.write("account_browser", "post_login_finalization_partial", {
            backendCleanupCompleted: browserCompletion.backendCleanupCompleted,
            collectorDisposed: browserCompletion.collectorDisposed,
            browserFinalizationCompleted: browserCompletion.browserFinalizationCompleted,
            browserPreservationRequested: browserCompletion.browserPreservationRequested,
            browserSessionPreserved: browserCompletion.browserSessionPreserved,
            finalizationClass: browserCompletion.finalizationClass,
          });
          if (mirrorDiagnostics) {
            console.warn(
              `[apple-automation] status:browser_login_succeeded_post_login_finalization_partial:backend_cleanup:${browserCompletion.backendCleanupCompleted ? 1 : 0}:collector_disposed:${browserCompletion.collectorDisposed ? 1 : 0}:browser_finalized:${browserCompletion.browserFinalizationCompleted ? 1 : 0}:preserve_requested:${browserCompletion.browserPreservationRequested ? 1 : 0}:preserved:${browserCompletion.browserSessionPreserved ? 1 : 0}:class:${browserCompletion.finalizationClass}`
            );
          }
        }
      } catch (e) {
        failureStage = readBrowserFailureStage(e);
        failureCode = readBrowserFailureCode(e);
        recordFlowPhaseError(flowAudit, "account_browser", e, {
          failureStage,
          failureCode,
        });
        flowAudit.write("account_browser", "failed", {
          failureStage,
          failureCode,
        });
        const accountHomeConfirmed = readBrowserAccountHomeConfirmed(e);
        report.phases.accountBrowser = {
          success: false,
          error: "Account browser phase failed",
          failureStage,
          failureCode,
          ...(accountHomeConfirmed
            ? {
                browserLogin: {
                  success: true,
                  backend: "ruyipage",
                  accountHomeConfirmed: true,
                },
              }
            : {}),
        };
        throw e;
      }
    } else {
      console.log("[Firefox] --skip-browser：跳过浏览器阶段\n");
      report.phases.accountBrowser = { skipped: true };
      flowAudit.write("account_browser", "skipped");
      recordFlowPhase(flowAudit, "account_browser", "skipped");
      if (mirrorDiagnostics) {
        console.log("[apple-automation] status:account_browser_skipped");
      }
    }

    failureStage = "report_write";
    failureCode = "report_write_failed";
    recordFlowPhase(flowAudit, "report_write", "entered");
    try {
      reportFile = writeReport(reportDir, report);
    } catch (error) {
      recordFlowPhaseError(flowAudit, "report_write", error, { failureStage, failureCode });
      throw error;
    }
    flowAudit.write("flow", "report_written", { file: "report.json" });
    recordFlowPhase(flowAudit, "report_write", "completed");
    recordFlowPhase(flowAudit, "acceptance_marker", "entered");
    const acceptanceMarkerState = recordAccountHomeAcceptanceMarker(
      report.phases.accountBrowser?.browserLogin?.accountHomeConfirmed === true,
      { flowAudit, mirrorDiagnostics }
    );
    recordFlowPhase(flowAudit, "acceptance_marker", acceptanceMarkerState);
    const browserCompletion = summarizeAccountBrowserCompletion(report.phases.accountBrowser);
    flowAudit.write("flow", "completed", {
      success: true,
      ...browserCompletion,
      acceptanceMarkerState,
    });
    recordFlowPhase(flowAudit, "flow", "completed", {
      profileCaptureState: browserCompletion.profileCaptureState,
      postLoginFinalizationState: browserCompletion.postLoginFinalizationState,
    });
    if (mirrorDiagnostics) {
      console.log(
        `[apple-automation] status:flow_completed:profile:${browserCompletion.profileCaptureState}:finalization:${browserCompletion.postLoginFinalizationState}:acceptance_marker:${acceptanceMarkerState}`
      );
    }
  } catch (e) {
    report.error = "Apple ID flow failed";
    report.failure = createFlowFailureEnvelope(failureStage, failureCode);
    recordFlowPhaseError(flowAudit, "flow", e, {
      failureStage: report.failure.failureStage,
      failureCode: report.failure.failureCode,
    });
    reportFile = writeReport(reportDir, report);
    flowAudit.write("flow", "failed", {
      failureStage: report.failure.failureStage,
      failureCode: report.failure.failureCode,
      reportFile: "report.json",
    });
    recordFlowPhase(flowAudit, "flow", "failed", {
      failureStage: report.failure.failureStage,
      failureCode: report.failure.failureCode,
    });
    if (mirrorDiagnostics) {
      console.error(`[apple-automation] failure_stage:${report.failure.failureStage}`);
      console.error(`[apple-automation] failure_code:${report.failure.failureCode}`);
      console.error(`[apple-automation] failed_at:${report.failure.failedAt}`);
      console.error(`[apple-automation] report_path:${reportFile}`);
      console.error(`[apple-automation] audit_path:${flowAudit.path}`);
    }
    console.error(
      `\n[×] 流程失败（阶段：${report.failure.failureStage}，原因：${report.failure.failureCode}）`
    );
    console.error(`[报告] ${reportFile}`);
    console.error(`[日志] ${flowAudit.path}`);
    if (launcherAudit.file) {
      console.error(`[启动日志] ${path.join(reportDir, launcherAudit.file)}`);
    }
    const twoFactorAuditPath = path.join(reportDir, "2fa-audit.jsonl");
    if (fs.existsSync(twoFactorAuditPath)) {
      console.error(`[2FA 日志] ${twoFactorAuditPath}`);
    }
    throw e;
  } finally {
    flowAudit.close();
  }

  console.log("\n═══════════════════════════════════════════");
  console.log(" 完成");
  console.log(` 报告: ${reportFile}`);
  console.log(` 日志: ${flowAudit.path}`);
  if (launcherAudit.file) {
    console.log(` 启动日志: ${path.join(reportDir, launcherAudit.file)}`);
  }
  const twoFactorAuditPath = path.join(reportDir, "2fa-audit.jsonl");
  if (fs.existsSync(twoFactorAuditPath)) {
    console.log(` 2FA 日志: ${twoFactorAuditPath}`);
  }
  console.log(` 截图: ${reportDir}/screenshots/`);
  console.log("═══════════════════════════════════════════\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
