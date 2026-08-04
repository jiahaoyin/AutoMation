/**
 * account.apple.com browser phase orchestration.
 *
 * Node owns credentials, reporting, and the macOS 2FA sidecar. Browser launch,
 * navigation, page reads, screenshots, and interaction are delegated to ruyiPage.
 */

import { isAccessibilityGranted } from "./accessibility.js";
import {
  saveApplePasswordToEnv,
  saveAppleProfileToEnv,
  saveDeveloperMembershipToEnv,
} from "./credentials.js";
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

const FIXED_ENVIRONMENT_WARNING = "[!] Firefox 环境提示：详情已写入日志";
const TWO_FACTOR_TIMEOUT_MS = 240_000;
const DEVELOPER_MEMBERSHIP_STATUSES = new Set([
  "active",
  "not_enrolled",
  "unknown",
]);
const ACCOUNT_MODULE_SKIP_REASONS = new Set([
  "developer_membership_gate",
  "unknown",
]);
const DEVELOPER_ACCOUNT_FAILURE_CLASSES = new Set([
  "developer_authentication_error",
  "developer_connection_lost",
  "developer_login_unconfirmed",
  "developer_membership_unknown",
  "developer_navigation_failed",
  "developer_result_missing",
  "developer_twofa_unavailable",
  "developer_account_failed",
  "unknown",
]);
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
    "[2FA] 原生验证码窗仍可见，正在继续提交到网页。",
  timeout:
    "[2FA] 240 秒内未取得可用验证码。请确认 Mac 已登录同一 Apple ID、允许弹窗已处理，并检查系统设置取码与相关权限。",
});
const TWO_FACTOR_WINNER_MESSAGES = Object.freeze({
  popup: "[2FA] 已从 Apple 验证码弹窗取得验证码。",
  settings: "[2FA] 已从系统设置取得验证码。",
  manual: "[2FA] 已使用终端手动输入的验证码。",
});
const SUPERVISED_TWO_FACTOR_STATUS_PREFIX = "[2FA] status:";
const TERMINAL_DEBUG_ENV = "APPLE_AUTOMATION_TERMINAL_DEBUG";
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
  "browser_session_attached",
  "browser_blank_tab_attached",
  "browser_login_tab_created",
  "browser_profile_attach_required",
  "browser_session_preserved",
  "browser_finalization_started",
  "browser_finalization_completed",
  "browser_finalization_partial",
  "screenshot_capture",
  "screenshot_failed",
  "account_home_confirmed",
  "browser_observation",
  "profile_capture_started",
  "profile_capture_readiness",
  "profile_capture_completed",
  "profile_capture_failed",
  "profile_page_ready",
  "profile_screenshot_saved",
  "profile_birthday_collected",
  "profile_name_collected",
  "profile_name_modal_closed",
  "profile_name_modal_query_failed",
  "profile_name_modal_unavailable",
  "profile_name_modal_cleanup_failed",
  "profile_navigation_started",
  "profile_navigation_sidebar_link_resolved",
  "profile_navigation_sidebar_click_sent",
  "profile_navigation_direct_fallback",
  "profile_navigation_arrived",
  "profile_navigation_sign_in_redirect",
  "profile_navigation_unconfirmed",
  "profile_reauthentication_started",
  "profile_reauthentication_completed",
  "profile_reauthentication_exhausted",
  "profile_reauthentication_twofa_exhausted",
  "developer_account_started",
  "developer_account_tab_created",
  "developer_account_authentication_started",
  "developer_account_authenticated",
  "developer_membership_probe",
  "developer_membership_checked",
  "developer_membership_card_unavailable",
  "developer_account_completed",
  "developer_account_failed",
  "developer_membership_gate_blocked",
  "account_module_started",
  "account_module_tab_created",
  "account_security_navigation_started",
  "account_security_navigation_link_resolved",
  "account_security_navigation_sidebar_click_sent",
  "account_security_navigation_direct_fallback",
  "account_security_navigation_arrived",
  "account_security_navigation_sign_in_redirect",
  "account_security_navigation_unconfirmed",
  "password_change_started",
  "password_change_page_ready",
  "password_change_form_ready",
  "password_change_submitted",
  "password_change_completed",
  "password_change_failed",
  "small_business_application_started",
  "small_business_application_tab_created",
  "small_business_application_authenticated",
  "small_business_enrollment_page_ready",
  "small_business_paid_agreement_accepted",
  "small_business_associated_accounts_answered",
  "small_business_revenue_certification_checked",
  "small_business_application_submitted",
  "small_business_application_completed",
  "small_business_application_failed",
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
  "trust_prompt_detected",
  "trust_click_sent",
  "handoff_failed",
]);
const RUYIPAGE_RUNNER_STATUS_CODES = new Set([
  "twofa_code_delivery_started",
  "twofa_code_delivery_sent",
  "twofa_code_delivery_acknowledged",
]);
const RUYIPAGE_RUNNER_LIFECYCLE_STATUSES = new Set([
  "backend_spawned",
  "backend_result_received",
  "backend_exit_observed",
  "backend_close_observed",
  "completion_close",
  "completion_timeout",
  "completion_termination",
  "completion_preserved",
  "cleanup_group_requested",
  "cleanup_backend_requested",
  "cleanup_not_required",
  "cleanup_completed",
  "cleanup_failed",
]);
const RUYIPAGE_PROFILE_STATUS_MESSAGES = Object.freeze({
  browser_session_attached: "[✓] 已接管现有 Apple 账户标签页",
  browser_blank_tab_attached: "[→] 已接管 Firefox 空白标签页",
  browser_login_tab_created: "[→] 已在 Firefox 中新建登录标签页",
  browser_profile_attach_required:
    "[!] Firefox Profile 正在使用，但控制连接不可用；没有启动第二个浏览器",
  account_home_confirmed: "[✓] 已确认 Apple 账户登录成功",
  profile_navigation_sidebar_click_sent: "[→] 正在通过账户侧栏打开个人信息",
  profile_navigation_direct_fallback: "[→] 正在使用个人信息网址继续打开",
  profile_reauthentication_started: "[→] 个人信息页面要求重新验证，正在恢复登录",
  profile_reauthentication_completed: "[✓] Apple 登录状态已恢复",
  profile_page_ready: "[✓] 个人信息页面已就绪",
  profile_birthday_collected: "[✓] 已读取出生日期",
  profile_name_collected: "[✓] 已读取姓名",
  profile_name_modal_closed: "[✓] 姓名弹窗已关闭",
  profile_name_modal_cleanup_failed:
    "[!] 姓名弹窗未能确认关闭，已停止后续账号修改流程；详情已写入日志",
  developer_account_started: "[→] 正在打开 Apple Developer 账户页面",
  developer_account_authentication_started:
    "[→] Apple Developer 页面需要登录，正在继续认证",
  developer_account_authenticated: "[✓] 已确认 Apple Developer 账户登录成功",
  developer_account_completed: "[✓] Apple Developer 会员状态检查完成",
  account_module_started: "[→] 正在打开 Apple 账户页面",
  account_security_navigation_started: "[→] 正在打开登录与安全性页面",
  account_security_navigation_sidebar_click_sent:
    "[→] 正在通过账户侧栏打开登录与安全性",
  account_security_navigation_direct_fallback:
    "[→] 正在使用登录与安全性网址继续打开",
  account_security_navigation_arrived: "[✓] 登录与安全性页面已打开",
  password_change_started: "[→] 正在准备修改 Apple 账户密码",
  password_change_page_ready: "[✓] 登录与安全性页面已就绪",
  password_change_form_ready: "[→] 正在填写当前密码和新密码",
  password_change_submitted: "[→] 已提交密码更改请求",
  small_business_application_started: "[→] 正在打开小开发者申请页面",
  small_business_application_tab_created: "[→] 已新建小开发者申请标签页",
  small_business_application_authenticated: "[✓] 小开发者申请页登录已确认",
  small_business_enrollment_page_ready: "[✓] 小开发者申请表单已就绪",
  small_business_paid_agreement_accepted: "[✓] 已选择付费应用协议确认项",
  small_business_associated_accounts_answered: "[✓] 已填写关联开发者账户问题",
  small_business_revenue_certification_checked: "[✓] 已勾选收益声明",
  small_business_application_submitted: "[→] 已提交小开发者申请",
  small_business_application_completed: "[✓] 小开发者申请已提交成功",
  browser_session_preserved: "[✓] 已保留 Firefox 窗口和账户标签页",
});
const RUYIPAGE_TWO_FACTOR_PROGRESS_MESSAGES = Object.freeze({
  input_started: "[→] 正在填写 Apple 验证码",
  input_completed: "[✓] Apple 验证码已填写",
  transition_waiting: "[→] 正在确认 Apple 登录状态",
  transition_confirmed: "[✓] Apple 验证已通过",
  trust_prompt_detected: "[→] 正在处理“信任此浏览器”确认",
  trust_click_sent: "[✓] 已点击“信任此浏览器”确认",
  handoff_failed: "[×] 验证码提交未确认，详情已写入日志",
});
const RUYIPAGE_BROWSER_STAGE_PROGRESS_MESSAGES = Object.freeze({
  email_input: "[→] 正在填写 Apple ID",
  email_submit: "[✓] Apple ID 已填写",
  password_input: "[→] 正在填写 Apple 密码",
  password_submit: "[✓] Apple 登录信息已提交",
});
const RUYIPAGE_STAGE_TRANSITIONS = new Set(["entered"]);
const RUYIPAGE_PROFILE_NAVIGATION_ROUTES = new Set([
  "existing",
  "sidebar",
  "direct",
  "sidebar_then_direct",
]);
const RUYIPAGE_PROFILE_NAVIGATION_FALLBACKS = new Set([
  "sidebar_unconfirmed",
]);
const RUYIPAGE_OBSERVATION_CHECKPOINTS = new Set([
  "login_state",
  "twofa_wait",
  "twofa_transition",
  "account_home",
  "account_information",
  "profile_ready",
  "profile_capture_failed",
]);
const RUYIPAGE_SCREENSHOT_CHECKPOINTS = new Set([
  "account_home",
  "account_information",
  "developer_membership",
  "small_business_application",
]);
const RUYIPAGE_PAGE_KINDS = new Set([
  "sign_in",
  "password",
  "two_factor",
  "trust_prompt",
  "account_manage",
  "account_information",
  "authentication_error",
  "unknown",
]);
const PROFILE_CAPTURE_FAILURE_CLASSES = new Set([
  "developer_membership_gate",
  "profile_authentication_error",
  "profile_reauthentication_exhausted",
  "profile_session_unconfirmed",
  "profile_element_unavailable",
  "profile_page_unready",
  "profile_card_ambiguous",
  "profile_card_identity_collision",
  "profile_data_incomplete",
  "profile_name_modal_query_failed",
  "profile_name_modal_ambiguous",
  "profile_name_modal_unavailable",
  "profile_name_modal_cleanup_failed",
  "browser_connection_lost",
  "profile_capture_failed",
  "profile_persistence_failed",
  "profile_result_missing",
  "runner_post_login_failed",
  "unknown",
]);
const PROFILE_CAPTURE_READINESS_OUTCOMES = new Set([
  "ready",
  "route_unready",
  "state_unavailable",
  "authentication_blocked",
  "card_missing",
  "card_ambiguous",
  "card_identity_collision",
  "card_query_failed",
]);
const PASSWORD_CHANGE_FAILURE_CLASSES = new Set([
  "password_change_not_attempted",
  "password_change_navigation_failed",
  "password_change_form_unready",
  "password_change_submit_unconfirmed",
  "password_change_confirmation_missing",
  "password_change_failed",
  "password_persistence_failed",
  "password_persistence_missing",
  "runner_post_login_failed",
  "unknown",
]);
const SMALL_BUSINESS_APPLICATION_FAILURE_CLASSES = new Set([
  "small_business_not_attempted",
  "small_business_navigation_failed",
  "small_business_login_unconfirmed",
  "small_business_form_unready",
  "small_business_submission_unconfirmed",
  "small_business_application_failed",
  "small_business_result_missing",
  "runner_post_login_failed",
  "unknown",
]);
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
const POST_LOGIN_RUNNER_PARTIAL_CODES = new Set([
  "backend_exit",
  "backend_timeout",
  "backend_cleanup",
]);
const BACKEND_DIAGNOSTIC_CLASSES = new Set([
  "twofa_digit_input_verification_failed",
  "twofa_sequence_failed",
  "twofa_input_unconfirmed",
  "twofa_input_missing",
  "twofa_input_target_count",
  "twofa_target_missing",
  "twofa_focus_unconfirmed",
  "twofa_submit_not_confirmed",
  "twofa_page_missing",
  "login_stopped_before_2fa",
  "account_session_unconfirmed_after_2fa",
  "twofa_login_failed",
  "password_input_verification_failed",
  "password_focus_unconfirmed",
  "password_target_unstable",
  "account_home_unconfirmed",
  "profile_capture_failed",
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
  "profile_capture",
  "profile_birthday",
  "profile_name",
  "developer_account",
  "developer_login",
  "developer_membership",
  "account_navigation",
  "account_security",
  "password_change",
  "small_business_application",
  "small_business_login",
  "small_business_enrollment",
  "post_login_finalization",
  "result_emitting",
  "result_emitted",
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
  "profile_persistence",
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

function sanitizeStageTransition(value) {
  return RUYIPAGE_STAGE_TRANSITIONS.has(value) ? value : "unknown";
}

function sanitizeProfileNavigationRoute(value) {
  return RUYIPAGE_PROFILE_NAVIGATION_ROUTES.has(value) ? value : "unknown";
}

function sanitizeProfileNavigationFallback(value) {
  return RUYIPAGE_PROFILE_NAVIGATION_FALLBACKS.has(value) ? value : "unknown";
}

function sanitizeBrowserObservationCheckpoint(value) {
  return RUYIPAGE_OBSERVATION_CHECKPOINTS.has(value) ? value : "unknown";
}

function sanitizeScreenshotCheckpoint(value) {
  return RUYIPAGE_SCREENSHOT_CHECKPOINTS.has(value) ? value : "unknown";
}

function sanitizeBrowserPageKind(value) {
  return RUYIPAGE_PAGE_KINDS.has(value) ? value : "unknown";
}

function sanitizeProfileCaptureFailureClass(value) {
  return PROFILE_CAPTURE_FAILURE_CLASSES.has(value) ? value : "unknown";
}

const PROFILE_NAME_MODAL_CLEANUP_FAILURE_CLASSES = new Set([
  "profile_name_modal_close_control_unavailable",
  "profile_name_modal_close_action_failed",
  "profile_name_modal_close_context_lost",
  "profile_name_modal_close_query_failed",
  "profile_name_modal_close_unconfirmed",
]);
const PROFILE_NAME_MODAL_CLOSE_SEARCH_SCOPES = new Set([
  "modal_content",
  "owner_overlay",
  "portal_owner",
  "none",
]);
const PROFILE_NAME_MODAL_UNAVAILABLE_OUTCOMES = new Set([
  "card_missing",
  "modal_missing",
  "timeout",
]);

function sanitizeProfileNameModalCleanupFailureClass(value) {
  return PROFILE_NAME_MODAL_CLEANUP_FAILURE_CLASSES.has(value) ? value : "unknown";
}

function sanitizeProfileNameModalCloseSearchScope(value) {
  return PROFILE_NAME_MODAL_CLOSE_SEARCH_SCOPES.has(value) ? value : "unknown";
}

function sanitizeProfileNameModalUnavailableAttemptCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2 ? value : 0;
}

function sanitizeProfileNameModalUnavailableOutcome(value) {
  return PROFILE_NAME_MODAL_UNAVAILABLE_OUTCOMES.has(value) ? value : "timeout";
}

function firstKnownBrowserFailureStage(...values) {
  for (const value of values) {
    const stage = sanitizeBrowserFailureStage(value);
    if (stage !== "unknown") return stage;
  }
  return "unknown";
}

function sanitizePasswordChangeFailureClass(value) {
  return PASSWORD_CHANGE_FAILURE_CLASSES.has(value) ? value : "unknown";
}

function sanitizeSmallBusinessApplicationFailureClass(value) {
  return SMALL_BUSINESS_APPLICATION_FAILURE_CLASSES.has(value) ? value : "unknown";
}

function sanitizePasswordLength(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1024 ? value : 0;
}

function sanitizeSmallBusinessAnswerCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4 ? value : 0;
}

