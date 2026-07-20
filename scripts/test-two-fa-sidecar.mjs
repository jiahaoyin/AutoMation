import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMac2FACollector } from "./lib/two-fa-sidecar.js";

const HARNESS_REPORT_PREFIX = "apple-automation-two-fa-sidecar-";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ManualClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.time + Math.max(0, Number(delay) || 0),
      callback,
    });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  async flush() {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }

  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      await this.flush();
      const dueAt = Math.min(
        ...[...this.timers.values()]
          .map((timer) => timer.at)
          .filter((at) => at <= target)
      );
      if (!Number.isFinite(dueAt)) break;
      this.time = dueAt;
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at === dueAt)
        .sort(([left], [right]) => left - right);
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.callback();
      }
    }
    this.time = target;
    await this.flush();
  }
}

function cancellationError() {
  const error = new Error("cancelled");
  error.code = "2FA_SETTINGS_CANCELLED";
  return error;
}

function accessibilityDeniedError() {
  const error = new Error("fixed accessibility failure");
  error.code = "2FA_SETTINGS_ACCESSIBILITY_DENIED";
  return error;
}

function createManualProviderHarness() {
  const calls = [];
  const provider = ({ signal, timeoutMs }) => {
    const result = deferred();
    const call = {
      signal,
      timeoutMs,
      aborted: false,
      resolve: result.resolve,
    };
    const onAbort = () => {
      call.aborted = true;
      result.resolve(null);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    calls.push(call);
    return result.promise.finally(() => signal.removeEventListener("abort", onAbort));
  };
  return { calls, provider };
}

function createNativeHarness(
  clock,
  {
    staleCodes = [],
    allowAttemptOutcome = "disappear",
    settingsCancelSettles = true,
    settingsForceStopSettles = true,
    settingsStartFailures = 0,
    settingsStartError = null,
    popupCloseWait = null,
    popupPrimaryCloseSucceeds = true,
    popupFallbackCloseFailures = 0,
    allowStrategy = null,
    allowSource = "FollowUpUI",
    popupSource = "test-popup",
    dismissAction = "dismissed_stale",
    popupCapability = null,
    popupReadResults = [],
    probeCapability = null,
    probe2FAState: customProbe2FAState = null,
    initialAllowVisible = false,
    accessibilityProvider = null,
  } = {}
) {
  let popup = null;
  let allowVisible = initialAllowVisible;
  const probeResults = [];
  const queuedPopupReadResults = [...popupReadResults];
  let fallbackCloseFailuresRemaining = popupFallbackCloseFailures;
  let settingsStartFailuresRemaining = settingsStartFailures;
  const settingsRequests = [];
  const stats = {
    allowClicks: 0,
    cleanupDismissals: 0,
    popupWinnerClosures: 0,
    popupCloseSignals: [],
    popupCloseCalls: 0,
    popupPhaseCalls: [],
    stalePopupCleanupCalls: 0,
    settingsStarts: 0,
    settingsCancels: 0,
    settingsForceStops: 0,
    accessibilityStarts: 0,
    accessibilityOptions: [],
    allowAttempts: [],
    popupReads: [],
    fullAllowWaits: 0,
    probeCalls: 0,
  };

  const runtime = {
    platform: "darwin",
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    async dismissStale2FAPopups() {
      stats.stalePopupCleanupCalls += 1;
      return { count: staleCodes.length, codes: [...staleCodes] };
    },
    async probe2FAState(timeoutSec, options) {
      stats.probeCalls += 1;
      if (customProbe2FAState) return customProbe2FAState(timeoutSec, options);
      if (probeCapability) return { action: probeCapability, code: null };
      if (probeResults.length > 0) {
        const result = probeResults.shift();
        if (result instanceof Error) throw result;
        return result;
      }
      if (allowVisible) {
        return { action: "has_allow_dialog", code: null };
      }
      if (popup) {
        return { action: "has_code_dialog", code: popup.code };
      }
      return { action: "idle", code: null };
    },
    async tryAllowOnce(timeoutSec, options) {
      stats.allowAttempts.push({ timeoutSec, options });
      if (!allowVisible) return { attempted: false, clicked: false, strategy: "none" };
      if (allowAttemptOutcome === "disappear") allowVisible = false;
      stats.allowClicks += 1;
      return {
        attempted: true,
        clicked: true,
        strategy: allowStrategy ?? `test-allow-${options.strategyOffset}`,
        source: allowSource,
      };
    },
    async waitForAllowClick() {
      stats.fullAllowWaits += 1;
      throw new Error("collector must not enter the full Allow wait loop");
    },
    async readPopupCode(timeoutSec, options) {
      stats.popupReads.push({ timeoutSec, options });
      if (popupCapability) {
        return { code: null, source: "vision", capability: popupCapability };
      }
      if (queuedPopupReadResults.length > 0) {
        return queuedPopupReadResults.shift();
      }
      if (!popup) return null;
      return { code: popup.code, raw: popup.raw, source: popupSource };
    },
    async runPopupPhase(phase) {
      stats.popupPhaseCalls.push(phase);
      if (phase === "read_code" && popup) {
        return { action: "read_code", code: popup.code, raw: popup.raw };
      }
      if (phase === "dismiss_stale" && popup) {
        if (fallbackCloseFailuresRemaining > 0) {
          fallbackCloseFailuresRemaining -= 1;
          return { action: "none", code: null };
        }
        const code = popup.code;
        popup = null;
        stats.cleanupDismissals += 1;
        return { action: dismissAction, code };
      }
      return { action: "none", code: null };
    },
    async dismissCodePopupForWebFill(_timeoutSec, options = {}) {
      stats.popupCloseCalls += 1;
      const signal = options.signal;
      stats.popupCloseSignals.push(signal ?? null);
      if (!popup) return false;
      if (popupCloseWait) {
        const waits = [popupCloseWait.promise.then(() => true)];
        if (signal) {
          waits.push(
            new Promise((resolve) => {
              if (signal.aborted) resolve(false);
              else signal.addEventListener("abort", () => resolve(false), { once: true });
            })
          );
        }
        if (!(await Promise.race(waits))) return false;
      }
      if (signal?.aborted) return false;
      if (!popupPrimaryCloseSucceeds) return false;
      popup = null;
      stats.popupWinnerClosures += 1;
      return true;
    },
    start2FASettingsCodeRequest() {
      stats.settingsStarts += 1;
      if (settingsStartFailuresRemaining > 0) {
        settingsStartFailuresRemaining -= 1;
        throw settingsStartError ?? new Error("settings start failed");
      }
      const result = deferred();
      let settled = false;
      const options = arguments[0];
      const request = {
        options,
        promise: result.promise,
        resolve(value) {
          if (settled) return;
          settled = true;
          result.resolve(value);
        },
        reject(error) {
          if (settled) return;
          settled = true;
          result.reject(error);
        },
        cancel() {
          request.cancelCalls += 1;
          if (settled) return false;
          stats.settingsCancels += 1;
          if (!settingsCancelSettles) return true;
          settled = true;
          result.reject(cancellationError());
          return true;
        },
        forceStop() {
          stats.settingsForceStops += 1;
          if (!settled && settingsForceStopSettles) {
            settled = true;
            result.reject(cancellationError());
          }
          return true;
        },
      };
      request.cancelCalls = 0;
      settingsRequests.push(request);
      return request;
    },
    async ensureAccessibility(options) {
      stats.accessibilityStarts += 1;
      stats.accessibilityOptions.push(options);
      if (accessibilityProvider) return accessibilityProvider(options);
      return { granted: true };
    },
  };

  return {
    runtime,
    stats,
    settingsRequests,
    setPopup(code, raw = `${code.slice(0, 3)} ${code.slice(3)}`) {
      popup = { code, raw };
    },
    clearPopup() {
      popup = null;
    },
    setAllowVisible(value) {
      allowVisible = value;
    },
    queueProbeResults(...results) {
      probeResults.push(...results);
    },
  };
}

function cleanupHarnessReportDir(reportDir) {
  const resolvedReportDir = path.resolve(reportDir);
  assert.equal(
    path.dirname(resolvedReportDir),
    path.resolve(os.tmpdir()),
    "harness report directory must be a direct child of os.tmpdir()"
  );
  assert.equal(
    path.basename(resolvedReportDir).startsWith(HARNESS_REPORT_PREFIX),
    true,
    "harness report directory must use the expected prefix"
  );
  const reportStats = fs.lstatSync(resolvedReportDir);
  assert.equal(
    reportStats.isSymbolicLink(),
    false,
    "harness report directory must not be a symlink"
  );
  assert.equal(reportStats.isDirectory(), true, "harness report path must be a directory");
  const auditPath = path.join(resolvedReportDir, "2fa-audit.jsonl");
  if (fs.existsSync(auditPath)) {
    const auditStats = fs.lstatSync(auditPath);
    assert.equal(auditStats.isSymbolicLink(), false, "harness audit path must not be a symlink");
    assert.equal(auditStats.isFile(), true, "harness audit path must be a regular file");
    fs.unlinkSync(auditPath);
  }
  assert.deepEqual(
    fs.readdirSync(resolvedReportDir),
    [],
    "harness report directory contains an unexpected entry"
  );
  fs.rmdirSync(resolvedReportDir);
}

function createHarness(options = {}) {
  const clock = new ManualClock();
  const native = createNativeHarness(clock, options);
  const audits = [];
  const diagnostics = [];
  const statuses = [];
  const reportDir = fs.mkdtempSync(
    path.join(os.tmpdir(), HARNESS_REPORT_PREFIX)
  );
  let collector;
  try {
    collector = createMac2FACollector({
      reportDir,
      timeoutMs: options.timeoutMs ?? 30_000,
      settingsFallbackAfterMs: options.settingsFallbackAfterMs ?? 8_000,
      popupPostAllowGraceMs: options.popupPostAllowGraceMs,
      settingsFallback: options.settingsFallback,
      settingsOnly: options.settingsOnly,
      pollIntervalMs: options.pollIntervalMs ?? 10,
      auditThrottleMs: options.auditThrottleMs ?? 30,
      cleanupGraceMs: 50,
      popupDeliveryGraceMs: options.popupDeliveryGraceMs,
      manualFallback: options.manualFallback,
      manualCodeProvider: options.manualCodeProvider,
      isTTY: options.isTTY ?? false,
      onAudit(entry) {
        audits.push(entry);
        options.onAudit?.(entry);
      },
      onDiagnostic(entry) {
        diagnostics.push(entry);
        options.onDiagnostic?.(entry);
      },
      onStatus(status) {
        statuses.push(status);
        options.onStatus?.(status);
      },
      runtime: native.runtime,
    });
  } catch (error) {
    cleanupHarnessReportDir(reportDir);
    throw error;
  }

  const disposeCollector = collector.dispose;
  let disposePromise = null;
  collector.dispose = () => {
    disposePromise ??= Promise.resolve()
      .then(() => disposeCollector())
      .finally(() => cleanupHarnessReportDir(reportDir));
    return disposePromise;
  };

  return { clock, native, collector, audits, diagnostics, statuses, reportDir };
}

function pathIsWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function readOnlyCwdDoesNotAffectHarnessReportsTest() {
  const originalCwd = process.cwd();
  const readOnlyCwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "apple-automation-two-fa-read-only-cwd-")
  );
  const originalMkdirSync = fs.mkdirSync;
  const originalAppendFileSync = fs.appendFileSync;
  const blockedWrites = [];
  const harnesses = [];
  let reportDirs = [];

  const rejectCwdWrite = (targetPath) => {
    const resolved = path.resolve(String(targetPath));
    if (!pathIsWithin(readOnlyCwd, resolved)) return;
    blockedWrites.push(resolved);
    const error = new Error(`simulated read-only cwd write: ${resolved}`);
    error.code = "EACCES";
    throw error;
  };

  try {
    process.chdir(readOnlyCwd);
    fs.mkdirSync = (targetPath, ...args) => {
      rejectCwdWrite(targetPath);
      return originalMkdirSync(targetPath, ...args);
    };
    fs.appendFileSync = (targetPath, ...args) => {
      rejectCwdWrite(targetPath);
      return originalAppendFileSync(targetPath, ...args);
    };

    harnesses.push(createHarness({ settingsFallback: false, manualFallback: false }));
    harnesses.push(createHarness({ settingsFallback: false, manualFallback: false }));
    reportDirs = harnesses.map(({ reportDir }) => reportDir);
    await Promise.all(harnesses.map(({ collector }) => collector.prepare()));

    assert.deepEqual(blockedWrites, [], "harness reports must never write under cwd");
    assert.equal(reportDirs.every((reportDir) => path.isAbsolute(reportDir)), true);
    assert.equal(
      reportDirs.every((reportDir) => pathIsWithin(os.tmpdir(), reportDir)),
      true,
      "every harness report directory must live under os.tmpdir()"
    );
    assert.notEqual(reportDirs[0], reportDirs[1], "each harness needs an isolated directory");
    assert.equal(
      reportDirs.every((reportDir) => fs.existsSync(path.join(reportDir, "2fa-audit.jsonl"))),
      true,
      "each harness must successfully write its audit outside cwd"
    );
  } finally {
    try {
      for (const { collector } of harnesses) await collector.dispose();
    } finally {
      fs.mkdirSync = originalMkdirSync;
      fs.appendFileSync = originalAppendFileSync;
      process.chdir(originalCwd);
      fs.rmdirSync(readOnlyCwd);
    }
  }

  for (const reportDir of reportDirs) {
    assert.equal(fs.existsSync(reportDir), false, "dispose must remove each harness directory");
  }
}

async function bufferEarlyPopupTest() {
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  const codePromise = collector.getCode();
  native.setPopup("123456");
  await clock.advance(100);

  assert.equal(await codePromise, "123456");
  assert.equal(native.stats.settingsStarts, 0);
  assert.equal(native.stats.popupWinnerClosures, 1);
  await collector.dispose();
  assert.equal(clock.timers.size, 0);
}

async function initialPopupProbeFailureDoesNotAbortPreparationTest() {
  const { clock, native, collector, audits } = createHarness({
    settingsFallback: false,
    manualFallback: false,
  });
  native.queueProbeResults(new Error("private initial probe failure"));

  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("121212");
  await clock.advance(30);

  assert.equal(await codePromise, "121212");
  assert.equal(
    audits.some(
      (entry) => entry.phase === "popup_probe_failure" && entry.state === "probe_error"
    ),
    true,
    "an initial native probe failure must be audited without disabling the watcher"
  );
  await collector.dispose();
}

