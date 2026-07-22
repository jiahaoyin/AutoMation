import { append2FAAudit } from "./2fa-audit.js";
import {
  readPopupCode,
  readSettingsVerificationCode,
  probe2FAState,
  tryAllowOnce,
} from "./mac-2fa-allow.js";
import {
  dismissCodePopupForWebFill,
  dismissStale2FAPopups,
  runPopupPhase,
} from "./mac-2fa-popup.js";
import { start2FASettingsCodeRequest } from "./mac-settings-2fa.js";
import { promptForHidden2FACode } from "./manual-2fa-prompt.js";
import { ensureAccessibility, isAccessibilityDeniedError } from "./accessibility.js";

const MAX_ALLOW_ATTEMPTS = 2;
const MAX_SETTINGS_ATTEMPTS = 2;
const SETTINGS_ATTEMPT_TIMEOUT_MS = 60_000;
const SETTINGS_RETRY_DELAY_MS = 5_000;
const POPUP_POST_ALLOW_GRACE_MS = 30_000;
const ALLOW_CONFIRMATION_POLL_TICKS = 3;
const MAX_ALLOW_CONFIRMATION_POLL_INTERVAL_MS = 1_000;
const ALLOW_CONFIRMATION_PROBE_TIMEOUT_MS = 1_000;
const POPUP_WATCHER_DISPOSE_GRACE_MS = 2_000;
const MANUAL_FALLBACK_AFTER_MS = 90_000;
const MIN_MANUAL_INPUT_WINDOW_MS = 90_000;
const PREEXISTING_ALLOW_CLEAR_IDLE_HITS = 3;
const POPUP_DELIVERY_GRACE_MS = 800;
const STATUS_NAMES = new Set([
  "settings_start",
  "settings_failed",
  "settings_retry",
  "settings_accessibility",
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
  "winner",
]);
const STATUS_SOURCES = new Set(["popup", "settings", "manual"]);

function numberFromEnv(key, fallback) {
  const value = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveConfig(options) {
  const settingsOnly = options.settingsOnly === true;
  const configuredPopupPrimaryMs = numberFromEnv(
    "BROWSER_2FA_SETTINGS_AFTER_MS",
    30_000
  );
  return {
    timeoutMs: options.timeoutMs ?? 240_000,
    settingsOnly,
    settingsFallbackAfterMs: settingsOnly
      ? 0
      : options.settingsFallbackAfterMs ??
        Math.max(30_000, configuredPopupPrimaryMs),
    popupPostAllowGraceMs: Math.max(
      0,
      options.popupPostAllowGraceMs ?? POPUP_POST_ALLOW_GRACE_MS
    ),
    settingsFallback: settingsOnly
      ? true
      : options.settingsFallback ?? process.env.BROWSER_2FA_SETTINGS_FALLBACK !== "0",
    manualFallback:
      options.manualFallback ?? process.env.BROWSER_2FA_MANUAL_FALLBACK !== "0",
    pollIntervalMs: Math.max(
      1,
      options.pollIntervalMs ?? numberFromEnv("BROWSER_2FA_POLL_MS", 800)
    ),
    auditThrottleMs: Math.max(1, options.auditThrottleMs ?? 10_000),
    cleanupGraceMs: options.cleanupGraceMs ?? 5_000,
    popupDeliveryGraceMs: Math.min(
      POPUP_DELIVERY_GRACE_MS,
      Math.max(0, options.popupDeliveryGraceMs ?? POPUP_DELIVERY_GRACE_MS)
    ),
  };
}

function resolveRuntime(overrides = {}) {
  return {
    platform: overrides.platform ?? process.platform,
    now: overrides.now ?? Date.now,
    setTimeout: overrides.setTimeout ?? globalThis.setTimeout,
    clearTimeout: overrides.clearTimeout ?? globalThis.clearTimeout,
    dismissStale2FAPopups:
      overrides.dismissStale2FAPopups ?? dismissStale2FAPopups,
    probe2FAState: overrides.probe2FAState ?? probe2FAState,
    tryAllowOnce: overrides.tryAllowOnce ?? tryAllowOnce,
    readPopupCode: overrides.readPopupCode ?? readPopupCode,
    readSettingsVerificationCode:
      overrides.readSettingsVerificationCode ?? readSettingsVerificationCode,
    runPopupPhase: overrides.runPopupPhase ?? runPopupPhase,
    dismissCodePopupForWebFill:
      overrides.dismissCodePopupForWebFill ?? dismissCodePopupForWebFill,
    start2FASettingsCodeRequest:
      overrides.start2FASettingsCodeRequest ?? start2FASettingsCodeRequest,
    ensureAccessibility: overrides.ensureAccessibility ?? ensureAccessibility,
  };
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    },
    reject(error) {
      if (settled) return false;
      settled = true;
      rejectPromise(error);
      return true;
    },
  };
}

function normalizeSixDigitCode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

function settingsFailureReason(error) {
  if (isAccessibilityDeniedError(error)) return "accessibility_denied";
  switch (error?.code) {
    case "2FA_SETTINGS_TIMEOUT":
      return "settings_timeout";
    case "2FA_SETTINGS_INVALID_OUTPUT":
      return "settings_invalid_output";
    case "2FA_SETTINGS_INVALID_CODE":
      return "settings_invalid_code";
    case "2FA_SETTINGS_OUTPUT_LIMIT":
      return "settings_output_limit";
    case "2FA_SETTINGS_START_FAILED":
      return "settings_start_failed";
    case "2FA_SETTINGS_UNAVAILABLE":
      return "settings_unavailable";
    case "2FA_SETTINGS_HELPER_EXIT":
      return "settings_helper_exit";
    case "2FA_SETTINGS_TWO_FACTOR_NOT_FOUND":
      return "settings_two_factor_not_found";
    case "2FA_SETTINGS_ALERT_NOT_OPENED":
      return "settings_alert_not_opened";
    case "2FA_SETTINGS_ALERT_NOT_FOUND":
      return "settings_alert_not_found";
    case "2FA_SETTINGS_ALERT_CLEANUP_FAILED":
      return "settings_alert_cleanup_failed";
    case "2FA_SETTINGS_UI_UNAVAILABLE":
      return "settings_ui_unavailable";
    default:
      return "settings_provider_failed";
  }
}

function settingsAlertCleanupError() {
  const error = new Error("Settings verification alert cleanup was not confirmed");
  error.code = "2FA_SETTINGS_ALERT_CLEANUP_FAILED";
  return error;
}

const APPLE_HELPER_LABELS = [
  "FollowUpUI",
  "CoreAuthUI",
  "CoreAuthentication",
  "AuthenticationServicesAgent",
  "SecurityAgent",
  "UserNotificationCenter",
  "akd",
  "loginwindow",
  "com.apple.FollowUpUI",
  "com.apple.CoreAuthUI",
  "com.apple.CoreAuthentication",
  "com.apple.AuthenticationServicesAgent",
  "com.apple.SecurityAgent",
  "com.apple.UserNotificationCenter",
  "com.apple.akd",
  "com.apple.loginwindow",
];
const AUDIT_LABELS_BY_KEY = Object.freeze({
  phase: new Set([
    "popup_probe_failure",
    "popup_probe_state",
    "popup_probe_idle_summary",
    "popup_allow_attempt_result",
    "popup_allow",
    "dismiss_rejected_popup",
    "popup_cleanup_only",
    "popup_allow_attempt_start",
    "popup_winner_close_failed",
    "popup_winner_close_fallback",
    "popup_winner_close_fallback_failed",
    "popup_winner_close_pending",
    "popup_code_buffered",
    "popup_code_read",
    "popup_ocr_scan",
    "popup_accessibility",
    "popup_primary_start",
    "popup_primary_exhausted",
    "popup_provider_error",
    "prepare_2fa",
    "settings_provider_start",
    "settings_accessibility",
    "settings_provider_failed",
    "settings_provider_result",
    "settings_provider_cancelled",
    "settings_provider_cancel",
    "settings_provider_cancel_cleanup_failed",
    "settings_provider_force_stop",
    "settings_provider_force_stop_cleanup",
    "settings_ocr",
    "manual_provider_unavailable",
    "manual_fallback_start",
    "2fa_acquisition_requested",
    "2fa_winner",
    "popup_dispose_cleanup",
    "popup_dispose_cleanup_failed",
  ]),
  action: new Set([
    "none",
    "idle",
    "has_allow_dialog",
    "has_code_dialog",
    "probe_error",
    "dismissed_stale",
    "dismissed_done",
    "read_code",
    "attempted_allow",
    "clicked_allow",
    "coords",
  ]),
  reason: new Set([
    "probe_error",
    "unknown_probe_state",
    "code_dialog_appeared",
    "allow_still_visible",
    "allow_disappeared_stably",
    "strategy_error",
    "action_not_attempted",
    "primary_close_failed",
    "fallback_close_failed",
    "close_pending",
    "probe_or_provider_failed",
    "ax_ocr_no_code",
    "code_available",
    "ocr_helper_unavailable",
    "ocr_permission_missing",
    "settings_start_failed",
    "settings_timeout",
    "settings_invalid_output",
    "settings_invalid_code",
    "settings_output_limit",
    "settings_unavailable",
    "settings_helper_exit",
    "settings_two_factor_not_found",
    "settings_alert_not_opened",
    "settings_alert_not_found",
    "settings_alert_cleanup_failed",
    "settings_ui_unavailable",
    "accessibility_denied",
    "accessibility_unavailable",
    "cancelled",
    "settings_provider_failed",
    "tty_unavailable",
    "popup_won",
    "collector_disposed",
    "dispose_probe_or_cleanup_failed",
    "watcher_shutdown_timeout",
  ]),
  state: new Set([
    "idle",
    "has_allow_dialog",
    "has_code_dialog",
    "accessibility_unavailable",
    "probe_error",
    "unknown",
  ]),
  previousState: new Set([
    "unobserved",
    "idle",
    "has_allow_dialog",
    "has_code_dialog",
    "accessibility_unavailable",
    "probe_error",
    "unknown",
  ]),
  source: new Set(["popup", "settings", "manual", "unknown", "vision", ...APPLE_HELPER_LABELS]),
  allowSource: new Set(["popup", "settings", "unknown", ...APPLE_HELPER_LABELS]),
  strategy: new Set([
    "none",
    "native_rotation",
    "cg_ax",
    "manual",
    "code_visible",
    "code_visible_late",
  ]),
  allowStrategy: new Set([
    "none",
    "native_rotation",
    "cg_ax",
    "manual",
    "code_visible",
    "code_visible_late",
  ]),
  outcome: new Set(["candidate_ready", "prompting", "granted", "unavailable"]),
  capability: new Set([
    "available",
    "permission_missing",
    "accessibility_missing",
    "unavailable",
  ]),
});
const AUDIT_STRING_KEYS = new Set(Object.keys(AUDIT_LABELS_BY_KEY));
const AUDIT_BOOLEAN_KEYS = new Set([
  "allowObserved",
  "attempted",
  "buffered",
  "cancelSignalled",
  "closedAfterForce",
  "confirmed",
  "forceStopped",
  "alertCleanupConfirmed",
  "popupClosed",
]);
const AUDIT_NUMBER_KEYS = new Set([
  "dismissedCount",
  "elapsedSincePrepareMs",
  "pollCount",
  "rejectedStaleCodeCount",
  "strategyOffset",
]);