function sanitizeProfileCaptureReadiness(event) {
  const count = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
  return {
    routeConfirmed: event?.routeConfirmed === true,
    stateReadable: event?.stateReadable === true,
    authenticationBlocked: event?.authenticationBlocked === true,
    nameCardCount: count(event?.nameCardCount),
    birthdayCardCount: count(event?.birthdayCardCount),
    birthdayValueReady: event?.birthdayValueReady === true,
    sameCardIdentity: event?.sameCardIdentity === true,
    snapshotOutcome: PROFILE_CAPTURE_READINESS_OUTCOMES.has(event?.snapshotOutcome)
      ? event.snapshotOutcome
      : "card_query_failed",
    stableObservations: count(event?.stableObservations),
  };
}

function sanitizePostLoginFinalizationClass(value) {
  return POST_LOGIN_FINALIZATION_CLASSES.has(value) ? value : "unknown";
}

function finalizationClassRequiresPartial(value) {
  return POST_LOGIN_FINALIZATION_PARTIAL_CLASSES.has(value);
}

function sanitizeBrowserObservation(event) {
  return {
    checkpoint: sanitizeBrowserObservationCheckpoint(event?.checkpoint),
    generation: sanitizeTwoFactorGeneration(event?.generation),
    pageKind: sanitizeBrowserPageKind(event?.pageKind),
    connectionAlive: event?.connectionAlive === true,
    inspectionAvailable: event?.inspectionAvailable !== false,
    sessionConfirmed: event?.sessionConfirmed === true,
    accountHomeConfirmed: event?.accountHomeConfirmed === true,
    twofaVisible: event?.twofaVisible === true,
    trustPrompt: event?.trustPrompt === true,
    inputReady: event?.inputReady === true,
    codeInputCount: event?.codeInputCount === 1 || event?.codeInputCount === 6
      ? event.codeInputCount
      : 0,
    authenticationError: event?.authenticationError === true,
    rootManageUrl: event?.rootManageUrl === true,
    rootAccountMarker: event?.rootAccountMarker === true,
    rootAuthenticationError: event?.rootAuthenticationError === true,
    rootSecurityCopyOnly: event?.rootSecurityCopyOnly === true,
    retiringChildError: event?.retiringChildError === true,
    childAuthUiPresent: event?.childAuthUiPresent === true,
  };
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
  if (shouldMirrorTerminalDiagnostics()) {
    console.log(`[ruyipage] status:node-failure:${code}`);
  } else {
    console.log(`[×] 浏览器流程失败（${code}）`);
  }
  return error;
}