async function popupAccessibilityPromptStartsWithoutBlockingCodeAcquisitionTest() {
  const authorization = deferred();
  let authorizationSignal = null;
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    probeCapability: "accessibility_unavailable",
    accessibilityProvider({ signal }) {
      authorizationSignal = signal;
      return authorization.promise;
    },
  });

  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(10);

  assert.equal(native.stats.accessibilityStarts, 1);
  assert.equal(authorizationSignal?.aborted, false);
  assert.equal(
    statuses.some(({ status, source }) => status === "popup_accessibility" && source === "popup"),
    true,
    "missing popup AX permission must be surfaced at the actual 2FA boundary"
  );
  assert.equal(
    audits.some(
      ({ phase, reason, outcome }) =>
        phase === "popup_accessibility" &&
        reason === "accessibility_denied" &&
        outcome === "prompting"
    ),
    true,
    "the authorization request must be recorded without native dialog text"
  );

  native.setPopup("232323");
  await clock.advance(10);
  assert.equal(await codePromise, "232323");
  assert.equal(
    authorizationSignal?.aborted,
    true,
    "a popup winner must cancel the background authorization wait"
  );
  authorization.resolve({ granted: true });
  await clock.flush();
  await collector.dispose();
}

async function collectorCarriesPreparationBoundaryIntoAllowFlowTest() {
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  native.setAllowVisible(true);
  await clock.advance(10);

  assert.equal(native.stats.allowAttempts.length, 0, "prepare must not click Allow before need_2fa");
  const codePromise = collector.getCode();
  await clock.advance(10);
  assert.equal(native.stats.allowAttempts.length, 1);
  assert.equal("confirmClick" in native.stats.allowAttempts[0].options, false);
  assert.equal(native.stats.allowAttempts[0].options.maxStrategies, 1);
  assert.equal(native.stats.allowAttempts[0].options.strategyOffset, 0);
  assert.equal(native.stats.fullAllowWaits, 0);
  const rejected = assert.rejects(codePromise, /disposed/i);
  await collector.dispose();
  await rejected;
}

async function preexistingAllowIsNeverAutomaticallyClickedTest() {
  const { clock, native, collector } = createHarness({
    initialAllowVisible: true,
    allowAttemptOutcome: "remain",
    settingsFallback: false,
    manualFallback: false,
  });
  await collector.prepare();
  native.setPopup("232323");
  native.queueProbeResults(
    { action: "idle" },
    { action: "probe_error", raw: "123456 TOP-SECRET" },
    { action: "idle" },
    { action: "unexpected_state", raw: "654321 person@example.com" },
    { action: "idle" },
    { action: "has_code_dialog", code: "232323" },
    { action: "idle" },
    { action: "has_allow_dialog" }
  );
  await clock.advance(80);

  assert.equal(
    native.stats.allowAttempts.length,
    0,
    "Allow, probe errors, unknown states, and code dialogs must reset stable idle evidence"
  );
  assert.equal(native.stats.popupReads.length, 0);
  assert.equal(native.stats.cleanupDismissals, 1);
  await collector.dispose();
}

async function preexistingAllowCodeIsDismissedRejectedAndGateStaysClosedTest() {
  const { clock, native, collector } = createHarness({
    initialAllowVisible: true,
    allowAttemptOutcome: "remain",
    settingsFallback: false,
    manualFallback: false,
  });
  await collector.prepare();
  await clock.flush();

  native.setAllowVisible(false);
  native.setPopup("121212");
  await clock.advance(10);
  assert.equal(native.stats.cleanupDismissals, 1, "the boundary code must be stale-dismissed");
  assert.equal(native.stats.popupReads.length, 0, "the boundary code must bypass popup OCR/read");

  native.setAllowVisible(true);
  await clock.advance(10);
  assert.equal(
    native.stats.allowAttempts.length,
    0,
    "the stale gate must remain closed until an explicit clear probe"
  );

  native.setAllowVisible(false);
  await clock.advance(30);
  native.setPopup("121212");
  await clock.advance(10);
  assert.equal(native.stats.cleanupDismissals, 2, "the boundary code must remain rejected after clear");
  assert.equal(native.stats.popupReads.length, 0);
  await collector.dispose();
}

async function newAllowAfterPreexistingGateClearUsesAutomaticBudgetTest() {
  const { clock, native, collector } = createHarness({
    initialAllowVisible: true,
    allowAttemptOutcome: "remain",
    settingsFallback: false,
    manualFallback: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(20);
  assert.equal(native.stats.allowAttempts.length, 0);

  native.setAllowVisible(false);
  await clock.advance(10);
  native.setAllowVisible(true);
  await clock.advance(10);
  assert.equal(
    native.stats.allowAttempts.length,
    0,
    "one transient idle observation must not release the same preexisting Allow"
  );

  native.setAllowVisible(false);
  await clock.advance(30);
  native.setAllowVisible(true);
  await clock.advance(20);

  assert.deepEqual(
    native.stats.allowAttempts.map(({ options }) => options.strategyOffset),
    [0, 1],
    "a new Allow may use both automatic attempts only after an idle clear state"
  );
  const rejected = assert.rejects(codePromise, /disposed/i);
  await collector.dispose();
  await rejected;
}

async function allowAttemptRemainingVisibleIsNotConfirmedTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "remain",
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  void codePromise.catch(() => {});
  native.setAllowVisible(true);

  await clock.advance(20);

  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "an attempted action must not become a confirmed Allow result"
  );
  assert.ok(
    audits.some(
      (entry) =>
        entry.phase === "popup_allow_attempt_result" &&
        entry.attempted === true &&
        entry.confirmed === false &&
        entry.reason === "allow_still_visible"
    ),
    "the still-visible Allow state must be audited as an unconfirmed attempt"
  );
  assert.ok(native.stats.allowAttempts.length >= 2, "the watcher must rotate strategies");
  assert.deepEqual(
    native.stats.allowAttempts.slice(0, 2).map(({ options }) => options.strategyOffset),
    [0, 1]
  );
  await collector.dispose();
}

async function failedAutomaticAllowDoesNotExtendPopupPrimaryWindowTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "remain",
    settingsFallbackAfterMs: 30,
    popupPostAllowGraceMs: 30,
    manualFallback: false,
    pollIntervalMs: 10,
  });
  await collector.prepare();
  native.setAllowVisible(true);
  const codePromise = collector.getCode({ generation: 1 });
  native.setAllowVisible(true);
  await clock.advance(49);
  assert.equal(native.stats.settingsStarts, 0);
  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "generation 2 must retain the fresh-code Settings retry backoff"
  );
  await clock.advance(4_979);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "an unconfirmed automatic Allow must receive only bounded confirmation polls"
  );
  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow" && entry.confirmed === true),
    false,
    "an Allow that remains visible must never be audited as confirmed"
  );
  native.settingsRequests[0].resolve({ code: "135790" });
  await clock.flush();
  assert.equal(await codePromise, "135790");
  await collector.dispose();
}

async function allowConfirmationGraceIsBoundedForLargePollIntervalTest() {
  const watcherProbe = deferred();
  const { clock, native, collector } = createHarness({
    allowAttemptOutcome: "remain",
    settingsFallbackAfterMs: 30,
    manualFallback: false,
    pollIntervalMs: 100_000,
  });
  native.queueProbeResults({ action: "idle" }, watcherProbe.promise);
  await collector.prepare();
  await clock.flush();
  const codePromise = collector.getCode({ generation: 1 });
  native.setAllowVisible(true);
  watcherProbe.resolve({ action: "has_allow_dialog" });
  await clock.flush();
  const probesBeforeFallback = native.stats.probeCalls;

  await clock.advance(2_029);
  assert.equal(native.stats.settingsStarts, 0);
  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "an oversized poll interval must not extend the bounded Allow confirmation window"
  );
  assert.ok(
    native.stats.probeCalls >= probesBeforeFallback + 3,
    "the bounded confirmation window must perform three AX probes instead of only sleeping"
  );
  native.settingsRequests[0].resolve({ code: "246810" });
  await clock.flush();
  assert.equal(await codePromise, "246810");
  await collector.dispose();
}

async function generationOneWakesPopupWatcherForLargePollIntervalTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 30,
    manualFallback: false,
    pollIntervalMs: 100_000,
  });
  await collector.prepare();
  await clock.flush();

  native.setPopup("864209");
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(0);

  assert.equal(
    await codePromise,
    "864209",
    "need_2fa must wake a sleeping popup watcher instead of waiting for its long poll interval"
  );
  assert.equal(native.stats.settingsStarts, 0, "a prompt popup code must win before Settings starts");
  await collector.dispose();
}

async function uncooperativePopupProbeNeverOverlapsConfirmationProbeTest() {
  const stuckProbe = deferred();
  const watcherAllow = deferred();
  const watcherStarted = deferred();
  let probeCount = 0;
  let activeProbeCount = 0;
  let maximumConcurrentProbes = 0;
  let stuckSignal = null;
  const settleProbe = (result) => {
    activeProbeCount -= 1;
    return result;
  };
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 10,
    manualFallback: false,
    pollIntervalMs: 1,
    probe2FAState(_timeoutSec, options = {}) {
      probeCount += 1;
      activeProbeCount += 1;
      maximumConcurrentProbes = Math.max(maximumConcurrentProbes, activeProbeCount);
      if (probeCount === 1) return Promise.resolve({ action: "idle" }).then(settleProbe);
      if (probeCount === 2) {
        watcherStarted.resolve();
        return watcherAllow.promise.then(settleProbe);
      }
      if (probeCount === 3) {
        stuckSignal = options.signal;
        return stuckProbe.promise.then(settleProbe);
      }
      return Promise.resolve({ action: "idle" }).then(settleProbe);
    },
  });
  await collector.prepare();
  await watcherStarted.promise;
  native.setAllowVisible(true);
  const codePromise = collector.getCode({ generation: 1 });
  watcherAllow.resolve({ action: "has_allow_dialog" });
  await clock.flush();
  await clock.advance(1);

  assert.equal(probeCount, 3, "the watcher must hold one probe when fallback begins");
  assert.equal(activeProbeCount, 1);
  await clock.advance(1_009);
  assert.equal(stuckSignal?.aborted, true, "fallback must abort the older watcher probe");
  assert.equal(
    maximumConcurrentProbes,
    1,
    "an uncooperative AX probe must prevent any overlapping confirmation probe"
  );
  assert.equal(probeCount, 3, "fallback must use Settings instead of starting another AX probe");
  assert.equal(native.stats.settingsStarts, 1);

  native.settingsRequests[0].resolve({ code: "975310" });
  await clock.flush();
  assert.equal(await codePromise, "975310");

  // Let the deliberately uncooperative helper settle so disposal can clean up
  // the watcher without leaving a harness report directory behind.
  stuckProbe.resolve({ action: "idle" });
  await clock.flush();
  await collector.dispose();
}

async function disposeDoesNotWaitForUncooperativePopupProbeTest() {
  const stuckProbe = deferred();
  const watcherStarted = deferred();
  let probeCount = 0;
  let watcherSignal = null;
  const { clock, collector, audits } = createHarness({
    pollIntervalMs: 1,
    probe2FAState(_timeoutSec, options = {}) {
      probeCount += 1;
      if (probeCount === 1) return { action: "idle" };
      if (probeCount === 2) {
        watcherSignal = options.signal;
        watcherStarted.resolve();
        return stuckProbe.promise;
      }
      return { action: "idle" };
    },
  });
  await collector.prepare();
  await watcherStarted.promise;

  let disposed = false;
  const disposePromise = collector.dispose().then(() => {
    disposed = true;
  });
  await clock.flush();
  assert.equal(watcherSignal?.aborted, true);
  await clock.advance(49);
  assert.equal(disposed, false);
  await clock.advance(1);
  await disposePromise;

  assert.equal(disposed, true, "an uncooperative popup probe must not hang disposal");
  assert.equal(probeCount, 2, "dispose must not start a second AX probe after watcher timeout");
  assert.equal(
    audits.some(
      (entry) =>
        entry.phase === "popup_dispose_cleanup_failed" &&
        entry.reason === "watcher_shutdown_timeout"
    ),
    true
  );

  stuckProbe.resolve({ action: "idle" });
  await clock.flush();
}

async function generationTwoWaitsForStalePopupProbeBeforeRestartingTest() {
  const staleProbe = deferred();
  const staleProbeStarted = deferred();
  let probeCount = 0;
  let staleSignal = null;
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    manualFallback: false,
    pollIntervalMs: 1,
    probe2FAState(_timeoutSec, options = {}) {
      probeCount += 1;
      if (probeCount === 1) return { action: "idle" };
      if (probeCount === 2) {
        staleSignal = options.signal;
        staleProbeStarted.resolve();
        return staleProbe.promise;
      }
      return { action: "has_code_dialog", code: "222222" };
    },
  });
  await collector.prepare();
  await staleProbeStarted.promise;

  const first = collector.getCode({ generation: 1 });
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(await first, "111111");

  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  await clock.advance(19);
  assert.equal(staleSignal?.aborted, true, "generation 2 must cancel generation 1 popup work");
  assert.equal(native.stats.settingsStarts, 1, "Settings must retain generation 2 popup-primary");
  assert.equal(probeCount, 2, "generation 2 must not overlap an uncooperative AX probe");

  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "generation 2 must retain the fresh-code Settings retry backoff"
  );
  await clock.advance(4_979);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    2,
      "Settings must start when generation 2 popup-primary expires despite the stale probe"
  );
  native.settingsRequests[1].resolve({ code: "222222" });
  await clock.flush();
  assert.equal(await second, "222222");
  staleProbe.resolve({ action: "idle" });
  await clock.flush();
  await collector.dispose();
}

