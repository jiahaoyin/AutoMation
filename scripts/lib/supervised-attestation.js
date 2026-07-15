import crypto from "node:crypto";

export const SUPERVISED_ATTESTATION_VERSION = 1;
export const SUPERVISED_COMMAND_ID = "run-sh-skip-mac";
export const SUPERVISED_COMMAND = "./run.sh --skip-mac";
export const SUPERVISED_SUCCESS_MARKER = "[验收] REAL_ACCOUNT_HOME_CONFIRMED";
export const SUPERVISED_ACCEPTANCE_VALUE = "REAL_ACCOUNT_HOME_CONFIRMED";
export const SUPERVISED_ACCOUNT_MODE = "account";
export const SUPERVISED_SETTINGS_SMOKE_MODE = "settings_smoke";
export const SUPERVISED_MODES = new Set([
  SUPERVISED_ACCOUNT_MODE,
  SUPERVISED_SETTINGS_SMOKE_MODE,
]);
export const SUPERVISED_MODE_ENV_KEY = "APPLE_AUTOMATION_SUPERVISED_MODE";
export const SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER =
  "[验收] SETTINGS_2FA_TWICE_CONFIRMED";
export const SUPERVISED_SETTINGS_SMOKE_ACCEPTANCE_VALUE =
  "SETTINGS_2FA_TWICE_CONFIRMED";

export function supervisedSuccessMarkerForMode(mode) {
  if (!SUPERVISED_MODES.has(mode)) throw new Error("supervised mode is invalid");
  return mode === SUPERVISED_SETTINGS_SMOKE_MODE
    ? SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER
    : SUPERVISED_SUCCESS_MARKER;
}

export function supervisedAcceptanceValueForMode(mode) {
  if (!SUPERVISED_MODES.has(mode)) throw new Error("supervised mode is invalid");
  return mode === SUPERVISED_SETTINGS_SMOKE_MODE
    ? SUPERVISED_SETTINGS_SMOKE_ACCEPTANCE_VALUE
    : SUPERVISED_ACCEPTANCE_VALUE;
}
export const SUPERVISED_COMMAND_SHA256 = crypto
  .createHash("sha256")
  .update(SUPERVISED_COMMAND, "utf8")
  .digest("hex");

export const SUPERVISED_PRODUCTION_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "APPLE_AUTOMATION_REPORT_ROOT",
  "APPLE_AUTOMATION_ACCEPTANCE_MARKER",
  "APPLE_AUTOMATION_SUPERVISED_GUI",
  "APPLE_AUTOMATION_SUPERVISED_TOKEN",
  SUPERVISED_MODE_ENV_KEY,
  "APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE",
  "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
  "APPLE_AUTOMATION_SETTINGS_SMOKE",
  "FIREFOX_PROFILE_DIR",
  "BROWSER_PROFILE_MODE",
  "APPLE_AUTOMATION_HELPER_DIR",
  "SKIP_ENV_SETUP",
  "PYTHONDONTWRITEBYTECODE",
  "TERM_PROGRAM",
]);
export const SUPERVISED_PRODUCTION_ENV_POLICY = JSON.stringify(
  SUPERVISED_PRODUCTION_ENV_KEYS
);