function terminalDebugEnabled(env = process.env) {
  const value = String(env?.[TERMINAL_DEBUG_ENV] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function shouldMirrorTerminalDiagnostics(env = process.env) {
  return (
    terminalDebugEnabled(env) ||
    String(env?.APPLE_AUTOMATION_SUPERVISED_GUI ?? "").trim() === "1"
  );
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

function sanitizeRunnerLifecycle(event) {
  return {
    status: RUYIPAGE_RUNNER_LIFECYCLE_STATUSES.has(event?.status)
      ? event.status
      : "unknown",
    backendExitCode: sanitizeBackendExitCode(event?.backendExitCode),
    resultSuccess: event?.resultSuccess === true,
    usesBrowserBroker: event?.usesBrowserBroker === true,
    strictProcessCleanup: event?.strictProcessCleanup === true,
    processGroupCleanup: event?.processGroupCleanup === true,
    directBackendCleanup: event?.directBackendCleanup === true,
    timedOut: event?.timedOut === true,
    interrupted: event?.interrupted === true,
  };
}

function sanitizeTwoFactorGeneration(value) {
  return value === 1 || value === 2 ? value : 0;
}

function sanitizeTwoFactorPageState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    twofaVisible: state.twofaVisible === true,
    inputReady: state.inputReady === true,
    codeInputCount:
      state.codeInputCount === 1 || state.codeInputCount === 6
        ? state.codeInputCount
        : 0,
    elapsedMs:
      Number.isInteger(state.elapsedMs) && state.elapsedMs >= 0
        ? Math.min(state.elapsedMs, 75_000)
        : 0,
  };
}

function sanitizeBackendExitCode(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
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
      codeDeliveryWriteStarted: false,
      codeDeliveryWriteCompleted: false,
      browserLaunchObserved: false,
      accountHomeConfirmed: false,
      browserPreserved: false,
      browserSessionPreserved: false,
      browserFinalizationCompleted: false,
      browserPreservationRequested: false,
      directBrowserPreservationRequested: false,
      directPostLoginRecoveryEligible: false,
      browserErrorClass: "unknown",
      backendExitCode: null,
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
    codeDeliveryWriteStarted: context.codeDeliveryWriteStarted === true,
    codeDeliveryWriteCompleted: context.codeDeliveryWriteCompleted === true,
    browserLaunchObserved: context.browserLaunchObserved === true,
    accountHomeConfirmed: context.accountHomeConfirmed === true,
    browserPreserved: context.browserPreserved === true,
    browserSessionPreserved: context.browserSessionPreserved === true,
    browserFinalizationCompleted: context.browserFinalizationCompleted === true,
    browserPreservationRequested: context.browserPreservationRequested === true,
    directBrowserPreservationRequested:
      context.directBrowserPreservationRequested === true,
    directPostLoginRecoveryEligible:
      context.directPostLoginRecoveryEligible === true,
    browserErrorClass: sanitizeBackendDiagnosticClass(context.browserErrorClass),
    backendExitCode: sanitizeBackendExitCode(context.backendExitCode),
    cleanupFailed: context.cleanupFailed === true,
  };
}

export function readBrowserAccountHomeConfirmed(error) {
  return (
    error?.browserAccountHomeConfirmed === true ||
    readRunnerFailureContext(error).accountHomeConfirmed === true
  );
}

function markBrowserAccountHomeConfirmed(error) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    Object.defineProperty(error, "browserAccountHomeConfirmed", {
      configurable: true,
      value: true,
    });
  }
  return error;
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
  if (normalized.includes("2fa code input was not confirmed")) {
    return "twofa_input_unconfirmed";
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
  if (normalized.includes("live password input target did not stabilize")) {
    return "password_target_unstable";
  }
  if (normalized.includes("login stopped before 2fa")) {
    return "login_stopped_before_2fa";
  }
  if (normalized.includes("account session was not confirmed after 2fa")) {
    return "account_session_unconfirmed_after_2fa";
  }
  if (normalized.includes("2fa submit")) {
    return "twofa_submit_not_confirmed";
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

function runnerLifecycleStatusLine(event) {
  if (event?.event !== "runner_lifecycle") return null;
  const lifecycle = sanitizeRunnerLifecycle(event);
  if (lifecycle.status === "unknown") return null;
  return `runner:${lifecycle.status}:exit:${
    lifecycle.backendExitCode ?? "unknown"
  }:group_cleanup:${lifecycle.processGroupCleanup ? 1 : 0}:backend_cleanup:${
    lifecycle.directBackendCleanup ? 1 : 0
  }:timeout:${lifecycle.timedOut ? 1 : 0}:interrupted:${
    lifecycle.interrupted ? 1 : 0
  }`;
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

function normalizeCapturedProfileValue(value, label, maxLength) {
  if (typeof value !== "string" || /[\r\n\u0000]/.test(value)) {
    throw new Error(`ruyipage ${label} is invalid`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`ruyipage ${label} is invalid`);
  }
  return normalized;
}

function shouldPrintCapturedProfile() {
  return process.stdout.isTTY && process.env.APPLE_AUTOMATION_SUPERVISED_GUI !== "1";
}

function normalizeCapturedProfile(personalInfo) {
  const name = normalizeCapturedProfileValue(personalInfo?.name, "profile name", 256);
  const birthday = normalizeCapturedProfileValue(
    personalInfo?.birthday,
    "profile birthday",
    128
  );
  return { name, birthday };
}

function sanitizeDeveloperRegistrationIdentityValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > 64 ||
    /[\r\n\u0000]/.test(value)
  ) {
    return null;
  }
  return normalized;
}

function saveCapturedProfile(personalInfo, flowAudit, saveProfile, printProfile) {
  const { name, birthday } = normalizeCapturedProfile(personalInfo);
  flowAudit?.addSecrets?.([name, birthday]);
  saveProfile({ name, birthday });
  if (printProfile === true) {
    console.log("[✓] 已写入 .env：name、birthday");
    console.log(`[✓] 姓名：${name}`);
    console.log(`[✓] 出生日期：${birthday}`);
  }
  return { collected: true, nameStored: true, birthdayStored: true };
}

function normalizeRotatedApplePassword(value) {
  if (typeof value !== "string") {
    throw new Error("rotated apple password is invalid");
  }
  if (!value || value.length > 1024 || /[\r\n\u0000]/.test(value)) {
    throw new Error("rotated apple password is invalid");
  }
  return value;
}

function saveRotatedApplePassword(event, flowAudit, savePassword) {
  const newPassword = normalizeRotatedApplePassword(event?.newPassword);
  const passwordLength = sanitizePasswordLength(event?.passwordLength);
  if (passwordLength !== newPassword.length) {
    throw new Error("rotated apple password length is invalid");
  }
  flowAudit?.addSecrets?.([newPassword]);
  savePassword(newPassword);
  writeFlowAudit(flowAudit, "account_browser", "password_persisted", {
    passwordLength,
    passwordStored: true,
  });
  console.log(`[✓] 新密码已写入 .env（${passwordLength} 位，已隐藏）`);
  return {
    attempted: true,
    passwordStored: true,
    passwordLength,
  };
}

function saveDeveloperMembership(
  membershipStatus,
  registrationIdentityValue,
  flowAudit,
  saveMembership,
  printResult
) {
  const normalized = sanitizeDeveloperMembershipStatus(membershipStatus);
  const safeRegistrationIdentity =
    normalized === "active"
      ? sanitizeDeveloperRegistrationIdentityValue(registrationIdentityValue)
      : null;
  if (safeRegistrationIdentity !== null) {
    flowAudit?.addSecrets?.([safeRegistrationIdentity]);
  }
  saveMembership(normalized, safeRegistrationIdentity);
  if (printResult === true) {
    const labels = {
      active: "已加入",
      not_enrolled: "未加入",
      unknown: "未确认",
    };
    console.log("[✓] 已写入 .env：developer_membership");
    console.log(`[✓] Apple Developer Program：${labels[normalized]}`);
    if (safeRegistrationIdentity !== null) {
      console.log("[✓] 已写入 .env：developer_registration_identity");
      console.log(`[✓] 注册身份：${safeRegistrationIdentity}`);
    }
  }
  writeFlowAudit(flowAudit, "developer_account", "membership_persisted", {
    membershipStatus: normalized,
  });
  return {
    checked: true,
    membershipStatus: normalized,
    membershipStored: true,
  };
}

function sanitizeScreenshotMetadata(screenshots) {
  const source = screenshots && typeof screenshots === "object" ? screenshots : {};
  const result = {};
  const expectedFiles = {
    personalInformation: "02-account-information.png",
    developerMembership: "03-developer-membership.png",
    smallBusinessApplication: "04-small-business-application.png",
  };
  for (const [key, expectedFile] of Object.entries(expectedFiles)) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const name = value.split(/[\\/]/).pop() || "";
    if (name === expectedFile) {
      result[key] = expectedFile;
    }
  }
  return result;
}

function sanitizeBrowserLoginMetadata(browserLogin) {
  const source = browserLogin && typeof browserLogin === "object" ? browserLogin : {};
  return {
    success: source.success === true,
    backend: source.backend === "ruyipage" ? "ruyipage" : "unknown",
    accountHomeConfirmed: source.accountHomeConfirmed === true,
    skippedLogin: source.skippedLogin === true,
    skipped2FA: source.skipped2FA === true,
    sessionReused: source.sessionReused === true,
    rememberAccount:
      source.rememberAccount === true ? true : source.rememberAccount === false ? false : null,
  };
}