function safeAuditLabel(key, value) {
  const label = String(value ?? "").trim();
  return AUDIT_LABELS_BY_KEY[key]?.has(label) ? label : "other";
}

function sanitizeAuditEntry(entry) {
  const sanitized = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (AUDIT_STRING_KEYS.has(key) && value != null) {
      sanitized[key] = safeAuditLabel(key, value);
    } else if (AUDIT_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      sanitized[key] = value;
    } else if (AUDIT_NUMBER_KEYS.has(key) && Number.isFinite(value)) {
      sanitized[key] = Math.max(0, Math.trunc(value));
    }
  }
  return sanitized;
}

const DIAGNOSTIC_SOURCES = new Set(["popup", "settings"]);
const DIAGNOSTIC_PHASES = new Set([
  "popup_code_read",
  "settings_provider_failed",
]);

function sanitizeDiagnosticEntry(entry) {
  return {
    source: DIAGNOSTIC_SOURCES.has(entry?.source) ? entry.source : "unknown",
    phase: DIAGNOSTIC_PHASES.has(entry?.phase) ? entry.phase : "unknown",
    // Native helper exceptions can carry AX/OCR text, stderr, or account data.
    // Keep diagnostics useful to the outer flow without exporting raw failures.
    error: {
      code: "2FA_PROVIDER_ERROR",
      hasHelperStderr: entry?.error?.hasHelperStderr === true,
    },
  };
}

function normalizeProbeAction(action) {
  if (
    action === "idle" ||
    action === "has_allow_dialog" ||
    action === "has_code_dialog" ||
    action === "accessibility_unavailable" ||
    action === "probe_error"
  ) {
    return action;
  }
  return "unknown";
}

/**
 * Pre-arms native popup monitoring, then advances serially to a cancellable
 * System Settings request only after popup-primary expires.
 *
 * @param {{
 *   auditThrottleMs?: number,
 *   onAudit?: (entry: object) => void,
 *   onDiagnostic?: (entry: { source: string, phase: string, error: { code: string, hasHelperStderr: boolean } }) => void,
 *   onStatus?: (status: object) => void,
 *   manualCodeProvider?: typeof promptForHidden2FACode,
 *   isTTY?: boolean,
 * }} [options]
 * @returns {{
 *   prepare: () => Promise<void>,
 *   getCode: (options?: {generation?: 1|2, rejectPrevious?: boolean}) => Promise<string>,
 *   dispose: () => Promise<void>
 * }}
 */
