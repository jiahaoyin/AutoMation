/**
 * account.apple.com browser phase orchestration.
 *
 * Node owns credentials, reporting, and the macOS 2FA sidecar. Browser launch,
 * navigation, page reads, screenshots, and interaction are delegated to ruyiPage.
 */

import { isAccessibilityGranted } from "./accessibility.js";
import { getBrowserEnvironmentSummary } from "./env-setup.js";
import { createRuyiPageBackendRunner } from "./ruyipage-backend-runner.js";
import { createMac2FACollector } from "./two-fa-sidecar.js";

const ALLOWED_READY_MODES = new Set([
  "browser",
  "ruyipage-only",
  "protocol-self-test",
  "node-self-test",
  "hang-self-test",
  "ignore-signals-self-test",
]);

const FIXED_ENVIRONMENT_WARNING = "[Firefox] 环境提示: browser environment warning";
const TWO_FACTOR_TIMEOUT_MS = 240_000;
const TWO_FACTOR_STATUS_MESSAGES = Object.freeze({
  popup_primary: "[2FA] 优先等待 Apple 验证弹窗，暂不启动系统设置取码。",
  settings_fallback: "[2FA] 弹窗未取得有效验证码，正在回退系统设置取码。",
  manual_unavailable:
    "[2FA] 当前会话没有可用交互终端，无法安全地隐藏输入验证码；当前串行自动取码阶段将继续完成。",
  settings_accessibility:
    "[2FA] 系统设置取码需要辅助功能权限，正在等待授权；请按 macOS 提示完成勾选。",
  settings_retry:
    "[2FA] 系统设置取码正在进行受限重试；popup 主阶段已结束，当前回退阶段将继续完成。",
  settings_failed:
    "[2FA] 系统设置取码未成功；将按串行顺序评估最终兜底。",
  manual_allow:
    "[2FA] 自动点击「允许」未成功，请在 Mac 上手动点击「允许」；取码仍在继续。",
  manual_code: "[2FA] 自动取码仍未完成，请在终端隐藏输入 Mac 上显示的 6 位验证码。",
  ocr_permission_missing:
    "[2FA] OCR 需要权限：系统设置 → 隐私与安全性 → 屏幕与系统音频录制；系统设置取码仍在工作。",
  ocr_helper_unavailable:
    "[2FA] OCR helper 不可用；将继续使用原生弹窗、系统设置与终端手输取码。",
  popup_accessibility:
    "[2FA] 原生验证码弹窗未获辅助功能授权；将先尝试已授权的屏幕录制 OCR，无有效码才按顺序回退。",
  popup_scanning:
    "[2FA] 网页已确认需要验证码，正在持续扫描受限 Apple 原生窗口。",
  popup_close_pending:
    "[2FA] 已读取验证码；系统弹窗尚未自动关闭，正在继续提交到网页。",
  timeout:
    "[2FA] 240 秒内未取得可用验证码。请确认 Mac 已登录同一 Apple ID、允许弹窗已处理，并检查系统设置取码与相关权限。",
});
const TWO_FACTOR_WINNER_MESSAGES = Object.freeze({
  popup: "[2FA] 已从 Apple 验证码弹窗取得验证码。",
  settings: "[2FA] 已从系统设置取得验证码。",
  manual: "[2FA] 已使用终端手动输入的验证码。",
});
const SUPERVISED_TWO_FACTOR_STATUS_PREFIX = "[2FA] status:";
const RUYIPAGE_STARTUP_STATUSES = new Set([
  "broker_credentials_received",
  "browser_url_validated",
  "browser_runtime_imported",
  "browser_constructing",
]);
const RUYIPAGE_STATUS_TYPES = new Set([
  "browser_stage",
  "browser_failure",
  "browser_preserved",
  "input_progress",
  "remember_progress",
  "twofa_progress",
  ...RUYIPAGE_STARTUP_STATUSES,
]);
const RUYIPAGE_TWO_FACTOR_PROGRESS_PHASES = new Set([
  "code_received",
  "target_waiting",
  "target_resolved",
  "input_started",
  "input_completed",
  "submit_started",
  "submit_sent",
  "transition_waiting",
  "transition_retry_requested",
  "transition_confirmed",
  "handoff_failed",
]);
const RUYIPAGE_RUNNER_STATUS_CODES = new Set([
  "twofa_code_delivery_started",
  "twofa_code_delivery_sent",
  "twofa_code_delivery_acknowledged",
]);
const BACKEND_DIAGNOSTIC_CLASSES = new Set([
  "twofa_digit_input_verification_failed",
  "twofa_sequence_failed",
  "twofa_input_missing",
  "twofa_input_target_count",
  "twofa_target_missing",
  "twofa_focus_unconfirmed",
  "twofa_page_missing",
  "login_stopped_before_2fa",
  "account_session_unconfirmed_after_2fa",
  "twofa_login_failed",
  "password_input_verification_failed",
  "account_home_unconfirmed",
  "browser_exception",
]);
const PASSWORD_BIDI_INPUT_PROGRESS = new Map([
  [
    "password\u0000owner_bidi_fallback_started\u0000owner",
    "password_bidi_input_started",
  ],
  ["password\u0000owner_bidi_typed\u0000owner", "password_bidi_input_sent"],
  ["password\u0000verified\u0000owner", "password_input_verified"],
  ["password\u0000failed\u0000none", "password_input_failed"],
]);
const SAFE_INPUT_FIELDS = new Set([
  "email",
  "password",
  "twofa_code",
  "twofa_digit",
  "unknown",
]);
const SAFE_INPUT_ROUTES = new Set(["root", "owner", "none"]);
const SAFE_INPUT_STEP_RE = /^[a-z0-9_]{1,80}$/;
const RUYIPAGE_FAILURE_STAGES = new Set([
  "not_started",
  "credentials_received",
  "url_validated",
  "runtime_importing",
  "runtime_imported",
  "browser_constructing",
  "browser_ready",
  "login_navigation",
  "login_page_loaded",
  "login_state_detected",
  "email_wait",
  "email_input",
  "email_submit",
  "password_wait",
  "password_input",
  "remember_account",
  "twofa_prepare",
  "password_submit",
  "twofa_page_wait",
  "twofa_code_wait",
  "twofa_input",
  "signed_in",
  "account_information",
]);
const BROWSER_RUN_FAILURE_CODES = new Set([
  "account_home_unconfirmed",
  "backend_cleanup",
  "backend_exit",
  "backend_failed",
  "backend_interrupted",
  "backend_stdin",
  "backend_timeout",
  "broker_connect",
  "broker_connect_timeout",
  "broker_ack",
  "broker_eof",
  "broker_io",
  "collector_cleanup",
  "event_handler",
  "event_handler_timeout",
  "process_state",
  "two_fa_preparation",
  "two_fa_provider",
  "backend_protocol",
  "protocol_invalid_json",
  "twofa_handoff",
  "unknown",
]);

