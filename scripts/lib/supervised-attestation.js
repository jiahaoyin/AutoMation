import crypto from "node:crypto";

export const SUPERVISED_ATTESTATION_VERSION = 1;
export const SUPERVISED_COMMAND_ID = "run-sh-skip-mac";
export const SUPERVISED_COMMAND = "./run.sh --skip-mac";
export const SUPERVISED_SUCCESS_MARKER = "[验收] REAL_ACCOUNT_HOME_CONFIRMED";
export const SUPERVISED_ACCEPTANCE_VALUE = "REAL_ACCOUNT_HOME_CONFIRMED";
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
  "APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE",
  "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
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

export function createSupervisedProductionPermissionProfile(productionDir, nonce) {
  const value = String(productionDir ?? "");
  if (!value.startsWith("/") || /["\\\r\n\0]/.test(value)) {
    throw new Error("Supervised production directory is invalid");
  }
  if (!/^[0-9a-f]{32}$/.test(String(nonce ?? ""))) {
    throw new Error("Supervised production nonce is invalid");
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

const ATTESTATION_KEYS = [
  "version",
  "nonce",
  "expectedHead",
  "observedHeadBefore",
  "observedHeadAfter",
  "commandId",
  "commandSha256",
  "status",
  "exitCode",
  "markerConfirmed",
  "failureClass",
];

export function createSupervisedAttestation(values = {}) {
  return {
    version: SUPERVISED_ATTESTATION_VERSION,
    nonce: values.nonce ?? "",
    expectedHead: values.expectedHead ?? "",
    observedHeadBefore: values.observedHeadBefore ?? null,
    observedHeadAfter: values.observedHeadAfter ?? null,
    commandId: SUPERVISED_COMMAND_ID,
    commandSha256: SUPERVISED_COMMAND_SHA256,
    status: values.status ?? "pending",
    exitCode: values.exitCode ?? null,
    markerConfirmed: values.markerConfirmed === true,
    failureClass: values.failureClass ?? "NONE",
  };
}

function isHead(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

export function validateSupervisedAttestation(value, expected = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["attestation must be an object"];
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...ATTESTATION_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
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
  if (!SUPERVISED_STATUSES.has(value.status)) errors.push("attestation status is invalid");
  if (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) {
    errors.push("attestation exit code is invalid");
  }
  if (typeof value.markerConfirmed !== "boolean") errors.push("attestation marker state is invalid");
  if (!SUPERVISED_FAILURE_CLASSES.has(value.failureClass)) {
    errors.push("attestation failure class is invalid");
  }
  if (expected.nonce !== undefined && value.nonce !== expected.nonce) {
    errors.push("attestation nonce does not match");
  }
  if (expected.expectedHead !== undefined && value.expectedHead !== expected.expectedHead) {
    errors.push("attestation expected head does not match");
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