function sanitizePostLoginProfileCapture(profileCapture) {
  const isPresent = profileCapture && typeof profileCapture === "object";
  const source = isPresent ? profileCapture : {};
  const success = source.success === true;
  return {
    success,
    failureStage: success
      ? "unknown"
      : isPresent
        ? sanitizeBrowserFailureStage(source.failureStage)
        : "profile_capture",
    failureClass: success
      ? "unknown"
      : isPresent
        ? sanitizeProfileCaptureFailureClass(source.failureClass)
        : "profile_result_missing",
    browserAlive: source.browserAlive === true,
    browserPreserved: source.browserPreserved === true,
    browserPreservationRequested: source.browserPreservationRequested === true,
  };
}

function sanitizePostLoginPasswordChange(passwordChange) {
  const isPresent = passwordChange && typeof passwordChange === "object";
  const source = isPresent ? passwordChange : {};
  const attempted = source.attempted === true;
  const success = source.success === true;
  return {
    success,
    attempted,
    passwordStored: source.passwordStored === true,
    passwordLength: sanitizePasswordLength(source.passwordLength),
    failureStage: success
      ? "unknown"
      : isPresent
        ? sanitizeBrowserFailureStage(source.failureStage)
        : "password_change",
    failureClass: success
      ? "unknown"
      : isPresent
        ? sanitizePasswordChangeFailureClass(source.failureClass)
        : "password_change_not_attempted",
    browserAlive: source.browserAlive === true,
    browserPreserved: source.browserPreserved === true,
    browserPreservationRequested: source.browserPreservationRequested === true,
  };
}

function sanitizePostLoginSmallBusinessApplication(application) {
  const isPresent = application && typeof application === "object";
  const source = isPresent ? application : {};
  const attempted = source.attempted === true;
  const success = source.success === true;
  return {
    success,
    attempted,
    submitted: source.submitted === true,
    failureStage: success
      ? "unknown"
      : isPresent
        ? sanitizeBrowserFailureStage(source.failureStage)
        : "small_business_application",
    failureClass: success
      ? "unknown"
      : isPresent
        ? sanitizeSmallBusinessApplicationFailureClass(source.failureClass)
        : "small_business_not_attempted",
    browserAlive: source.browserAlive === true,
    browserPreserved: source.browserPreserved === true,
    browserPreservationRequested: source.browserPreservationRequested === true,
  };
}

function sanitizeDeveloperMembershipStatus(value) {
  return DEVELOPER_MEMBERSHIP_STATUSES.has(value) ? value : "unknown";
}

function sanitizeDeveloperMembershipProbe(event) {
  const fieldCount = Number.isInteger(event?.membershipFieldCount)
    ? Math.min(5, Math.max(0, event.membershipFieldCount))
    : 0;
  const stableCount = Number.isInteger(event?.stableCount)
    ? Math.min(2, Math.max(0, event.stableCount))
    : 0;
  return {
    routeMatched: event?.routeMatched === true,
    authBlocked: event?.authBlocked === true,
    detailsPage: event?.detailsPage === true,
    appleDeveloperProgram: event?.appleDeveloperProgram === true,
    renewalDate: event?.renewalDate === true,
    registrationIdentity: event?.registrationIdentity === true,
    teamId: event?.teamId === true,
    membershipFieldCount: fieldCount,
    stableCount,
  };
}

function sanitizeDeveloperAccountFailureClass(value) {
  return DEVELOPER_ACCOUNT_FAILURE_CLASSES.has(value) ? value : "unknown";
}

function sanitizePostLoginDeveloperAccount(developerAccount) {
  const isPresent = developerAccount && typeof developerAccount === "object";
  const source = isPresent ? developerAccount : {};
  const membershipStatus = sanitizeDeveloperMembershipStatus(
    source.membershipStatus
  );
  const success =
    source.success === true &&
    source.authenticated === true &&
    DEVELOPER_MEMBERSHIP_STATUSES.has(source.membershipStatus);
  return {
    success,
    authenticated: source.authenticated === true,
    membershipStatus,
    failureStage: success
      ? "unknown"
      : isPresent
        ? sanitizeBrowserFailureStage(source.failureStage)
        : "developer_account",
    failureClass: success
      ? "unknown"
      : isPresent
        ? sanitizeDeveloperAccountFailureClass(source.failureClass)
        : "developer_result_missing",
    browserAlive: source.browserAlive === true,
    browserPreserved: source.browserPreserved === true,
    browserPreservationRequested: source.browserPreservationRequested === true,
  };
}

function sanitizeAccountModule(accountModule) {
  const source = accountModule && typeof accountModule === "object" ? accountModule : {};
  return {
    attempted: source.attempted === true,
    skipped: source.skipped === true,
    skipReason: ACCOUNT_MODULE_SKIP_REASONS.has(source.skipReason)
      ? source.skipReason
      : "unknown",
    membershipGateEnabled: source.membershipGateEnabled === true,
    membershipGatePassed: source.membershipGatePassed === true,
  };
}

function isIntentionalDeveloperMembershipGateStop(result) {
  const source = result && typeof result === "object" ? result : {};
  const developerAccount = sanitizePostLoginDeveloperAccount(
    source.postLoginDeveloperAccount
  );
  const accountModule = sanitizeAccountModule(source.accountModule);
  const profileCapture = sanitizePostLoginProfileCapture(
    source.postLoginProfileCapture
  );
  return (
    source.success === true &&
    accountModule.attempted === false &&
    accountModule.skipped === true &&
    accountModule.skipReason === "developer_membership_gate" &&
    accountModule.membershipGateEnabled === true &&
    accountModule.membershipGatePassed === false &&
    developerAccount.authenticated === true &&
    profileCapture.success === false &&
    profileCapture.failureClass === "developer_membership_gate"
  );
}

function hasConfirmedAccountHome(result) {
  const browserLogin = sanitizeBrowserLoginMetadata(result?.browserLogin);
  return (
    browserLogin.success === true &&
    browserLogin.backend === "ruyipage" &&
    browserLogin.accountHomeConfirmed === true
  );
}

function sanitizePostLoginFinalization(finalization) {
  if (!finalization || typeof finalization !== "object") return null;
  const source = finalization;
  const finalizationClass = sanitizePostLoginFinalizationClass(source.finalizationClass);
  const classRequiresPartial = finalizationClassRequiresPartial(finalizationClass);
  const backendCleanupCompleted =
    source.backendCleanupCompleted !== false && finalizationClass !== "backend_cleanup_failed";
  const collectorDisposed =
    source.collectorDisposed !== false && finalizationClass !== "collector_dispose_failed";
  const browserFinalizationCompleted =
    source.browserFinalizationCompleted === true &&
    finalizationClass !== "browser_connection_lost" &&
    finalizationClass !== "browser_quit_failed";
  const browserPreservationRequested = source.browserPreservationRequested === true;
  const browserSessionPreserved = source.browserSessionPreserved === true;
  const browserPreservationSatisfied =
    !browserPreservationRequested || browserSessionPreserved;
  return {
    success:
      !classRequiresPartial &&
      backendCleanupCompleted &&
      collectorDisposed &&
      browserFinalizationCompleted &&
      browserPreservationSatisfied,
    backendCleanupCompleted,
    collectorDisposed,
    browserFinalizationCompleted,
    browserPreservationRequested,
    browserSessionPreserved,
    finalizationClass,
  };
}

function sanitizeBrowserFinalizationStatus(event) {
  return {
    browserFinalizationCompleted: event?.browserFinalizationCompleted === true,
    browserPreservationRequested: event?.browserPreservationRequested === true,
    browserSessionPreserved: event?.browserSessionPreserved === true,
    finalizationClass: sanitizePostLoginFinalizationClass(event?.finalizationClass),
  };
}

function safeRunnerFailureAuditDetails(failureCode, failureStage, runnerContext) {
  return {
    failureCode,
    failureStage,
    runnerStage: runnerContext.stage,
    twoFaPhase: runnerContext.twoFaPhase,
    twoFaGeneration: runnerContext.generation,
    codeDeliveryAttempted: runnerContext.codeDeliveryAttempted,
    codeDeliverySent: runnerContext.codeDeliverySent,
    codeDeliveryAcknowledged: runnerContext.codeDeliveryAcknowledged,
    codeDeliveryWriteStarted: runnerContext.codeDeliveryWriteStarted,
    codeDeliveryWriteCompleted: runnerContext.codeDeliveryWriteCompleted,
    browserLaunchObserved: runnerContext.browserLaunchObserved,
    accountHomeConfirmed: runnerContext.accountHomeConfirmed,
    browserPreserved: runnerContext.browserPreserved,
    browserSessionPreserved: runnerContext.browserSessionPreserved,
    browserFinalizationCompleted: runnerContext.browserFinalizationCompleted,
    browserPreservationRequested: runnerContext.browserPreservationRequested,
    directBrowserPreservationRequested:
      runnerContext.directBrowserPreservationRequested,
    directPostLoginRecoveryEligible:
      runnerContext.directPostLoginRecoveryEligible,
    browserErrorClass: runnerContext.browserErrorClass,
    backendExitCode: runnerContext.backendExitCode,
    cleanupFailed: runnerContext.cleanupFailed,
  };
}

function canReturnPostLoginRunnerPartial(failureCode, runnerContext) {
  return (
    runnerContext.accountHomeConfirmed === true &&
    runnerContext.directPostLoginRecoveryEligible === true &&
    POST_LOGIN_RUNNER_PARTIAL_CODES.has(failureCode)
  );
}