export function classifyBrowserRunFailure(error) {
  const runnerCode = error?.ruyiPageFailureCode;
  if (BROWSER_RUN_FAILURE_CODES.has(runnerCode)) return runnerCode;
  const message = error instanceof Error ? error.message : "";
  const exact = new Map([
    ["ruyipage browser broker socket closed", "broker_eof"],
    ["ruyipage browser broker socket connection failed", "broker_connect"],
    [
      "ruyipage browser broker socket connection timed out",
      "broker_connect_timeout",
    ],
    ["ruyipage browser broker socket I/O failed", "broker_io"],
    ["ruyipage browser broker command acknowledgement invalid", "broker_ack"],
    [
      "ruyipage browser broker command acknowledgement timed out",
      "broker_ack",
    ],
    ["ruyipage backend failed", "backend_failed"],
    ["ruyipage backend stdin failed", "backend_stdin"],
    ["ruyipage backend cleanup failed", "backend_cleanup"],
    ["ruyipage backend interrupted", "backend_interrupted"],
    ["ruyipage process state initialization failed", "process_state"],
    ["ruyipage event handler failed", "event_handler"],
    ["ruyipage 2FA preparation failed", "two_fa_preparation"],
    ["ruyipage 2FA code provider failed", "two_fa_provider"],
    [
      "ruyipage backend did not confirm the authenticated Apple account home",
      "account_home_unconfirmed",
    ],
  ]).get(message);
  if (exact) return exact;
  if (/^ruyipage backend exited (?:unknown|\d+)$/.test(message)) {
    return "backend_exit";
  }
  if (/^ruyipage backend timed out after \d+ms$/.test(message)) {
    return "backend_timeout";
  }
  if (
    /^ruyipage onEvent handler timed out for [a-z0-9_]+ after \d+ms$/.test(
      message
    )
  ) {
    return "event_handler_timeout";
  }
  return "unknown";
}