async function generationTwoStaleProbeStillReachesSerialSettingsFallbackTest() {
  const staleProbe = deferred();
  const staleProbeStarted = deferred();
  let probeCount = 0;
  let activeProbeCount = 0;
  let maximumConcurrentProbes = 0;
  let staleSignal = null;
  const settleProbe = (result) => {
    activeProbeCount -= 1;
    return result;
  };
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallbackAfterMs: 20,
    manualFallback: false,
    pollIntervalMs: 1,
    probe2FAState(_timeoutSec, options = {}) {
      probeCount += 1;
      activeProbeCount += 1;
      maximumConcurrentProbes = Math.max(maximumConcurrentProbes, activeProbeCount);
      if (probeCount === 1) return Promise.resolve({ action: "idle" }).then(settleProbe);
      if (probeCount === 2) {
        staleSignal = options.signal;
        staleProbeStarted.resolve();
        return staleProbe.promise.then(settleProbe);
      }
      return Promise.resolve({ action: "idle" }).then(settleProbe);
    },
  });
  await collector.prepare();
  await staleProbeStarted.promise;

  const first = collector.getCode({ generation: 1 });
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(await first, "111111");

  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  await clock.advance(19);
  assert.equal(native.stats.settingsStarts, 1, "generation 2 must retain its popup-primary window");
  assert.equal(staleSignal?.aborted, true, "generation 2 must cancel the stale popup probe");
  assert.equal(probeCount, 2, "generation 2 must not overlap the stale AX probe");

  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "generation 2 must retain the fresh-code Settings retry backoff"
  );
  await clock.advance(4_979);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(
    native.stats.settingsStarts,
    2,
    "Settings must begin when generation 2 popup-primary expires, not at the shared deadline"
  );
  assert.equal(maximumConcurrentProbes, 1, "only one AX probe may run while Settings starts");
  native.settingsRequests[1].resolve({ code: "222222" });
  await clock.flush();
  assert.equal(await second, "222222");
  assert.equal(probeCount, 2, "Settings winner must not restart popup probing");

  let disposed = false;
  const disposePromise = collector.dispose().then(() => {
    disposed = true;
  });
  await clock.flush();
  await clock.advance(49);
  assert.equal(disposed, false, "dispose must wait only for its bounded popup cleanup grace");
  await clock.advance(1);
  await disposePromise;
  assert.equal(disposed, true, "an Abort-ignoring stale probe must not hang disposal");
  assert.equal(clock.timers.size, 0);

  staleProbe.resolve({ action: "idle" });
  await clock.flush();
}

async function generationTwoStaleProbeCannotStarveManualFallbackTest() {
  const staleProbe = deferred();
  const staleProbeStarted = deferred();
  const manual = createManualProviderHarness();
  let probeCount = 0;
  let activeProbeCount = 0;
  let maximumConcurrentProbes = 0;
  const settleProbe = (result) => {
    activeProbeCount -= 1;
    return result;
  };
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallbackAfterMs: 20,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1,
    probe2FAState() {
      probeCount += 1;
      activeProbeCount += 1;
      maximumConcurrentProbes = Math.max(maximumConcurrentProbes, activeProbeCount);
      if (probeCount === 1) return Promise.resolve({ action: "idle" }).then(settleProbe);
      if (probeCount === 2) {
        staleProbeStarted.resolve();
        return staleProbe.promise.then(settleProbe);
      }
      return Promise.resolve({ action: "idle" }).then(settleProbe);
    },
  });
  await collector.prepare();
  await staleProbeStarted.promise;

  const first = collector.getCode({ generation: 1 });
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(await first, "111111");

  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(4_980);
  assert.equal(native.stats.settingsStarts, 2);
  native.settingsRequests[1].reject(new Error("second Settings failure"));
  await clock.flush();

  await clock.advance(84_980);
  assert.equal(manual.calls.length, 1, "terminal fallback must start after both bounded Settings attempts");
  assert.equal(probeCount, 2, "a stale AX probe must not restart during serial fallback");
  assert.equal(maximumConcurrentProbes, 1, "serial fallback must never overlap AX probes");
  manual.calls[0].resolve("333333");
  await clock.flush();
  assert.equal(await second, "333333");

  staleProbe.resolve({ action: "has_code_dialog", code: "444444" });
  await clock.flush();
  assert.equal(probeCount, 2, "a late stale probe must not start a replacement AX probe");
  await collector.dispose();
}

async function allowIsConfirmedOnlyAfterStableStateTransitionTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "disappear",
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  void codePromise.catch(() => {});
  native.setAllowVisible(true);

  await clock.advance(0);
  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "the immediate raw Allow action must remain attempted until a later probe"
  );

  await clock.advance(10);
  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "one disappearance probe is not stable confirmation"
  );

  await clock.advance(10);
  const confirmations = audits.filter((entry) => entry.phase === "popup_allow");
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].confirmed, true);
  assert.equal(confirmations[0].reason, "allow_disappeared_stably");
  assert.equal(confirmations[0].allowSource, "FollowUpUI");
  await collector.dispose();
}

async function probeErrorsResetAllowDisappearanceAndAuditSafelyTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "remain",
    auditThrottleMs: 30,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  void codePromise.catch(() => {});
  native.setAllowVisible(true);
  await clock.advance(0);
  assert.equal(native.stats.allowAttempts.length, 1);

  native.queueProbeResults(
    { action: "idle" },
    {
      action: "probe_error",
      raw: "123456 password=TOP-SECRET",
      account: "person@example.com",
      body: "full page body",
    },
    { action: "probe_error", message: "code 654321 for person@example.com" },
    { action: "probe_error", snippet: "TOP-SECRET full page body" },
    { action: "idle" },
    { action: "has_allow_dialog" }
  );
  await clock.advance(60);

  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "probe failures must never confirm an attempted Allow action"
  );
  assert.ok(
    native.stats.allowAttempts.length >= 2,
    "the watcher must keep running and rotate after an unconfirmed attempt"
  );
  assert.deepEqual(
    native.stats.allowAttempts.slice(0, 2).map(({ options }) => options.strategyOffset),
    [0, 1]
  );

  const probeFailures = audits.filter((entry) => entry.phase === "popup_probe_failure");
  assert.equal(probeFailures.length, 1, "repeated probe failures must be throttled");
  assert.equal(probeFailures[0].state, "probe_error");
  assert.equal(probeFailures[0].reason, "probe_error");

  const serialized = JSON.stringify(audits);
  for (const secret of [
    "123456",
    "654321",
    "TOP-SECRET",
    "person@example.com",
    "full page body",
  ]) {
    assert.equal(serialized.includes(secret), false, `probe audit leaked ${secret}`);
  }
  await collector.dispose();
}

async function unknownMalformedAndThrownProbesNeverConfirmAllowTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "remain",
    auditThrottleMs: 100,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  void codePromise.catch(() => {});
  native.setAllowVisible(true);
  await clock.advance(0);
  assert.equal(native.stats.allowAttempts.length, 1);

  native.queueProbeResults(
    { action: "idle" },
    { action: "unexpected_state", detail: "password=TOP-SECRET" },
    { action: "idle" },
    { raw: "123456 person@example.com" },
    { action: "idle" },
    new Error("654321 full page body"),
    { action: "idle" },
    { action: "has_allow_dialog" }
  );
  await clock.advance(80);

  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "unknown, malformed, and thrown probes must reset stable disappearance"
  );
  assert.ok(
    native.stats.allowAttempts.length >= 2,
    "the watcher must rotate after the pending attempt remains unconfirmed"
  );
  assert.ok(
    audits.some((entry) => entry.phase === "popup_probe_failure"),
    "probe failures need bounded audit evidence"
  );

  const serialized = JSON.stringify(audits);
  for (const secret of [
    "123456",
    "654321",
    "TOP-SECRET",
    "person@example.com",
    "full page body",
  ]) {
    assert.equal(serialized.includes(secret), false, `probe audit leaked ${secret}`);
  }
  await collector.dispose();
}

async function auditIsThrottledAndSanitizedTest() {
  const { clock, native, collector, audits } = createHarness({
    auditThrottleMs: 30,
  });
  await collector.prepare();

  await clock.advance(95);
  const idleAudits = audits.filter(
    (entry) =>
      entry.phase === "popup_probe_state" || entry.phase === "popup_probe_idle_summary"
  );
  assert.ok(idleAudits.length >= 2, "idle state needs bounded diagnostic evidence");
  assert.ok(idleAudits.length <= 4, "idle polling must be throttled");

  const codePromise = collector.getCode();
  native.setPopup("123456", "123 456 password=TOP-SECRET full page body");
  await clock.advance(20);
  assert.equal(await codePromise, "123456");

  const serialized = JSON.stringify(audits);
  assert.match(serialized, /popup_code_buffered/);
  for (const secret of ["123456", "123 456", "TOP-SECRET", "full page body"]) {
    assert.equal(serialized.includes(secret), false, `audit leaked ${secret}`);
  }
  await collector.dispose();
}

async function auditLabelsUseExplicitAllowListsTest() {
  const injected = createHarness({
    allowStrategy: "123 456",
    allowSource: "password-value",
    popupSource: "person@example.com",
  });
  await injected.collector.prepare();
  const injectedCode = injected.collector.getCode();
  injected.native.setAllowVisible(true);
  await injected.clock.advance(10);
  injected.native.setPopup("343434");
  await injected.clock.advance(20);
  assert.equal(await injectedCode, "343434");

  const allowAudit = injected.audits.find((entry) => entry.phase === "popup_allow");
  const popupAudit = injected.audits.find((entry) => entry.phase === "popup_code_buffered");
  assert.equal(
    [allowAudit?.allowStrategy, allowAudit?.allowSource, popupAudit?.source].every(
      (label) => label === "other"
    ),
    true,
    "untrusted helper labels must map to other"
  );
  await injected.collector.dispose();

  const rawAction = createHarness({ dismissAction: "raw" });
  await rawAction.collector.prepare();
  rawAction.native.setPopup("565656");
  await rawAction.collector.dispose();
  const cleanupAudit = rawAction.audits.find(
    (entry) => entry.phase === "popup_dispose_cleanup"
  );
  assert.equal(cleanupAudit?.action, "other");
}

async function popupReaderReceivesCodeOnlyOptionsTest() {
  const { clock, native, collector, audits } = createHarness();
  await collector.prepare();
  const codePromise = collector.getCode();
  native.setPopup("343434");
  await clock.advance(20);
  assert.equal(await codePromise, "343434");

  assert.ok(native.stats.popupReads.length >= 1);
  const options = native.stats.popupReads[0].options;
  assert.equal(options.preferOcr, true);
  assert.equal(options.rejectCodes instanceof Set, true);
  assert.equal("requireFormattedRaw" in options, false);
  assert.equal("debugDir" in options, false);
  assert.equal("raw" in options, false);
  assert.equal(
    audits.some(
      (entry) =>
        entry.phase === "popup_code_read" &&
        entry.outcome === "candidate_ready" &&
        entry.reason === "code_available"
    ),
    true,
    "a verified popup candidate must not be logged as an empty OCR result"
  );
  await collector.dispose();
}

async function rejectedPopupReaderResultIsDismissedWithoutWinningTest() {
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    popupReadResults: [
      { rejected: true, code: null, source: "vision", capability: "available" },
    ],
  });
  await collector.prepare();
  let delivered = false;
  const codePromise = collector.getCode({ generation: 1 }).then((code) => {
    delivered = true;
    return code;
  });

  native.queueProbeResults({ action: "has_code_dialog", code: null });
  native.setPopup("121212");
  await clock.advance(10);
  await clock.flush();

  assert.ok(native.stats.popupReads.length >= 1, "the rejected dialog must be read");
  assert.equal(native.stats.cleanupDismissals, 1, "rejected reader output must dismiss stale UI");
  assert.equal(delivered, false, "a rejected reader result must not settle the winner");
  assert.equal(statuses.some(({ status }) => status === "winner"), false);
  assert.equal(
    audits.some((entry) => entry.phase === "dismiss_rejected_popup"),
    true,
    "stale dismissal must remain visible through a fixed audit phase"
  );
  assert.equal(JSON.stringify(audits).includes("121212"), false, "audit leaked rejected OTP");

  native.setPopup("654321");
  await clock.advance(10);
  assert.equal(await codePromise, "654321", "collector must keep waiting for a fresh code");
  assert.equal(native.stats.cleanupDismissals, 1, "rejected popup must be dismissed exactly once");
  assert.equal(
    statuses.some(({ status, source }) => status === "winner" && source === "popup"),
    true
  );
  assert.equal(JSON.stringify(audits).includes("654321"), false, "audit leaked fresh OTP");
  await collector.dispose();
}