function createPostLoginRunnerPartialResult(failureCode, failureStage, runnerContext) {
  // A generic failure-preservation event is not proof that the authenticated
  // account session is still available. Only a session-preservation status
  // may be reported as a retained post-login browser.
  const browserPreserved = runnerContext.browserSessionPreserved;
  const browserPreservationRequested =
    runnerContext.browserPreservationRequested ||
    runnerContext.directBrowserPreservationRequested;
  return {
    success: true,
    browserLogin: {
      success: true,
      backend: "ruyipage",
      accountHomeConfirmed: true,
    },
    postLoginProfileCapture: {
      success: false,
      failureStage,
      failureClass: "runner_post_login_failed",
      browserAlive: false,
      browserPreserved,
      browserPreservationRequested,
    },
    postLoginPasswordChange: {
      success: false,
      attempted: false,
      passwordStored: false,
      passwordLength: 0,
      failureStage,
      failureClass: "runner_post_login_failed",
      browserAlive: false,
      browserPreserved,
      browserPreservationRequested,
    },
    postLoginSmallBusinessApplication: {
      success: false,
      attempted: false,
      submitted: false,
      failureStage,
      failureClass: "runner_post_login_failed",
      browserAlive: false,
      browserPreserved,
      browserPreservationRequested,
    },
    postLoginFinalization: {
      backendCleanupCompleted:
        runnerContext.cleanupFailed !== true && failureCode !== "backend_cleanup",
      collectorDisposed: true,
      browserFinalizationCompleted: runnerContext.browserFinalizationCompleted,
      browserPreservationRequested,
      browserSessionPreserved: runnerContext.browserSessionPreserved,
      finalizationClass: "runner_post_login_failed",
    },
    personalInfo: {},
    screenshots: {},
  };
}