export function readBrowserFailureCode(error) {
  const code = error?.browserFailureCode ?? error?.ruyiPageFailureCode;
  return BROWSER_RUN_FAILURE_CODES.has(code) ? code : "unknown";
}

export function readBrowserFailureStage(error) {
  const stage = error?.browserFailureStage ?? error?.ruyiPageFailureStage;
  return RUYIPAGE_FAILURE_STAGES.has(stage) ? stage : "unknown";
}

function sanitizeBrowserFailureStage(stage) {
  return RUYIPAGE_FAILURE_STAGES.has(stage) ? stage : "unknown";
}

function annotateBrowserRunFailure(error, override = null, failureStage = "unknown") {
  const inheritedCode = error?.ruyiPageFailureCode;
  const inheritedStage = error?.ruyiPageFailureStage;
  const code = BROWSER_RUN_FAILURE_CODES.has(override)
    ? override
    : BROWSER_RUN_FAILURE_CODES.has(inheritedCode)
      ? inheritedCode
      : classifyBrowserRunFailure(error);
  const stage = sanitizeBrowserFailureStage(
    failureStage === "unknown" ? inheritedStage : failureStage
  );
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "browserFailureCode", {
        configurable: true,
        value: code,
      });
      Object.defineProperty(error, "browserFailureStage", {
        configurable: true,
        value: stage,
      });
    } catch {
      /* The fixed status line remains sufficient for non-extensible errors. */
    }
  }
  console.log(`[ruyipage] status:node-failure:${code}`);
  return error;
}

function sanitizeReadyMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  return ALLOWED_READY_MODES.has(normalized) ? normalized : "browser";
}

function passwordBidiInputProgressToken(event) {
  if (
    !event ||
    typeof event !== "object" ||
    event.event !== "status" ||
    event.status !== "input_progress" ||
    typeof event.field !== "string" ||
    typeof event.step !== "string"
  ) {
    return null;
  }
  const route = Object.hasOwn(event, "route")
    ? typeof event.route === "string"
      ? event.route
      : null
    : "none";
  if (route === null) return null;
  return (
    PASSWORD_BIDI_INPUT_PROGRESS.get(`${event.field}\u0000${event.step}\u0000${route}`) ??
    null
  );
}

function sanitizeInputField(field) {
  return SAFE_INPUT_FIELDS.has(field) ? field : "unknown";
}

function sanitizeInputStep(step) {
  return typeof step === "string" && SAFE_INPUT_STEP_RE.test(step)
    ? step
    : "unknown";
}

function sanitizeInputRoute(route) {
  return SAFE_INPUT_ROUTES.has(route) ? route : "none";
}

function sanitizeTwoFactorProgressPhase(value) {
  return RUYIPAGE_TWO_FACTOR_PROGRESS_PHASES.has(value) ? value : "unknown";
}

function sanitizeRunnerStatusCode(value) {
  return RUYIPAGE_RUNNER_STATUS_CODES.has(value) ? value : "unknown";
}

function sanitizeTwoFactorGeneration(value) {
  return value === 1 || value === 2 ? value : 0;
}

function readRunnerFailureContext(error) {
  const context = error?.ruyiPageFailureContext;
  if (!context || typeof context !== "object") {
    return {
      stage: "unknown",
      twoFaPhase: "unknown",
      generation: 0,
      codeDeliveryAttempted: false,
      codeDeliverySent: false,
      codeDeliveryAcknowledged: false,
      browserPreserved: false,
      browserErrorClass: "unknown",
      cleanupFailed: false,
    };
  }
  return {
    stage: sanitizeBrowserFailureStage(context.stage),
    twoFaPhase: sanitizeTwoFactorProgressPhase(context.twoFaPhase),
    generation: sanitizeTwoFactorGeneration(context.generation),
    codeDeliveryAttempted: context.codeDeliveryAttempted === true,
    codeDeliverySent: context.codeDeliverySent === true,
    codeDeliveryAcknowledged: context.codeDeliveryAcknowledged === true,
    browserPreserved: context.browserPreserved === true,
    browserErrorClass: sanitizeBackendDiagnosticClass(context.browserErrorClass),
    cleanupFailed: context.cleanupFailed === true,
  };
}