async function ocrPermissionStatusIsFixedOnceAndSettingsContinuesTest() {
  const { clock, native, collector, statuses } = createHarness({
    timeoutMs: 240_000,
    settingsFallbackAfterMs: 20,
    popupCapability: "permission_missing",
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("101010");
  await clock.advance(100);

  const permissionStatuses = statuses.filter(
    ({ status }) => status === "ocr_permission_missing"
  );
  assert.deepEqual(permissionStatuses, [
    {
      status: "ocr_permission_missing",
      source: "popup",
      remainingSec: 240,
    },
  ]);
  assert.equal(native.stats.settingsStarts, 1, "Settings must keep working without OCR permission");

  native.settingsRequests[0].resolve({ code: "202020" });
  await clock.flush();
  assert.equal(await codePromise, "202020");
  await collector.dispose();
}

async function popupAccessibilityFailureIsFixedAndDoesNotLeakIntoOcrTest() {
  const { clock, native, collector, statuses, audits } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    popupCapability: "accessibility_missing",
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("101010");
  await clock.advance(20);

  assert.deepEqual(
    statuses.filter(({ status }) => status === "popup_accessibility"),
    [{ status: "popup_accessibility", source: "popup", remainingSec: 30 }]
  );
  assert.equal(
    audits.some(
      (entry) =>
        entry.phase === "popup_code_read" &&
        entry.capability === "accessibility_missing" &&
        entry.reason === "accessibility_denied"
    ),
    true
  );
  assert.equal(JSON.stringify(audits).includes("101010"), false, "audit leaked OTP");
  await collector.dispose();
  await assert.rejects(codePromise, /disposed/i);
}

async function popupAccessibilityFallbackUsesScreenOcrAfterNeedTwoFactorTest() {
  const { clock, native, collector, statuses, audits } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    probeCapability: "accessibility_unavailable",
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("202020");
  await clock.advance(30);

  assert.equal(await codePromise, "202020");
  assert.equal(native.stats.popupReads.length > 0, true, "screen OCR must run after need_2fa");
  assert.deepEqual(
    statuses.filter(({ status }) => status === "popup_accessibility"),
    [{ status: "popup_accessibility", source: "popup", remainingSec: 30 }]
  );
  assert.equal(
    audits.some(
      (entry) => entry.phase === "popup_code_read" && entry.outcome === "candidate_ready"
    ),
    true
  );
  assert.equal(JSON.stringify(audits).includes("202020"), false, "audit leaked OTP");
  await collector.dispose();
}

async function popupIdleUsesScreenOcrAfterNeedTwoFactorTest() {
  const { clock, native, collector, statuses, audits } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    probeCapability: "idle",
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("303030");
  await clock.advance(30);

  assert.equal(await codePromise, "303030");
  assert.equal(
    native.stats.popupReads.length > 0,
    true,
    "an AX idle result must still reach constrained OCR after need_2fa"
  );
  assert.deepEqual(
    statuses.filter(({ status }) => status === "popup_scanning"),
    [{ status: "popup_scanning", source: "popup", remainingSec: 30 }]
  );
  assert.equal(
    audits.some((entry) => entry.phase === "popup_ocr_scan" && entry.outcome === "prompting"),
    true
  );
  assert.equal(JSON.stringify(audits).includes("303030"), false, "audit leaked OCR candidate");
  await collector.dispose();
}

async function preexistingAllowGateDoesNotBlockActiveOcrTest() {
  const { clock, native, collector } = createHarness({
    initialAllowVisible: true,
    settingsFallback: false,
    manualFallback: false,
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  await clock.advance(10);
  native.setAllowVisible(false);
  native.setPopup("313131");
  native.queueProbeResults({ action: "idle" });

  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(30);

  assert.equal(await codePromise, "313131");
  assert.equal(native.stats.allowAttempts.length, 0, "a preexisting Allow must remain unclicked");
  assert.equal(
    native.stats.popupReads.length > 0,
    true,
    "a preexisting Allow gate must not block active OCR"
  );
  await collector.dispose();
}

async function popupProbeErrorUsesOcrDuringActiveAcquisitionTest() {
  const { clock, native, collector, audits } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("212121");
  native.queueProbeResults(new Error("private probe startup failure 212121"));

  await clock.advance(20);

  assert.equal(await codePromise, "212121");
  assert.equal(native.stats.popupReads.length, 1, "probe errors must still reach constrained OCR");
  assert.equal(
    audits.some((entry) => entry.phase === "popup_code_read" && entry.outcome === "candidate_ready"),
    true
  );
  assert.equal(JSON.stringify(audits).includes("212121"), false, "audit leaked OCR candidate");
  await collector.dispose();
}

async function cancelledProbeErrorOcrCannotPublishLateCodeTest() {
  const clock = new ManualClock();
  const slowRead = deferred();
  const readerStarted = deferred();
  const statuses = [];
  let probeCalls = 0;
  let readerSignal = null;
  const collector = createMac2FACollector({
    pollIntervalMs: 10,
    settingsFallback: false,
    manualFallback: false,
    onStatus(status) {
      statuses.push(status);
    },
    runtime: {
      platform: "darwin",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      async dismissStale2FAPopups() {
        return { count: 0, codes: [] };
      },
      async probe2FAState() {
        probeCalls += 1;
        if (probeCalls === 1) return { action: "idle" };
        throw new Error("private probe timeout 313131");
      },
      async readPopupCode(_timeoutSec, options = {}) {
        readerSignal = options.signal;
        readerStarted.resolve();
        return slowRead.promise;
      },
    },
  });

  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /disposed/i);
  await clock.advance(10);
  await readerStarted.promise;

  const disposePromise = collector.dispose();
  assert.equal(readerSignal?.aborted, true, "dispose must abort the OCR fallback reader");
  slowRead.resolve({ code: "313131", source: "vision" });
  await disposePromise;
  await rejected;

  assert.equal(
    statuses.some(({ status }) => status === "winner"),
    false,
    "a late OCR result after cancellation must not become a winner"
  );
  assert.equal(clock.timers.size, 0, "cancelled OCR fallback must not leak timers");
}

async function unavailableOcrDoesNotEmitPermissionStatusTest() {
  const { clock, native, collector, statuses, audits } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: false,
    popupCapability: "unavailable",
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /disposed/i);
  native.setPopup("303030");
  await clock.advance(100);

  assert.equal(
    statuses.some(({ status }) => status === "ocr_permission_missing"),
    false
  );
  assert.deepEqual(
    statuses.filter(({ status }) => status === "ocr_helper_unavailable"),
    [{ status: "ocr_helper_unavailable", source: "popup", remainingSec: 240 }]
  );
  assert.equal(
    audits.some(
      (entry) =>
        entry.phase === "popup_code_read" &&
        entry.capability === "unavailable" &&
        entry.reason === "ocr_helper_unavailable"
    ),
    true,
    "a missing OCR helper must not be misreported as an empty code scan"
  );
  await collector.dispose();
  await rejected;
}

async function sharedDeadlineEmitsTimeoutBeforeRejectingTest() {
  const timeline = [];
  const { clock, collector, statuses } = createHarness({
    timeoutMs: 100,
    settingsFallback: false,
    manualFallback: false,
    onStatus(status) {
      if (status.status === "timeout") timeline.push("timeout");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /超时/).then(() => {
    timeline.push("rejected");
  });

  await clock.advance(100);
  await rejected;
  assert.deepEqual(
    statuses.filter(({ status }) => status === "timeout"),
    [{ status: "timeout", remainingSec: 0 }]
  );
  assert.deepEqual(timeline, ["timeout", "rejected"]);
  await collector.dispose();
}

async function latePopupReaderAtDeadlineCannotWinTest() {
  const clock = new ManualClock();
  const slowRead = deferred();
  const readerStarted = deferred();
  const statuses = [];
  let nowMs = 0;
  let probeCalls = 0;
  const collector = createMac2FACollector({
    timeoutMs: 100,
    settingsFallback: false,
    manualFallback: false,
    pollIntervalMs: 10,
    onStatus(status) {
      statuses.push(status);
    },
    runtime: {
      platform: "darwin",
      now: () => nowMs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      async dismissStale2FAPopups() {
        return { count: 0, codes: [] };
      },
      async probe2FAState() {
        probeCalls += 1;
        return probeCalls <= 2 ? { action: "idle" } : { action: "has_code_dialog" };
      },
      async readPopupCode() {
        readerStarted.resolve();
        return slowRead.promise;
      },
      async runPopupPhase() {
        return { action: "none", code: null };
      },
    },
  });

  await collector.prepare();
  await clock.flush();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /超时/);
  await clock.advance(10);
  await readerStarted.promise;

  nowMs = 100;
  slowRead.resolve({ code: "717171", source: "vision" });
  await rejected;
  assert.equal(
    statuses.some(({ status }) => status === "winner"),
    false,
    "a code resolved after the deadline must not become a winner"
  );
  assert.deepEqual(
    statuses.filter(({ status }) => status === "timeout"),
    [{ status: "timeout", remainingSec: 0 }]
  );
  await collector.dispose();
  assert.equal(clock.timers.size, 0);
}

async function winnerUsesStatusWithoutDynamicConsoleTest() {
  const { clock, native, collector, statuses } = createHarness();
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("404040");
  await clock.advance(20);

  const original = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    assert.equal(await codePromise, "404040");
  } finally {
    console.log = original;
  }

  assert.equal(logs.some((line) => line.includes("来源=")), false);
  assert.equal(logs.some((line) => line.includes("404040")), false);
  assert.equal(
    statuses.some(({ status, source }) => status === "winner" && source === "popup"),
    true
  );
  await collector.dispose();
}

async function lateNeedStartsSettingsImmediatelyTest() {
  const { clock, native, collector, audits } = createHarness();
  await collector.prepare();
  await clock.advance(9_000);
  assert.equal(native.stats.settingsStarts, 0);

  const codePromise = collector.getCode();
  assert.equal(native.stats.settingsStarts, 0, "popup-primary must start its full window at need_2fa");
  assert.ok(
    audits.some(
      (entry) =>
        entry.phase === "2fa_acquisition_requested" &&
        entry.elapsedSincePrepareMs === 9_000
    ),
    "late acquisition must be visible in sanitized audit"
  );

  await clock.advance(7_999);
  assert.equal(native.stats.settingsStarts, 0, "Settings must stay idle until popup-primary expires");
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({
    code: "654321",
    raw: "654 321",
    screenshot: null,
  });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
}

async function popupAppearingAfterPreparationIsRetainedUntilNeed2FATest() {
  const { clock, native, collector } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    pollIntervalMs: 10,
  });
  await collector.prepare();
  native.setPopup("616161");
  await clock.advance(10);
  assert.equal(
    native.stats.cleanupDismissals,
    0,
    "a popup that appears after preparation must remain available for need_2fa"
  );

  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(10);
  assert.equal(await codePromise, "616161");
  await collector.dispose();
}

async function confirmedAllowExtendsPopupPrimaryWindowTest() {
  const { clock, native, collector, audits } = createHarness({
    settingsFallbackAfterMs: 30,
    popupPostAllowGraceMs: 30,
    manualFallback: false,
    pollIntervalMs: 10,
    popupReadResults: [{ code: null, source: "vision", capability: "available" }],
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  native.setAllowVisible(true);
  await clock.advance(10);
  native.setPopup("999999");
  await clock.advance(10);
  native.clearPopup();

  await clock.advance(10);
  assert.equal(
    native.stats.settingsStarts,
    0,
    "a confirmed Allow must extend popup-primary beyond its original deadline"
  );
  await clock.advance(19);
  assert.equal(native.stats.settingsStarts, 0, "Settings must wait through post-Allow grace");
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 1, "Settings may start only after post-Allow grace");
  assert.equal(
    audits.some((entry) => entry.phase === "popup_primary_start"),
    true,
    "popup-primary audit phase must remain allowlisted"
  );
  assert.equal(
    audits.some((entry) => entry.phase === "popup_primary_exhausted"),
    true,
    "popup fallback audit phase must remain allowlisted"
  );

  native.settingsRequests[0].resolve({ code: "654321" });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
}

async function manualAllowExtendsPopupPrimaryWindowTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 30,
    popupPostAllowGraceMs: 30,
    manualFallback: false,
    pollIntervalMs: 10,
    allowAttemptOutcome: "remain",
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  native.setAllowVisible(true);
  await clock.advance(20);
  native.setAllowVisible(false);
  await clock.advance(20);
  assert.equal(
    native.stats.settingsStarts,
    0,
    "manual Allow confirmation must extend popup-primary beyond the original window"
  );
  await clock.advance(29);
  assert.equal(native.stats.settingsStarts, 0, "manual Allow grace must be fully honored");
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "567890" });
  await clock.flush();
  assert.equal(await codePromise, "567890");
  await collector.dispose();
}

async function disabledSettingsDoesNotLeavePopupEligibleAfterPrimaryWindowTest() {
  const { clock, native, collector } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    settingsFallbackAfterMs: 20,
    pollIntervalMs: 10,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(20);
  native.setPopup("787878");
  await clock.advance(20);
  let settled = false;
  codePromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  assert.equal(settled, false, "disabled Settings must not leave popup eligible after expiry");
  await collector.dispose();
  await assert.rejects(codePromise, /disposed/i);
}

async function popupCodePublishesBeforeDialogCleanupGraceTest() {
  const popupCloseWait = deferred();
  const { clock, native, collector } = createHarness({
    popupCloseWait,
    popupDeliveryGraceMs: 10,
  });
  await collector.prepare();
  let returned = false;
  const codePromise = collector.getCode().then((code) => {
    returned = true;
    return code;
  });
  native.setPopup("343434");
  await clock.advance(0);
  await clock.flush();
  assert.equal(returned, true, "verified popup delivery must not wait for cleanup grace");
  assert.equal(await codePromise, "343434");
  assert.equal(native.stats.popupWinnerClosures, 0, "primary cleanup should still be pending");

  popupCloseWait.resolve();
  await clock.flush();
  assert.equal(native.stats.popupWinnerClosures, 1);
  await collector.dispose();
}

async function manualPopupCloseCannotDiscardBufferedCodeTest() {
  const popupCloseWait = deferred();
  const { clock, native, collector } = createHarness({
    popupCloseWait,
    popupPrimaryCloseSucceeds: false,
    popupDeliveryGraceMs: 10,
  });
  await collector.prepare();
  let deliveries = 0;
  const codePromise = collector.getCode().then((code) => {
    deliveries += 1;
    return code;
  });
  native.setPopup("454545");

  await clock.advance(0);
  assert.equal(deliveries, 1, "the verified candidate must publish before a user can close it");
  assert.equal(await codePromise, "454545");
  native.clearPopup();
  await clock.advance(10);
  await clock.flush();
  assert.equal(deliveries, 1, "manual dialog dismissal must not replay or discard OTP delivery");
  assert.equal(native.stats.cleanupDismissals, 0);
  assert.equal(native.stats.popupCloseSignals.length, 1);
  assert.equal(native.stats.popupCloseSignals[0]?.aborted, true);

  popupCloseWait.resolve();
  await clock.flush();
  await collector.dispose();
  assert.equal(clock.timers.size, 0, "manual close cleanup must not leak timers");
}

async function popupDeliveryGraceNeverExceedsConfiguredMaximumTest() {
  const popupCloseWait = deferred();
  const { clock, native, collector } = createHarness({
    popupCloseWait,
    popupDeliveryGraceMs: 60_000,
    pollIntervalMs: 1,
  });
  await collector.prepare();
  let returned = false;
  const codePromise = collector.getCode().then((code) => {
    returned = true;
    return code;
  });
  native.setPopup("454545");
  await clock.advance(1);
  assert.equal(returned, true, "delivery must not wait for a capped cleanup grace");
  assert.equal(await codePromise, "454545");
  assert.equal(native.stats.cleanupDismissals, 0, "fallback must wait for the configured grace");

  await clock.advance(800);
  assert.equal(
    native.stats.cleanupDismissals,
    1,
    "fallback cleanup must run in the background when primary close outlives grace"
  );
  assert.equal(native.stats.popupCloseSignals[0]?.aborted, true);
  popupCloseWait.resolve();
  await clock.flush();
  await collector.dispose();
  assert.equal(clock.timers.size, 0, "background fallback must not leave timers behind");
}