function sanitizeAccountBrowserBackendResult(result) {
  const source = result && typeof result === "object" ? result : {};
  const personalInfo = source.personalInfo && typeof source.personalInfo === "object"
    ? source.personalInfo
    : {};
  return {
    success: source.success === true,
    browserLogin: sanitizeBrowserLoginMetadata(source.browserLogin),
    postLoginProfileCapture: sanitizePostLoginProfileCapture(
      source.postLoginProfileCapture
    ),
    postLoginDeveloperAccount: sanitizePostLoginDeveloperAccount(
      source.postLoginDeveloperAccount
    ),
    postLoginPasswordChange: sanitizePostLoginPasswordChange(
      source.postLoginPasswordChange
    ),
    postLoginSmallBusinessApplication: sanitizePostLoginSmallBusinessApplication(
      source.postLoginSmallBusinessApplication
    ),
    postLoginFinalization: sanitizePostLoginFinalization(
      source.postLoginFinalization
    ),
    accountModule: sanitizeAccountModule(source.accountModule),
    personalInfo: {
      name: personalInfo.name,
      birthday: personalInfo.birthday,
    },
    screenshots: sanitizeScreenshotMetadata(source.screenshots),
  };
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
  if (event.event === "runner_lifecycle") {
    writeFlowAudit(flowAudit, "ruyipage_runner", "lifecycle", sanitizeRunnerLifecycle(event));
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
      details.previousStage = sanitizeBrowserFailureStage(event.previousStage);
      details.transition = sanitizeStageTransition(event.transition);
    }
    if (event.status === "browser_preserved") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
      details.preserved = event.preserved === true;
    }
    if (event.status === "browser_session_preserved") {
      details.preserved = event.preserved === true;
      details.profileCaptureSuccess = event.profileCaptureSuccess === true;
    }
    if (event.status === "browser_finalization_started") {
      details.browserPreservationRequested = event.browserPreservationRequested === true;
    }
    if (
      event.status === "browser_finalization_completed" ||
      event.status === "browser_finalization_partial"
    ) {
      Object.assign(details, sanitizeBrowserFinalizationStatus(event));
    }
    if (event.status === "screenshot_capture" || event.status === "screenshot_failed") {
      details.checkpoint = sanitizeScreenshotCheckpoint(event.checkpoint);
    }
    if (event.status === "account_home_confirmed") {
      details.accountHomeConfirmed = true;
    }
    if (event.status === "twofa_progress") {
      details.phase = sanitizeTwoFactorProgressPhase(event.phase);
      details.generation = sanitizeTwoFactorGeneration(event.generation);
      if (event.targetCount === 1 || event.targetCount === 6) {
        details.targetCount = event.targetCount;
      }
      if (typeof event.submitted === "boolean") details.submitted = event.submitted;
    }
    if (event.status === "browser_observation") {
      Object.assign(details, sanitizeBrowserObservation(event));
    }
    if (event.status === "profile_capture_readiness") {
      Object.assign(details, sanitizeProfileCaptureReadiness(event));
    }
    if (event.status === "profile_capture_failed") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
      details.failureClass = sanitizeProfileCaptureFailureClass(event.failureClass);
      details.browserAlive = event.browserAlive === true;
      details.browserPreservationRequested =
        event.browserPreservationRequested === true;
    }
    if (event.status === "profile_name_modal_cleanup_failed") {
      details.failureClass = sanitizeProfileNameModalCleanupFailureClass(
        event.failureClass
      );
      details.closeSearchScope = sanitizeProfileNameModalCloseSearchScope(
        event.closeSearchScope
      );
    }
    if (event.status === "profile_name_modal_unavailable") {
      details.attemptCount = sanitizeProfileNameModalUnavailableAttemptCount(
        event.attemptCount
      );
      details.outcome = sanitizeProfileNameModalUnavailableOutcome(event.outcome);
    }
    if (event.status === "password_change_form_ready") {
      details.fieldCount = event.fieldCount === 3 ? 3 : 0;
    }
    if (event.status === "password_change_completed") {
      details.passwordLength = sanitizePasswordLength(event.passwordLength);
    }
    if (event.status === "password_change_failed") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
      details.failureClass = sanitizePasswordChangeFailureClass(event.failureClass);
    }
    if (event.status === "small_business_associated_accounts_answered") {
      details.answerCount = sanitizeSmallBusinessAnswerCount(event.answerCount);
    }
    if (event.status === "small_business_application_failed") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
      details.failureClass = sanitizeSmallBusinessApplicationFailureClass(
        event.failureClass
      );
      details.submitted = event.submitted === true;
    }
    if (event.status === "developer_membership_checked") {
      details.membershipStatus = sanitizeDeveloperMembershipStatus(
        event.membershipStatus
      );
    }
    if (event.status === "developer_membership_probe") {
      Object.assign(details, sanitizeDeveloperMembershipProbe(event));
    }
    if (event.status === "developer_account_failed") {
      details.failureStage = sanitizeBrowserFailureStage(event.failureStage);
      details.failureClass = sanitizeDeveloperAccountFailureClass(
        event.failureClass
      );
      details.authenticated = event.authenticated === true;
      details.membershipStatus = sanitizeDeveloperMembershipStatus(
        event.membershipStatus
      );
    }
    if (event.status === "developer_membership_gate_blocked") {
      details.membershipStatus = sanitizeDeveloperMembershipStatus(
        event.membershipStatus
      );
      details.gateEnabled = event.gateEnabled === true;
      details.developerResultSucceeded = event.developerResultSucceeded === true;
    }
    if (
      event.status.startsWith("profile_navigation_") ||
      event.status.startsWith("profile_reauthentication_") ||
      event.status.startsWith("account_security_navigation_")
    ) {
      details.attempt = event.attempt === 1 || event.attempt === 2 ? event.attempt : 0;
      if (Object.hasOwn(event, "route")) {
        details.route = sanitizeProfileNavigationRoute(event.route);
      }
      if (Object.hasOwn(event, "after")) {
        details.after = sanitizeProfileNavigationFallback(event.after);
      }
    } else if (Number.isInteger(event.attempt)) {
      details.attempt = event.attempt;
    }
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
      generation: sanitizeTwoFactorGeneration(event.generation),
      state: sanitizeTwoFactorPageState(event.state),
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
    const accountModule = sanitizeAccountModule(event.accountModule);
    const passwordChange = sanitizePostLoginPasswordChange(
      event.postLoginPasswordChange
    );
    const smallBusinessApplication = sanitizePostLoginSmallBusinessApplication(
      event.postLoginSmallBusinessApplication
    );
    const resultFailureStage = firstKnownBrowserFailureStage(
      event.failureStage,
      event.postLoginProfileCapture?.failureStage,
      event.postLoginPasswordChange?.failureStage,
      event.postLoginSmallBusinessApplication?.failureStage,
      event.postLoginDeveloperAccount?.failureStage
    );
    writeFlowAudit(flowAudit, "ruyipage", "result", {
      success: event.success === true,
      failureStage: resultFailureStage,
      accountHomeConfirmed:
        event.browserLogin?.accountHomeConfirmed === true,
      profileCaptureSuccess: event.postLoginProfileCapture?.success === true,
      passwordChangeSuccess: passwordChange.success,
      passwordStored: passwordChange.passwordStored,
      passwordLength: passwordChange.passwordLength,
      smallBusinessApplicationSuccess: smallBusinessApplication.success,
      smallBusinessApplicationSubmitted: smallBusinessApplication.submitted,
      developerAccountSuccess:
        event.postLoginDeveloperAccount?.success === true,
      developerMembershipStatus: sanitizeDeveloperMembershipStatus(
        event.postLoginDeveloperAccount?.membershipStatus
      ),
      accountModuleAttempted: accountModule.attempted,
      accountModuleSkipped: accountModule.skipped,
      accountModuleSkipReason: accountModule.skipReason,
      membershipGateEnabled: accountModule.membershipGateEnabled,
      membershipGatePassed: accountModule.membershipGatePassed,
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
  { creds, reportDir, flowAudit = null, runId = "standalone" },
  runtime = {}
) {
  const getEnvironmentSummary =
    runtime.getBrowserEnvironmentSummary ?? getBrowserEnvironmentSummary;
  const checkAccessibility = runtime.isAccessibilityGranted ?? isAccessibilityGranted;
  const createRunner =
    runtime.createRuyiPageBackendRunner ?? createRuyiPageBackendRunner;
  const createCollector = runtime.createMac2FACollector ?? createMac2FACollector;
  const saveProfile = runtime.saveAppleProfileToEnv ?? saveAppleProfileToEnv;
  const savePassword = runtime.saveApplePasswordToEnv ?? saveApplePasswordToEnv;
  const saveMembership =
    runtime.saveDeveloperMembershipToEnv ?? saveDeveloperMembershipToEnv;
  const shouldPrintProfile = runtime.shouldPrintCapturedProfile ?? shouldPrintCapturedProfile;
  const showTerminalDebug =
    typeof runtime.isTerminalDebugEnabled === "function"
      ? runtime.isTerminalDebugEnabled()
      : shouldMirrorTerminalDiagnostics();

  const summary = getEnvironmentSummary();
  writeFlowAudit(flowAudit, "account_browser", "environment", {
    backend: summary.backend,
    backendReason: summary.backendReason,
    warnings: summary.warnings,
  });
  console.log(`[→] 浏览器自动化：${summary.backend}`);
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
    console.warn("[!] 辅助功能未授权，系统设置取码可能失败");
  }

  const collector = createCollector({
    timeoutMs: TWO_FACTOR_TIMEOUT_MS,
    reportDir,
    runId,
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
  let collectorDisposed = true;
  let lastFailureStage = "unknown";
  let reportedFailureStage = null;
  let reportedProfilePartial = false;
  let reportedFinalizationPartial = false;
  let reportedDeveloperMembershipGateStop = false;
  let developerMembershipPersistenceAttempted = false;
  let passwordChangePersistence = {
    attempted: false,
    passwordStored: false,
    passwordLength: 0,
    failureClass: "password_change_not_attempted",
  };
  let developerAccount = {
    checked: false,
    membershipStatus: "unknown",
    membershipStored: false,
  };
  const persistDeveloperMembership = (
    membershipStatus,
    checked,
    registrationIdentityValue = null
  ) => {
    if (developerMembershipPersistenceAttempted) return developerAccount;

    developerMembershipPersistenceAttempted = true;
    const normalizedMembershipStatus = sanitizeDeveloperMembershipStatus(membershipStatus);
    developerAccount = {
      checked: checked === true,
      membershipStatus: normalizedMembershipStatus,
      membershipStored: false,
    };
    try {
      developerAccount = {
        ...saveDeveloperMembership(
          normalizedMembershipStatus,
          registrationIdentityValue,
          flowAudit,
          saveMembership,
          shouldPrintProfile()
        ),
        checked: checked === true,
      };
    } catch (error) {
      writeFlowAuditError(
        flowAudit,
        "developer_account",
        "membership_persistence_failed",
        error,
        { membershipStatus: normalizedMembershipStatus }
      );
    }
    return developerAccount;
  };
  const reportDeveloperMembershipGateStop = (membershipStatus) => {
    if (reportedDeveloperMembershipGateStop) return;

    reportedDeveloperMembershipGateStop = true;
    if (sanitizeDeveloperMembershipStatus(membershipStatus) === "not_enrolled") {
      console.log("[✓] Developer 未满足资格，Account 已跳过");
    } else {
      console.warn("[!] Developer 会员状态未确认，Account 已跳过");
    }
  };
  const reportedTerminalProgress = new Set();
  const reportTerminalProgress = (key, message) => {
    if (reportedTerminalProgress.has(key)) return;
    reportedTerminalProgress.add(key);
    console.log(message);
  };
  try {
    console.log("[→] 正在启动 Firefox 浏览器");
    if (showTerminalDebug) console.log("[ruyipage] status:runtime_resolving");
    writeFlowAudit(flowAudit, "ruyipage", "runtime_resolving");
    const runner = createRunner({ sanitizeResult: sanitizeAccountBrowserBackendResult });
    if (showTerminalDebug) console.log("[ruyipage] status:backend_starting");
    writeFlowAudit(flowAudit, "ruyipage", "backend_starting");
    result = sanitizeAccountBrowserBackendResult(await runner.run({
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
        const runnerLifecycleLine = runnerLifecycleStatusLine(event);
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
        if (event.event === "status" && event.status === "developer_membership_checked") {
          persistDeveloperMembership(
            event.membershipStatus,
            true,
            event.registrationIdentityValue
          );
        } else if (
          event.event === "status" &&
          event.status === "developer_account_failed" &&
          event.authenticated === true
        ) {
          persistDeveloperMembership("unknown", false);
        }
        if (
          event.event === "status" &&
          event.status === "password_change_completed" &&
          passwordChangePersistence.passwordStored !== true
        ) {
          reportTerminalProgress(
            "password-change:completed",
            "[✓] Apple 账户密码已更改"
          );
          try {
            passwordChangePersistence = {
              ...passwordChangePersistence,
              ...saveRotatedApplePassword(event, flowAudit, savePassword),
              failureClass: "unknown",
            };
          } catch (error) {
            passwordChangePersistence = {
              attempted: true,
              passwordStored: false,
              passwordLength: sanitizePasswordLength(event.passwordLength),
              failureClass: "password_persistence_failed",
            };
            writeFlowAuditError(
              flowAudit,
              "account_browser",
              "password_persistence_failed",
              error,
              {
                passwordLength: passwordChangePersistence.passwordLength,
                passwordStored: false,
              }
            );
            console.warn(
              "[!] 新密码已在网页确认，但写入 .env 失败，详情已写入日志"
            );
          }
        }
        if (event.event === "ready") {
          console.log("[✓] Firefox 浏览器已就绪");
          if (showTerminalDebug) {
            console.log(`[ruyipage] ready:mode:${sanitizeReadyMode(event.mode)}`);
          }
        } else if (
          event.event === "status" &&
          RUYIPAGE_STARTUP_STATUSES.has(event.status)
        ) {
          if (showTerminalDebug) console.log(`[ruyipage] status:${event.status}`);
        } else if (inputStatusLine) {
          if (showTerminalDebug) console.log(`[ruyipage] status:${inputStatusLine}`);
        } else if (twoFactorHandoffLine) {
          if (showTerminalDebug) console.log(`[ruyipage] status:${twoFactorHandoffLine}`);
          const phase =
            event.event === "status" && event.status === "twofa_progress"
              ? sanitizeTwoFactorProgressPhase(event.phase)
              : "unknown";
          if (Object.hasOwn(RUYIPAGE_TWO_FACTOR_PROGRESS_MESSAGES, phase)) {
            const message = RUYIPAGE_TWO_FACTOR_PROGRESS_MESSAGES[phase];
            if (phase === "trust_prompt_detected" || phase === "trust_click_sent") {
              reportTerminalProgress(
                phase === "trust_click_sent" ? "developer-trust:click" : "developer-trust:prompt",
                message
              );
            } else {
              console.log(message);
            }
          }
        } else if (runnerLifecycleLine) {
          if (showTerminalDebug) console.log(`[ruyipage] status:${runnerLifecycleLine}`);
        } else if (
          event.event === "status" &&
          event.status === "developer_account_authentication_started"
        ) {
          console.log("[→] 正在登录 Apple Developer");
        } else if (
          event.event === "status" &&
          event.status === "developer_account_authenticated"
        ) {
          console.log("[✓] Apple Developer 登录成功，正在检查会员资格");
        } else if (
          event.event === "status" &&
          event.status === "developer_membership_probe"
        ) {
          const probe = sanitizeDeveloperMembershipProbe(event);
          if (showTerminalDebug) {
            console.log(
              `[ruyipage] membership:route:${probe.routeMatched ? 1 : 0}:auth_blocked:${probe.authBlocked ? 1 : 0}:details:${probe.detailsPage ? 1 : 0}:program:${probe.appleDeveloperProgram ? 1 : 0}:renewal:${probe.renewalDate ? 1 : 0}:identity:${probe.registrationIdentity ? 1 : 0}:team:${probe.teamId ? 1 : 0}:fields:${probe.membershipFieldCount}:stable:${probe.stableCount}`
            );
          }
          if (probe.routeMatched) {
            reportTerminalProgress(
              "developer-membership:details",
              "[→] 已到达会员资格详细信息，正在核验计划、续订日期和注册身份"
            );
          }
          if (
            probe.detailsPage &&
            probe.appleDeveloperProgram &&
            probe.renewalDate &&
            probe.registrationIdentity
          ) {
            reportTerminalProgress(
              "developer-membership:evidence",
              "[✓] MembershipDetailsCard 已读取，正在确认会员资格"
            );
          }
        } else if (
          event.event === "status" &&
          event.status === "developer_account_failed" &&
          event.authenticated !== true
        ) {
          console.warn("[×] Apple Developer 登录未完成，Account 阶段未启动");
        } else if (event.event === "status" && event.status === "browser_stage") {
          const stage = sanitizeBrowserFailureStage(event.stage);
          if (showTerminalDebug) {
            console.log(
              `[ruyipage] stage:${stage}:from:${sanitizeBrowserFailureStage(
                event.previousStage
              )}:transition:${sanitizeStageTransition(event.transition)}`
            );
          }
          if (Object.hasOwn(RUYIPAGE_BROWSER_STAGE_PROGRESS_MESSAGES, stage)) {
            reportTerminalProgress(
              `browser-stage:${stage}`,
              RUYIPAGE_BROWSER_STAGE_PROGRESS_MESSAGES[stage]
            );
          }
        } else if (
          event.event === "status" &&
          event.status === "profile_capture_readiness"
        ) {
          if (showTerminalDebug) {
            const readiness = sanitizeProfileCaptureReadiness(event);
            console.log(
              `[ruyipage] profile:route:${readiness.routeConfirmed ? 1 : 0}:state:${readiness.stateReadable ? 1 : 0}:auth_blocked:${readiness.authenticationBlocked ? 1 : 0}:name_cards:${readiness.nameCardCount}:birthday_cards:${readiness.birthdayCardCount}:birthday_ready:${readiness.birthdayValueReady ? 1 : 0}:same_card:${readiness.sameCardIdentity ? 1 : 0}:outcome:${readiness.snapshotOutcome}:stable:${readiness.stableObservations}`
            );
          }
        } else if (event.event === "status" && event.status === "browser_observation") {
          if (showTerminalDebug) {
            const observation = sanitizeBrowserObservation(event);
            console.log(
              `[ruyipage] observation:${observation.checkpoint}:generation:${observation.generation}:page:${observation.pageKind}:session:${observation.sessionConfirmed ? 1 : 0}:home:${observation.accountHomeConfirmed ? 1 : 0}:alive:${observation.connectionAlive ? 1 : 0}:inspection_available:${observation.inspectionAvailable ? 1 : 0}:twofa:${observation.twofaVisible ? 1 : 0}:trust_prompt:${observation.trustPrompt ? 1 : 0}:input:${observation.inputReady ? 1 : 0}:cells:${observation.codeInputCount}:auth_error:${observation.authenticationError ? 1 : 0}:root_manage:${observation.rootManageUrl ? 1 : 0}:root_marker:${observation.rootAccountMarker ? 1 : 0}:root_error:${observation.rootAuthenticationError ? 1 : 0}:root_security_copy:${observation.rootSecurityCopyOnly ? 1 : 0}:retiring_child:${observation.retiringChildError ? 1 : 0}:child_auth:${observation.childAuthUiPresent ? 1 : 0}`
            );
          }
        } else if (
          event.event === "status" &&
          (event.status === "screenshot_capture" || event.status === "screenshot_failed")
        ) {
          const checkpoint = sanitizeScreenshotCheckpoint(event.checkpoint);
          if (showTerminalDebug) {
            console.log(`[ruyipage] status:${event.status}:checkpoint:${checkpoint}`);
          }
          if (event.status === "screenshot_failed") {
            console.warn(
              checkpoint === "developer_membership"
                ? "[!] Apple Developer 会员详情截图保存失败，详情已写入日志"
                : "[!] 个人信息页面截图保存失败，详情已写入日志"
            );
          } else if (checkpoint === "account_information") {
            console.log("[✓] 已保存个人信息页面截图");
          } else if (checkpoint === "developer_membership") {
            console.log("[✓] 已保存 Apple Developer 会员详情截图");
          }
        } else if (event.event === "status" && event.status === "profile_capture_started") {
          console.log("[→] 正在打开个人信息页面");
        } else if (event.event === "status" && event.status === "profile_capture_completed") {
          console.log("[✓] 个人资料采集完成");
        } else if (event.event === "status" && event.status === "profile_capture_failed") {
          const stage = sanitizeBrowserFailureStage(event.failureStage);
          const failureClass = sanitizeProfileCaptureFailureClass(event.failureClass);
          reportedProfilePartial = true;
          console.warn(
            `[!] 个人资料采集未完成（阶段：${stage}，原因：${failureClass}），详情已写入日志`
          );
        } else if (
          event.event === "status" &&
          event.status === "password_change_failed"
        ) {
          const stage = sanitizeBrowserFailureStage(event.failureStage);
          const failureClass = sanitizePasswordChangeFailureClass(event.failureClass);
          console.warn(
            `[!] Apple 账户密码修改未完成（阶段：${stage}，原因：${failureClass}），详情已写入日志`
          );
        } else if (
          event.event === "status" &&
          event.status === "account_security_navigation_sign_in_redirect"
        ) {
          console.warn("[!] 登录与安全性页面要求重新登录，密码修改未继续");
        } else if (
          event.event === "status" &&
          event.status === "account_security_navigation_unconfirmed"
        ) {
          console.warn("[!] 登录与安全性页面未确认，密码修改未继续");
        } else if (event.event === "status" && event.status === "browser_finalization_started") {
          if (showTerminalDebug) {
            console.log(
              `[ruyipage] status:browser_finalization_started:preserve_requested:${event.browserPreservationRequested === true ? 1 : 0}`
            );
          }
        } else if (
          event.event === "status" &&
          (event.status === "browser_finalization_completed" ||
            event.status === "browser_finalization_partial")
        ) {
          const finalization = sanitizeBrowserFinalizationStatus(event);
          const output =
            `[ruyipage] status:${event.status}:completed:${
              finalization.browserFinalizationCompleted ? 1 : 0
            }:preserve_requested:${
              finalization.browserPreservationRequested ? 1 : 0
            }:preserved:${finalization.browserSessionPreserved ? 1 : 0}:class:${
              finalization.finalizationClass
            }`;
          if (showTerminalDebug) console.log(output);
          if (event.status === "browser_finalization_partial") {
            reportedFinalizationPartial = true;
            console.warn("[!] 浏览器收尾未完全完成，详情已写入日志");
          }
        } else if (
          event.event === "status" &&
          event.status === "developer_membership_gate_blocked"
        ) {
          reportDeveloperMembershipGateStop(event.membershipStatus);
        } else if (
          event.event === "status" &&
          Object.hasOwn(RUYIPAGE_PROFILE_STATUS_MESSAGES, event.status)
        ) {
          console.log(RUYIPAGE_PROFILE_STATUS_MESSAGES[event.status]);
        } else if (event.event === "status" && event.status === "browser_preserved") {
          if (event.preserved === true) {
            console.warn("[!] 流程未完成，Firefox 已保留供核对");
          } else {
            console.warn("[!] Firefox 保留状态未确认");
          }
        } else if (
          event.event === "status" &&
          event.status === "browser_failure" &&
          eventFailureStage !== "unknown"
        ) {
          if (eventFailureStage !== reportedFailureStage) {
            reportedFailureStage = eventFailureStage;
            if (showTerminalDebug) {
              console.log(`[ruyipage] status:failure:${eventFailureStage}`);
            }
            console.log(`[×] 浏览器流程失败（阶段：${eventFailureStage}）`);
          }
        } else if (
          event.event === "result" &&
          event.success === false &&
          eventFailureStage !== "unknown"
        ) {
          if (eventFailureStage !== reportedFailureStage) {
            reportedFailureStage = eventFailureStage;
            if (showTerminalDebug) {
              console.log(`[ruyipage] status:failure:${eventFailureStage}`);
            }
            console.log(`[×] 浏览器流程失败（阶段：${eventFailureStage}）`);
          }
        } else if (event.event === "warning") {
          console.warn("[!] 浏览器后端报告异常，详情已写入日志");
        } else if (event.event === "prepare_2fa") {
          console.log("[→] 正在准备 Apple 验证码监听");
        } else if (event.event === "need_2fa") {
          console.log("[→] 正在获取 Apple 验证码");
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
    }));
  } catch (error) {
    runError = error;
    const failureCode = classifyBrowserRunFailure(error);
    const runnerContext = readRunnerFailureContext(error);
    const failureStage = sanitizeBrowserFailureStage(
      lastFailureStage === "unknown" ? runnerContext.stage : lastFailureStage
    );
    if (canReturnPostLoginRunnerPartial(failureCode, runnerContext)) {
      result = sanitizeAccountBrowserBackendResult(
        createPostLoginRunnerPartialResult(failureCode, failureStage, runnerContext)
      );
      runError = null;
      writeFlowAudit(flowAudit, "account_browser", "runner_post_login_partial", {
        ...safeRunnerFailureAuditDetails(failureCode, failureStage, runnerContext),
        finalizationClass: "runner_post_login_failed",
      });
      console.warn(
        `[!] 登录已成功，后续浏览器处理未完成（阶段：${failureStage}，原因：${failureCode}）`
      );
    } else {
      writeFlowAuditError(
        flowAudit,
        "account_browser",
        "runner_failed",
        error,
        safeRunnerFailureAuditDetails(failureCode, failureStage, runnerContext)
      );
      if (runnerContext.accountHomeConfirmed) markBrowserAccountHomeConfirmed(error);
      throw annotateBrowserRunFailure(error, null, failureStage);
    }
  } finally {
    try {
      await collector.dispose();
      writeFlowAudit(flowAudit, "two_factor", "collector_disposed");
    } catch (error) {
      collectorDisposed = false;
      writeFlowAuditError(flowAudit, "two_factor", "collector_dispose_failed", error);
      const accountHomeConfirmed = hasConfirmedAccountHome(result);
      const intentionalGateStop = isIntentionalDeveloperMembershipGateStop(result);
      if (!runError && !accountHomeConfirmed && !intentionalGateStop) {
        throw annotateBrowserRunFailure(error, "collector_cleanup", lastFailureStage);
      }
      if (accountHomeConfirmed || intentionalGateStop) {
        writeFlowAudit(flowAudit, "two_factor", "collector_dispose_partial", {
          accountHomeConfirmed,
          intentionalGateStop,
        });
        if (!reportedFinalizationPartial) {
          reportedFinalizationPartial = true;
          console.warn("[!] 登录已成功，验证码监听器收尾未完全完成，详情已写入日志");
        }
      } else {
        console.warn("[×] 验证码监听器收尾失败");
      }
    }
  }

  const postLoginDeveloperAccount = sanitizePostLoginDeveloperAccount(
    result.postLoginDeveloperAccount
  );
  const accountModule = sanitizeAccountModule(result.accountModule);
  const developerResultReported =
    postLoginDeveloperAccount.success ||
    postLoginDeveloperAccount.failureClass !== "developer_result_missing";
  if (developerResultReported && postLoginDeveloperAccount.authenticated) {
    if (!postLoginDeveloperAccount.success) {
      writeFlowAudit(flowAudit, "developer_account", "partial", {
        failureStage: postLoginDeveloperAccount.failureStage,
        failureClass: postLoginDeveloperAccount.failureClass,
        authenticated: postLoginDeveloperAccount.authenticated,
        membershipStatus: postLoginDeveloperAccount.membershipStatus,
      });
    }
    persistDeveloperMembership(
      postLoginDeveloperAccount.membershipStatus,
      postLoginDeveloperAccount.success
    );
  }

  const accountHomeConfirmed = hasConfirmedAccountHome(result);
  const developerAuthenticationResultPresent =
    postLoginDeveloperAccount.failureClass !== "developer_result_missing";
  const unauthenticatedDeveloperAdvancedPastBoundary =
    developerAuthenticationResultPresent &&
    postLoginDeveloperAccount.authenticated !== true &&
    (accountHomeConfirmed ||
      accountModule.attempted === true ||
      (accountModule.skipped === true &&
        accountModule.skipReason === "developer_membership_gate"));
  if (unauthenticatedDeveloperAdvancedPastBoundary) {
    writeFlowAudit(flowAudit, "developer_account", "authentication_unconfirmed", {
      failureStage: postLoginDeveloperAccount.failureStage,
      failureClass: postLoginDeveloperAccount.failureClass,
      accountModuleAttempted: accountModule.attempted,
      accountModuleSkipped: accountModule.skipped,
      accountHomeConfirmed,
    });
    throw annotateBrowserRunFailure(
      new Error("Developer authentication was not confirmed before Account module"),
      null,
      postLoginDeveloperAccount.failureStage
    );
  }
  const intentionalGateStop = isIntentionalDeveloperMembershipGateStop(result);
  if (!accountHomeConfirmed && !intentionalGateStop) {
    writeFlowAudit(flowAudit, "account_browser", "account_home_unconfirmed");
    throw annotateBrowserRunFailure(
      new Error("ruyipage backend did not confirm the authenticated Apple account home"),
      null,
      lastFailureStage
    );
  }

  if (accountHomeConfirmed) {
    writeFlowAudit(flowAudit, "account_browser", "account_home_confirmed");
  }

  let postLoginProfileCapture = sanitizePostLoginProfileCapture(
    result.postLoginProfileCapture
  );
  let postLoginPasswordChange = sanitizePostLoginPasswordChange(
    result.postLoginPasswordChange
  );
  let postLoginSmallBusinessApplication =
    sanitizePostLoginSmallBusinessApplication(
      result.postLoginSmallBusinessApplication
    );
  if (postLoginPasswordChange.success) {
    if (passwordChangePersistence.passwordStored === true) {
      postLoginPasswordChange = {
        ...postLoginPasswordChange,
        passwordStored: true,
        passwordLength:
          passwordChangePersistence.passwordLength ||
          postLoginPasswordChange.passwordLength,
      };
      writeFlowAudit(flowAudit, "account_browser", "password_change_completed", {
        passwordLength: postLoginPasswordChange.passwordLength,
        passwordStored: true,
      });
    } else {
      const failureClass =
        passwordChangePersistence.failureClass === "password_persistence_failed"
          ? "password_persistence_failed"
          : "password_persistence_missing";
      postLoginPasswordChange = {
        ...postLoginPasswordChange,
        success: false,
        attempted: true,
        passwordStored: false,
        passwordLength:
          passwordChangePersistence.passwordLength ||
          postLoginPasswordChange.passwordLength,
        failureStage: "password_change",
        failureClass,
      };
      writeFlowAudit(flowAudit, "account_browser", "password_change_partial", {
        passwordLength: postLoginPasswordChange.passwordLength,
        passwordStored: false,
        failureStage: postLoginPasswordChange.failureStage,
        failureClass: postLoginPasswordChange.failureClass,
      });
      if (failureClass === "password_persistence_missing") {
        console.warn(
          "[!] 新密码网页确认事件未完成本地持久化，详情已写入日志"
        );
      }
    }
  } else if (postLoginPasswordChange.attempted) {
    writeFlowAudit(flowAudit, "account_browser", "password_change_partial", {
      passwordLength: postLoginPasswordChange.passwordLength,
      passwordStored: postLoginPasswordChange.passwordStored,
      failureStage: postLoginPasswordChange.failureStage,
      failureClass: postLoginPasswordChange.failureClass,
    });
  }
  if (postLoginSmallBusinessApplication.success) {
    writeFlowAudit(flowAudit, "account_browser", "small_business_application_completed", {
      submitted: postLoginSmallBusinessApplication.submitted === true,
    });
  } else if (postLoginSmallBusinessApplication.attempted) {
    writeFlowAudit(flowAudit, "account_browser", "small_business_application_partial", {
      submitted: postLoginSmallBusinessApplication.submitted === true,
      failureStage: postLoginSmallBusinessApplication.failureStage,
      failureClass: postLoginSmallBusinessApplication.failureClass,
      browserAlive: postLoginSmallBusinessApplication.browserAlive,
      browserPreserved: postLoginSmallBusinessApplication.browserPreserved,
    });
    console.warn(
      `[!] 小开发者申请未完成（阶段：${postLoginSmallBusinessApplication.failureStage}，原因：${postLoginSmallBusinessApplication.failureClass}），详情已写入日志`
    );
  }
  let postLoginFinalization = sanitizePostLoginFinalization(
    result.postLoginFinalization
  );
  if (!collectorDisposed) {
    postLoginFinalization = {
      ...(postLoginFinalization ?? {
        backendCleanupCompleted: true,
        browserFinalizationCompleted: false,
        browserPreservationRequested: false,
        browserSessionPreserved: false,
      }),
      success: false,
      collectorDisposed: false,
      finalizationClass: "collector_dispose_failed",
    };
  }
  if (postLoginFinalization?.success === false) {
    writeFlowAudit(flowAudit, "account_browser", "post_login_finalization_partial", {
      ...postLoginFinalization,
    });
    if (!reportedFinalizationPartial) {
      console.warn(
        `[!] 浏览器收尾未完全完成（原因：${postLoginFinalization.finalizationClass}），详情已写入日志`
      );
    }
  }
  const partialProfileResult = () => ({
    browserLogin: sanitizeBrowserLoginMetadata(result.browserLogin),
    antiAutomation: { backend: "ruyipage", delegated: true },
    postLoginProfileCapture,
    postLoginDeveloperAccount,
    postLoginPasswordChange,
    postLoginSmallBusinessApplication,
    postLoginFinalization,
    accountModule,
    personalInfo: {
      collected: false,
      nameStored: false,
      birthdayStored: false,
    },
    developerAccount,
    screenshots: sanitizeScreenshotMetadata(result.screenshots),
  });

  if (intentionalGateStop) {
    writeFlowAudit(flowAudit, "account_browser", "developer_membership_gate_blocked", {
      membershipStatus: postLoginDeveloperAccount.membershipStatus,
      membershipGateEnabled: true,
      membershipGatePassed: false,
    });
    reportDeveloperMembershipGateStop(postLoginDeveloperAccount.membershipStatus);
    return partialProfileResult();
  }

  if (!postLoginProfileCapture.success) {
    writeFlowAudit(flowAudit, "account_browser", "profile_capture_partial", {
      ...postLoginProfileCapture,
    });
    if (!reportedProfilePartial) {
      console.warn(
        `[!] 个人资料采集未完成（阶段：${postLoginProfileCapture.failureStage}，原因：${postLoginProfileCapture.failureClass}），详情已写入日志`
      );
    }
    return partialProfileResult();
  }

  let capturedProfile;
  try {
    capturedProfile = normalizeCapturedProfile(result.personalInfo);
  } catch (error) {
    postLoginProfileCapture = {
      ...postLoginProfileCapture,
      success: false,
      failureStage: "profile_capture",
      failureClass: "profile_result_missing",
    };
    writeFlowAuditError(flowAudit, "account_browser", "profile_result_invalid", error, {
      ...postLoginProfileCapture,
    });
    console.warn("[!] 个人资料结果不完整，详情已写入日志");
    return partialProfileResult();
  }

  let personalInfo;
  try {
    personalInfo = saveCapturedProfile(
      capturedProfile,
      flowAudit,
      saveProfile,
      shouldPrintProfile()
    );
  } catch (error) {
    postLoginProfileCapture = {
      ...postLoginProfileCapture,
      success: false,
      failureStage: "profile_capture",
      failureClass: "profile_persistence_failed",
    };
    writeFlowAuditError(flowAudit, "account_browser", "profile_persistence_failed", error, {
      ...postLoginProfileCapture,
    });
    console.warn("[!] 个人资料写入 .env 失败，详情已写入日志");
    return partialProfileResult();
  }
  writeFlowAudit(flowAudit, "account_browser", "profile_persisted", {
    collected: true,
    nameStored: true,
    birthdayStored: true,
  });

  return {
    browserLogin: sanitizeBrowserLoginMetadata(result.browserLogin),
    antiAutomation: { backend: "ruyipage", delegated: true },
    postLoginProfileCapture,
    postLoginDeveloperAccount,
    postLoginPasswordChange,
    postLoginSmallBusinessApplication,
    postLoginFinalization,
    accountModule,
    personalInfo,
    developerAccount,
    screenshots: sanitizeScreenshotMetadata(result.screenshots),
  };
}