function sanitizeBackendDiagnosticType(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_.-]{1,96}$/.test(token) ? token : "unknown";
}

function sanitizeBackendDiagnosticClass(value) {
  return BACKEND_DIAGNOSTIC_CLASSES.has(value) ? value : "unknown";
}

function classifyBackendDiagnosticMessage(value) {
  const message = typeof value === "string" ? value : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("2fa digit input verification failed")) {
    return "twofa_digit_input_verification_failed";
  }
  if (normalized.includes("2fa code input was not detected")) {
    return "twofa_input_missing";
  }
  if (normalized.includes("2fa code input must resolve")) {
    return "twofa_input_target_count";
  }
  if (normalized.includes("2fa code page did not appear")) {
    return "twofa_page_missing";
  }
  if (normalized.includes("password input verification failed")) {
    return "password_input_verification_failed";
  }
  if (normalized.includes("login stopped before 2fa")) {
    return "login_stopped_before_2fa";
  }
  if (normalized.includes("account session was not confirmed after 2fa")) {
    return "account_session_unconfirmed_after_2fa";
  }
  if (normalized.includes("personal information page did not confirm")) {
    return "account_home_unconfirmed";
  }
  if (message) return "backend_exception";
  return "unknown";
}

function sanitizeNativeProviderCode(value) {
  const token = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^2FA_[A-Z0-9_]{1,80}$/.test(token) ? token : "unknown";
}

function inputProgressStatusLine(event, passwordBidiInputProgress) {
  if (passwordBidiInputProgress) return passwordBidiInputProgress;
  if (event?.event !== "status" || event?.status !== "input_progress") return null;
  return `input:${sanitizeInputField(event.field)}:${sanitizeInputStep(
    event.step
  )}:${sanitizeInputRoute(typeof event.route === "string" ? event.route : "none")}`;
}

function twoFactorHandoffStatusLine(event) {
  if (!event || typeof event !== "object") return null;
  if (event.event === "runner_status") {
    const status = sanitizeRunnerStatusCode(event.status);
    if (status === "unknown") return null;
    return `twofa:${status}:generation:${sanitizeTwoFactorGeneration(event.generation)}`;
  }
  if (event.event !== "status" || event.status !== "twofa_progress") return null;
  return `twofa:${sanitizeTwoFactorProgressPhase(event.phase)}:generation:${sanitizeTwoFactorGeneration(
    event.generation
  )}`;
}

function writeFlowAudit(flowAudit, source, event, details = {}) {
  if (!flowAudit) return;
  try {
    flowAudit.write(source, event, details);
  } catch {
    console.warn("[报告] 统一诊断日志写入失败");
  }
}

function writeFlowAuditError(flowAudit, source, event, error, details = {}) {
  if (!flowAudit) return;
  try {
    flowAudit.writeError(source, event, error, details);
  } catch {
    console.warn("[报告] 统一诊断日志写入失败");
  }
}