export function createSupervisedProductionPermissionProfile(
  productionDir,
  nonce,
  mode = SUPERVISED_ACCOUNT_MODE
) {
  const value = String(productionDir ?? "");
  if (!value.startsWith("/") || /["\\\r\n\0]/.test(value)) {
    throw new Error("Supervised production directory is invalid");
  }
  if (!/^[0-9a-f]{32}$/.test(String(nonce ?? ""))) {
    throw new Error("Supervised production nonce is invalid");
  }
  if (!SUPERVISED_MODES.has(mode)) {
    throw new Error("Supervised production mode is invalid");
  }
  if (mode === SUPERVISED_SETTINGS_SMOKE_MODE) {
    return `{ extends = ":read-only", filesystem = { "${value}" = "write" } }`;
  }
  const socketPath = `/tmp/apple-automation-${nonce}.sock`;
  return `{ extends = ":read-only", filesystem = { "${value}" = "write", "${socketPath}" = "write" }, network = { enabled = true, domains = {}, unix_sockets = { "${socketPath}" = "allow" } } }`;
}

export function createMacVerificationPermissionProfile(runTmpDir, repository) {
  const writable = String(runTmpDir ?? "");
  const repo = String(repository ?? "");
  for (const value of [writable, repo]) {
    if (!value.startsWith("/") || /["\\\r\n\0]/.test(value)) {
      throw new Error("Mac verification permission path is invalid");
    }
  }
  return `{ extends = ":read-only", filesystem = { "${writable}" = "write", "${repo}/.env" = "deny", "~/.codex/auth.json" = "deny", "~/.ssh" = "deny", "~/.git-credentials" = "deny", "~/.netrc" = "deny", "~/.config/gh" = "deny" } }`;
}

export const SUPERVISED_STATUSES = new Set([
  "not_requested",
  "pending",
  "ready",
  "running",
  "accepted",
  "failed",
  "cancelled",
]);

export const SUPERVISED_FAILURE_CLASSES = new Set([
  "NONE",
  "BRIDGE_LAUNCH_FAILED",
  "BRIDGE_NOT_READY",
  "TRIGGER_INVALID",
  "TRIGGER_TIMEOUT",
  "CANCELLED",
  "PRODUCTION_TIMEOUT",
  "PRODUCTION_EXIT_NONZERO",
  "ACCESSIBILITY_PERMISSION_REQUIRED",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_BACKEND_START_FAILED",
  "BROWSER_BROKER_LAUNCH_FAILED",
  "BROWSER_BROKER_TRANSPORT_FAILED",
  "BROWSER_PROCESS_UNRESPONSIVE",
  "BROWSER_LAUNCH_FAILED",
  "BROWSER_URL_VALIDATION_FAILED",
  "BROWSER_PAGE_LOAD_FAILED",
  "BROWSER_EMAIL_STEP_FAILED",
  "BROWSER_PASSWORD_STEP_FAILED",
  "ACCOUNT_INFORMATION_FAILED",
  "TWO_FA_PAGE_FAILED",
  "TWO_FA_CODE_UNAVAILABLE",
  "TWO_FA_LOGIN_FAILED",
  "ACCEPTANCE_EVIDENCE_MISSING",
  "HEAD_MISMATCH",
  "GIT_DIRTY",
  "LOG_LIMIT_EXCEEDED",
  "PROCESS_CLEANUP_FAILED",
  "HELPER_COMPILE_FAILED",
  "SANDBOX_PREFLIGHT_FAILED",
  "INTERNAL_ERROR",
]);

export const SUPERVISED_TTY_CAPABILITIES = new Set([
  "unknown",
  "available",
  "unavailable",
]);

export const SUPERVISED_TWO_FA_DETAILS = new Set([
  "none",
  "manual_tty_unavailable",
  "manual_prompt_timeout",
  "automatic_code_unavailable",
]);

// These values are deliberately independent from helper output. The bridge only
// records them after observing fixed stdout/audit tokens or the fixed helper path.
export const SUPERVISED_SETTINGS_PROVIDER_STATES = new Set([
  "not_started",
  "request_created",
  "helper_spawned",
  "failed",
  "cancelled",
  "winner",
]);

export const SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS = new Set([
  "none",
  "accessibility_denied",
  "settings_timeout",
  "settings_invalid_output",
  "settings_invalid_code",
  "settings_output_limit",
  "settings_start_failed",
  "settings_unavailable",
  "settings_helper_exit",
  "settings_two_factor_not_found",
  "settings_alert_not_opened",
  "settings_alert_not_found",
  "settings_alert_cleanup_failed",
  "settings_ui_unavailable",
  "settings_provider_failed",
]);

export const SUPERVISED_STDOUT_STAGE_TOKENS = new Set([
  "launcher_entered",
  "launcher_bootstrap_started",
  "launcher_bootstrap_ready",
  "launcher_env_setup_started",
  "launcher_env_setup_ready",
  "launcher_env_setup_skipped",
  "launcher_preflight_started",
  "launcher_preflight_ready",
  "flow_main_started",
  "credentials_ready",
]);

export const SUPERVISED_PRODUCTION_STAGES = new Set([
  "not_started",
  ...SUPERVISED_STDOUT_STAGE_TOKENS,
  "accessibility_preflight",
  "accessibility_prompted",
  "accessibility_ready",
  "accessibility_missing",
  "two_fa_code_acquired",
  "two_fa_code_unavailable",
  "two_fa_code_pending",
  "browser_runtime_resolving",
  "browser_backend_starting",
  "browser_credentials_received",
  "browser_url_validated",
  "browser_runtime_imported",
  "browser_constructing",
  "browser_failure:not_started",
  "browser_failure:credentials_received",
  "browser_failure:url_validated",
  "browser_failure:runtime_importing",
  "browser_failure:runtime_imported",
  "browser_failure:browser_constructing",
  "browser_failure:browser_ready",
  "browser_failure:login_navigation",
  "browser_failure:login_page_loaded",
  "browser_failure:login_state_detected",
  "browser_failure:email_wait",
  "browser_failure:email_input",
  "browser_failure:email_submit",
  "browser_failure:password_wait",
  "browser_failure:password_input",
  "browser_failure:remember_account",
  "browser_failure:twofa_prepare",
  "browser_failure:password_submit",
  "browser_failure:twofa_page_wait",
  "browser_failure:twofa_code_wait",
  "browser_failure:twofa_input",
  "browser_failure:signed_in",
  "browser_failure:account_information",
]);

export const SUPERVISED_NODE_FAILURES = new Set([
  "none",
  "account_home_unconfirmed",
  "backend_cleanup",
  "backend_exit",
  "backend_failed",
  "backend_interrupted",
  "backend_stdin",
  "backend_timeout",
  "broker_connect",
  "broker_connect_timeout",
  "broker_eof",
  "broker_io",
  "collector_cleanup",
  "event_handler",
  "event_handler_timeout",
  "process_state",
  "two_fa_preparation",
  "two_fa_provider",
  "unknown",
]);

const ATTESTATION_REQUIRED_KEYS = [
  "version",
  "nonce",
  "expectedHead",
  "observedHeadBefore",
  "observedHeadAfter",
  "commandId",
  "commandSha256",
  "mode",
  "status",
  "exitCode",
  "markerConfirmed",
  "failureClass",
];
const ATTESTATION_OPTIONAL_KEYS = [
  "ttyCapability",
  "twoFaDetail",
  "productionStage",
  "nodeFailure",
  "settingsProviderState",
  "settingsProviderAttempt",
  "settingsProviderFailureReason",
];
const ATTESTATION_KEYS = new Set([
  ...ATTESTATION_REQUIRED_KEYS,
  ...ATTESTATION_OPTIONAL_KEYS,
]);

export function createSupervisedAttestation(values = {}) {
  return {
    version: SUPERVISED_ATTESTATION_VERSION,
    nonce: values.nonce ?? "",
    expectedHead: values.expectedHead ?? "",
    observedHeadBefore: values.observedHeadBefore ?? null,
    observedHeadAfter: values.observedHeadAfter ?? null,
    commandId: SUPERVISED_COMMAND_ID,
    commandSha256: SUPERVISED_COMMAND_SHA256,
    mode: values.mode ?? SUPERVISED_ACCOUNT_MODE,
    status: values.status ?? "pending",
    exitCode: values.exitCode ?? null,
    markerConfirmed: values.markerConfirmed === true,
    failureClass: values.failureClass ?? "NONE",
    ttyCapability: values.ttyCapability ?? "unknown",
    twoFaDetail: values.twoFaDetail ?? "none",
    productionStage: values.productionStage ?? "not_started",
    nodeFailure: values.nodeFailure ?? "none",
    settingsProviderState: values.settingsProviderState ?? "not_started",
    settingsProviderAttempt: values.settingsProviderAttempt ?? 0,
    settingsProviderFailureReason:
      values.settingsProviderFailureReason ?? "none",
  };
}

function isHead(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function validateSupervisedAttestation(value, expected = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["attestation must be an object"];
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !ATTESTATION_KEYS.has(key)) ||
    ATTESTATION_REQUIRED_KEYS.some((key) => !hasOwn(value, key))
  ) {
    errors.push("attestation keys are invalid");
  }
  if (value.version !== SUPERVISED_ATTESTATION_VERSION) errors.push("attestation version is invalid");
  if (typeof value.nonce !== "string" || !/^(?:|[0-9a-f]{32})$/.test(value.nonce)) {
    errors.push("attestation nonce is invalid");
  }
  if (!isHead(value.expectedHead)) errors.push("attestation expected head is invalid");
  for (const key of ["observedHeadBefore", "observedHeadAfter"]) {
    if (value[key] !== null && !isHead(value[key])) errors.push(`attestation ${key} is invalid`);
  }
  if (value.commandId !== SUPERVISED_COMMAND_ID) errors.push("attestation command id is invalid");
  if (value.commandSha256 !== SUPERVISED_COMMAND_SHA256) {
    errors.push("attestation command digest is invalid");
  }
  if (!SUPERVISED_MODES.has(value.mode)) {
    errors.push("attestation mode is invalid");
  }
  if (!SUPERVISED_STATUSES.has(value.status)) errors.push("attestation status is invalid");
  if (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) {
    errors.push("attestation exit code is invalid");
  }
  if (typeof value.markerConfirmed !== "boolean") errors.push("attestation marker state is invalid");
  if (!SUPERVISED_FAILURE_CLASSES.has(value.failureClass)) {
    errors.push("attestation failure class is invalid");
  }
  if (
    hasOwn(value, "ttyCapability") &&
    !SUPERVISED_TTY_CAPABILITIES.has(value.ttyCapability)
  ) {
    errors.push("attestation TTY capability is invalid");
  }
  if (
    hasOwn(value, "twoFaDetail") &&
    !SUPERVISED_TWO_FA_DETAILS.has(value.twoFaDetail)
  ) {
    errors.push("attestation 2FA detail is invalid");
  }
  if (
    hasOwn(value, "twoFaDetail") &&
    value.twoFaDetail !== "none" &&
    (value.status !== "failed" ||
      value.failureClass !== "TWO_FA_CODE_UNAVAILABLE")
  ) {
    errors.push("attestation 2FA detail is inconsistent");
  }
  if (
    hasOwn(value, "productionStage") &&
    !SUPERVISED_PRODUCTION_STAGES.has(value.productionStage)
  ) {
    errors.push("attestation production stage is invalid");
  }
  if (hasOwn(value, "nodeFailure") && !SUPERVISED_NODE_FAILURES.has(value.nodeFailure)) {
    errors.push("attestation node failure is invalid");
  }
  const settingsProviderKeys = [
    "settingsProviderState",
    "settingsProviderAttempt",
    "settingsProviderFailureReason",
  ];
  const hasSettingsProviderFields = settingsProviderKeys.some((key) => hasOwn(value, key));
  if (
    hasSettingsProviderFields &&
    settingsProviderKeys.some((key) => !hasOwn(value, key))
  ) {
    errors.push("attestation Settings provider fields are incomplete");
  }
  if (
    hasOwn(value, "settingsProviderState") &&
    !SUPERVISED_SETTINGS_PROVIDER_STATES.has(value.settingsProviderState)
  ) {
    errors.push("attestation Settings provider state is invalid");
  }
  if (
    hasOwn(value, "settingsProviderAttempt") &&
    (!Number.isInteger(value.settingsProviderAttempt) ||
      value.settingsProviderAttempt < 0 ||
      value.settingsProviderAttempt > 2)
  ) {
    errors.push("attestation Settings provider attempt is invalid");
  }
  if (
    hasOwn(value, "settingsProviderFailureReason") &&
    !SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS.has(
      value.settingsProviderFailureReason
    )
  ) {
    errors.push("attestation Settings provider failure reason is invalid");
  }
  if (
    hasSettingsProviderFields &&
    SUPERVISED_SETTINGS_PROVIDER_STATES.has(value.settingsProviderState) &&
    Number.isInteger(value.settingsProviderAttempt) &&
    SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS.has(
      value.settingsProviderFailureReason
    )
  ) {
    const state = value.settingsProviderState;
    const attempt = value.settingsProviderAttempt;
    const reason = value.settingsProviderFailureReason;
    if (
      (state === "not_started" && (attempt !== 0 || reason !== "none")) ||
      (["request_created", "helper_spawned", "cancelled", "winner"].includes(state) &&
        (attempt < 1 || reason !== "none")) ||
      (state === "failed" && (attempt < 1 || reason === "none"))
    ) {
      errors.push("attestation Settings provider evidence is inconsistent");
    }
  }
  const hasProductionDiagnostic =
    (hasOwn(value, "productionStage") && value.productionStage !== "not_started") ||
    (hasOwn(value, "nodeFailure") && value.nodeFailure !== "none");
  if (
    hasProductionDiagnostic &&
    !["failed", "accepted"].includes(value.status)
  ) {
    errors.push("attestation production diagnostics are inconsistent");
  }
  if (
    hasOwn(value, "nodeFailure") &&
    value.nodeFailure !== "none" &&
    value.status !== "failed"
  ) {
    errors.push("attestation node failure is inconsistent");
  }
  if (expected.nonce !== undefined && value.nonce !== expected.nonce) {
    errors.push("attestation nonce does not match");
  }
  if (expected.expectedHead !== undefined && value.expectedHead !== expected.expectedHead) {
    errors.push("attestation expected head does not match");
  }
  if (expected.mode !== undefined) {
    if (!SUPERVISED_MODES.has(expected.mode)) {
      errors.push("expected attestation mode is invalid");
    } else if (value.mode !== expected.mode) {
      errors.push("attestation mode does not match");
    }
  }
  if (value.status === "accepted") {
    if (
      value.exitCode !== 0 ||
      value.markerConfirmed !== true ||
      value.failureClass !== "NONE" ||
      value.observedHeadBefore !== value.expectedHead ||
      value.observedHeadAfter !== value.expectedHead
    ) {
      errors.push("accepted attestation evidence is inconsistent");
    }
  }
  if (
    ["pending", "ready", "running"].includes(value.status) &&
    (value.exitCode !== null ||
      value.markerConfirmed !== false ||
      value.failureClass !== "NONE" ||
      value.observedHeadAfter !== null)
  ) {
    errors.push("in-progress attestation evidence is inconsistent");
  }
  if (
    value.status === "not_requested" &&
    (value.nonce !== "" ||
      value.exitCode !== null ||
      value.markerConfirmed !== false ||
      value.failureClass !== "NONE" ||
      value.observedHeadBefore !== value.expectedHead ||
      value.observedHeadAfter !== value.expectedHead)
  ) {
    errors.push("not-requested attestation evidence is inconsistent");
  }
  if (
    value.status === "failed" &&
    (value.exitCode === null || value.exitCode === 0 || value.failureClass === "NONE")
  ) {
    errors.push("failed attestation evidence is inconsistent");
  }
  if (
    value.status === "cancelled" &&
    (value.exitCode === null || value.exitCode === 0 || value.failureClass !== "CANCELLED")
  ) {
    errors.push("cancelled attestation evidence is inconsistent");
  }
  return errors;
}

export function parseSupervisedAttestation(source, expected = {}) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch {
    return { value: null, errors: ["attestation JSON is invalid"] };
  }
  return { value, errors: validateSupervisedAttestation(value, expected) };
}
