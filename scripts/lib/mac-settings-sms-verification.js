import { promptForHiddenVerificationCode } from "./manual-verification-prompt.js";
import { runMacSettingsSmsHelper } from "./mac-settings-sms-ax.js";
import { sleep } from "./prompt.js";

const VALID_STAGES = new Set(["phone_selection", "code_entry", "code_pending", "waiting"]);
const SMS_STATE_REASONS = new Set([
  "no_trusted_surface",
  "phone_code_transition",
  "code_surface_unready",
  "ambiguous_sms_surface",
  "surface_unclassified",
  "code_value_unreadable",
]);
const SIX_DIGIT_CODE_RE = /^[0-9]{6}$/;
const TWO_DIGIT_SUFFIX_RE = /^[0-9]{2}$/;
function failure(code) { const error = new Error(code); error.code = code; return error; }
function readRemainingMs(deadline, now) { return Math.max(0, deadline - now()); }
function boundedPositiveInteger(value, fallback, errorCode) { const candidate = value ?? fallback; if (!Number.isFinite(candidate) || candidate <= 0) throw failure(errorCode); const normalized = Math.trunc(candidate); if (normalized <= 0) throw failure(errorCode); return normalized; }
export function trustedPhoneSuffix(phoneNumber) { const raw = String(phoneNumber ?? "").trim(); if (!/^\+?[0-9()\s.-]+$/.test(raw)) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID"); const digits = raw.replace(/\D/g, ""); if (digits.length < 4) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID"); return digits.slice(-2); }
export function normalizeManualSmsCode(value) { const code = typeof value === "string" ? value.trim() : ""; return SIX_DIGIT_CODE_RE.test(code) ? code : null; }
export function normalizeMacSettingsSmsState(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return { ok: false, stage: "invalid" };
  const stage = VALID_STAGES.has(value.stage) ? value.stage : "invalid";
  const reason = SMS_STATE_REASONS.has(value.reason) ? value.reason : undefined;
  return { ok: true, stage, ...(reason ? { reason } : {}) };
}
function requireSupervisedSession({ platform, supervised, isTTY }) { if (platform !== "darwin") throw failure("MAC_SETTINGS_SMS_UNSUPPORTED_PLATFORM"); if (supervised !== true) throw failure("MAC_SETTINGS_SMS_SUPERVISION_REQUIRED"); if (isTTY !== true) throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED"); }
async function readCodeWithinDeadline(provider, { signal, timeoutMs }) { let removeAbortListener = () => {}; const aborted = new Promise((resolve) => { const onAbort = () => resolve(null); if (signal.aborted) { onAbort(); return; } signal.addEventListener("abort", onAbort, { once: true }); removeAbortListener = () => signal.removeEventListener("abort", onAbort); }); try { return await Promise.race([Promise.resolve().then(() => provider({ signal, timeoutMs })).catch(() => null), aborted]); } finally { removeAbortListener(); } }
async function defaultNativeRunner(phase, options) { return runMacSettingsSmsHelper(phase, options); }

/** Complete supervised Mac Settings SMS verification. Provider polling is independent from browser 2FA and falls back to hidden local entry. */
export async function completeSupervisedMacSettingsSmsVerification(options = {}) {
  const suffix = trustedPhoneSuffix(options.phoneNumber);
  const platform = options.platform ?? process.platform;
  const supervised = options.supervised ?? process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const isTTY = options.isTTY ?? Boolean(process.stdin?.isTTY === true && (process.stdout?.isTTY === true || supervised === true));
  requireSupervisedSession({ platform, supervised, isTTY });
  const codeProvider = options.codeProvider ?? null;
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, codeProvider ? 420_000 : 120_000, "MAC_SETTINGS_SMS_TIMEOUT_INVALID");
  // Keep provider polling inside the overall SMS deadline.  The old fixed
  // 120-second budget could fall back to manual entry while the mandatory
  // code page was still waiting on a slow provider/network.
  const providerTimeoutMs = boundedPositiveInteger(
    options.codePollTimeoutMs ?? options.providerTimeoutMs,
    timeoutMs,
    "MAC_SETTINGS_SMS_PROVIDER_TIMEOUT_INVALID"
  );
  const manualTimeoutMs = boundedPositiveInteger(options.manualTimeoutMs, 300_000, "MAC_SETTINGS_SMS_MANUAL_TIMEOUT_INVALID");
  const pollIntervalMs = Math.max(50, boundedPositiveInteger(options.pollIntervalMs, 500, "MAC_SETTINGS_SMS_POLL_INTERVAL_INVALID"));
  const stateReadAttempts = boundedPositiveInteger(options.stateReadAttempts, 3, "MAC_SETTINGS_SMS_STATE_ATTEMPTS_INVALID");
  const maxStateFailureWindows = boundedPositiveInteger(
    options.maxStateFailureWindows,
    5,
    "MAC_SETTINGS_SMS_STATE_FAILURE_WINDOWS_INVALID"
  );
  // System Settings can leave the AX tree temporarily blank while the SMS
  // surface is hydrated over the network.  A short run of failed snapshots is
  // only a diagnostic threshold; it is not proof that the mandatory six-cell
  // page will never appear.  Keep observing the same SMS module for this
  // bounded window before requesting a supervised manual handoff.
  const surfaceUnreadyGraceMs = boundedPositiveInteger(
    options.surfaceUnreadyGraceMs,
    Math.min(timeoutMs, 120_000),
    "MAC_SETTINGS_SMS_SURFACE_UNREADY_GRACE_INVALID"
  );
  const stableCodeEntryReads = boundedPositiveInteger(
    options.stableCodeEntryReads,
    2,
    "MAC_SETTINGS_SMS_STABLE_CODE_READS_INVALID"
  );
  const maxActionAttempts = boundedPositiveInteger(options.maxActionAttempts, 3, "MAC_SETTINGS_SMS_ACTION_ATTEMPTS_INVALID");
  const actionRetryDelayMs = Math.max(
    pollIntervalMs,
    boundedPositiveInteger(options.actionRetryDelayMs, 1_500, "MAC_SETTINGS_SMS_ACTION_RETRY_DELAY_INVALID")
  );
  const phoneTransitionGraceMs = boundedPositiveInteger(
    options.phoneTransitionGraceMs,
    90_000,
    "MAC_SETTINGS_SMS_PHONE_TRANSITION_GRACE_INVALID"
  );
  const codeTransitionGraceMs = boundedPositiveInteger(
    options.codeTransitionGraceMs,
    90_000,
    "MAC_SETTINGS_SMS_CODE_TRANSITION_GRACE_INVALID"
  );
  // SMS provider cadence is a user-visible contract: one request every five
  // seconds.  Keep a small lower bound for focused tests, but use 5_000ms in
  // production unless a caller explicitly supplies a test/diagnostic value.
  const providerPollIntervalMs = Math.max(
    250,
    boundedPositiveInteger(
      options.providerPollIntervalMs,
      5_000,
      "MAC_SETTINGS_SMS_PROVIDER_POLL_INTERVAL_INVALID"
    )
  );
  const manualContinuationGraceMs = boundedPositiveInteger(
    options.manualContinuationGraceMs,
    300_000,
    "MAC_SETTINGS_SMS_MANUAL_CONTINUATION_GRACE_INVALID"
  );
  const phaseTimeouts = {
    "sms-state": boundedPositiveInteger(
      options.stateProbeTimeoutMs,
      8_000,
      "MAC_SETTINGS_SMS_STATE_PROBE_TIMEOUT_INVALID"
    ),
    "sms-select": boundedPositiveInteger(
      options.phoneSelectTimeoutMs,
      12_000,
      "MAC_SETTINGS_SMS_PHONE_SELECT_TIMEOUT_INVALID"
    ),
    "sms-continue": boundedPositiveInteger(
      options.phoneContinueTimeoutMs,
      12_000,
      "MAC_SETTINGS_SMS_PHONE_CONTINUE_TIMEOUT_INVALID"
    ),
    "sms-code": boundedPositiveInteger(
      options.codeWriteTimeoutMs,
      12_000,
      "MAC_SETTINGS_SMS_CODE_WRITE_TIMEOUT_INVALID"
    ),
  };
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const nativeRunner = options.nativeRunner ?? defaultNativeRunner;
  const manualCodeProvider = options.manualCodeProvider ?? promptForHiddenVerificationCode;
  const manualContinuation = typeof options.manualContinuation === "function"
    ? options.manualContinuation
    : null;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  let deadline = now() + timeoutMs;
  let lastProgress = null;
  let stateFailures = 0;
  let surfaceUnavailableStartedAt = null;
  let waitingSurfaceStartedAt = null;
  let waitingSurfaceObservations = 0;
  let phoneSelectionAttempts = 0;
  let codeSubmissionAttempts = 0;
  let codeSurfaceFailures = 0;
  let verificationCode = null;
  let manualPhoneHandoffPending = false;
  let manualSurfaceHandoffPending = false;
  let manualCodeHandoffPending = false;
  let phoneTransitionPendingUntil = 0;
  let codeTransitionPendingUntil = 0;
  let codeEntryObserved = false;
  let codeWriteAttempted = false;
  let postCodeWaitingObservations = 0;
  let manualPostCodeWaitingObservations = 0;
  let providerPolls = 0;
  const repeatableProgressEvents = new Set([
    "code_provider_poll_started",
    "code_provider_poll_empty",
  ]);

  const reportEvent = (event, details = {}) => {
    if (!onEvent) return;
    try {
      onEvent({ module: "sms", event, ...details });
    } catch {
      // Audit delivery must never interrupt a supervised verification run.
    }
  };
  const reportProgress = (event, details = {}) => {
    reportEvent(event, details);
    if (!onProgress || (lastProgress === event && !repeatableProgressEvents.has(event))) return;
    lastProgress = event;
    try {
      onProgress({ event, ...details });
    } catch {
      // Progress rendering must never interrupt verification.
    }
  };
  const invokeNative = async (phase, values = {}) => {
    const remainingMs = readRemainingMs(deadline, now);
    if (remainingMs <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
    const timeoutMsForPhase = Math.min(remainingMs, phaseTimeouts[phase] ?? remainingMs);
    reportEvent("native_call_started", { phase, timeoutMs: timeoutMsForPhase });
    let result;
    try {
      result = await nativeRunner(phase, { ...values, timeoutMs: timeoutMsForPhase });
    } catch {
      reportEvent("native_call_failed", { phase });
      throw failure("MAC_SETTINGS_SMS_NATIVE_FAILED");
    }
    reportEvent("native_call_completed", {
      phase,
      ok: result?.ok === true,
      stage: VALID_STAGES.has(result?.stage) || ["selected", "continued", "code_submitted"].includes(result?.stage)
        ? result.stage
        : "invalid",
      reason: typeof result?.reason === "string" ? result.reason : "ok",
    });
    if (readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT");
    return result;
  };
  const acquireCode = async (provider, maxMs) => {
    const availableMs = Math.min(maxMs, readRemainingMs(deadline, now));
    if (availableMs <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), availableMs);
    try {
      const value = await readCodeWithinDeadline(provider, {
        signal: controller.signal,
        timeoutMs: availableMs,
      });
      return controller.signal.aborted ? null : normalizeManualSmsCode(value);
    } finally {
      clearTimeout(timer);
    }
  };
  const pollProviderUntilCode = async (provider) => {
    if (typeof provider !== "function") return null;
    const pollDeadline = Math.min(deadline, now() + providerTimeoutMs);
    while (readRemainingMs(pollDeadline, now) > 0) {
      providerPolls += 1;
      const pollStartedAt = now();
      const requestBudget = Math.min(readRemainingMs(pollDeadline, now), providerPollIntervalMs);
      reportProgress("code_provider_poll_started", {
        polls: providerPolls,
        timeoutMs: requestBudget,
        pollIntervalMs: providerPollIntervalMs,
      });
      const value = await acquireCode(provider, requestBudget);
      if (value) {
        reportEvent("code_provider_code_ready", { polls: providerPolls });
        return value;
      }
      const elapsedMs = Math.max(0, now() - pollStartedAt);
      reportProgress("code_provider_poll_empty", {
        polls: providerPolls,
        elapsedMs,
        pollIntervalMs: providerPollIntervalMs,
      });
      if (readRemainingMs(pollDeadline, now) <= 0) break;
      // Schedule by poll start time, not by response completion time.  A slow
      // request cannot silently stretch the configured 5-second cadence.
      const elapsedWithinInterval = Math.min(providerPollIntervalMs, elapsedMs);
      const waitMs = Math.min(
        Math.max(0, providerPollIntervalMs - elapsedWithinInterval),
        readRemainingMs(pollDeadline, now)
      );
      if (waitMs > 0 && !(await waitBounded(waitMs))) {
        break;
      }
    }
    return null;
  };
  const waitBounded = async (milliseconds) => {
    const remainingMs = readRemainingMs(deadline, now);
    if (remainingMs <= 0) return false;
    await pause(Math.min(milliseconds, remainingMs));
    return readRemainingMs(deadline, now) > 0;
  };
  const readStableSmsState = async () => {
    let previousStage = null;
    let consecutive = 0;
    for (let attempt = 0; attempt < stateReadAttempts; attempt += 1) {
      let rawState = null;
      try {
        rawState = await invokeNative("sms-state", { suffix });
      } catch (error) {
        if (error?.code === "MAC_SETTINGS_SMS_TIMEOUT") throw error;
      }
      const state = normalizeMacSettingsSmsState(rawState);
      reportEvent("state_probe", {
        probeAttempt: attempt + 1,
        stage: state.stage,
        ok: state.ok,
        stableReads: consecutive,
        ...(state.reason ? { reason: state.reason } : {}),
      });
      if (state.ok && state.stage !== "invalid") {
        if (state.stage === previousStage) consecutive += 1;
        else {
          previousStage = state.stage;
          consecutive = 1;
        }
        const requiredReads = state.stage === "code_entry" ? stableCodeEntryReads : 1;
        if (consecutive >= requiredReads) {
          reportEvent("state_stable", {
            stage: state.stage,
            stableReads: consecutive,
            ...(state.reason ? { reason: state.reason } : {}),
          });
          return state;
        }
      } else {
        previousStage = null;
        consecutive = 0;
      }
      if (attempt + 1 < stateReadAttempts) {
        await waitBounded(pollIntervalMs);
      }
    }
    return null;
  };
  const finishManualModule = async (stage, reason, attempts = 0) => {
    if (!manualContinuation) return false;
    reportProgress("manual_required", { stage, reason, attempts });
    try {
      const resumed = (await manualContinuation({ module: "sms", stage, reason, attempts })) === true;
      if (resumed) {
        // An Enter acknowledges a supervised handoff and grants enough time to
        // re-probe the dynamic surface. It never by itself proves login.
        deadline = Math.max(deadline, now() + manualContinuationGraceMs);
      }
      return resumed;
    } catch {
      return false;
    }
  };
  const beginManualCodeHandoff = async (reason) => {
    if (!(await finishManualModule("code_entry", reason, codeSubmissionAttempts))) return false;
    manualCodeHandoffPending = true;
    manualPostCodeWaitingObservations = 0;
    verificationCode = null;
    reportProgress("manual_sms_step_confirmed", { stage: "code_entry" });
    return true;
  };
  while (true) {
    if (readRemainingMs(deadline, now) <= 0) {
      // A visible code page is a safe, supervised handoff point.  Enter gives
      // the operator another bounded observation window; it does not claim
      // that Apple accepted the code or skip the mandatory transition checks.
      if (codeEntryObserved && await beginManualCodeHandoff("timeout")) continue;
      throw failure("MAC_SETTINGS_SMS_TIMEOUT");
    }
    const state = await readStableSmsState();
    if (!state) {
      stateFailures += 1;
      if (surfaceUnavailableStartedAt === null) surfaceUnavailableStartedAt = now();
      const surfaceUnavailableElapsedMs = Math.max(0, now() - surfaceUnavailableStartedAt);
      if (manualSurfaceHandoffPending) {
        // The six-cell page is mandatory. A manual acknowledgement only helps
        // recover the currently blank/transitioning Settings surface; it never
        // proves the SMS module is complete or permits post-SMS to start.
        reportProgress("manual_sms_code_entry_waiting", {
          stage: "surface_unavailable",
          attempts: stateFailures,
          elapsedMs: surfaceUnavailableElapsedMs,
        });
        reportEvent("manual_surface_reprobe_waiting", {
          attempts: stateFailures,
          elapsedMs: surfaceUnavailableElapsedMs,
        });
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (stateFailures >= maxStateFailureWindows && surfaceUnavailableElapsedMs < surfaceUnreadyGraceMs) {
        // The old implementation switched to manual handling after a handful
        // of sub-second probes.  That race is common between the phone picker
        // and the mandatory six-cell page on a slow network.  Keep probing;
        // provider polling remains impossible until `code_entry` is stable.
        reportProgress("sms_surface_loading", {
          attempts: stateFailures,
          elapsedMs: surfaceUnavailableElapsedMs,
        });
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (stateFailures >= maxStateFailureWindows) {
        if (await finishManualModule("surface_unavailable", "state_unavailable", stateFailures)) {
          // The six-cell page is mandatory. Enter only acknowledges the
          // handoff; continue probing until that page is observed and its
          // transition is confirmed. Never jump directly to post-SMS here.
          manualSurfaceHandoffPending = true;
          stateFailures = 0;
          surfaceUnavailableStartedAt = null;
          reportProgress("manual_sms_step_confirmed", { stage: "surface_unavailable" });
          continue;
        }
        throw failure("MAC_SETTINGS_SMS_STATE_UNAVAILABLE");
      }
      await waitBounded(pollIntervalMs);
      continue;
    }

    stateFailures = 0;
    surfaceUnavailableStartedAt = null;
    if (state.stage !== "waiting") {
      waitingSurfaceStartedAt = null;
      waitingSurfaceObservations = 0;
    }
    if (manualSurfaceHandoffPending && state.stage === "code_entry") {
      manualSurfaceHandoffPending = false;
      reportProgress("code_entry_detected", { attempts: codeSubmissionAttempts });
    }
    if (state.stage !== "phone_selection") phoneTransitionPendingUntil = 0;
    if (manualCodeHandoffPending) {
      // The operator owns this six-cell page until a real transition is
      // observed. A persistent AXValue-unreadable `code_entry` is not a new
      // empty form, so it must neither trigger another prompt nor replay the
      // code while the manual handoff is pending.
      if (state.stage === "code_entry" || state.stage === "code_pending") {
        reportProgress("manual_code_transition_waiting", { stage: "code_entry" });
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (state.stage === "waiting") {
        manualPostCodeWaitingObservations += 1;
        reportEvent("manual_code_transition_probe", {
          observations: manualPostCodeWaitingObservations,
        });
        if (manualPostCodeWaitingObservations >= 2) {
          manualCodeHandoffPending = false;
          verificationCode = null;
          codeSubmissionAttempts = 0;
          codeSurfaceFailures = 0;
          reportProgress("manual_sms_step_advanced", { stage: "code_entry" });
          return { status: "manual_completed", stage: "code_entry" };
        }
        await waitBounded(pollIntervalMs);
        continue;
      }
      manualCodeHandoffPending = false;
      verificationCode = null;
      codeSubmissionAttempts = 0;
      codeSurfaceFailures = 0;
    }
    if (codeEntryObserved && codeWriteAttempted) {
      if (state.stage === "code_pending") {
        reportProgress("code_transition_waiting", { attempts: codeSubmissionAttempts });
        if (now() >= codeTransitionPendingUntil) {
          if (await beginManualCodeHandoff("code_transition_timeout")) continue;
          throw failure("MAC_SETTINGS_SMS_CODE_FILL_FAILED");
        }
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (state.stage === "waiting") {
        // The helper reports `code_pending` while the populated six-cell group
        // remains visible. Only after it disappears do two independent waiting
        // observations hand control to the optional post-SMS modules.
        postCodeWaitingObservations += 1;
        reportEvent("code_transition_probe", {
          attempts: codeSubmissionAttempts,
          observations: postCodeWaitingObservations,
        });
        if (postCodeWaitingObservations >= 2) {
          reportProgress("code_transition_observed", { attempts: codeSubmissionAttempts });
          return { status: "submitted" };
        }
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (state.stage === "code_entry") {
        if (state.reason === "code_value_unreadable") {
          // SwiftUI can keep AXValue absent after the six digits were written.
          // That is not evidence of a fresh empty form, so wait for the bounded
          // transition before escalating instead of replaying the same code.
          reportEvent("code_transition_unreadable", { attempts: codeSubmissionAttempts });
          reportProgress("code_transition_waiting", { attempts: codeSubmissionAttempts });
          if (now() >= codeTransitionPendingUntil) {
            if (await beginManualCodeHandoff("code_value_unreadable")) continue;
            throw failure("MAC_SETTINGS_SMS_CODE_FILL_FAILED");
          }
          await waitBounded(pollIntervalMs);
          continue;
        }
        // A fresh, empty six-cell group means the native write did not survive
        // the page transition. It is safe to use one of the remaining bounded
        // attempts; do not classify it as an accepted submission.
        reportEvent("code_surface_reset", { attempts: codeSubmissionAttempts });
        codeWriteAttempted = false;
        codeTransitionPendingUntil = 0;
        postCodeWaitingObservations = 0;
        await waitBounded(actionRetryDelayMs);
        continue;
      }
      if (state.stage === "phone_selection") {
        reportEvent("code_surface_returned_to_phone_selection");
        verificationCode = null;
        codeSubmissionAttempts = 0;
        codeSurfaceFailures = 0;
        codeEntryObserved = false;
        codeWriteAttempted = false;
        codeTransitionPendingUntil = 0;
        postCodeWaitingObservations = 0;
      }
    }
    if (state.stage === "waiting") {
      // `waiting` is valid during a remote Settings transition, but it must
      // not turn an unrecognised live SMS page into an invisible loop. Keep a
      // bounded observation window before asking the supervised operator to
      // complete the current page and resume the same scanner.
      if (waitingSurfaceStartedAt === null) waitingSurfaceStartedAt = now();
      waitingSurfaceObservations += 1;
      const elapsedMs = Math.max(0, now() - waitingSurfaceStartedAt);
      const waitingDetails = {
        observations: waitingSurfaceObservations,
        elapsedMs,
        ...(state.reason ? { reason: state.reason } : {}),
      };
      if (manualSurfaceHandoffPending) {
        reportEvent("waiting_for_sms_surface", waitingDetails);
        reportEvent("manual_surface_reprobe_waiting", {
          attempts: waitingSurfaceObservations,
          elapsedMs,
        });
        // Keep this handoff inside the mandatory SMS state machine. The next
        // module may only run after a stable `code_entry`, a provider/manual
        // code write, and the observed code-page transition.
        reportProgress("manual_sms_code_entry_waiting", {
          stage: "surface_unavailable",
          ...waitingDetails,
        });
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (elapsedMs < surfaceUnreadyGraceMs) {
        reportProgress(
          waitingSurfaceObservations === 1 ? "waiting_for_sms_surface" : "sms_surface_loading",
          waitingDetails
        );
        await waitBounded(pollIntervalMs);
        continue;
      }
      reportEvent("waiting_for_sms_surface", waitingDetails);
      if (await finishManualModule("surface_unavailable", "state_waiting", waitingSurfaceObservations)) {
        manualSurfaceHandoffPending = true;
        waitingSurfaceStartedAt = null;
        waitingSurfaceObservations = 0;
        reportProgress("manual_sms_step_confirmed", { stage: "surface_unavailable" });
        await waitBounded(pollIntervalMs);
        continue;
      }
      throw failure("MAC_SETTINGS_SMS_STATE_UNAVAILABLE");
    }
    if (state.stage === "phone_selection") {
      reportProgress("phone_selection_detected", { attempts: phoneSelectionAttempts });
      if (manualPhoneHandoffPending) {
        // Enter acknowledges the operator's action; it is not proof that the
        // SMS module is finished.  Keep scanning until the mandatory six-cell
        // page or a later state is actually observed.
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (phoneTransitionPendingUntil > now()) {
        reportProgress("phone_selection_transition_waiting");
        await waitBounded(pollIntervalMs);
        continue;
      }
      phoneTransitionPendingUntil = 0;
      if (phoneSelectionAttempts >= maxActionAttempts) {
        if (await finishManualModule("phone_selection", "action_attempt_limit", phoneSelectionAttempts)) {
          manualPhoneHandoffPending = true;
          phoneSelectionAttempts = 0;
          stateFailures = 0;
          reportProgress("manual_sms_step_confirmed", { stage: "phone_selection" });
          continue;
        }
        throw failure("MAC_SETTINGS_SMS_PHONE_NOT_MATCHED");
      }

      phoneSelectionAttempts += 1;
      let selection = null;
      let continued = null;
      let continueAttempted = false;
      try {
        selection = await invokeNative("sms-select", { suffix });
        if (selection?.ok === true) {
          continueAttempted = true;
          continued = await invokeNative("sms-continue", { suffix });
        }
      } catch {
        // A click can succeed while the helper exits during the page transition.
      }
      if (selection?.ok === true && continueAttempted) {
        if (continued?.ok === true) {
          reportProgress("phone_selection_submitted", { attempts: phoneSelectionAttempts });
        } else {
          reportProgress("phone_selection_transition_waiting");
        }
        // A Continue invocation can reach the page while its helper reply is
        // lost. Observe the transition grace window before allowing another
        // click, otherwise a slow network can send duplicate SMS messages.
        phoneTransitionPendingUntil = now() + phoneTransitionGraceMs;
      }
      // Both native actions are idempotent only for the single suffix-matched
      // destination. Give the dynamically-loaded code surface a bounded grace
      // interval before deciding whether the next of the three attempts is needed.
      await waitBounded(actionRetryDelayMs);
      continue;
    }

    if (state.stage === "code_entry") {
      reportProgress("code_entry_detected", { attempts: codeSubmissionAttempts });
      codeEntryObserved = true;
      postCodeWaitingObservations = 0;
      if (manualPhoneHandoffPending) {
        manualPhoneHandoffPending = false;
        phoneSelectionAttempts = 0;
        reportProgress("manual_sms_step_advanced", { stage: "code_entry" });
      }
      if (manualCodeHandoffPending) {
        // A manual Enter only re-probes the page.  Never reuse the cached
        // provider code or perform a fourth automatic write while the six
        // cells are still visible.
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (!verificationCode) {
        reportProgress("code_polling_started");
        const providerCode = await pollProviderUntilCode(codeProvider);
        if (!providerCode) {
          reportProgress("sms_code_not_received", {
            polls: providerPolls,
            elapsedMs: Math.max(0, timeoutMs - readRemainingMs(deadline, now)),
          });
        }
        verificationCode = providerCode ?? await acquireCode(manualCodeProvider, manualTimeoutMs);
      }
      if (!verificationCode && readRemainingMs(deadline, now) <= 0) {
        if (await beginManualCodeHandoff("code_unavailable")) continue;
        throw failure("MAC_SETTINGS_SMS_TIMEOUT");
      }
      if (!verificationCode) {
        if (await beginManualCodeHandoff("code_unavailable")) continue;
        throw failure("MAC_SETTINGS_SMS_MANUAL_CODE_INVALID");
      }

      if (codeSubmissionAttempts >= maxActionAttempts) {
        if (await beginManualCodeHandoff("action_attempt_limit")) continue;
        throw failure("MAC_SETTINGS_SMS_CODE_FILL_FAILED");
      }

      codeSubmissionAttempts += 1;
      codeWriteAttempted = true;
      codeTransitionPendingUntil = 0;
      reportEvent("code_write_started", { attempts: codeSubmissionAttempts });
      let filled = null;
      try {
        filled = await invokeNative("sms-code", { code: verificationCode, suffix });
      } catch {
        // Re-probe below; the native helper can exit while the last cell triggers navigation.
      }
      if (filled?.ok === true) {
        // A successful helper write proves the six cells were populated, not
        // that Apple has accepted the SMS. Wait for the populated group to
        // disappear before advancing into the dynamic post-SMS state machine.
        codeTransitionPendingUntil = now() + codeTransitionGraceMs;
        reportProgress("code_written", { attempts: codeSubmissionAttempts });
        await waitBounded(pollIntervalMs);
        continue;
      }

      // A final-cell navigation can make the short-lived helper lose its reply.
      // If the verified SMS surface has disappeared, hand the dynamic next-stage
      // scanner control instead of turning a slow Apple transition into a false
      // failure.  A still-empty code page gets at most two additional safe tries.
      const afterWrite = await readStableSmsState();
      if (afterWrite?.stage === "waiting") {
        codeSurfaceFailures = 0;
        codeTransitionPendingUntil = now() + codeTransitionGraceMs;
        reportProgress("code_transition_waiting", { attempts: codeSubmissionAttempts });
        postCodeWaitingObservations = 1;
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (afterWrite?.stage === "code_pending") {
        codeSurfaceFailures = 0;
        codeTransitionPendingUntil = now() + codeTransitionGraceMs;
        reportProgress("code_transition_waiting", { attempts: codeSubmissionAttempts });
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (afterWrite?.stage === "phone_selection") {
        codeSurfaceFailures = 0;
        verificationCode = null;
        codeSubmissionAttempts = 0;
        phoneSelectionAttempts = 0;
        codeEntryObserved = false;
        codeWriteAttempted = false;
        codeTransitionPendingUntil = 0;
        postCodeWaitingObservations = 0;
        await waitBounded(pollIntervalMs);
        continue;
      }
      if (afterWrite?.stage === "code_entry") {
        codeSurfaceFailures = 0;
        await waitBounded(actionRetryDelayMs);
        continue;
      }
      codeSurfaceFailures += 1;
      if (codeSurfaceFailures < stateReadAttempts) {
        await waitBounded(actionRetryDelayMs);
        continue;
      }
      if (await beginManualCodeHandoff("code_write_unconfirmed")) continue;
      throw failure("MAC_SETTINGS_SMS_CODE_FILL_FAILED");
    }

    reportProgress("waiting_for_sms_surface");
    await waitBounded(pollIntervalMs);
  }
}
export const MAC_SETTINGS_SMS_SUFFIX_RE = TWO_DIGIT_SUFFIX_RE;