export function createMac2FACollector(options = {}) {
  const config = resolveConfig(options);
  const runtime = resolveRuntime(options.runtime);
  const reportDir = options.reportDir;
  const manualCodeProvider = options.manualCodeProvider ?? promptForHidden2FACode;
  const isTTY =
    options.isTTY ??
    Boolean(
      process.stdin?.isTTY === true &&
        (process.stdout?.isTTY === true ||
          process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1")
    );
  const rejectedCodes = new Set();
  let popupReady = createDeferred();
  const delays = new Set();

  let prepared = false;
  let preparePromise = null;
  let preparedAt = 0;
  let disposed = false;
  let disposePromise = null;
  let popupWatcherPromise = null;
  let popupWatcherController = null;
  let popupWatcherDelay = null;
  let popupWatcherRestartRequested = false;
  let popupCandidate = null;
  let popupGeneration = 1;
  let popupPrimaryReadyAt = null;
  let providerPhase = "prepared";
  let lastPopupAllowAt = null;
  let manualAllowAwaitingConfirmation = false;
  let manualAllowDisappearanceHits = 0;
  let popupFallbackConfirmationGraceUsed = false;
  let popupConfirmationPolling = false;
  let popupProbe = null;
  let cleanupOnly = false;
  let pendingPopupClose = null;
  let allowStrategy = "none";
  let allowAttempt = 0;
  let preexistingAllowGate = false;
  let preexistingAllowIdleHits = 0;
  let settingsRequest = null;
  let settingsCompletion = null;
  let settingsNativeCompletion = null;
  let settingsOutcome = null;
  let settingsOcrController = null;
  let settingsOcrPromise = null;
  let settingsOcrDelay = null;
  let settingsStartDelay = null;
  let settingsProviderPromise = null;
  let settingsAttempt = 0;
  let lastSettingsCandidateAt = null;
  const settingsCancelPromises = new WeakMap();
  let settingsAccessibilityStatusSent = false;
  let activeAcquisition = null;
  const winnerCleanupPromises = new Map();
  let settledWinner = null;
  let manualAbortController = null;
  let manualCompletion = null;
  let manualStartDelay = null;
  let sharedDeadline = null;
  let sharedAcquisitionStartedAt = null;
  let lastRequestedGeneration = 0;
  let lastReturnedCode = null;
  let pendingAllowAttempt = null;
  let lastProbeState = null;
  let lastProbeAuditAt = null;
  let idlePollCount = 0;
  let manualAllowStatusSent = false;
  let manualUnavailableStatusSent = false;
  let ocrPermissionStatusSent = false;
  let ocrHelperUnavailableStatusSent = false;
  let settingsOcrPermissionStatusSent = false;
  let settingsOcrUnavailableStatusSent = false;
  let popupAccessibilityStatusSent = false;
  let popupAccessibilityAttempted = false;
  let popupAccessibilityController = null;
  let popupScanningStatusSent = false;
  const popupCloseControllers = new Set();
  const popupReadControllers = new Set();
  let timeoutStatusSent = false;
  const auditTimes = new Map();
  const onAudit = typeof options.onAudit === "function" ? options.onAudit : null;
  const onDiagnostic =
    typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : null;

  const elapsedSincePrepare = () => Math.max(0, runtime.now() - preparedAt);
  const throwIfDisposedDuringPreparation = () => {
    if (!disposed) return;
    const error = new Error("2FA collector was disposed during preparation");
    error.code = "2FA_PREPARE_DISPOSED";
    throw error;
  };

  const audit = (entry, auditOptions = {}) => {
    const throttleKey = auditOptions.throttleKey ?? null;
    if (throttleKey) {
      const previous = auditTimes.get(throttleKey);
      if (previous != null && runtime.now() - previous < config.auditThrottleMs) return false;
      auditTimes.set(throttleKey, runtime.now());
    }

    const sanitized = sanitizeAuditEntry(entry);
    try {
      append2FAAudit(reportDir, sanitized);
      onAudit?.(sanitized);
      return true;
    } catch {
      console.warn("[2FA] 写入审计记录失败");
      return false;
    }
  };

  const diagnostic = (entry) => {
    try {
      onDiagnostic?.(sanitizeDiagnosticEntry(entry));
    } catch {
      /* Diagnostics must not disrupt collection or winner selection. */
    }
  };

  const remainingSeconds = (deadline = activeAcquisition?.deadline) => {
    const remainingMs = deadline == null ? config.timeoutMs : deadline - runtime.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  };

  const activeWinnerSettled = () => activeAcquisition?.winner.settled === true;

  const status = (name, values = {}) => {
    if (!onStatus || !STATUS_NAMES.has(name)) return false;
    const payload = { status: name };
    if (Number.isInteger(values.attempt) && values.attempt > 0) {
      payload.attempt = values.attempt;
    }
    if (STATUS_SOURCES.has(values.source)) payload.source = values.source;
    if (Number.isFinite(values.remainingSec)) {
      payload.remainingSec = Math.max(0, Math.trunc(values.remainingSec));
    }
    try {
      onStatus(payload);
      return true;
    } catch {
      return false;
    }
  };

  const popupPrimaryActive = () =>
    !disposed &&
    !cleanupOnly &&
    activeAcquisition != null &&
    providerPhase === "popup" &&
    !activeWinnerSettled();

  const popupWatcherCanProbe = () => {
    if (disposed) return false;
    // A Settings winner may leave its native code dialog above Firefox. Keep
    // the existing cleanup-only probe path for that one provider, while a
    // manual winner never restarts AX work after the operator supplied a code.
    if (cleanupOnly) return settledWinner?.source === "settings";
    return activeAcquisition == null ? providerPhase === "prepared" : popupPrimaryActive();
  };

  const abortPopupAccessibilityPrompt = () => {
    const controller = popupAccessibilityController;
    popupAccessibilityController = null;
    controller?.abort();
  };

  // Trigger the exact helper's TCC prompt only after the browser has asked for
  // a code. It must never delay password submission or stop OCR fallbacks.
  const startPopupAccessibilityPrompt = (deadline) => {
    if (
      disposed ||
      popupAccessibilityAttempted ||
      runtime.platform !== "darwin" ||
      !Number.isFinite(deadline)
    ) {
      return;
    }
    const remainingMs = Math.max(0, deadline - runtime.now());
    if (remainingMs <= 0) return;

    popupAccessibilityAttempted = true;
    if (!popupAccessibilityStatusSent) {
      popupAccessibilityStatusSent = true;
      status("popup_accessibility", {
        source: "popup",
        remainingSec: remainingSeconds(deadline),
      });
    }
    audit({
      phase: "popup_accessibility",
      reason: "accessibility_denied",
      outcome: "prompting",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });

    const controller = new AbortController();
    popupAccessibilityController = controller;
    void Promise.resolve()
      .then(() =>
        runtime.ensureAccessibility({
          quiet: false,
          timeoutMs: Math.min(180_000, remainingMs),
          signal: controller.signal,
        })
      )
      .then(
        (result) => {
          if (disposed || controller.signal.aborted) return;
          const granted = result?.granted === true;
          audit({
            phase: "popup_accessibility",
            ...(granted ? {} : { reason: "accessibility_unavailable" }),
            outcome: granted ? "granted" : "unavailable",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        },
        () => {
          if (disposed || controller.signal.aborted) return;
          audit({
            phase: "popup_accessibility",
            reason: "accessibility_unavailable",
            outcome: "unavailable",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
      )
      .finally(() => {
        if (popupAccessibilityController === controller) {
          popupAccessibilityController = null;
        }
      });
  };

  const observeProbeState = (state) => {
    const action = normalizeProbeAction(state?.action);
    const now = runtime.now();
    if (action === "probe_error" || action === "unknown") {
      audit(
        {
          phase: "popup_probe_failure",
          state: action,
          reason: action === "probe_error" ? "probe_error" : "unknown_probe_state",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        },
        { throttleKey: `popup-probe-failure:${action}` }
      );
    }
    if (action !== lastProbeState) {
      audit({
        phase: "popup_probe_state",
        state: action,
        previousState: lastProbeState ?? "unobserved",
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
      lastProbeState = action;
      lastProbeAuditAt = now;
      idlePollCount = 0;
    } else if (action === "idle") {
      idlePollCount += 1;
      if (lastProbeAuditAt == null || now - lastProbeAuditAt >= config.auditThrottleMs) {
        audit({
          phase: "popup_probe_idle_summary",
          state: action,
          pollCount: idlePollCount,
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
        lastProbeAuditAt = now;
        idlePollCount = 0;
      }
    } else {
      idlePollCount = 0;
    }
    return action;
  };

  const finishAllowAttempt = (confirmed, reason) => {
    const attempt = pendingAllowAttempt;
    if (!attempt) return;
    pendingAllowAttempt = null;
    audit(
      {
        phase: "popup_allow_attempt_result",
        strategy: attempt.strategy,
        source: attempt.source,
        attempted: true,
        confirmed,
        reason,
        elapsedSincePrepareMs: elapsedSincePrepare(),
      },
      confirmed
        ? {}
        : { throttleKey: `allow-result:${attempt.strategy}:${reason}` }
    );
    if (!confirmed) {
      if (providerPhase === "popup" && allowAttempt >= MAX_ALLOW_ATTEMPTS) {
        manualAllowAwaitingConfirmation = true;
        manualAllowDisappearanceHits = 0;
        if (!manualAllowStatusSent) {
          manualAllowStatusSent = true;
          status("manual_allow", { remainingSec: remainingSeconds() });
        }
      }
      return;
    }
    if (providerPhase !== "popup") return;

    allowStrategy = attempt.strategy;
    lastPopupAllowAt = runtime.now();
    audit({
      phase: "popup_allow",
      allowObserved: true,
      allowStrategy,
      allowSource: attempt.source,
      confirmed: true,
      reason,
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
  };

  const finishManualAllowConfirmation = () => {
    if (!manualAllowAwaitingConfirmation || providerPhase !== "popup") return;
    manualAllowAwaitingConfirmation = false;
    manualAllowDisappearanceHits = 0;
    allowStrategy = "manual";
    lastPopupAllowAt = runtime.now();
    audit({
      phase: "popup_allow",
      allowObserved: true,
      allowStrategy,
      allowSource: "popup",
      confirmed: true,
      reason: "allow_disappeared_stably",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
  };

  const scheduleDelay = (delayMs) => {
    let active = true;
    let token = null;
    let resolveDelay;
    const record = {
      promise: new Promise((resolve) => {
        resolveDelay = resolve;
      }),
      cancel() {
        if (!active) return false;
        active = false;
        runtime.clearTimeout(token);
        delays.delete(record);
        resolveDelay(false);
        return true;
      },
    };
    token = runtime.setTimeout(() => {
      if (!active) return;
      active = false;
      delays.delete(record);
      resolveDelay(true);
    }, Math.max(0, delayMs));
    delays.add(record);
    return record;
  };

  const awaitWithin = async (promise, timeoutMs) => {
    const timeout = scheduleDelay(Math.max(0, timeoutMs));
    const outcome = await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ kind: "fulfilled", value }),
        (error) => ({ kind: "rejected", error })
      ),
      timeout.promise.then((elapsed) => ({ kind: elapsed ? "timeout" : "cancelled" })),
    ]);
    timeout.cancel();
    return outcome;
  };

  const waitForPopupWatcherDelay = async (delayMs) => {
    const delay = scheduleDelay(delayMs);
    popupWatcherDelay = delay;
    const elapsed = await delay.promise;
    if (popupWatcherDelay === delay) popupWatcherDelay = null;
    return elapsed;
  };

  const requestPopupWatcherRestart = () => {
    popupWatcherRestartRequested = true;
    popupWatcherDelay?.cancel();
  };

  const cancelAllDelays = () => {
    for (const delay of [...delays]) delay.cancel();
  };

  const abortPopupCloseTasks = () => {
    for (const controller of popupCloseControllers) controller.abort();
  };

  const abortPopupReadTasks = () => {
    for (const controller of popupReadControllers) controller.abort();
  };

  const abortPopupProbe = () => {
    popupProbe?.controller.abort();
  };

  const resetPendingPopupClose = () => {
    pendingPopupClose = null;
  };

  const reportPopupClosePending = (candidate) => {
    if (candidate.closePendingReported) return;
    candidate.closePendingReported = true;
    audit(
      {
        phase: "popup_winner_close_pending",
        reason: "close_pending",
        elapsedSincePrepareMs: elapsedSincePrepare(),
      },
      { throttleKey: "popup-winner-close-pending" }
    );
    status("popup_close_pending", {
      source: "popup",
      remainingSec: remainingSeconds(),
    });
  };

  const startPopupCloseCleanup = (candidate, generation) => {
    const primaryController = new AbortController();
    const fallbackController = new AbortController();
    popupCloseControllers.add(primaryController);
    popupCloseControllers.add(fallbackController);

    const closeMayContinue = (controller) => {
      if (controller.signal.aborted || disposed || generation !== popupGeneration) {
        return false;
      }
      const winnerSource =
        settledWinner?.generation === generation ? settledWinner.source : null;
      if (winnerSource) return winnerSource === "popup";
      return !activeWinnerSettled() || popupCandidate?.generation === generation;
    };

    const closePrimary = async () => {
      try {
        if (!closeMayContinue(primaryController)) return false;
        const popupClosed = await runtime.dismissCodePopupForWebFill(4, {
          signal: primaryController.signal,
          compileIfNeeded: false,
        });
        return closeMayContinue(primaryController) && popupClosed;
      } catch {
        if (!disposed && generation === popupGeneration) {
          audit({
            phase: "popup_winner_close_failed",
            reason: "primary_close_failed",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
        return false;
      }
    };

    const closeFallback = async () => {
      try {
        if (!closeMayContinue(fallbackController)) return false;
        const fallback = await runtime.runPopupPhase("dismiss_stale", 2, {
          signal: fallbackController.signal,
          compileIfNeeded: false,
        });
        if (!closeMayContinue(fallbackController)) return false;
        const popupClosed = fallback?.action === "dismissed_stale";
        audit({
          phase: "popup_winner_close_fallback",
          action: fallback?.action ?? "none",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
        return popupClosed;
      } catch {
        if (!disposed && generation === popupGeneration) {
          audit({
            phase: "popup_winner_close_fallback_failed",
            reason: "fallback_close_failed",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
        return false;
      }
    };

    const primaryClose = closePrimary();
    const closeGrace = scheduleDelay(config.popupDeliveryGraceMs);
    const cleanup = (async () => {
      const closeResult = await Promise.race([
        primaryClose.then((popupClosed) => ({ kind: "close", popupClosed })),
        closeGrace.promise.then((elapsed) => ({
          kind: elapsed ? "grace" : "cancelled",
          popupClosed: false,
        })),
      ]);
      closeGrace.cancel();
      if (closeResult.kind === "cancelled" || !closeMayContinue(fallbackController)) {
        return;
      }
      if (closeResult.kind === "close" && closeResult.popupClosed) return;

      if (closeResult.kind === "grace") {
        // Do not let a hung primary close touch a later popup. The fallback has
        // its own controller so it can still run after this bounded grace.
        primaryController.abort();
        reportPopupClosePending(candidate);
      }

      const fallbackClosed = await closeFallback();
      if (!fallbackClosed && closeMayContinue(fallbackController)) {
        reportPopupClosePending(candidate);
      }
    })();

    void cleanup
      .catch(() => {
        /* Popup cleanup is best-effort and must never affect OTP delivery. */
      })
      .finally(() => {
        closeGrace.cancel();
        popupCloseControllers.delete(primaryController);
        popupCloseControllers.delete(fallbackController);
      });
  };

  const tryClosePendingPopup = (candidate, generation) => {
    if (
      disposed ||
      generation !== popupGeneration ||
      !popupPrimaryActive() ||
      activeWinnerSettled()
    ) {
      resetPendingPopupClose();
      return false;
    }

    // A verified popup candidate belongs to this generation immediately. Native
    // dialog closing is only background cleanup, so it cannot consume the code.
    resetPendingPopupClose();
    popupCandidate = { ...candidate, generation };
    audit({
      phase: "popup_code_buffered",
      allowStrategy: candidate.allowStrategy,
      source: candidate.popupSource,
      popupClosed: false,
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
    popupReady.resolve(popupCandidate);
    startPopupCloseCleanup(popupCandidate, generation);
    return true;
  };

  const dismissRejectedPopup = async (code, signal) => {
    if (disposed || activeWinnerSettled()) return;
    const result = await runtime.runPopupPhase("dismiss_stale", 2, {
      signal,
      compileIfNeeded: false,
    });
    if (disposed || activeWinnerSettled()) return;
    const dismissedCode = normalizeSixDigitCode(result?.code) || code;
    if (dismissedCode) rejectedCodes.add(dismissedCode);
    audit({
      phase: "dismiss_rejected_popup",
      action: result?.action ?? "none",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
    resetPendingPopupClose();
  };

  const pollPopupOnce = async (signal, record = null) => {
    if (signal?.aborted) return;
    if (!popupWatcherCanProbe()) return;
    const generation = popupGeneration;
    const acquisitionAtStart = record?.acquisition ?? activeAcquisition;
    let state;
    try {
      if (record) record.nativeProbeStarted = true;
      state = await runtime.probe2FAState(2, { signal });
    } catch {
      state = { action: "probe_error" };
    }
    if (
      signal?.aborted ||
      disposed ||
      generation !== popupGeneration ||
      acquisitionAtStart !== activeAcquisition ||
      !popupWatcherCanProbe()
    ) {
      return;
    }
    if (!cleanupOnly && activeWinnerSettled()) return;
    const action = observeProbeState(state);
    if (
      signal?.aborted ||
      disposed ||
      generation !== popupGeneration ||
      acquisitionAtStart !== activeAcquisition ||
      !popupWatcherCanProbe()
    ) {
      return;
    }
    if (!cleanupOnly && activeWinnerSettled()) return;

    // Preparation has already removed code dialogs that existed before the
    // password submission boundary. A code dialog that appears after that
    // point can be the current browser login popup even when ruyiPage has not
    // emitted need_2fa yet. Leave it visible until popup-primary starts; do
    // not click Allow, OCR-read, buffer, or dismiss it prematurely.
    if (!cleanupOnly && !activeAcquisition) {
      pendingAllowAttempt = null;
      manualAllowAwaitingConfirmation = false;
      manualAllowDisappearanceHits = 0;
      resetPendingPopupClose();
      if (preexistingAllowGate) {
        if (action === "idle") {
          preexistingAllowIdleHits += 1;
          if (preexistingAllowIdleHits >= PREEXISTING_ALLOW_CLEAR_IDLE_HITS) {
            preexistingAllowGate = false;
            preexistingAllowIdleHits = 0;
          }
          return;
        }
        preexistingAllowIdleHits = 0;
        if (action !== "has_code_dialog") return;
        const stateCode = normalizeSixDigitCode(state?.code);
        if (stateCode) rejectedCodes.add(stateCode);
        const result = await runtime.runPopupPhase("dismiss_stale", 2, {
          signal,
          compileIfNeeded: false,
        });
        if (signal?.aborted || disposed || generation !== popupGeneration) return;
        const dismissedCode = normalizeSixDigitCode(result?.code);
        if (dismissedCode) rejectedCodes.add(dismissedCode);
        audit({
          phase: "dismiss_rejected_popup",
          action: result?.action ?? "none",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
        return;
      }
      const stateCode = normalizeSixDigitCode(state?.code);
      if (stateCode && rejectedCodes.has(stateCode)) {
        await dismissRejectedPopup(stateCode, signal);
      }
      return;
    }

    if (action === "accessibility_unavailable" && activeAcquisition) {
      startPopupAccessibilityPrompt(activeAcquisition.deadline);
    }

    if (manualAllowAwaitingConfirmation) {
      if (action === "has_code_dialog") {
        finishManualAllowConfirmation();
      } else if (action === "idle") {
        manualAllowDisappearanceHits += 1;
        if (manualAllowDisappearanceHits >= 2) {
          finishManualAllowConfirmation();
        } else {
          return;
        }
      } else if (action === "has_allow_dialog") {
        manualAllowDisappearanceHits = 0;
      } else {
        manualAllowDisappearanceHits = 0;
      }
    }

    // The System Settings Apple Account sheet can be visible while AX reports
    // an idle tree on macOS 15. Once the browser has explicitly requested a
    // code, an idle/probe result must still reach the tightly scoped OCR path.
    const screenOcrFallback =
      activeAcquisition != null &&
      ["idle", "accessibility_unavailable", "probe_error", "unknown"].includes(action);
    if (screenOcrFallback) {
      if (!popupScanningStatusSent) {
        popupScanningStatusSent = true;
        status("popup_scanning", {
          source: "popup",
          remainingSec: remainingSeconds(),
        });
        audit({
          phase: "popup_ocr_scan",
          source: "popup",
          outcome: "prompting",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
      }
      if (!popupAccessibilityStatusSent) {
        if (action === "accessibility_unavailable") {
          popupAccessibilityStatusSent = true;
          status("popup_accessibility", {
            source: "popup",
            remainingSec: remainingSeconds(),
          });
        }
      }
    }

    if (preexistingAllowGate) {
      if (action === "idle") {
        preexistingAllowIdleHits += 1;
        if (preexistingAllowIdleHits >= PREEXISTING_ALLOW_CLEAR_IDLE_HITS) {
          preexistingAllowGate = false;
          preexistingAllowIdleHits = 0;
        }
        // A real browser 2FA request makes the scoped OCR path safe even
        // while an earlier Allow dialog still awaits its stable idle clear.
        if (!activeAcquisition) {
          pendingAllowAttempt = null;
          resetPendingPopupClose();
          return;
        }
      }
      else {
        preexistingAllowIdleHits = 0;
        if (!activeAcquisition) {
          pendingAllowAttempt = null;
          resetPendingPopupClose();
          if (action !== "has_code_dialog") return;

          const stateCode = normalizeSixDigitCode(state?.code);
          if (stateCode) rejectedCodes.add(stateCode);
          const result = await runtime.runPopupPhase("dismiss_stale", 2, {
            signal,
            compileIfNeeded: false,
          });
          if (signal?.aborted || disposed || generation !== popupGeneration) return;
          const dismissedCode = normalizeSixDigitCode(result?.code);
          if (dismissedCode) rejectedCodes.add(dismissedCode);
          audit({
            phase: "dismiss_rejected_popup",
            action: result?.action ?? "none",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
          return;
        }

        // Never auto-click an Allow that pre-dates this browser request, but
        // do not let that guard hide a fresh code dialog or OCR fallback.
        if (action === "has_allow_dialog") {
          pendingAllowAttempt = null;
          resetPendingPopupClose();
          if (!manualAllowStatusSent) {
            manualAllowStatusSent = true;
            status("manual_allow", { remainingSec: remainingSeconds() });
          }
          return;
        }
      }
    }

    if (cleanupOnly) {
      pendingAllowAttempt = null;
      if (action === "has_code_dialog") {
        if (disposed || generation !== popupGeneration) return;
        const result = await runtime.runPopupPhase("dismiss_stale", 2, {
          signal,
          compileIfNeeded: false,
        });
        if (signal?.aborted || disposed || generation !== popupGeneration) return;
        audit({
          phase: "popup_cleanup_only",
          action: result?.action ?? "none",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
      }
      return;
    }

    if (popupCandidate) return;

    if (pendingAllowAttempt) {
      if (action === "has_code_dialog") {
        finishAllowAttempt(true, "code_dialog_appeared");
      } else if (action === "has_allow_dialog") {
        finishAllowAttempt(false, "allow_still_visible");
      } else if (action === "idle") {
        pendingAllowAttempt.disappearanceHits += 1;
        if (pendingAllowAttempt.disappearanceHits >= 2) {
          finishAllowAttempt(true, "allow_disappeared_stably");
        }
        return;
      } else {
        pendingAllowAttempt.disappearanceHits = 0;
        return;
      }
    }

    if (action === "has_allow_dialog") {
      if (allowAttempt >= MAX_ALLOW_ATTEMPTS) {
        if (!manualAllowStatusSent) {
          manualAllowStatusSent = true;
          status("manual_allow", { remainingSec: remainingSeconds() });
        }
        manualAllowAwaitingConfirmation = true;
        manualAllowDisappearanceHits = 0;
        resetPendingPopupClose();
        return;
      }
      const strategyOffset = allowAttempt;
      allowAttempt += 1;
      audit(
        {
          phase: "popup_allow_attempt_start",
          strategy: "native_rotation",
          strategyOffset,
          elapsedSincePrepareMs: elapsedSincePrepare(),
        },
        { throttleKey: "allow-attempt-start" }
      );

      let allow;
      try {
        if (disposed || generation !== popupGeneration || activeWinnerSettled()) return;
        allow = await runtime.tryAllowOnce(
          Math.max(1, Math.ceil(Math.min(2_000, config.pollIntervalMs) / 1000)),
          {
            maxStrategies: 1,
            strategyOffset,
            signal,
            compileIfNeeded: false,
          }
        );
        if (
          signal?.aborted ||
          disposed ||
          generation !== popupGeneration ||
          !popupPrimaryActive() ||
          activeWinnerSettled()
        ) {
          return;
        }
      } catch {
        if (disposed) return;
        audit(
          {
            phase: "popup_allow_attempt_result",
            strategy: "native_rotation",
            strategyOffset,
            attempted: false,
            confirmed: false,
            reason: "strategy_error",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          },
          { throttleKey: `allow-result:native_rotation:strategy_error` }
        );
        resetPendingPopupClose();
        return;
      }

      const attempted = Boolean(
        allow?.attempted ||
          allow?.clicked ||
          allow?.action === "attempted_allow" ||
          allow?.action === "clicked_allow"
      );
      const strategy = allow?.strategy ?? "native_rotation";
      const source = allow?.source ?? "unknown";
      if (attempted) {
        pendingAllowAttempt = {
          strategy,
          source,
          disappearanceHits: 0,
        };
      } else {
        audit(
          {
            phase: "popup_allow_attempt_result",
            strategy,
            source,
            strategyOffset,
            attempted: false,
            confirmed: false,
            reason: "action_not_attempted",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          },
          { throttleKey: `allow-result:${strategy}:action_not_attempted` }
        );
      }
      resetPendingPopupClose();
      return;
    }

    if (action !== "has_code_dialog" && !screenOcrFallback) {
      resetPendingPopupClose();
      return;
    }

    const stateCode = normalizeSixDigitCode(state.code);
    if (stateCode && rejectedCodes.has(stateCode)) {
      await dismissRejectedPopup(stateCode, signal);
      return;
    }

    if (pendingPopupClose) {
      if (stateCode && stateCode !== pendingPopupClose.code) {
        resetPendingPopupClose();
      } else {
        await tryClosePendingPopup(pendingPopupClose, generation);
        return;
      }
    }

    if (disposed || generation !== popupGeneration || activeWinnerSettled()) return;
    const readerController = new AbortController();
    const abortReader = () => readerController.abort();
    signal?.addEventListener?.("abort", abortReader, { once: true });
    popupReadControllers.add(readerController);
    let result;
    try {
      result = await runtime.readPopupCode(4, {
        preferOcr: true,
        rejectCodes: rejectedCodes,
        signal: readerController.signal,
        now: runtime.now,
        deadlineMs: activeAcquisition?.deadline,
      });
    } catch (error) {
      diagnostic({ source: "popup", phase: "popup_code_read", error });
      audit({
        phase: "popup_code_read",
        source: "popup",
        outcome: "unavailable",
        reason: "probe_or_provider_failed",
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
      resetPendingPopupClose();
      return;
    } finally {
      signal?.removeEventListener?.("abort", abortReader);
      popupReadControllers.delete(readerController);
    }
    if (
      signal?.aborted ||
      disposed ||
      generation !== popupGeneration ||
      !popupPrimaryActive() ||
      activeWinnerSettled()
    ) {
      return;
    }
    if (result?.capability === "accessibility_missing" && !popupAccessibilityStatusSent) {
      popupAccessibilityStatusSent = true;
      status("popup_accessibility", {
        source: "popup",
        remainingSec: remainingSeconds(),
      });
    }
    if (result?.capability === "permission_missing" && !ocrPermissionStatusSent) {
      ocrPermissionStatusSent = true;
      status("ocr_permission_missing", {
        source: "popup",
        remainingSec: remainingSeconds(),
      });
    }
    if (result?.capability === "unavailable" && !ocrHelperUnavailableStatusSent) {
      ocrHelperUnavailableStatusSent = true;
      status("ocr_helper_unavailable", {
        source: "popup",
        remainingSec: remainingSeconds(),
      });
    }
    const readerRejected = result?.rejected === true;
    const code = readerRejected ? null : normalizeSixDigitCode(result?.code);
    audit({
      phase: "popup_code_read",
      source: result?.source ?? "popup",
      outcome: code ? "candidate_ready" : "unavailable",
      capability: result?.capability ?? "available",
      reason:
        code
          ? "code_available"
          : result?.capability === "permission_missing"
          ? "ocr_permission_missing"
          : result?.capability === "accessibility_missing"
            ? "accessibility_denied"
            : result?.capability === "unavailable"
              ? "ocr_helper_unavailable"
            : "ax_ocr_no_code",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
    if (readerRejected) {
      await dismissRejectedPopup(null, signal);
      return;
    }
    if (!code) {
      resetPendingPopupClose();
      return;
    }
    if (rejectedCodes.has(code)) {
      await dismissRejectedPopup(code, signal);
      return;
    }

    const candidate = {
      source: "popup",
      code,
      allowStrategy,
      popupSource: result?.source ?? "popup",
      closePendingReported: false,
    };
    pendingPopupClose = candidate;
    await tryClosePendingPopup(candidate, generation);
  };

  const startPopupProbe = (parentSignal) => {
    if (popupProbe) return popupProbe;

    const generation = popupGeneration;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener?.("abort", abort, { once: true });

    const record = {
      controller,
      generation,
      acquisition: activeAcquisition,
      nativeProbeStarted: false,
      promise: null,
    };
    if (
      activeAcquisition?.generation === generation &&
      providerPhase === "popup" &&
      popupPrimaryReadyAt == null
    ) {
      popupPrimaryReadyAt = runtime.now();
    }
    let probePromise;
    try {
      // Keep the watcher timing identical to calling pollPopupOnce() directly:
      // a Promise.then() here delays the first AX probe by one microtask and
      // can make it observe a later browser state.
      probePromise = pollPopupOnce(controller.signal, record);
    } catch (error) {
      probePromise = Promise.reject(error);
    }
    record.promise = Promise.resolve(probePromise)
      .finally(() => {
        parentSignal?.removeEventListener?.("abort", abort);
        if (popupProbe === record) popupProbe = null;
      });
    popupProbe = record;
    return record;
  };

  const waitForPopupProbe = async (record, timeoutMs) => {
    const outcome = await awaitWithin(record.promise, timeoutMs);
    return outcome.kind === "fulfilled" || outcome.kind === "rejected";
  };

  const allowConfirmationNeedsPolling = (acquisition) =>
    !disposed &&
    !cleanupOnly &&
    activeAcquisition === acquisition &&
    !acquisition.winner.settled &&
    providerPhase === "popup" &&
    (pendingAllowAttempt != null || manualAllowAwaitingConfirmation);

  const runBoundedAllowConfirmationPolls = async (acquisition) => {
    const parentSignal = popupWatcherController?.signal;
    const pollDelayMs = Math.min(
      MAX_ALLOW_CONFIRMATION_POLL_INTERVAL_MS,
      config.pollIntervalMs
    );
    popupConfirmationPolling = true;
    try {
      // The watcher may already be inside AX when popup-primary reaches its
      // fallback boundary. Cancel it and only continue after it actually
      // settles; an uncooperative helper must never be overlapped by another
      // AX probe just to preserve a best-effort confirmation window.
      if (popupProbe) {
        const activeProbe = popupProbe;
        abortPopupProbe();
        const settled = await waitForPopupProbe(
          activeProbe,
          Math.min(
            ALLOW_CONFIRMATION_PROBE_TIMEOUT_MS,
            Math.max(0, acquisition.deadline - runtime.now())
          )
        );
        if (!settled || !allowConfirmationNeedsPolling(acquisition)) return;
      }

      for (let tick = 0; tick < ALLOW_CONFIRMATION_POLL_TICKS; tick += 1) {
        if (!allowConfirmationNeedsPolling(acquisition)) return;
        const remainingMs = acquisition.deadline - runtime.now();
        if (remainingMs <= 0) return;

        // The first probe runs at the fallback boundary. It preserves a manual
        // Allow transition that became visible in the same event-loop turn;
        // only the remaining two probes wait for the short bounded interval.
        if (tick > 0) {
          const delay = scheduleDelay(Math.min(pollDelayMs, remainingMs));
          const elapsed = await delay.promise;
          if (!elapsed || !allowConfirmationNeedsPolling(acquisition)) return;
        }

        const probe = startPopupProbe(parentSignal);
        const completed = await waitForPopupProbe(
          probe,
          Math.min(
            ALLOW_CONFIRMATION_PROBE_TIMEOUT_MS,
            Math.max(0, acquisition.deadline - runtime.now())
          )
        );
        if (!completed) {
          probe.controller.abort();
          return;
        }
        if (!allowConfirmationNeedsPolling(acquisition)) return;
      }
    } finally {
      popupConfirmationPolling = false;
    }
  };

  const watchPopup = async (signal) => {
    while (!disposed && !signal?.aborted) {
      if (popupWatcherRestartRequested) popupWatcherRestartRequested = false;
      if (!popupWatcherCanProbe()) {
        const elapsed = await waitForPopupWatcherDelay(config.pollIntervalMs);
        if (!elapsed && !popupWatcherRestartRequested) break;
        if (signal?.aborted) break;
        continue;
      }
      if (popupConfirmationPolling) {
        const elapsed = await waitForPopupWatcherDelay(
          Math.min(MAX_ALLOW_CONFIRMATION_POLL_INTERVAL_MS, config.pollIntervalMs)
        );
        if (!elapsed && !popupWatcherRestartRequested) break;
        if (signal?.aborted) break;
        continue;
      }
      try {
        await startPopupProbe(signal).promise;
      } catch {
        if (!disposed) {
          audit(
            {
              phase: "popup_provider_error",
              reason: "probe_or_provider_failed",
              elapsedSincePrepareMs: elapsedSincePrepare(),
            },
            { throttleKey: "popup-provider-error" }
          );
        }
      }
      if (disposed || signal?.aborted) break;
      if (popupWatcherRestartRequested) continue;
      const elapsed = await waitForPopupWatcherDelay(config.pollIntervalMs);
      if (!elapsed && !popupWatcherRestartRequested) break;
      if (signal?.aborted) break;
    }
  };

  const prepare = () => {
    if (disposed) return Promise.reject(new Error("2FA collector is disposed"));
    if (prepared) return Promise.resolve();
    if (preparePromise) return preparePromise;

    preparePromise = (async () => {
      if (runtime.platform !== "darwin") {
        throw new Error("macOS 2FA collection requires macOS");
      }

      let stale = { count: 0, codes: [] };
      let initialProbeState = null;
      if (!config.settingsOnly) {
        stale = await runtime.dismissStale2FAPopups(6, {
          compileIfNeeded: false,
        });
        throwIfDisposedDuringPreparation();
        for (const value of stale?.codes ?? []) {
          const code = normalizeSixDigitCode(value);
          if (code) rejectedCodes.add(code);
        }

        try {
          initialProbeState = await runtime.probe2FAState(2);
        } catch {
          initialProbeState = { action: "probe_error" };
        }
        throwIfDisposedDuringPreparation();
        if (initialProbeState?.action === "has_allow_dialog") {
          preexistingAllowGate = true;
          preexistingAllowIdleHits = 0;
        } else if (initialProbeState?.action === "has_code_dialog") {
          const visibleCode = normalizeSixDigitCode(initialProbeState.code);
          if (visibleCode) rejectedCodes.add(visibleCode);
          const dismissed = await runtime.runPopupPhase("dismiss_stale", 2, {
            compileIfNeeded: false,
          });
          throwIfDisposedDuringPreparation();
          const dismissedCode = normalizeSixDigitCode(dismissed?.code);
          if (dismissedCode) rejectedCodes.add(dismissedCode);
        }
      }

      throwIfDisposedDuringPreparation();
      preparedAt = runtime.now();
      prepared = true;
      audit({
        phase: "prepare_2fa",
        dismissedCount: stale?.count ?? 0,
        rejectedStaleCodeCount: rejectedCodes.size,
        elapsedSincePrepareMs: 0,
      });
      if (!config.settingsOnly) {
        if (initialProbeState?.action === "probe_error") {
          observeProbeState(initialProbeState);
        }
        popupWatcherController = new AbortController();
        popupWatcherPromise = watchPopup(popupWatcherController.signal);
      }
    })();

    return preparePromise;
  };

  const beginSettingsFallback = (acquisition) => {
    if (config.settingsOnly) {
      providerPhase = "settings";
      return true;
    }
    if (
      disposed ||
      activeAcquisition !== acquisition ||
      acquisition.winner.settled ||
      popupCandidate?.generation === acquisition.generation
    ) {
      return false;
    }
    if (providerPhase === "settings") return true;
    if (providerPhase !== "popup") return false;

    // End popup-primary before starting Settings. A helper may ignore Abort,
    // but its generation/phase checks fence late output and no new AX probe is
    // allowed once the serial fallback has advanced.
    abortPopupProbe();
    providerPhase = "settings";
    pendingAllowAttempt = null;
    manualAllowAwaitingConfirmation = false;
    manualAllowDisappearanceHits = 0;
    popupConfirmationPolling = false;
    resetPendingPopupClose();
    abortPopupReadTasks();
    abortPopupAccessibilityPrompt();
    audit({
      phase: "popup_primary_exhausted",
      reason: "popup_primary_window_elapsed",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
    status("settings_fallback", {
      source: "settings",
      remainingSec: remainingSeconds(acquisition.deadline),
    });
    return true;
  };

  const settingsPhaseCanContinue = (acquisition) =>
    !disposed &&
    activeAcquisition === acquisition &&
    !acquisition.winner.settled &&
    providerPhase === "settings";

  const stopSettingsOcr = (controller = settingsOcrController) => {
    if (controller != null && settingsOcrController !== controller) return false;
    const retryDelay = settingsOcrDelay;
    settingsOcrDelay = null;
    settingsOcrController = null;
    retryDelay?.cancel();
    controller?.abort();
    return retryDelay != null || controller != null;
  };

  const readSettingsOcrCandidate = async (acquisition, deadline, signal) => {
    while (settingsPhaseCanContinue(acquisition) && !signal.aborted) {
      const remainingMs = deadline - runtime.now();
      if (remainingMs < 1_000) return null;
      let result = null;
      try {
        result = await runtime.readSettingsVerificationCode(
          Math.min(10, Math.max(1, Math.floor(remainingMs / 1_000))),
          {
            signal,
            rejectCodes: rejectedCodes,
            deadlineMs: deadline,
            now: runtime.now,
          }
        );
      } catch {
        return null;
      }
      if (signal.aborted || !settingsPhaseCanContinue(acquisition)) return null;
      const capability = result?.capability;
      if (capability === "permission_missing") {
        if (!settingsOcrPermissionStatusSent) {
          settingsOcrPermissionStatusSent = true;
          status("ocr_permission_missing", {
            source: "settings",
            remainingSec: remainingSeconds(deadline),
          });
          audit({
            phase: "settings_ocr",
            source: "vision",
            outcome: "unavailable",
            capability,
            reason: "ocr_permission_missing",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
        return null;
      }
      if (capability === "unavailable" || capability === "accessibility_missing") {
        if (!settingsOcrUnavailableStatusSent) {
          settingsOcrUnavailableStatusSent = true;
          status("ocr_helper_unavailable", {
            source: "settings",
            remainingSec: remainingSeconds(deadline),
          });
          audit({
            phase: "settings_ocr",
            source: "vision",
            outcome: "unavailable",
            capability,
            reason: "ocr_helper_unavailable",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
        return null;
      }
      const code = normalizeSixDigitCode(result?.code);
      if (code && !rejectedCodes.has(code)) return code;
      const retryDelay = scheduleDelay(Math.min(400, Math.max(0, deadline - runtime.now())));
      settingsOcrDelay = retryDelay;
      const elapsed = await retryDelay.promise;
      if (settingsOcrDelay === retryDelay) settingsOcrDelay = null;
      if (!elapsed) return null;
    }
    return null;
  };

  const startSettingsProvider = async (acquisition) => {
    const generationRetryAt =
      acquisition.generation === 2 && lastSettingsCandidateAt != null
        ? Math.max(lastSettingsCandidateAt, acquisition.startedAt) + SETTINGS_RETRY_DELAY_MS
        : 0;
    // Re-evaluate the popup deadline after each delay. An Allow confirmation
    // can arrive while the original popup-primary window is still ticking and
    // must grant a full post-Allow AX/OCR read window before Settings starts.
    while (true) {
      if (disposed || acquisition.winner.settled || activeAcquisition !== acquisition) return;
      const now = runtime.now();
      const popupStartedAt = config.settingsOnly ? acquisition.startedAt : popupPrimaryReadyAt;
      if (!config.settingsOnly && popupStartedAt == null) {
        const waitMs = Math.min(
          MAX_ALLOW_CONFIRMATION_POLL_INTERVAL_MS,
          Math.max(0, acquisition.deadline - now)
        );
        if (waitMs <= 0) return;
        settingsStartDelay = scheduleDelay(waitMs);
        const elapsed = await settingsStartDelay.promise;
        settingsStartDelay = null;
        if (!elapsed) return;
        continue;
      }
      const popupFallbackAt = config.settingsOnly
        ? acquisition.startedAt
        : Math.max(
            popupStartedAt + config.settingsFallbackAfterMs,
            lastPopupAllowAt == null ? 0 : lastPopupAllowAt + config.popupPostAllowGraceMs
          );
      const waitMs = Math.max(0, Math.max(popupFallbackAt, generationRetryAt) - now);
      if (waitMs <= 0) {
        const needsAllowConfirmation =
          !config.settingsOnly &&
          providerPhase === "popup" &&
          (pendingAllowAttempt != null || manualAllowAwaitingConfirmation);
        if (!needsAllowConfirmation || popupFallbackConfirmationGraceUsed) break;

        // A manual Allow can disappear at the same instant the popup-primary
        // timer expires. Run three short, bounded AX polls before Settings so
        // a real transition wins, without trusting an unbounded poll setting.
        popupFallbackConfirmationGraceUsed = true;
        await runBoundedAllowConfirmationPolls(acquisition);
        continue;
      }
      if (generationRetryAt > now) {
        status("settings_retry", {
          attempt: settingsAttempt + 1,
          source: "settings",
          remainingSec: remainingSeconds(acquisition.deadline),
        });
      }
      settingsStartDelay = scheduleDelay(waitMs);
      const elapsed = await settingsStartDelay.promise;
      settingsStartDelay = null;
      if (!elapsed) return;
      // A popup Allow may have moved the effective fallback deadline forward.
      // Loop once more instead of allowing a stale timer to launch Settings.
    }
    if (!beginSettingsFallback(acquisition)) return;
    if (!config.settingsFallback || settingsAttempt >= MAX_SETTINGS_ATTEMPTS) return;
    while (settingsAttempt < MAX_SETTINGS_ATTEMPTS) {
      if (!settingsPhaseCanContinue(acquisition)) return;
      const remainingMs = acquisition.deadline - runtime.now();
      if (remainingMs <= 0) return;

      settingsAttempt += 1;
      const attempt = settingsAttempt;
      const attemptTimeoutMs = Math.min(SETTINGS_ATTEMPT_TIMEOUT_MS, remainingMs);
      status("settings_start", {
        attempt,
        source: "settings",
        remainingSec: remainingSeconds(acquisition.deadline),
      });
      audit({
        phase: "settings_provider_start",
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });

      let request = null;
      let outcome = null;
      try {
        request = runtime.start2FASettingsCodeRequest({
          timeoutMs: attemptTimeoutMs,
          reportDir,
          runtime: { compileIfNeeded: false },
        });
      } catch (error) {
        outcome = {
          kind: "failed",
          error,
          failureReason: isAccessibilityDeniedError(error)
            ? "accessibility_denied"
            : "settings_start_failed",
        };
      }

      if (request) {
        settingsRequest = request;
        const outcomeGate = createDeferred();
        const nativeCompletion = Promise.resolve(request.promise).then(
          (result) => ({ kind: "result", result }),
          (error) => ({
              kind: error?.code === "2FA_SETTINGS_CANCELLED" ? "cancelled" : "failed",
              error,
            })
        );
        void nativeCompletion.then((nativeOutcome) => outcomeGate.resolve(nativeOutcome));
        const completion = outcomeGate.promise;
        settingsCompletion = completion;
        settingsNativeCompletion = nativeCompletion;
        settingsOutcome = outcomeGate;
        const ocrController = new AbortController();
        settingsOcrController = ocrController;
        const ocrDeadline = runtime.now() + attemptTimeoutMs;
        const alertReady = Promise.race([
          Promise.resolve(request.alertReady).then((ready) => ready === true, () => false),
          nativeCompletion.then(() => false),
        ]);
        const ocrPromise = alertReady.then((ready) => {
          if (!ready || !settingsPhaseCanContinue(acquisition)) return null;
          return readSettingsOcrCandidate(acquisition, ocrDeadline, ocrController.signal);
        }).then((code) => {
          if (code) outcomeGate.resolve({ kind: "ocr", code });
        });
        settingsOcrPromise = ocrPromise;
        outcome = await completion;
        stopSettingsOcr(ocrController);
        if (settingsOcrPromise === ocrPromise) settingsOcrPromise = null;

        if (outcome.kind === "ocr") {
          const code = normalizeSixDigitCode(outcome.code);
          if (code && !rejectedCodes.has(code)) {
            audit({
              phase: "settings_provider_result",
              source: "vision",
              outcome: "candidate_ready",
              elapsedSincePrepareMs: elapsedSincePrepare(),
            });
            const cleanup = await cancelSettingsProvider("settings_ocr_won", {
              requireAlertCleanup: true,
            });
            if (cleanup.alertCleanupConfirmed) {
              const accepted = acquisition.offer({ source: "settings", code });
              if (accepted) lastSettingsCandidateAt = runtime.now();
              return;
            }
            outcome = {
              kind: "failed",
              error: cleanup.error ?? settingsAlertCleanupError(),
              failureReason: "settings_alert_cleanup_failed",
            };
          } else {
            await cancelSettingsProvider("settings_ocr_invalid");
            outcome = { kind: "failed" };
          }
        }
        if (outcome.kind !== "ocr" && settingsNativeCompletion === nativeCompletion) {
          settingsNativeCompletion = null;
        }
        if (settingsRequest === request) settingsRequest = null;
        if (settingsCompletion === completion) settingsCompletion = null;
        if (settingsOutcome === outcomeGate) settingsOutcome = null;

        if (outcome.kind === "result") {
          const code = normalizeSixDigitCode(outcome.result?.code);
          if (code && !rejectedCodes.has(code)) {
            audit({
              phase: "settings_provider_result",
              outcome: "candidate_ready",
              elapsedSincePrepareMs: elapsedSincePrepare(),
            });
            if (acquisition.offer({ source: "settings", code })) {
              lastSettingsCandidateAt = runtime.now();
            }
            return;
          }
          outcome = { kind: "failed" };
        }

      }

      outcome ??= { kind: "failed" };
      const failureReason =
        outcome.kind === "failed"
          ? outcome.failureReason ?? settingsFailureReason(outcome.error)
          : "settings_provider_failed";
      const accessibilityDenied = failureReason === "accessibility_denied";
      if (outcome.kind === "failed" && outcome.error) {
        diagnostic({
          source: "settings",
          phase: "settings_provider_failed",
          error: outcome.error,
        });
      }
      audit({
        phase:
          outcome.kind === "cancelled"
            ? "settings_provider_cancelled"
            : "settings_provider_failed",
        reason:
          outcome.kind === "cancelled"
            ? "cancelled"
            : failureReason,
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
      if (outcome.kind === "failed" && !disposed && !acquisition.winner.settled) {
        status("settings_failed", {
          attempt,
          source: "settings",
          remainingSec: remainingSeconds(acquisition.deadline),
        });
      }

      if (accessibilityDenied && config.settingsOnly && !settingsAccessibilityStatusSent) {
        settingsAccessibilityStatusSent = true;
        status("settings_accessibility", {
          attempt,
          source: "settings",
          remainingSec: remainingSeconds(acquisition.deadline),
        });
        audit({
          phase: "settings_accessibility",
          reason: "accessibility_denied",
          outcome: "unavailable",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
      }

      // mac-settings-2fa-code owns its own AX prompt. A popup-reader grant
      // cannot authorize that separate helper, so keep the bounded retry race
      // alive instead of waiting on the wrong TCC client.

      if (outcome.kind === "cancelled" || !settingsPhaseCanContinue(acquisition)) return;
      if (settingsAttempt >= MAX_SETTINGS_ATTEMPTS) return;

      const retryWaitMs = Math.min(
        SETTINGS_RETRY_DELAY_MS,
        Math.max(0, acquisition.deadline - runtime.now())
      );
      if (retryWaitMs <= 0) return;
      status("settings_retry", {
        attempt: attempt + 1,
        source: "settings",
        remainingSec: remainingSeconds(acquisition.deadline),
      });
      settingsStartDelay = scheduleDelay(retryWaitMs);
      const retryElapsed = await settingsStartDelay.promise;
      settingsStartDelay = null;
      if (!retryElapsed) return;
    }
  };

  const cancelSettingsProvider = async (reason, options = {}) => {
    const startDelay = settingsStartDelay;
    const request = settingsRequest;
    const completion = settingsCompletion;
    const nativeCompletion = settingsNativeCompletion;
    const outcomeGate = settingsOutcome;
    if (settingsStartDelay === startDelay) settingsStartDelay = null;
    startDelay?.cancel();
    stopSettingsOcr();
    if (!request || !completion || !nativeCompletion) {
      return { alertCleanupConfirmed: false, error: settingsAlertCleanupError() };
    }
    const existing = settingsCancelPromises.get(request);
    if (existing) return existing;

    const cleanup = (async () => {
      const cancelSignalled = request.cancel();
      audit({ phase: "settings_provider_cancel", reason, cancelSignalled });

      const cleanupTimeout = scheduleDelay(config.cleanupGraceMs);
      let nativeOutcome = null;
      const initialCleanup = await Promise.race([
        nativeCompletion.then((outcome) => ({ settled: true, outcome })),
        cleanupTimeout.promise.then(() => ({ settled: false })),
      ]);
      cleanupTimeout.cancel();
      if (initialCleanup.settled) {
        nativeOutcome = initialCleanup.outcome;
      } else {
        const forceStopped = request.forceStop();
        audit({ phase: "settings_provider_force_stop", reason, forceStopped });
        const forceWait = scheduleDelay(config.cleanupGraceMs);
        const forcedCleanup = await Promise.race([
          nativeCompletion.then((outcome) => ({ settled: true, outcome })),
          forceWait.promise.then(() => ({ settled: false })),
        ]);
        forceWait.cancel();
        audit({
          phase: "settings_provider_force_stop_cleanup",
          reason,
          closedAfterForce: forcedCleanup.settled,
        });
        if (forcedCleanup.settled) {
          nativeOutcome = forcedCleanup.outcome;
        } else {
          outcomeGate?.resolve({ kind: "cancelled" });
        }
      }
      const alertCleanupConfirmed =
        nativeOutcome?.kind === "result" || nativeOutcome?.error?.alertCleanupConfirmed === true;
      const error =
        nativeOutcome?.kind === "failed"
          ? nativeOutcome.error
          : alertCleanupConfirmed
            ? null
            : settingsAlertCleanupError();
      if (options.requireAlertCleanup === true && !alertCleanupConfirmed) {
        audit({
          phase: "settings_provider_cancel_cleanup_failed",
          reason: "settings_alert_cleanup_failed",
          alertCleanupConfirmed,
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
      }
      if (settingsRequest === request) settingsRequest = null;
      if (settingsCompletion === completion) settingsCompletion = null;
      if (settingsNativeCompletion === nativeCompletion) settingsNativeCompletion = null;
      if (settingsOutcome === outcomeGate) settingsOutcome = null;
      settingsOcrPromise = null;
      return { alertCleanupConfirmed, error };
    })();
    settingsCancelPromises.set(request, cleanup);
    try {
      return await cleanup;
    } finally {
      settingsCancelPromises.delete(request);
    }
  };

  const abortManualProvider = async () => {
    manualStartDelay?.cancel();
    manualStartDelay = null;
    const controller = manualAbortController;
    const completion = manualCompletion;
    manualAbortController = null;
    manualCompletion = null;
    controller?.abort();
    if (completion) {
      void completion.catch(() => {});
      await Promise.resolve();
    }
  };

  const beginManualFallback = (acquisition) => {
    if (
      disposed ||
      activeAcquisition !== acquisition ||
      acquisition.winner.settled ||
      providerPhase === "manual"
    ) {
      return providerPhase === "manual";
    }
    if (providerPhase !== "popup" && providerPhase !== "settings") return false;

    providerPhase = "manual";
    pendingAllowAttempt = null;
    manualAllowAwaitingConfirmation = false;
    manualAllowDisappearanceHits = 0;
    popupConfirmationPolling = false;
    resetPendingPopupClose();
    abortPopupReadTasks();
    abortPopupAccessibilityPrompt();
    audit({
      phase: "manual_fallback_start",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });
    return true;
  };

  const startManualProvider = async (acquisition) => {
    if (!config.manualFallback) return;
    if (disposed || acquisition.winner.settled || activeAcquisition !== acquisition) return;
    if (!isTTY) {
      if (!manualUnavailableStatusSent) {
        manualUnavailableStatusSent = true;
        status("manual_unavailable", {
          source: "manual",
          remainingSec: remainingSeconds(acquisition.deadline),
        });
        audit({
          phase: "manual_provider_unavailable",
          source: "manual",
          reason: "tty_unavailable",
          outcome: "unavailable",
          elapsedSincePrepareMs: elapsedSincePrepare(),
        });
      }
      return;
    }
    const latestManualStartAt = Math.max(
      sharedAcquisitionStartedAt,
      acquisition.deadline - MIN_MANUAL_INPUT_WINDOW_MS
    );
    const startsAt = Math.min(
      sharedAcquisitionStartedAt + MANUAL_FALLBACK_AFTER_MS,
      latestManualStartAt
    );
    const waitMs = Math.max(0, startsAt - runtime.now());
    if (waitMs > 0) {
      manualStartDelay = scheduleDelay(waitMs);
      const elapsed = await manualStartDelay.promise;
      manualStartDelay = null;
      if (!elapsed) return;
    }
    if (disposed || acquisition.winner.settled || activeAcquisition !== acquisition) return;
    if (!beginManualFallback(acquisition)) return;

    const timeoutMs = acquisition.deadline - runtime.now();
    if (timeoutMs <= 0) return;
    const controller = new AbortController();
    manualAbortController = controller;
    status("manual_code", {
      attempt: acquisition.generation,
      source: "manual",
      remainingSec: remainingSeconds(acquisition.deadline),
    });
    const completion = Promise.resolve()
      .then(() => manualCodeProvider({ signal: controller.signal, timeoutMs }))
      .then((value) => {
        if (
          disposed ||
          controller.signal.aborted ||
          activeAcquisition !== acquisition ||
          acquisition.winner.settled
        ) {
          return;
        }
        const code = typeof value === "string" && /^[0-9]{6}$/.test(value) ? value : null;
        if (!code || rejectedCodes.has(code)) return;
        acquisition.offer({ source: "manual", code });
      })
      .catch(() => {});
    manualCompletion = completion;
    await completion;
    if (manualAbortController === controller) manualAbortController = null;
    if (manualCompletion === completion) manualCompletion = null;
  };

  const stopAcquisitionLosers = async (winnerSource, reason) => {
    const providerPromise = settingsProviderPromise;
    abortPopupAccessibilityPrompt();
    settingsStartDelay?.cancel();
    manualStartDelay?.cancel();
    const settingsCancellation =
      winnerSource !== "settings" ? cancelSettingsProvider(reason) : null;
    const manualAbort = abortManualProvider();
    await manualAbort;
    if (settingsCancellation) await settingsCancellation;
    if (providerPromise && winnerSource !== "settings") {
      try {
        await providerPromise;
      } catch {
        /* provider errors were already reduced to fixed audit states */
      }
    }
  };

  const startWinnerCleanup = (generation, winnerSource, reason) => {
    const existing = winnerCleanupPromises.get(generation);
    if (existing) return existing;
    const cleanup = stopAcquisitionLosers(winnerSource, reason)
      .catch(() => {
        /* Cleanup failure must not prevent the verified code from being delivered. */
      });
    let trackedCleanup;
    trackedCleanup = cleanup.finally(() => {
      if (winnerCleanupPromises.get(generation) === trackedCleanup) {
        winnerCleanupPromises.delete(generation);
      }
    });
    winnerCleanupPromises.set(generation, trackedCleanup);
    return trackedCleanup;
  };

  const initializeGeneration = (generation, rejectPrevious, startedAt) => {
    providerPhase = config.settingsOnly ? "settings" : "popup";
    // The popup-primary window belongs to the web request, not to a helper's
    // process lifetime. A stale AX probe may ignore Abort, but it is fenced by
    // generation and must not indefinitely block the serial Settings/manual
    // fallback chain. New AX probes still remain single-flight until it exits.
    popupPrimaryReadyAt = startedAt;
    lastPopupAllowAt = null;
    manualAllowAwaitingConfirmation = false;
    manualAllowDisappearanceHits = 0;
    popupFallbackConfirmationGraceUsed = false;
    popupConfirmationPolling = false;
    if (generation === 2) abortPopupProbe();
    // A configured poll interval can be much longer than popup-primary. Every
    // new browser code request must wake a sleeping watcher immediately so the
    // AX/OCR primary path gets its full configured window.
    requestPopupWatcherRestart();
    if (generation !== 2) return;
    abortPopupCloseTasks();
    abortPopupReadTasks();
    if ((rejectPrevious || generation === 2) && lastReturnedCode) {
      rejectedCodes.add(lastReturnedCode);
    }
    popupGeneration = generation;
    settledWinner = null;
    popupCandidate = null;
    popupReady = createDeferred();
    cleanupOnly = false;
    pendingAllowAttempt = null;
    resetPendingPopupClose();
  };

  const acquireCode = async ({ generation, rejectPrevious }) => {
    if (!prepared) throw new Error("2FA collector must be prepared before requesting a code");
    if (disposed) throw new Error("2FA collector is disposed");
    if ((generation !== 1 && generation !== 2) || generation !== lastRequestedGeneration + 1) {
      throw new Error("2FA generation must be 1 then 2 exactly once");
    }
    if (activeAcquisition) throw new Error("a 2FA acquisition is already active");

    lastRequestedGeneration = generation;
    const startedAt = runtime.now();
    if (sharedDeadline == null) {
      sharedAcquisitionStartedAt = startedAt;
      sharedDeadline = sharedAcquisitionStartedAt + config.timeoutMs;
    }
    initializeGeneration(generation, rejectPrevious, startedAt);

    audit({
      phase: "2fa_acquisition_requested",
      elapsedSincePrepareMs: elapsedSincePrepare(),
    });

    const winner = createDeferred();
    const acquisition = {
      winner,
      generation,
      startedAt,
      deadline: sharedDeadline,
      offer(candidate) {
        if (
          disposed ||
          activeAcquisition !== acquisition ||
          candidate?.generation != null && candidate.generation !== generation ||
          rejectedCodes.has(candidate?.code)
        ) {
          return false;
        }
        if (runtime.now() >= acquisition.deadline) {
          expireAcquisition();
          return false;
        }
        return winner.resolve(candidate);
      },
    };
    const expireAcquisition = () => {
      if (
        disposed ||
        activeAcquisition !== acquisition ||
        acquisition.winner.settled
      ) {
        return false;
      }
      cleanupOnly = true;
      pendingAllowAttempt = null;
      abortPopupReadTasks();
      if (!timeoutStatusSent) {
        timeoutStatusSent = true;
        status("timeout", { remainingSec: 0 });
      }
      acquisition.winner.reject(new Error("macOS 2FA 验证码获取超时"));
      return true;
    };
    activeAcquisition = acquisition;
    if (lastProbeState === "accessibility_unavailable") {
      startPopupAccessibilityPrompt(acquisition.deadline);
    }
    if (!config.settingsOnly) {
      status("popup_primary", {
        source: "popup",
        remainingSec: remainingSeconds(acquisition.deadline),
      });
      audit({
        phase: "popup_primary_start",
        generation,
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
      popupReady.promise.then((candidate) => acquisition.offer(candidate));
      if (popupCandidate?.generation === generation) acquisition.offer(popupCandidate);
    }

    const remainingMs = Math.max(0, acquisition.deadline - runtime.now());
    const deadlineDelay = scheduleDelay(remainingMs);
    deadlineDelay.promise.then((elapsed) => {
      if (elapsed) expireAcquisition();
    });
    settingsProviderPromise = startSettingsProvider(acquisition).catch(() => {
      audit({
        phase: "settings_provider_failed",
        reason: "settings_provider_failed",
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
    });
    void settingsProviderPromise
      .then(() => startManualProvider(acquisition))
      .catch(() => {
        /* Manual fallback failures are intentionally kept out of provider diagnostics. */
      });

    let candidate = null;
    try {
      candidate = await winner.promise;
      abortPopupReadTasks();
      settledWinner = { generation, source: candidate.source };
      if (candidate.source !== "popup") {
        cleanupOnly = true;
        pendingAllowAttempt = null;
      }
      const winnerCleanup = startWinnerCleanup(
        acquisition.generation,
        candidate.source,
        `${candidate.source}_won`
      );

      audit({
        phase: "2fa_winner",
        source: candidate.source,
        elapsedSincePrepareMs: elapsedSincePrepare(),
      });
      status("winner", {
        source: candidate.source,
        remainingSec: remainingSeconds(acquisition.deadline),
      });
      // Popup is the primary web-login source. Its verified code must reach
      // ruyiPage immediately; native popup-close and any cancelled fallback
      // cleanup remain best-effort background work.
      if (candidate.source !== "popup") await winnerCleanup;
      else void winnerCleanup;
      lastReturnedCode = candidate.code;
      return candidate.code;
    } finally {
      deadlineDelay.cancel();
      if (!candidate) {
        await stopAcquisitionLosers(null, "acquisition_finished");
      }
      if (activeAcquisition === acquisition) activeAcquisition = null;
      if (!candidate && settingsProviderPromise) {
        try {
          await settingsProviderPromise;
        } catch {
          /* fixed audit state already recorded */
        }
        settingsProviderPromise = null;
      }
    }
  };

  const getCode = async ({ generation = 1, rejectPrevious = false } = {}) => {
    return acquireCode({ generation, rejectPrevious });
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    const popupProbeAtDispose = popupProbe?.nativeProbeStarted ? popupProbe : null;
    abortPopupAccessibilityPrompt();
    abortPopupCloseTasks();
    abortPopupReadTasks();
    abortPopupProbe();
    popupWatcherController?.abort();
    manualAbortController?.abort();
    activeAcquisition?.winner.reject(new Error("2FA collector was disposed"));
    cancelAllDelays();

    disposePromise = (async () => {
      let prepareFailure = null;
      if (preparePromise) {
        try {
          await preparePromise;
        } catch (error) {
          if (error?.code !== "2FA_PREPARE_DISPOSED") prepareFailure = error;
        }
      }
      await cancelSettingsProvider("collector_disposed");
      await abortManualProvider();
      await Promise.all([...winnerCleanupPromises.values()]);
      if (settingsProviderPromise) {
        try {
          await settingsProviderPromise;
        } catch {
          /* fixed audit state already recorded */
        }
      }
      const popupDisposeGraceMs = Math.min(
        POPUP_WATCHER_DISPOSE_GRACE_MS,
        Math.max(0, config.cleanupGraceMs)
      );
      let popupProbeSettled = true;
      if (popupProbeAtDispose) {
        const probeOutcome = await awaitWithin(popupProbeAtDispose.promise, popupDisposeGraceMs);
        popupProbeSettled =
          probeOutcome.kind === "fulfilled" || probeOutcome.kind === "rejected";
        if (!popupProbeSettled) {
          audit({
            phase: "popup_dispose_cleanup_failed",
            reason: "watcher_shutdown_timeout",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        }
      }
      if (popupProbeSettled && prepared && runtime.platform === "darwin" && !config.settingsOnly) {
        const cleanupController = new AbortController();
        const probeOutcome = await awaitWithin(
          Promise.resolve().then(() =>
            runtime.probe2FAState(2, { signal: cleanupController.signal })
          ),
          popupDisposeGraceMs
        );
        if (probeOutcome.kind !== "fulfilled") {
          cleanupController.abort();
          audit({
            phase: "popup_dispose_cleanup_failed",
            reason: "dispose_probe_or_cleanup_failed",
            elapsedSincePrepareMs: elapsedSincePrepare(),
          });
        } else if (probeOutcome.value?.action === "has_code_dialog") {
          const cleanupOutcome = await awaitWithin(
            Promise.resolve().then(() =>
              runtime.runPopupPhase("dismiss_stale", 2, {
                signal: cleanupController.signal,
                compileIfNeeded: false,
              })
            ),
            popupDisposeGraceMs
          );
          if (cleanupOutcome.kind !== "fulfilled") {
            cleanupController.abort();
            audit({
              phase: "popup_dispose_cleanup_failed",
              reason: "dispose_probe_or_cleanup_failed",
              elapsedSincePrepareMs: elapsedSincePrepare(),
            });
          } else {
            audit({
              phase: "popup_dispose_cleanup",
              action: cleanupOutcome.value?.action ?? "none",
              elapsedSincePrepareMs: elapsedSincePrepare(),
            });
          }
        }
      }
      cancelAllDelays();
      if (prepareFailure) throw prepareFailure;
    })();
    return disposePromise;
  };

  return { prepare, getCode, dispose };
}