async function generationTwoRunsCleanupWhileGenerationOneCleanupIsPendingTest() {
  const popupCloseWait = deferred();
  const { clock, native, collector } = createHarness({
    manualFallback: false,
    settingsFallback: false,
    popupCloseWait,
    popupDeliveryGraceMs: 800,
    pollIntervalMs: 1,
  });
  await collector.prepare();
  const first = collector.getCode({ generation: 1 });
  let firstReturned = false;
  first.then(() => {
    firstReturned = true;
  });
  native.setPopup("111111");
  await clock.advance(1);
  assert.equal(firstReturned, true, "popup delivery must not wait for native dialog cleanup");
  assert.equal(await first, "111111");
  assert.equal(native.stats.settingsStarts, 0, "popup-primary must not start Settings");

  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  await clock.advance(1);
  assert.equal(
    native.stats.popupCloseSignals[0]?.aborted,
    true,
    "generation 2 must stop generation 1 popup cleanup before reading a fresh dialog"
  );
  native.setPopup("222222");
  await clock.advance(1);
  assert.equal(await second, "222222");
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 0, "generation 2 must re-enter popup-primary first");
  popupCloseWait.resolve();
  const dispose = collector.dispose();
  await clock.flush();
  await dispose;
  assert.equal(clock.timers.size, 0, "generation-scoped cleanup must not leak timers");
}