function auditRuyiPageEvent(flowAudit, event) {
  if (!event || typeof event !== "object") {
    writeFlowAudit(flowAudit, "ruyipage", "invalid_event");
    return;
  }
  if (event.event === "ready") {
    writeFlowAudit(flowAudit, "ruyipage", "ready", {
      mode: sanitizeReadyMode(event.mode),
    });
    return;
  }
  if (event.event === "runner_status") {
    writeFlowAudit(flowAudit, "ruyipage", "runner_status", {
      status: sanitizeRunnerStatusCode(event.status),
      generation: sanitizeTwoFactorGeneration(event.generation),
    });
    return;
  }
  if (event.event === "status") {
    const passwordBidiInputProgress = passwordBidiInputProgressToken(event);
    const isInputProgress = event.status === "input_progress";
    const details = {
      status: RUYIPAGE_STATUS_TYPES.has(event.status) ? event.status : "unknown",
    };
    if (isInputProgress) {
      details.field = sanitizeInputField(event.field);
      details.step = sanitizeInputStep(event.step);
      details.route = sanitizeInputRoute(
        typeof event.route === "string" ? event.route : "none"
      );
    }
    if (passwordBidiInputProgress) {
      details.inputProgress = passwordBidiInputProgress;
    }
    if (event.status === "browser_failure") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
    }
    if (event.status === "browser_stage") {
      details.stage = sanitizeBrowserFailureStage(event.stage);
    }
    if (event.status === "browser_preserved") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
    }
    if (event.status === "twofa_progress") {
      details.phase = sanitizeTwoFactorProgressPhase(event.phase);
      details.generation = sanitizeTwoFactorGeneration(event.generation);
      if (event.targetCount === 1 || event.targetCount === 6) {
        details.targetCount = event.targetCount;
      }
      if (typeof event.submitted === "boolean") details.submitted = event.submitted;
    }
    if (Number.isInteger(event.attempt)) details.attempt = event.attempt;
    writeFlowAudit(flowAudit, "ruyipage", "status", details);
    return;
  }
  if (event.event === "diagnostic") {
    writeFlowAudit(flowAudit, "ruyipage", "diagnostic", {
      failureStage: sanitizeBrowserFailureStage(event.failureStage),
      errorType: "backend_diagnostic",
      diagnosticErrorType: sanitizeBackendDiagnosticType(event.errorType),
      diagnosticErrorClass: sanitizeBackendDiagnosticClass(event.errorClass),
      diagnosticMessageClass: classifyBackendDiagnosticMessage(event.message),
      hasDiagnosticMessage: typeof event.message === "string",
      hasTraceback: event.hasTraceback === true || typeof event.traceback === "string",
    });
    return;
  }
  if (event.event === "prepare_2fa") {
    writeFlowAudit(flowAudit, "ruyipage", "prepare_2fa");
    return;
  }
  if (event.event === "need_2fa") {
    writeFlowAudit(flowAudit, "ruyipage", "need_2fa", {
      generation: event.generation,
    });
    return;
  }
  if (event.event === "warning") {
    writeFlowAudit(flowAudit, "ruyipage", "warning", {
      warning: "backend_warning",
    });
    return;
  }
  if (event.event === "result") {
    writeFlowAudit(flowAudit, "ruyipage", "result", {
      success: event.success === true,
      failureStage: sanitizeBrowserFailureStage(event.failureStage),
      accountHomeConfirmed:
        event.browserLogin?.accountHomeConfirmed === true,
    });
    return;
  }
  writeFlowAudit(flowAudit, "ruyipage", "unknown_event", {
    event: "unknown",
  });
}

function reportTwoFactorStatus(event) {
  if (!event || typeof event !== "object") return;

  if (process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1") {
    if (
      event.status === "winner" &&
      Object.hasOwn(TWO_FACTOR_WINNER_MESSAGES, event.source)
    ) {
      console.log(`${SUPERVISED_TWO_FACTOR_STATUS_PREFIX}winner:${event.source}`);
    } else if (
      [
        "settings_start",
        "settings_retry",
        "settings_accessibility",
        "settings_failed",
        "manual_allow",
        "manual_code",
        "manual_unavailable",
        "ocr_permission_missing",
        "ocr_helper_unavailable",
        "popup_accessibility",
        "popup_primary",
        "popup_scanning",
        "popup_close_pending",
        "settings_fallback",
        "timeout",
      ].includes(event.status)
    ) {
      console.log(`${SUPERVISED_TWO_FACTOR_STATUS_PREFIX}${event.status}`);
    }
  }

  if (event.status === "settings_start" && (event.attempt === 1 || event.attempt === 2)) {
    console.log(
      event.attempt === 1
        ? "[2FA] 正在尝试通过系统设置获取验证码（第 1/2 次）；如出现 macOS 辅助功能提示，请允许系统设置取码 helper。"
        : "[2FA] 正在尝试通过系统设置获取验证码（第 2/2 次）..."
    );
    return;
  }
  if (event.status === "settings_retry" && event.attempt === 2) {
    console.log("[2FA] 系统设置取码失败，5 秒后进行第 2/2 次尝试...");
    return;
  }
  if (event.status === "winner") {
    if (Object.hasOwn(TWO_FACTOR_WINNER_MESSAGES, event.source)) {
      console.log(TWO_FACTOR_WINNER_MESSAGES[event.source]);
    }
    return;
  }

  if (Object.hasOwn(TWO_FACTOR_STATUS_MESSAGES, event.status)) {
    console.log(TWO_FACTOR_STATUS_MESSAGES[event.status]);
  }
}