async function popupCodeFallsBackToGenericDialogCleanupTest() {
  const { clock, native, collector } = createHarness({
    popupPrimaryCloseSucceeds: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  native.setPopup("565656");
  await clock.advance(20);

  assert.equal(await codePromise, "565656");
  assert.equal(native.stats.popupWinnerClosures, 0);
  assert.equal(native.stats.cleanupDismissals, 1);
  await collector.dispose();
}

async function popupCodeIsPublishedWhenDialogCleanupFailsTest() {
  const { clock, native, collector, audits } = createHarness({
    popupPrimaryCloseSucceeds: false,
    popupFallbackCloseFailures: 1,
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  let deliveries = 0;
  const codePromise = collector.getCode().then((code) => {
    deliveries += 1;
    return code;
  });
  native.setPopup("676767");
  await clock.advance(10);
  await clock.flush();
  assert.equal(deliveries, 1, "a failed close must still deliver the verified OTP once");
  assert.equal(await codePromise, "676767");
  assert.ok(
    audits.some(
      (entry) =>
        entry.phase === "popup_winner_close_pending" && entry.reason === "close_pending"
    ),
    "a failed close must remain visible in the fixed audit state"
  );
  assert.ok(
    audits.some(
      (entry) => entry.phase === "popup_code_buffered" && entry.popupClosed === false
    ),
    "delivery must record that native dialog cleanup remains pending"
  );
  assert.equal(native.stats.cleanupDismissals, 0);
  await clock.advance(50);
  assert.equal(deliveries, 1, "cleanup failure must not replay the popup candidate");
  assert.equal(native.stats.popupReads.length, 1, "cleanup failure must not re-read the popup");
  await collector.dispose();
}

async function popupCodeWinsAfterAllDialogCleanupPathsFailTest() {
  const { clock, native, collector, audits } = createHarness({
    popupPrimaryCloseSucceeds: false,
    popupFallbackCloseFailures: 2,
    popupDeliveryGraceMs: 0,
    settingsFallback: false,
    manualFallback: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  native.setPopup("787878");

  await clock.advance(40);
  assert.equal(native.stats.popupReads.length, 1, "close retries must reuse one candidate");
  assert.equal(native.stats.popupWinnerClosures, 0);
  assert.equal(
    audits.filter((entry) => entry.phase === "popup_winner_close_pending").length,
    1,
    "bounded close failure must produce one fixed pending state"
  );
  assert.equal(
    audits.some((entry) => entry.phase === "2fa_winner" && entry.source === "popup"),
    true,
    "a verified popup code must still win when dialog cleanup is unavailable"
  );
  assert.equal(JSON.stringify(audits).includes("787878"), false, "audit leaked OTP");

  await collector.dispose();
  assert.equal(await codePromise, "787878");
}

async function settingsGracePeriodTest() {
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  const codePromise = collector.getCode();

  await clock.advance(7_999);
  assert.equal(native.stats.settingsStarts, 0);
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal("screenshotPath" in native.settingsRequests[0].options, false);

  native.settingsRequests[0].resolve({ code: "654321", raw: "654 321", screenshot: null });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
}

function popupHelperStats(native) {
  return {
    stalePopupCleanupCalls: native.stats.stalePopupCleanupCalls,
    probeCalls: native.stats.probeCalls,
    allowAttempts: native.stats.allowAttempts.length,
    popupReads: native.stats.popupReads.length,
    popupPhaseCalls: native.stats.popupPhaseCalls.length,
    popupCloseCalls: native.stats.popupCloseCalls,
  };
}

async function settingsOnlyStartsImmediatelyWithoutPopupHelpersTest() {
  const { clock, native, collector, statuses } = createHarness({
    settingsOnly: true,
    settingsFallbackAfterMs: 8_000,
    manualFallback: false,
  });
  await collector.prepare();
  assert.equal(native.stats.settingsStarts, 0, "prepare must not request a code before need_2fa");
  assert.deepEqual(popupHelperStats(native), {
    stalePopupCleanupCalls: 0,
    probeCalls: 0,
    allowAttempts: 0,
    popupReads: 0,
    popupPhaseCalls: 0,
    popupCloseCalls: 0,
  });

  const codePromise = collector.getCode({ generation: 1, rejectPrevious: false });
  assert.equal(native.stats.settingsStarts, 1, "settings-only must start Settings immediately");
  assert.deepEqual(popupHelperStats(native), {
    stalePopupCleanupCalls: 0,
    probeCalls: 0,
    allowAttempts: 0,
    popupReads: 0,
    popupPhaseCalls: 0,
    popupCloseCalls: 0,
  });
  native.settingsRequests[0].resolve({ code: "135790" });
  await clock.flush();
  assert.equal(await codePromise, "135790");
  assert.equal(
    statuses.some(({ status, source }) => status === "winner" && source === "settings"),
    true
  );
  await collector.dispose();
  assert.deepEqual(
    popupHelperStats(native),
    {
      stalePopupCleanupCalls: 0,
      probeCalls: 0,
      allowAttempts: 0,
      popupReads: 0,
      popupPhaseCalls: 0,
      popupCloseCalls: 0,
    },
    "settings-only disposal must not touch popup/Allow/OCR helpers"
  );
}

async function settingsOnlyManualFallbackStartsAtNinetySecondsTest() {
  const manual = createManualProviderHarness();
  const { clock, native, collector } = createHarness({
    settingsOnly: true,
    timeoutMs: 240_000,
    settingsStartFailures: 2,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1, rejectPrevious: false });
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(manual.calls.length, 0, "manual input must wait for Settings failure");
  await clock.advance(4_999);
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(manual.calls.length, 0);
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 2);
  await clock.advance(84_999);
  assert.equal(manual.calls.length, 0, "manual input must retain the 90-second grace period");
  await clock.advance(1);
  assert.equal(
    manual.calls.length,
    1,
    "manual input must start at 90 seconds even when Settings has already failed"
  );
  manual.calls[0].resolve("987654");
  await clock.flush();
  assert.equal(await codePromise, "987654");
  assert.deepEqual(popupHelperStats(native), {
    stalePopupCleanupCalls: 0,
    probeCalls: 0,
    allowAttempts: 0,
    popupReads: 0,
    popupPhaseCalls: 0,
    popupCloseCalls: 0,
  });
  await collector.dispose();
}

async function settingsOnlyAccessibilityFailureKeepsManualFallbackOnScheduleTest() {
  const manual = createManualProviderHarness();
  const never = deferred();
  const { clock, native, collector, statuses } = createHarness({
    settingsOnly: true,
    timeoutMs: 240_000,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    accessibilityProvider() {
      return never.promise;
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1, rejectPrevious: false });

  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  assert.equal(
    native.stats.accessibilityStarts,
    0,
    "settings-only must not wait on a different helper's Accessibility prompt"
  );
  assert.equal(
    statuses.some(({ status, source }) =>
      status === "settings_accessibility" && source === "settings"
    ),
    true
  );

  await clock.advance(5_000);
  assert.equal(native.stats.settingsStarts, 2, "Settings remains eligible for its bounded retry");
  native.settingsRequests[1].reject(accessibilityDeniedError());
  await clock.flush();
  await clock.advance(85_000);
  assert.equal(
    manual.calls.length,
    1,
    "the hidden terminal fallback must start only after Settings exhausts its budget"
  );
  manual.calls[0].resolve("864209");
  await clock.flush();
  assert.equal(await codePromise, "864209");
  await collector.dispose();
}

async function settingsOnlyGenerationTwoRejectsPreviousCodeTest() {
  const { clock, native, collector } = createHarness({
    settingsOnly: true,
    manualFallback: false,
  });
  await collector.prepare();

  const first = collector.getCode({ generation: 1, rejectPrevious: false });
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(await first, "111111");

  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  await clock.advance(5_000);
  assert.equal(
    native.stats.settingsStarts,
    2,
    "generation 2 may consume only the one remaining collector-wide Settings attempt"
  );
  native.settingsRequests[1].resolve({ code: "111111" });
  await clock.flush();
  await clock.advance(5_000);
  assert.equal(native.stats.settingsStarts, 2, "generation 2 must not reset the Settings budget");
  const rejected = assert.rejects(second, /disposed/i);
  await collector.dispose();
  await rejected;
  assert.deepEqual(popupHelperStats(native), {
    stalePopupCleanupCalls: 0,
    probeCalls: 0,
    allowAttempts: 0,
    popupReads: 0,
    popupPhaseCalls: 0,
    popupCloseCalls: 0,
  });
  await collector.dispose();
}

async function settingsStartFailureEmitsFixedStatusAfterAuditTest() {
  const timeline = [];
  const startError = new Error("private helper stderr AX OCR 123456");
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 0,
    manualFallback: false,
    settingsStartFailures: 1,
    settingsStartError: startError,
    onAudit(entry) {
      if (entry.phase === "settings_provider_failed") timeline.push("audit");
    },
    onStatus(entry) {
      if (entry.status === "settings_failed") timeline.push("status");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(0);

  assert.equal(native.stats.settingsStarts, 1);
  assert.deepEqual(
    statuses.filter(({ status }) => status === "settings_failed"),
    [{ status: "settings_failed", attempt: 1, source: "settings", remainingSec: 30 }]
  );
  assert.deepEqual(timeline, ["audit", "status"]);
  assert.equal(
    audits.some(
      ({ phase, reason }) =>
        phase === "settings_provider_failed" && reason === "settings_start_failed"
    ),
    true
  );
  assert.equal(JSON.stringify(statuses).includes("123456"), false);
  assert.equal(JSON.stringify(statuses).includes("stderr"), false);

  await clock.advance(5_000);
  assert.equal(native.stats.settingsStarts, 2, "a start failure must leave retry available");
  native.settingsRequests[0].resolve({ code: "654321" });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
}

async function settingsRetriesOnceAfterFiveSecondsTest() {
  const { clock, native, collector, audits, statuses } = createHarness({
    timeoutMs: 240_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode();

  await clock.advance(8_000);
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(native.settingsRequests[0].options.timeoutMs, 60_000);
  const timeoutError = new Error("private settings failure 123456");
  timeoutError.code = "2FA_SETTINGS_TIMEOUT";
  native.settingsRequests[0].reject(timeoutError);
  await clock.flush();

  await clock.advance(4_999);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 2);
  assert.equal(native.settingsRequests[1].options.timeoutMs, 60_000);

  native.settingsRequests[1].resolve({ code: "654321", screenshot: "must-not-escape" });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  assert.deepEqual(
    statuses.filter(({ status }) => status === "settings_start").map(({ attempt }) => attempt),
    [1, 2]
  );
  assert.equal(
    statuses
      .filter(({ status }) => status === "settings_start" || status === "settings_retry")
      .every(({ source }) => source === "settings"),
    true
  );
  assert.equal(statuses.some(({ status }) => status === "settings_retry"), true);
  assert.equal(
    audits.some(
      ({ phase, reason }) =>
        phase === "settings_provider_failed" && reason === "settings_timeout"
    ),
    true
  );
  await collector.dispose();
}

async function settingsFixedFailureReasonIsPreservedTest() {
  const timeline = [];
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 0,
    manualFallback: false,
    onAudit(entry) {
      if (entry.phase === "settings_provider_failed") timeline.push("audit");
    },
    onStatus(entry) {
      if (entry.status === "settings_failed") timeline.push("status");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(0);

  const error = new Error("private settings failure 123456");
  error.code = "2FA_SETTINGS_ALERT_NOT_OPENED";
  native.settingsRequests[0].reject(error);
  await clock.flush();

  assert.equal(
    audits.some(
      ({ phase, reason }) =>
        phase === "settings_provider_failed" && reason === "settings_alert_not_opened"
    ),
    true
  );
  assert.deepEqual(
    statuses.filter(({ status }) => status === "settings_failed"),
    [{ status: "settings_failed", attempt: 1, source: "settings", remainingSec: 30 }]
  );
  assert.deepEqual(timeline, ["audit", "status"]);
  assert.deepEqual(
    Object.keys(statuses.find(({ status }) => status === "settings_failed")).sort(),
    ["attempt", "remainingSec", "source", "status"]
  );
  assert.equal(JSON.stringify(statuses).includes("settings_alert_not_opened"), false);
  assert.equal(JSON.stringify(audits).includes("123456"), false);
  assert.equal(JSON.stringify(statuses).includes("123456"), false);
  await collector.dispose();
  await assert.rejects(codePromise, /disposed/i);
}

async function diagnosticCallbackSanitizesSettingsFailureTest() {
  const sensitiveValues = [
    "TOP-SECRET-HELPER-STDERR",
    "654321",
    "AX OCR raw verification text",
    "fake-account@example.invalid",
    "nested-cause@example.invalid",
  ];
  const { clock, native, collector, diagnostics } = createHarness({
    settingsFallbackAfterMs: 0,
    manualFallback: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(0);

  const error = new Error(sensitiveValues.join(" | "));
  error.code = "2FA_SETTINGS_ALERT_NOT_OPENED";
  error.hasHelperStderr = true;
  error.stack = `Error: ${sensitiveValues.join(" | ")}`;
  error.cause = new Error(`nested cause: ${sensitiveValues.at(-1)} OTP 123456`);
  native.settingsRequests[0].reject(error);
  await clock.flush();

  assert.deepEqual(diagnostics, [
    {
      source: "settings",
      phase: "settings_provider_failed",
      error: { code: "2FA_PROVIDER_ERROR", hasHelperStderr: true },
    },
  ]);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), ["error", "phase", "source"]);
  assert.deepEqual(Object.keys(diagnostics[0].error).sort(), ["code", "hasHelperStderr"]);
  const serialized = JSON.stringify(diagnostics);
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(
      serialized.includes(sensitiveValue),
      false,
      `onDiagnostic must not expose raw helper data: ${sensitiveValue}`
    );
  }

  const rejected = assert.rejects(codePromise, /disposed/i);
  await collector.dispose();
  await rejected;
}

async function settingsNeverStartsThirdAttemptTest() {
  const { clock, native, collector } = createHarness({ timeoutMs: 240_000 });
  await collector.prepare();
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);

  await clock.advance(8_000);
  native.settingsRequests[0].reject(new Error("first failure"));
  await clock.flush();
  await clock.advance(5_000);
  native.settingsRequests[1].reject(new Error("second failure"));
  await clock.flush();
  await clock.advance(30_000);

  assert.equal(native.stats.settingsStarts, 2);
  await collector.dispose();
  await rejected;
}

async function cancelledSettingsDoesNotRetryTest() {
  const { clock, native, collector, statuses } = createHarness({ timeoutMs: 240_000 });
  await collector.prepare();
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);

  await clock.advance(8_000);
  native.settingsRequests[0].reject(cancellationError());
  await clock.flush();
  await clock.advance(10_000);

  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(
    statuses.some(({ status }) => status === "settings_failed"),
    false,
    "cancelled Settings must not be reported as failed"
  );
  await collector.dispose();
  await rejected;
}

async function settingsAccessibilityDeniedNeverUsesPopupAuthorizationTest() {
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 20,
    accessibilityProvider() {
      assert.fail("Settings denial must never invoke the popup helper authorization path");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();

  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(native.stats.accessibilityStarts, 0);
  assert.equal(
    statuses.some(({ status }) => status === "settings_accessibility"),
    false,
    "normal popup-first collection must not report a different helper authorization wait"
  );
  assert.equal(
    audits.some(
      ({ phase, reason }) =>
        phase === "settings_provider_failed" && reason === "accessibility_denied"
    ),
    true
  );

  await clock.advance(4_999);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 2, "Settings must use its bounded five-second retry");
  native.settingsRequests[1].resolve({ code: "606060" });
  await clock.flush();
  assert.equal(await codePromise, "606060");
  await collector.dispose();
}

async function synchronousSettingsAccessibilityDeniedUsesBoundedRetryTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    settingsStartFailures: 1,
    settingsStartError: accessibilityDeniedError(),
    accessibilityProvider() {
      assert.fail("A synchronous Settings denial must not prompt the popup helper");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  await clock.advance(20);
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(native.stats.accessibilityStarts, 0);
  await clock.advance(4_999);
  assert.equal(native.stats.settingsStarts, 1);
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 2);
  native.settingsRequests[0].resolve({ code: "616161" });
  await clock.flush();
  assert.equal(await codePromise, "616161");
  await collector.dispose();
}

async function settingsFallbackSuppressesLatePopupCandidateTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    accessibilityProvider() {
      assert.fail("Settings denial must not invoke the popup helper authorization path");
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);
  const popupReadsAtFallback = native.stats.popupReads.length;
  native.setPopup("707070");
  await clock.advance(20);

  assert.equal(
    native.stats.popupReads.length,
    popupReadsAtFallback,
    "a late popup must not re-enter after the serial Settings fallback starts"
  );
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  await clock.advance(5_000);
  assert.equal(native.stats.settingsStarts, 2);
  native.settingsRequests[1].resolve({ code: "808080" });
  await clock.flush();
  assert.equal(await codePromise, "808080");
  assert.equal(native.stats.accessibilityStarts, 0);
  await collector.dispose();
}

async function allowBudgetStopsAtTwoAndReportsManualOnceTest() {
  const { clock, native, collector, statuses } = createHarness({
    allowAttemptOutcome: "remain",
    timeoutMs: 240_000,
  });
  await collector.prepare();
  native.setAllowVisible(true);
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);

  await clock.advance(30_100);

  assert.equal(native.stats.allowAttempts.length, 2);
  assert.ok(native.stats.probeCalls > native.stats.allowAttempts.length);
  assert.equal(native.stats.settingsStarts, 1, "Settings must continue after Allow budget exhaustion");
  assert.equal(
    statuses.filter(({ status }) => status === "manual_allow").length,
    1,
    "manual_allow must be emitted once"
  );
  for (const payload of statuses) {
    assert.deepEqual(
      Object.keys(payload).filter(
        (key) => !["status", "attempt", "source", "remainingSec"].includes(key)
      ),
      [],
      "status payload must not carry arbitrary native text"
    );
    assert.equal(typeof payload.status, "string");
    if ("attempt" in payload) assert.equal(Number.isInteger(payload.attempt), true);
    if ("remainingSec" in payload) assert.equal(Number.isInteger(payload.remainingSec), true);
  }

  await collector.dispose();
  await rejected;
}

async function manualFallbackStartsAtNinetySecondsTest() {
  const manual = createManualProviderHarness();
  const { clock, collector, audits, statuses } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  await clock.advance(89_999);
  assert.equal(manual.calls.length, 0);
  await clock.advance(1);
  assert.equal(manual.calls.length, 1);
  assert.equal(manual.calls[0].timeoutMs, 150_000);
  assert.equal(
    statuses.some(({ status, source }) => status === "manual_code" && source === "manual"),
    true
  );

  manual.calls[0].resolve("123456");
  await clock.flush();
  assert.equal(await codePromise, "123456");
  assert.equal(manual.calls[0].aborted, false);
  assert.equal(JSON.stringify(audits).includes("123456"), false);
  await collector.dispose();
}

async function manualFallbackReservesNinetySecondInputWindowTest() {
  const manual = createManualProviderHarness();
  const { clock, collector } = createHarness({
    timeoutMs: 130_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });

  await clock.advance(39_999);
  assert.equal(manual.calls.length, 0);
  await clock.advance(1);
  assert.equal(manual.calls.length, 1);
  assert.equal(manual.calls[0].timeoutMs, 90_000);

  manual.calls[0].resolve("234567");
  await clock.flush();
  assert.equal(await codePromise, "234567");
  await collector.dispose();
}

async function manualFallbackSuppressesLatePopupCandidateTest() {
  const manual = createManualProviderHarness();
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(90_000);
  assert.equal(manual.calls.length, 1);

  native.setPopup("234567");
  await clock.advance(2_000);
  assert.equal(manual.calls[0].aborted, false);
  manual.calls[0].resolve("345678");
  await clock.flush();
  assert.equal(await codePromise, "345678");
  await collector.dispose();
}

async function popupWinnerReturnsBeforeFallbackStartsTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    manualFallback: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.setPopup("765432");
  await clock.advance(10);
  assert.equal(await codePromise, "765432");
  assert.equal(native.stats.settingsStarts, 0);
  await collector.dispose();
}

async function popupWinnerWaitsForBoundedSettingsCleanupTest() {
  const { clock, native, collector, statuses } = createHarness({
    settingsFallbackAfterMs: 0,
    settingsCancelSettles: false,
    settingsForceStopSettles: false,
    manualFallback: false,
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(10);
  assert.equal(native.stats.settingsStarts, 1);

  let returned = false;
  codePromise.then(() => {
    returned = true;
  });
  native.setPopup("876543");
  await clock.advance(10);
  assert.equal(
    returned,
    false,
    "a popup winner must not return while the Settings helper can still cover Firefox"
  );
  assert.equal(native.stats.settingsForceStops, 0);

  await clock.advance(49);
  assert.equal(returned, false);
  assert.equal(native.stats.settingsForceStops, 0);
  await clock.advance(1);
  assert.equal(native.stats.settingsForceStops, 1);
  assert.equal(returned, false, "force-stop cleanup gets its own bounded grace");
  await clock.advance(49);
  assert.equal(returned, false);
  await clock.advance(1);
  assert.equal(await codePromise, "876543");
  assert.equal(
    statuses.some(({ status }) => status === "settings_failed"),
    false,
    "a popup winner cancelling Settings must not be reported as a Settings failure"
  );
  await collector.dispose();
}

async function popupWinnerSuppressesLateSettingsFailureStatusTest() {
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 0,
    settingsCancelSettles: false,
    manualFallback: false,
    popupDeliveryGraceMs: 0,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(10);
  assert.equal(native.stats.settingsStarts, 1);

  native.setPopup("876543");
  await clock.advance(10);
  let returned = false;
  codePromise.then(() => {
    returned = true;
  });
  assert.equal(returned, false, "delivery must wait for loser cleanup");

  const lateError = new Error("private late Settings failure 123456");
  native.settingsRequests[0].reject(lateError);
  await clock.flush();
  assert.equal(await codePromise, "876543");

  assert.equal(
    statuses.some(({ status }) => status === "settings_failed"),
    false,
    "a late Settings failure after another winner must not reach the live status channel"
  );
  assert.equal(
    audits.some((entry) => entry.phase === "settings_provider_failed"),
    true,
    "the fixed audit record must remain available for the late helper failure"
  );
  assert.equal(JSON.stringify(audits).includes("123456"), false, "audit leaked late OTP");
  await collector.dispose();
}

async function manualWinnerCancelsActiveSettingsTest() {
  const manual = createManualProviderHarness();
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(90_000);
  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(manual.calls.length, 1);

  manual.calls[0].resolve("345678");
  await clock.flush();
  assert.equal(await codePromise, "345678");
  assert.equal(native.stats.settingsCancels, 1);
  await collector.dispose();
}

async function settingsWinnerAbortsManualFallbackTest() {
  const manual = createManualProviderHarness();
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(90_000);
  assert.equal(manual.calls.length, 1);

  native.settingsRequests[0].resolve({ code: "456789" });
  await clock.flush();
  assert.equal(await codePromise, "456789");
  assert.equal(manual.calls[0].aborted, true);
  await collector.dispose();
}

async function settingsWinnerStopsInFlightPopupActionsTest() {
  const watcherProbe = deferred();
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallbackAfterMs: 0,
    manualFallback: false,
    pollIntervalMs: 10,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.queueProbeResults(watcherProbe.promise);
  await clock.advance(10);
  assert.equal(native.stats.settingsStarts, 1);

  native.settingsRequests[0].resolve({ code: "787878" });
  await Promise.resolve();
  watcherProbe.resolve({ action: "has_allow_dialog" });
  await clock.flush();

  assert.equal(await codePromise, "787878");
  assert.equal(
    native.stats.allowAttempts.length,
    0,
    "an in-flight probe must not start Allow after Settings settles the winner"
  );
  assert.equal(native.stats.popupReads.length, 0);

  native.setPopup("898989");
  await clock.advance(10);
  assert.equal(native.stats.cleanupDismissals, 1, "cleanup-only must own later popup work");
  assert.equal(native.stats.popupReads.length, 0, "cleanup-only must not start popup OCR/read");
  await collector.dispose();
}

async function manualWinnerStopsInFlightPopupActionsTest() {
  const watcherProbe = deferred();
  const manualResult = deferred();
  let manualCalls = 0;
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider() {
      manualCalls += 1;
      return manualResult.promise;
    },
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  native.queueProbeResults(watcherProbe.promise);
  await clock.advance(90_000);
  assert.equal(manualCalls, 1);

  manualResult.resolve("909090");
  await Promise.resolve();
  watcherProbe.resolve({ action: "has_allow_dialog" });
  await clock.flush();

  assert.equal(await codePromise, "909090");
  assert.equal(
    native.stats.allowAttempts.length,
    0,
    "an in-flight probe must not start Allow after manual entry settles the winner"
  );
  assert.equal(native.stats.popupReads.length, 0);

  native.setPopup("919191");
  await clock.advance(1_000);
  assert.equal(native.stats.cleanupDismissals, 1, "cleanup-only must own later popup work");
  assert.equal(native.stats.popupReads.length, 0, "cleanup-only must not start popup OCR/read");
  await collector.dispose();
}

async function nonTtyNeverStartsManualFallbackTest() {
  const manual = createManualProviderHarness();
  const { clock, collector, audits, statuses } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: false,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /disposed/i);
  await clock.advance(120_000);
  assert.equal(manual.calls.length, 0);
  assert.deepEqual(
    statuses
      .filter(({ status }) => status === "manual_unavailable")
      .map(({ status, source }) => ({ status, source })),
    [{ status: "manual_unavailable", source: "manual" }]
  );
  assert.equal(
    audits.some(
      (entry) =>
        entry.phase === "manual_provider_unavailable" &&
        entry.source === "manual" &&
        entry.reason === "tty_unavailable" &&
        entry.outcome === "unavailable"
    ),
    true
  );
  await collector.dispose();
  await rejected;
}

async function manualFallbackEnvironmentToggleTest() {
  const original = process.env.BROWSER_2FA_MANUAL_FALLBACK;
  try {
    process.env.BROWSER_2FA_MANUAL_FALLBACK = "0";
    const disabledManual = createManualProviderHarness();
    const disabled = createHarness({
      timeoutMs: 240_000,
      settingsFallback: false,
      manualCodeProvider: disabledManual.provider,
      isTTY: true,
      pollIntervalMs: 1_000,
    });
    await disabled.collector.prepare();
    const disabledCode = disabled.collector.getCode({ generation: 1 });
    const disabledRejected = assert.rejects(disabledCode, /disposed/i);
    await disabled.clock.advance(100_000);
    assert.equal(disabledManual.calls.length, 0);
    await disabled.collector.dispose();
    await disabledRejected;

    delete process.env.BROWSER_2FA_MANUAL_FALLBACK;
    const enabledManual = createManualProviderHarness();
    const enabled = createHarness({
      timeoutMs: 240_000,
      settingsFallback: false,
      manualCodeProvider: enabledManual.provider,
      isTTY: true,
      pollIntervalMs: 1_000,
    });
    await enabled.collector.prepare();
    const enabledCode = enabled.collector.getCode({ generation: 1 });
    await enabled.clock.advance(90_000);
    assert.equal(enabledManual.calls.length, 1);
    enabledManual.calls[0].resolve("876543");
    await enabled.clock.flush();
    assert.equal(await enabledCode, "876543");
    await enabled.collector.dispose();
  } finally {
    if (original == null) delete process.env.BROWSER_2FA_MANUAL_FALLBACK;
    else process.env.BROWSER_2FA_MANUAL_FALLBACK = original;
  }
}

async function settingsFallbackEnvironmentToggleTest() {
  const original = process.env.BROWSER_2FA_SETTINGS_FALLBACK;
  try {
    process.env.BROWSER_2FA_SETTINGS_FALLBACK = "0";
    const disabled = createHarness({
      timeoutMs: 240_000,
      settingsFallbackAfterMs: 20,
      manualFallback: false,
      pollIntervalMs: 10,
    });
    await disabled.collector.prepare();
    const disabledCode = disabled.collector.getCode({ generation: 1 });
    await disabled.clock.advance(40);
    assert.equal(disabled.native.stats.settingsStarts, 0);
    const disabledRejected = assert.rejects(disabledCode, /disposed/i);
    await disabled.collector.dispose();
    await disabledRejected;

    delete process.env.BROWSER_2FA_SETTINGS_FALLBACK;
    const enabled = createHarness({
      timeoutMs: 240_000,
      settingsFallbackAfterMs: 20,
      manualFallback: false,
      pollIntervalMs: 10,
    });
    await enabled.collector.prepare();
    const enabledCode = enabled.collector.getCode({ generation: 1 });
    await enabled.clock.advance(20);
    assert.equal(enabled.native.stats.settingsStarts, 1);
    enabled.native.settingsRequests[0].resolve({ code: "246810" });
    await enabled.clock.flush();
    assert.equal(await enabledCode, "246810");
    await enabled.collector.dispose();
  } finally {
    if (original == null) delete process.env.BROWSER_2FA_SETTINGS_FALLBACK;
    else process.env.BROWSER_2FA_SETTINGS_FALLBACK = original;
  }
}

async function timeoutAndDisposeAbortManualFallbackTest() {
  for (const ending of ["timeout", "dispose"]) {
    const manual = createManualProviderHarness();
    const { clock, collector } = createHarness({
      timeoutMs: 240_000,
      settingsFallback: false,
      manualFallback: true,
      manualCodeProvider: manual.provider,
      isTTY: true,
      pollIntervalMs: 1_000,
    });
    await collector.prepare();
    const codePromise = collector.getCode({ generation: 1 });
    await clock.advance(90_000);
    assert.equal(manual.calls.length, 1);

    if (ending === "timeout") {
      const rejected = assert.rejects(codePromise, /超时/);
      await clock.advance(150_000);
      await rejected;
    } else {
      const rejected = assert.rejects(codePromise, /disposed/i);
      await collector.dispose();
      await rejected;
    }
    assert.equal(manual.calls[0].aborted, true, `${ending} must abort hidden input`);
    await collector.dispose();
  }
}

async function disposeDoesNotWaitForNonCooperativeManualProviderTest() {
  let signal = null;
  const { clock, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider(options) {
      signal = options.signal;
      return new Promise(() => {});
    },
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  let codeSettled = false;
  const rejected = assert.rejects(codePromise, /disposed/i).finally(() => {
    codeSettled = true;
  });
  await clock.advance(90_000);
  assert.ok(signal);

  let disposed = false;
  const disposePromise = collector.dispose().then(() => {
    disposed = true;
  });
  await clock.flush();
  await clock.advance(0);

  assert.equal(signal.aborted, true);
  assert.equal(disposed, true, "a provider that ignores Abort must not hang disposal");
  assert.equal(codeSettled, true, "the active generation must also settle after disposal");
  await disposePromise;
  await rejected;
}

async function manualProviderFailureDoesNotStopPopupWinnerTest() {
  let calls = 0;
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: true,
    manualCodeProvider() {
      calls += 1;
      throw new Error("manual provider private failure 123456");
    },
    isTTY: true,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(90_000);
  assert.equal(calls, 1);

  native.setPopup("567890");
  await clock.advance(2_000);
  assert.equal(await codePromise, "567890");
  await collector.dispose();
}

async function generationTwoRejectsAndCannotReusePreviousCodeTest() {
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: false,
    pollIntervalMs: 100,
  });
  await collector.prepare();
  const first = collector.getCode({ generation: 1, rejectPrevious: false });
  native.setPopup("111111");
  await clock.advance(200);
  assert.equal(await first, "111111");

  let secondSettled = false;
  const second = collector
    .getCode({ generation: 2, rejectPrevious: true })
    .finally(() => {
      secondSettled = true;
    });
  native.setPopup("111111");
  await clock.advance(200);
  assert.equal(secondSettled, false, "generation 2 must not reuse generation 1 code");
  assert.ok(native.stats.cleanupDismissals >= 1);

  native.setPopup("222222");
  await clock.advance(200);
  assert.equal(await second, "222222");
  assert.equal(
    native.stats.popupReads.some(({ options }) => options.rejectCodes.has("111111")),
    true
  );
  await collector.dispose();
}

async function generationTwoSettingsWaitsBeforeRequestingFreshCodeTest() {
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallbackAfterMs: 8_000,
    manualFallback: false,
    pollIntervalMs: 100,
  });
  await collector.prepare();

  const first = collector.getCode({ generation: 1 });
  await clock.advance(8_000);
  assert.equal(native.stats.settingsStarts, 1);
  native.settingsRequests[0].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(await first, "111111");

  let secondSettled = false;
  const second = collector
    .getCode({ generation: 2, rejectPrevious: true })
    .finally(() => {
      secondSettled = true;
    });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1, "generation 2 must not request immediately");

  native.setPopup("222222");
  await clock.advance(200);
  assert.equal(await second, "222222");
  assert.equal(secondSettled, true);
  assert.equal(
    native.stats.settingsStarts,
    1,
    "generation 2 popup success must prevent a second Settings request"
  );
  await collector.dispose();
}

async function generationSequenceIsStrictTest() {
  const { clock, native, collector } = createHarness({
    settingsFallback: false,
    manualFallback: false,
    pollIntervalMs: 100,
  });
  await collector.prepare();
  await assert.rejects(collector.getCode({ generation: 2 }), /generation/i);

  const first = collector.getCode({ generation: 1 });
  native.setPopup("333333");
  await clock.advance(200);
  assert.equal(await first, "333333");
  await assert.rejects(collector.getCode({ generation: 1 }), /generation/i);
  await assert.rejects(collector.getCode({ generation: 3 }), /generation/i);
  await collector.dispose();
}

async function generationsShareOneDeadlineTest() {
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    settingsFallback: false,
    manualFallback: false,
    pollIntervalMs: 1_000,
  });
  await collector.prepare();
  const first = collector.getCode({ generation: 1 });
  native.setPopup("444444");
  await clock.advance(2_000);
  assert.equal(await first, "444444");

  await clock.advance(237_999);
  const second = collector.getCode({ generation: 2, rejectPrevious: true });
  const rejected = assert.rejects(second, /超时/);
  await clock.advance(1);
  await rejected;
  await collector.dispose();
}

async function disposeCancelsSettingsRetryDelayTest() {
  const { clock, native, collector } = createHarness({ timeoutMs: 240_000 });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  const rejected = assert.rejects(codePromise, /disposed/i);
  await clock.advance(8_000);
  native.settingsRequests[0].reject(new Error("retryable"));
  await clock.flush();

  await collector.dispose();
  await clock.advance(5_000);
  assert.equal(native.stats.settingsStarts, 1);
  await rejected;
}

function sidecarHasNoScreenshotOrAppleScriptAuditContractTest() {
  const source = fs.readFileSync(new URL("./lib/two-fa-sidecar.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /screenshot\s*:/);
  assert.doesNotMatch(source, /["']applescript["']/i);
  assert.match(source, /options\.isTTY \?\?/);
  assert.match(source, /process\.stdin\?\.isTTY === true/);
  assert.match(source, /process\.stdout\?\.isTTY === true/);
  assert.match(source, /process\.env\.APPLE_AUTOMATION_SUPERVISED_GUI === "1"/);
}

async function latePopupBeatsSettingsTest() {
  const { clock, native, collector } = createHarness({ settingsFallbackAfterMs: 20 });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);

  native.setPopup("246810");
  await clock.advance(20);
  assert.equal(await codePromise, "246810");
  assert.equal(native.stats.settingsCancels, 1);
  assert.equal(native.stats.settingsForceStops, 0);
  assert.equal(native.stats.popupWinnerClosures, 1);
  await collector.dispose();
}

async function settingsWinnerEnablesCleanupOnlyTest() {
  const { clock, native, collector } = createHarness({ settingsFallbackAfterMs: 20 });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(20);
  native.settingsRequests[0].resolve({ code: "135790", raw: "135 790", screenshot: null });
  await clock.flush();
  assert.equal(await codePromise, "135790");

  native.setAllowVisible(true);
  await clock.advance(20);
  assert.equal(native.stats.allowClicks, 0, "cleanup-only mode must not click a new Allow dialog");
  native.setAllowVisible(false);
  native.setPopup("112233");
  await clock.advance(10);
  assert.equal(native.stats.cleanupDismissals, 1);
  await collector.dispose();
}

async function staleCodeIsRejectedTest() {
  const { clock, native, collector } = createHarness({
    staleCodes: ["123456"],
    settingsFallbackAfterMs: 10_000,
  });
  await collector.prepare();
  const codePromise = collector.getCode();

  native.setPopup("123456");
  await clock.advance(10);
  assert.equal(native.stats.cleanupDismissals, 1);

  native.setPopup("445566");
  await clock.advance(20);
  assert.equal(await codePromise, "445566");
  await collector.dispose();
}

async function providerFailureFallsBackTest() {
  const { clock, native, collector } = createHarness({ settingsFallbackAfterMs: 20 });
  await collector.prepare();
  const codePromise = collector.getCode();
  await clock.advance(20);
  native.settingsRequests[0].reject(new Error("settings unavailable"));
  await clock.flush();

  native.setPopup("778899");
  await clock.advance(20);
  assert.equal(await codePromise, "778899");
  await collector.dispose();
}

async function popupForcesUnresponsiveSettingsCleanupTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    settingsCancelSettles: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  let returned = false;
  codePromise.then(() => {
    returned = true;
  });
  await clock.advance(20);

  native.setPopup("121212");
  await clock.advance(20);
  assert.equal(native.stats.settingsCancels, 1);
  assert.equal(returned, false, "popup delivery must wait while Settings can cover Firefox");

  await clock.advance(39);
  assert.equal(native.stats.settingsForceStops, 0);
  assert.equal(returned, false);
  await clock.advance(1);
  assert.equal(native.stats.settingsForceStops, 1);
  assert.equal(await codePromise, "121212");
  await collector.dispose();
}

async function popupWaitsAfterForceStopForBoundedCloseTest() {
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    settingsCancelSettles: false,
    settingsForceStopSettles: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  let returned = false;
  codePromise.then(() => {
    returned = true;
  });
  await clock.advance(20);
  native.setPopup("232323");
  await clock.advance(20);
  assert.equal(returned, false, "popup delivery must wait for force-stop cleanup");

  await clock.advance(50);
  assert.equal(native.stats.settingsForceStops, 1);
  assert.equal(returned, false);
  await clock.advance(39);
  assert.equal(returned, false);
  await clock.advance(1);
  assert.equal(await codePromise, "232323");
  await collector.dispose();
}

async function disposalStopsAllWorkTest() {
  const { clock, native, collector } = createHarness({ settingsFallbackAfterMs: 20 });
  await collector.prepare();
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);
  await clock.advance(20);
  assert.equal(native.stats.settingsStarts, 1);

  await collector.dispose();
  await rejected;
  assert.equal(native.stats.settingsCancels, 1);
  assert.equal(clock.timers.size, 0);
}

async function disposeDuringInFlightWatcherProbeStopsBeforeAllowActionTest() {
  const clock = new ManualClock();
  let probeCalls = 0;
  let allowAttempts = 0;
  let watcherSignal = null;
  const collector = createMac2FACollector({
    pollIntervalMs: 10,
    runtime: {
      platform: "darwin",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      async dismissStale2FAPopups() {
        return { count: 0, codes: [] };
      },
      async probe2FAState(_timeoutSec, options = {}) {
        probeCalls += 1;
        if (probeCalls === 1) return { action: "idle" };
        if (probeCalls === 2) {
          watcherSignal = options.signal;
          return new Promise((resolve) => {
            if (watcherSignal?.aborted) resolve({ action: "idle" });
            else watcherSignal?.addEventListener("abort", () => resolve({ action: "idle" }), {
              once: true,
            });
          });
        }
        return { action: "idle" };
      },
      async tryAllowOnce() {
        allowAttempts += 1;
        return { attempted: true, strategy: "cg_ax", source: "FollowUpUI" };
      },
    },
  });

  await collector.prepare();
  await clock.flush();
  assert.equal(probeCalls, 2, "watcher probe must be in flight before disposal");

  let disposeSettled = false;
  const disposePromise = collector.dispose().then(() => {
    disposeSettled = true;
  });
  await clock.flush();
  assert.equal(watcherSignal?.aborted, true, "dispose must abort the watcher probe");
  await disposePromise;

  assert.equal(disposeSettled, true, "an aborted watcher probe must not delay disposal");
  assert.equal(allowAttempts, 0, "an aborted probe must not click Allow");
  assert.equal(clock.timers.size, 0);
}

async function disposeAbortsInFlightWatcherAllowTest() {
  const clock = new ManualClock();
  let probeCalls = 0;
  let allowSignal = null;
  const collector = createMac2FACollector({
    pollIntervalMs: 10,
    settingsFallback: false,
    manualFallback: false,
    runtime: {
      platform: "darwin",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      async dismissStale2FAPopups() {
        return { count: 0, codes: [] };
      },
      async probe2FAState() {
        probeCalls += 1;
        return probeCalls === 1 ? { action: "idle" } : { action: "has_allow_dialog" };
      },
      async tryAllowOnce(_timeoutSec, options = {}) {
        allowSignal = options.signal;
        return new Promise((resolve) => {
          if (allowSignal?.aborted) resolve({ attempted: false });
          else allowSignal?.addEventListener("abort", () => resolve({ attempted: false }), {
            once: true,
          });
        });
      },
    },
  });

  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(10);
  assert.ok(allowSignal, "popup-primary watcher must start the Allow helper after need_2fa");

  await collector.dispose();
  assert.equal(allowSignal.aborted, true, "dispose must abort the Allow helper");
  await assert.rejects(codePromise, /disposed/i);
  assert.equal(clock.timers.size, 0);
}

async function disposeWaitsForInProgressPreparationTest() {
  for (const blockedCall of ["dismiss_stale", "probe", "dismiss_visible_code"]) {
    const clock = new ManualClock();
    const nativeCall = deferred();
    const calls = [];
    const audits = [];
    let settingsStarts = 0;
    const waitIfBlocked = async (name) => {
      calls.push(name);
      if (name === blockedCall) await nativeCall.promise;
    };
    const collector = createMac2FACollector({
      pollIntervalMs: 10,
      onAudit(entry) {
        audits.push(entry);
      },
      runtime: {
        platform: "darwin",
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        async dismissStale2FAPopups() {
          await waitIfBlocked("dismiss_stale");
          return { count: 0, codes: [] };
        },
        async probe2FAState() {
          await waitIfBlocked("probe");
          return { action: "has_code_dialog", code: "123456" };
        },
        async runPopupPhase() {
          await waitIfBlocked("dismiss_visible_code");
          return { action: "dismissed_stale", code: "123456" };
        },
        start2FASettingsCodeRequest() {
          settingsStarts += 1;
          throw new Error("settings must not start during disposal");
        },
      },
    });

    const prepareOutcomePromise = collector.prepare().then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error })
    );
    await clock.flush();
    assert.equal(calls.at(-1), blockedCall, `prepare must reach ${blockedCall}`);

    let disposeSettled = false;
    const disposePromise = collector.dispose().then(() => {
      disposeSettled = true;
    });
    await clock.flush();
    const disposeSettledBeforeRelease = disposeSettled;
    const callsBeforeRelease = [...calls];

    nativeCall.resolve();
    const prepareOutcome = await prepareOutcomePromise;
    await disposePromise;
    await clock.flush();

    assert.equal(
      disposeSettledBeforeRelease,
      false,
      `dispose must wait while ${blockedCall} is in progress`
    );
    assert.equal(prepareOutcome.status, "rejected");
    assert.match(prepareOutcome.error.message, /disposed/i);
    assert.deepEqual(
      calls,
      callsBeforeRelease,
      `prepare must not enter another native call after ${blockedCall} returns`
    );
    assert.equal(settingsStarts, 0);
    assert.equal(
      audits.some((entry) => entry.phase === "prepare_2fa"),
      false,
      "disposed preparation must not be audited as prepared"
    );
    assert.equal(clock.timers.size, 0, "disposed preparation must not start a watcher timer");
  }
}