/**
 * @param {object} params
 * @param {{ appleId: string, password: string }} params.creds
 * @param {string} params.reportDir
 * @param {object} [params.flowAudit]
 * @param {object} [runtime]
 */
export async function runAccountBrowserPhase(
  { creds, reportDir, flowAudit = null },
  runtime = {}
) {
  const getEnvironmentSummary =
    runtime.getBrowserEnvironmentSummary ?? getBrowserEnvironmentSummary;
  const checkAccessibility = runtime.isAccessibilityGranted ?? isAccessibilityGranted;
  const createRunner =
    runtime.createRuyiPageBackendRunner ?? createRuyiPageBackendRunner;
  const createCollector = runtime.createMac2FACollector ?? createMac2FACollector;

  const summary = getEnvironmentSummary();
  writeFlowAudit(flowAudit, "account_browser", "environment", {
    backend: summary.backend,
    backendReason: summary.backendReason,
    warnings: summary.warnings,
  });
  console.log(`[Firefox] 浏览器后端: ${summary.backend} (${summary.backendReason})`);
  for (const _warning of summary.warnings) {
    console.log(FIXED_ENVIRONMENT_WARNING);
  }

  let axOk = false;
  try {
    axOk = await checkAccessibility({ compileIfNeeded: false });
  } catch (error) {
    writeFlowAuditError(flowAudit, "account_browser", "accessibility_check_failed", error);
  }
  writeFlowAudit(flowAudit, "account_browser", "accessibility", {
    granted: axOk,
  });
  if (!axOk) {
    console.warn("[2FA] 警告: 辅助功能未授权，系统设置取码可能失败");
  }

  const collector = createCollector({
    timeoutMs: TWO_FACTOR_TIMEOUT_MS,
    reportDir,
    // Keep the popup-first policy explicit. The collector resolves optional
    // fallback switches from the environment so documented opt-outs work.
    settingsOnly: false,
    onStatus(event) {
      writeFlowAudit(flowAudit, "two_factor", "status", event);
      reportTwoFactorStatus(event);
    },
    onAudit(entry) {
      writeFlowAudit(flowAudit, "two_factor", "audit", entry);
    },
    onDiagnostic(entry) {
      writeFlowAuditError(
        flowAudit,
        "two_factor",
        "native_provider_diagnostic",
        entry?.error,
        {
          source: entry?.source,
          phase: entry?.phase,
          helperFailureCode: sanitizeNativeProviderCode(entry?.error?.code),
          hasHelperStderr: entry?.error?.hasHelperStderr === true,
        }
      );
    },
  });
  let result;
  let runError = null;
  let lastFailureStage = "unknown";
  let reportedFailureStage = null;
  try {
    console.log("[ruyipage] status:runtime_resolving");
    writeFlowAudit(flowAudit, "ruyipage", "runtime_resolving");
    const runner = createRunner();
    console.log("[ruyipage] status:backend_starting");
    writeFlowAudit(flowAudit, "ruyipage", "backend_starting");
    result = await runner.run({
      creds,
      reportDir,
      onEvent(event) {
        const eventFailureStage = sanitizeBrowserFailureStage(
          event?.status === "browser_stage" ? event?.stage : event?.failureStage
        );
        const passwordBidiInputProgress = passwordBidiInputProgressToken(event);
        const inputStatusLine = inputProgressStatusLine(
          event,
          passwordBidiInputProgress
        );
        const twoFactorHandoffLine = twoFactorHandoffStatusLine(event);
        if (
          eventFailureStage !== "unknown" &&
          ((event.event === "status" &&
            (event.status === "browser_stage" ||
              event.status === "browser_failure" ||
              event.status === "browser_preserved")) ||
            (event.event === "result" && event.success === false))
        ) {
          lastFailureStage = eventFailureStage;
        }
        auditRuyiPageEvent(flowAudit, event);
        if (event.event === "ready") {
          console.log(`[ruyipage] 浏览器已就绪 (${sanitizeReadyMode(event.mode)})`);
        } else if (
          event.event === "status" &&
          RUYIPAGE_STARTUP_STATUSES.has(event.status)
        ) {
          console.log(`[ruyipage] status:${event.status}`);
        } else if (inputStatusLine) {
          console.log(`[ruyipage] status:${inputStatusLine}`);
        } else if (twoFactorHandoffLine) {
          console.log(`[ruyipage] status:${twoFactorHandoffLine}`);
        } else if (event.event === "status" && event.status === "browser_preserved") {
          console.warn("[ruyipage] 流程失败，Firefox 已保留供人工核对当前页面");
        } else if (
          event.event === "status" &&
          event.status === "browser_failure" &&
          eventFailureStage !== "unknown"
        ) {
          if (eventFailureStage !== reportedFailureStage) {
            reportedFailureStage = eventFailureStage;
            console.log(`[ruyipage] status:failure:${eventFailureStage}`);
          }
        } else if (
          event.event === "result" &&
          event.success === false &&
          eventFailureStage !== "unknown"
        ) {
          if (eventFailureStage !== reportedFailureStage) {
            reportedFailureStage = eventFailureStage;
            console.log(`[ruyipage] status:failure:${eventFailureStage}`);
          }
        } else if (event.event === "warning") {
          console.warn("[ruyipage] backend warning");
        } else if (event.event === "prepare_2fa") {
          console.log("[ruyipage] 密码提交前预备 macOS 2FA 监听...");
        } else if (event.event === "need_2fa") {
          console.log("[ruyipage] 页面已确认进入 2FA，等待首个可用验证码...");
        }
      },
      async prepare2FA() {
        writeFlowAudit(flowAudit, "two_factor", "prepare_started");
        try {
          await collector.prepare();
        } catch (error) {
          writeFlowAuditError(flowAudit, "two_factor", "prepare_failed", error);
          throw error;
        }
        writeFlowAudit(flowAudit, "two_factor", "prepare_completed");
      },
      async get2FACode(request) {
        writeFlowAudit(flowAudit, "two_factor", "code_requested", request);
        let code;
        try {
          code = await collector.getCode(request);
        } catch (error) {
          writeFlowAuditError(flowAudit, "two_factor", "code_provider_failed", error, {
            generation: request?.generation,
          });
          throw error;
        }
        flowAudit?.addSecrets?.([code]);
        writeFlowAudit(flowAudit, "two_factor", "code_acquired", {
          generation: request?.generation,
        });
        return code;
      },
    });
  } catch (error) {
    runError = error;
    const failureCode = classifyBrowserRunFailure(error);
    const runnerContext = readRunnerFailureContext(error);
    const failureStage = sanitizeBrowserFailureStage(
      lastFailureStage === "unknown" ? runnerContext.stage : lastFailureStage
    );
    writeFlowAuditError(flowAudit, "account_browser", "runner_failed", error, {
      failureCode,
      failureStage,
      runnerStage: runnerContext.stage,
      twoFaPhase: runnerContext.twoFaPhase,
      twoFaGeneration: runnerContext.generation,
      codeDeliveryAttempted: runnerContext.codeDeliveryAttempted,
      codeDeliverySent: runnerContext.codeDeliverySent,
      codeDeliveryAcknowledged: runnerContext.codeDeliveryAcknowledged,
      browserPreserved: runnerContext.browserPreserved,
      browserErrorClass: runnerContext.browserErrorClass,
      cleanupFailed: runnerContext.cleanupFailed,
    });
    throw annotateBrowserRunFailure(error, null, failureStage);
  } finally {
    try {
      await collector.dispose();
      writeFlowAudit(flowAudit, "two_factor", "collector_disposed");
    } catch (error) {
      writeFlowAuditError(flowAudit, "two_factor", "collector_dispose_failed", error);
      if (!runError) {
        throw annotateBrowserRunFailure(error, "collector_cleanup", lastFailureStage);
      }
      console.warn("[2FA] collector cleanup failed");
    }
  }

  if (
    result?.browserLogin?.success !== true ||
    result.browserLogin.backend !== "ruyipage" ||
    result.browserLogin.accountHomeConfirmed !== true
  ) {
    writeFlowAudit(flowAudit, "account_browser", "account_home_unconfirmed");
    throw annotateBrowserRunFailure(
      new Error("ruyipage backend did not confirm the authenticated Apple account home"),
      null,
      lastFailureStage
    );
  }

  writeFlowAudit(flowAudit, "account_browser", "account_home_confirmed");

  return {
    browserLogin: result.browserLogin,
    antiAutomation: { backend: "ruyipage", delegated: true },
    personalInfo: result.personalInfo ?? null,
    screenshots: result.screenshots ?? {},
  };
}