async function disposalClosesVisiblePopupTest() {
  const { native, collector } = createHarness();
  await collector.prepare();
  native.setPopup("998877");

  await collector.dispose();
  assert.equal(native.stats.cleanupDismissals, 1);
}

const focusedTests = {
  "report-dir": readOnlyCwdDoesNotAffectHarnessReportsTest,
  "initial-probe-failure": initialPopupProbeFailureDoesNotAbortPreparationTest,
  "popup-accessibility-prompt": popupAccessibilityPromptStartsWithoutBlockingCodeAcquisitionTest,
  "allow-remains": allowAttemptRemainingVisibleIsNotConfirmedTest,
  "allow-confirmation-bounded": allowConfirmationGraceIsBoundedForLargePollIntervalTest,
  "generation-wake": generationOneWakesPopupWatcherForLargePollIntervalTest,
  "allow-confirmation-no-overlap": uncooperativePopupProbeNeverOverlapsConfirmationProbeTest,
  "popup-dispose-timeout": disposeDoesNotWaitForUncooperativePopupProbeTest,
  "generation-stale-popup-probe": generationTwoWaitsForStalePopupProbeBeforeRestartingTest,
  "generation-stale-popup-settings": generationTwoStaleProbeStillReachesSerialSettingsFallbackTest,
  "generation-stale-popup-manual": generationTwoStaleProbeCannotStarveManualFallbackTest,
  "allow-failed-window": failedAutomaticAllowDoesNotExtendPopupPrimaryWindowTest,
  "manual-allow-grace": manualAllowExtendsPopupPrimaryWindowTest,
  "allow-transition": allowIsConfirmedOnlyAfterStableStateTransitionTest,
  "preexisting-allow": preexistingAllowIsNeverAutomaticallyClickedTest,
  "preexisting-code": preexistingAllowCodeIsDismissedRejectedAndGateStaysClosedTest,
  "preexisting-clear": newAllowAfterPreexistingGateClearUsesAutomaticBudgetTest,
  "probe-error": probeErrorsResetAllowDisappearanceAndAuditSafelyTest,
  "probe-failure-variants": unknownMalformedAndThrownProbesNeverConfirmAllowTest,
  audit: auditIsThrottledAndSanitizedTest,
  "audit-labels": auditLabelsUseExplicitAllowListsTest,
  "popup-reader-options": popupReaderReceivesCodeOnlyOptionsTest,
  "popup-rejected": rejectedPopupReaderResultIsDismissedWithoutWinningTest,
  "ocr-permission-status": ocrPermissionStatusIsFixedOnceAndSettingsContinuesTest,
  "popup-accessibility-ocr": popupAccessibilityFallbackUsesScreenOcrAfterNeedTwoFactorTest,
  "popup-idle-ocr": popupIdleUsesScreenOcrAfterNeedTwoFactorTest,
  "preexisting-active-ocr": preexistingAllowGateDoesNotBlockActiveOcrTest,
  "popup-probe-error-ocr": popupProbeErrorUsesOcrDuringActiveAcquisitionTest,
  "popup-probe-error-cancel": cancelledProbeErrorOcrCannotPublishLateCodeTest,
  "ocr-unavailable-status": unavailableOcrDoesNotEmitPermissionStatusTest,
  "timeout-status": sharedDeadlineEmitsTimeoutBeforeRejectingTest,
  "timeout-late-popup": latePopupReaderAtDeadlineCannotWinTest,
  "winner-status": winnerUsesStatusWithoutDynamicConsoleTest,
  "late-need": lateNeedStartsSettingsImmediatelyTest,
  "popup-close-pending": popupCodeWinsAfterAllDialogCleanupPathsFailTest,
  "popup-close-grace": popupDeliveryGraceNeverExceedsConfiguredMaximumTest,
  "generation-cleanup": generationTwoRunsCleanupWhileGenerationOneCleanupIsPendingTest,
  "prepare-dispose": disposeWaitsForInProgressPreparationTest,
  "watcher-dispose": disposeDuringInFlightWatcherProbeStopsBeforeAllowActionTest,
  "watcher-allow-dispose": disposeAbortsInFlightWatcherAllowTest,
  "settings-start-failure": settingsStartFailureEmitsFixedStatusAfterAuditTest,
  "diagnostic-sanitization": diagnosticCallbackSanitizesSettingsFailureTest,
  "settings-retry": settingsRetriesOnceAfterFiveSecondsTest,
  "settings-max": settingsNeverStartsThirdAttemptTest,
  "settings-cancel": cancelledSettingsDoesNotRetryTest,
  "settings-only": settingsOnlyStartsImmediatelyWithoutPopupHelpersTest,
  "settings-only-manual": settingsOnlyManualFallbackStartsAtNinetySecondsTest,
  "settings-only-accessibility-manual": settingsOnlyAccessibilityFailureKeepsManualFallbackOnScheduleTest,
  "settings-only-generation": settingsOnlyGenerationTwoRejectsPreviousCodeTest,
  "settings-accessibility": settingsAccessibilityDeniedNeverUsesPopupAuthorizationTest,
  "settings-sync-accessibility": synchronousSettingsAccessibilityDeniedUsesBoundedRetryTest,
  "settings-fallback-late-popup": settingsFallbackSuppressesLatePopupCandidateTest,
  "allow-budget": allowBudgetStopsAtTwoAndReportsManualOnceTest,
  "manual-start": manualFallbackStartsAtNinetySecondsTest,
  "manual-window": manualFallbackReservesNinetySecondInputWindowTest,
  "manual-late-popup": manualFallbackSuppressesLatePopupCandidateTest,
  "popup-fast-return": popupWinnerReturnsBeforeFallbackStartsTest,
  "manual-nontty": nonTtyNeverStartsManualFallbackTest,
  "manual-env": manualFallbackEnvironmentToggleTest,
  "settings-env": settingsFallbackEnvironmentToggleTest,
  "manual-cleanup": timeoutAndDisposeAbortManualFallbackTest,
  "manual-noncooperative": disposeDoesNotWaitForNonCooperativeManualProviderTest,
  generation: generationTwoRejectsAndCannotReusePreviousCodeTest,
  "generation-settings-retry": generationTwoSettingsWaitsBeforeRequestingFreshCodeTest,
  "generation-sequence": generationSequenceIsStrictTest,
  "generation-deadline": generationsShareOneDeadlineTest,
  "retry-dispose": disposeCancelsSettingsRetryDelayTest,
};

const focusedTest = process.env.TWO_FA_FOCUSED_TEST;
if (focusedTest) {
  const test = focusedTests[focusedTest];
  assert.ok(test, `unknown focused test: ${focusedTest}`);
  await test();
  console.log(`two-fa collector focused test: ${focusedTest} ok`);
} else {
  await readOnlyCwdDoesNotAffectHarnessReportsTest();
  await bufferEarlyPopupTest();
  await initialPopupProbeFailureDoesNotAbortPreparationTest();
  await popupAccessibilityPromptStartsWithoutBlockingCodeAcquisitionTest();
  await collectorCarriesPreparationBoundaryIntoAllowFlowTest();
  await preexistingAllowIsNeverAutomaticallyClickedTest();
  await preexistingAllowCodeIsDismissedRejectedAndGateStaysClosedTest();
  await newAllowAfterPreexistingGateClearUsesAutomaticBudgetTest();
  await allowAttemptRemainingVisibleIsNotConfirmedTest();
  await failedAutomaticAllowDoesNotExtendPopupPrimaryWindowTest();
  await allowConfirmationGraceIsBoundedForLargePollIntervalTest();
  await generationOneWakesPopupWatcherForLargePollIntervalTest();
  await uncooperativePopupProbeNeverOverlapsConfirmationProbeTest();
  await disposeDoesNotWaitForUncooperativePopupProbeTest();
  await generationTwoStaleProbeStillReachesSerialSettingsFallbackTest();
  await generationTwoStaleProbeCannotStarveManualFallbackTest();
  await allowIsConfirmedOnlyAfterStableStateTransitionTest();
  await probeErrorsResetAllowDisappearanceAndAuditSafelyTest();
  await unknownMalformedAndThrownProbesNeverConfirmAllowTest();
  await auditIsThrottledAndSanitizedTest();
  await auditLabelsUseExplicitAllowListsTest();
  await popupReaderReceivesCodeOnlyOptionsTest();
  await rejectedPopupReaderResultIsDismissedWithoutWinningTest();
  await ocrPermissionStatusIsFixedOnceAndSettingsContinuesTest();
  await popupAccessibilityFailureIsFixedAndDoesNotLeakIntoOcrTest();
  await popupAccessibilityFallbackUsesScreenOcrAfterNeedTwoFactorTest();
  await popupIdleUsesScreenOcrAfterNeedTwoFactorTest();
  await preexistingAllowGateDoesNotBlockActiveOcrTest();
  await popupProbeErrorUsesOcrDuringActiveAcquisitionTest();
  await cancelledProbeErrorOcrCannotPublishLateCodeTest();
  await unavailableOcrDoesNotEmitPermissionStatusTest();
  await sharedDeadlineEmitsTimeoutBeforeRejectingTest();
  await latePopupReaderAtDeadlineCannotWinTest();
  await winnerUsesStatusWithoutDynamicConsoleTest();
  await lateNeedStartsSettingsImmediatelyTest();
  await popupAppearingAfterPreparationIsRetainedUntilNeed2FATest();
  await confirmedAllowExtendsPopupPrimaryWindowTest();
  await manualAllowExtendsPopupPrimaryWindowTest();
  await disabledSettingsDoesNotLeavePopupEligibleAfterPrimaryWindowTest();
  await popupCodePublishesBeforeDialogCleanupGraceTest();
  await manualPopupCloseCannotDiscardBufferedCodeTest();
  await popupDeliveryGraceNeverExceedsConfiguredMaximumTest();
  await popupCodeFallsBackToGenericDialogCleanupTest();
  await popupCodeIsPublishedWhenDialogCleanupFailsTest();
  await popupCodeWinsAfterAllDialogCleanupPathsFailTest();
  await settingsGracePeriodTest();
await settingsOnlyStartsImmediatelyWithoutPopupHelpersTest();
await settingsOnlyManualFallbackStartsAtNinetySecondsTest();
await settingsOnlyAccessibilityFailureKeepsManualFallbackOnScheduleTest();
  await settingsOnlyGenerationTwoRejectsPreviousCodeTest();
  await settingsStartFailureEmitsFixedStatusAfterAuditTest();
  await diagnosticCallbackSanitizesSettingsFailureTest();
  await settingsRetriesOnceAfterFiveSecondsTest();
  await settingsFixedFailureReasonIsPreservedTest();
  await settingsNeverStartsThirdAttemptTest();
  await cancelledSettingsDoesNotRetryTest();
  await settingsAccessibilityDeniedNeverUsesPopupAuthorizationTest();
  await synchronousSettingsAccessibilityDeniedUsesBoundedRetryTest();
  await settingsFallbackSuppressesLatePopupCandidateTest();
  await allowBudgetStopsAtTwoAndReportsManualOnceTest();
  await manualFallbackStartsAtNinetySecondsTest();
  await manualFallbackReservesNinetySecondInputWindowTest();
  await manualFallbackSuppressesLatePopupCandidateTest();
  await popupWinnerReturnsBeforeFallbackStartsTest();
  await nonTtyNeverStartsManualFallbackTest();
  await manualFallbackEnvironmentToggleTest();
  await settingsFallbackEnvironmentToggleTest();
  await timeoutAndDisposeAbortManualFallbackTest();
  await disposeDoesNotWaitForNonCooperativeManualProviderTest();
  await generationTwoRejectsAndCannotReusePreviousCodeTest();
  await generationTwoRunsCleanupWhileGenerationOneCleanupIsPendingTest();
  await generationTwoWaitsForStalePopupProbeBeforeRestartingTest();
  await generationTwoSettingsWaitsBeforeRequestingFreshCodeTest();
  await generationSequenceIsStrictTest();
  await generationsShareOneDeadlineTest();
  await disposeCancelsSettingsRetryDelayTest();
  sidecarHasNoScreenshotOrAppleScriptAuditContractTest();
  await settingsWinnerEnablesCleanupOnlyTest();
  await staleCodeIsRejectedTest();
  await disposalStopsAllWorkTest();
  await disposeDuringInFlightWatcherProbeStopsBeforeAllowActionTest();
  await disposeAbortsInFlightWatcherAllowTest();
  await disposeWaitsForInProgressPreparationTest();
  await disposalClosesVisiblePopupTest();

  console.log("two-fa collector: ok");
}
