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
    popupCloseWait = null,
    popupPrimaryCloseSucceeds = true,
    popupFallbackCloseFailures = 0,
    allowStrategy = null,
    allowSource = "FollowUpUI",
    popupSource = "test-popup",
    dismissAction = "dismissed_stale",
    popupCapability = null,
    initialAllowVisible = false,
    accessibilityProvider = null,
  } = {}
) {
  let popup = null;
  let allowVisible = initialAllowVisible;
  const probeResults = [];
  let fallbackCloseFailuresRemaining = popupFallbackCloseFailures;
  const settingsRequests = [];
  const stats = {
    allowClicks: 0,
    cleanupDismissals: 0,
    popupWinnerClosures: 0,
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
      return { count: staleCodes.length, codes: [...staleCodes] };
    },
    async probe2FAState() {
      stats.probeCalls += 1;
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
      if (!popup) return null;
      return { code: popup.code, raw: popup.raw, source: popupSource };
    },
    async runPopupPhase(phase) {
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
    async dismissCodePopupForWebFill() {
      if (!popup) return false;
      if (popupCloseWait) await popupCloseWait.promise;
      if (!popupPrimaryCloseSucceeds) return false;
      popup = null;
      stats.popupWinnerClosures += 1;
      return true;
    },
    start2FASettingsCodeRequest() {
      stats.settingsStarts += 1;
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
      settingsFallback: options.settingsFallback,
      pollIntervalMs: options.pollIntervalMs ?? 10,
      auditThrottleMs: options.auditThrottleMs ?? 30,
      cleanupGraceMs: 50,
      manualFallback: options.manualFallback,
      manualCodeProvider: options.manualCodeProvider,
      isTTY: options.isTTY ?? false,
      onAudit(entry) {
        audits.push(entry);
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

  return { clock, native, collector, audits, statuses, reportDir };
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
  native.setPopup("123456");
  await clock.advance(20);

  assert.equal(await collector.getCode(), "123456");
  assert.equal(native.stats.settingsStarts, 0);
  assert.equal(native.stats.popupWinnerClosures, 1);
  await collector.dispose();
  assert.equal(clock.timers.size, 0);
}

async function collectorCarriesPreparationBoundaryIntoAllowFlowTest() {
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  native.setAllowVisible(true);
  await clock.advance(10);

  assert.equal(native.stats.allowAttempts.length, 1);
  assert.equal("confirmClick" in native.stats.allowAttempts[0].options, false);
  assert.equal(native.stats.allowAttempts[0].options.maxStrategies, 1);
  assert.equal(native.stats.allowAttempts[0].options.strategyOffset, 0);
  assert.equal(native.stats.fullAllowWaits, 0);
  await collector.dispose();
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
  await collector.dispose();
}

async function allowAttemptRemainingVisibleIsNotConfirmedTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "remain",
  });
  await collector.prepare();
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

async function allowIsConfirmedOnlyAfterStableStateTransitionTest() {
  const { clock, native, collector, audits } = createHarness({
    allowAttemptOutcome: "disappear",
  });
  await collector.prepare();
  native.setAllowVisible(true);

  await clock.advance(10);
  assert.equal(
    audits.some((entry) => entry.phase === "popup_allow"),
    false,
    "the raw action result must remain attempted until a later probe"
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
  native.setAllowVisible(true);
  await clock.advance(10);
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
  native.setAllowVisible(true);
  await clock.advance(10);
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

  native.setPopup("123456", "123 456 password=TOP-SECRET full page body");
  await clock.advance(20);
  assert.equal(await collector.getCode(), "123456");

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
  injected.native.setAllowVisible(true);
  await injected.clock.advance(10);
  injected.native.setPopup("343434");
  await injected.clock.advance(20);
  assert.equal(await injected.collector.getCode(), "343434");

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
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  native.setPopup("343434");
  await clock.advance(20);
  assert.equal(await collector.getCode(), "343434");

  assert.ok(native.stats.popupReads.length >= 1);
  const options = native.stats.popupReads[0].options;
  assert.equal(options.preferOcr, true);
  assert.equal(options.rejectCodes instanceof Set, true);
  assert.equal("requireFormattedRaw" in options, false);
  assert.equal("debugDir" in options, false);
  assert.equal("raw" in options, false);
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

async function unavailableOcrDoesNotEmitPermissionStatusTest() {
  const { clock, native, collector, statuses } = createHarness({
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

async function winnerUsesStatusWithoutDynamicConsoleTest() {
  const { clock, native, collector, statuses } = createHarness();
  await collector.prepare();
  native.setPopup("404040");
  await clock.advance(20);

  const original = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    assert.equal(await collector.getCode({ generation: 1 }), "404040");
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
  assert.equal(native.stats.settingsStarts, 1, "late need must not wait another grace period");
  assert.ok(
    audits.some(
      (entry) =>
        entry.phase === "2fa_acquisition_requested" &&
        entry.elapsedSincePrepareMs === 9_000
    ),
    "late acquisition must be visible in sanitized audit"
  );

  native.settingsRequests[0].resolve({
    code: "654321",
    raw: "654 321",
    screenshot: null,
  });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
}

async function popupCodeWaitsForDialogCleanupTest() {
  const popupCloseWait = deferred();
  const { clock, native, collector } = createHarness({ popupCloseWait });
  await collector.prepare();
  native.setPopup("343434");
  await clock.advance(20);

  let returned = false;
  const codePromise = collector.getCode().then((code) => {
    returned = true;
    return code;
  });
  await clock.flush();
  assert.equal(returned, false, "code must wait until the native popup is closed");

  popupCloseWait.resolve();
  await clock.flush();
  assert.equal(await codePromise, "343434");
  await collector.dispose();
}

async function popupCodeFallsBackToGenericDialogCleanupTest() {
  const { clock, native, collector } = createHarness({
    popupPrimaryCloseSucceeds: false,
  });
  await collector.prepare();
  native.setPopup("565656");
  await clock.advance(20);

  assert.equal(await collector.getCode(), "565656");
  assert.equal(native.stats.popupWinnerClosures, 0);
  assert.equal(native.stats.cleanupDismissals, 1);
  await collector.dispose();
}

async function popupCodeIsNotPublishedUntilCleanupSucceedsTest() {
  const { clock, native, collector } = createHarness({
    popupPrimaryCloseSucceeds: false,
    popupFallbackCloseFailures: 1,
  });
  await collector.prepare();
  native.setPopup("676767");
  await clock.advance(20);

  let returned = false;
  const codePromise = collector.getCode().then((code) => {
    returned = true;
    return code;
  });
  await clock.flush();
  assert.equal(returned, false);

  await clock.advance(10);
  assert.equal(await codePromise, "676767");
  assert.equal(native.stats.cleanupDismissals, 1);
  await collector.dispose();
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
  const { clock, native, collector } = createHarness({ timeoutMs: 240_000 });
  await collector.prepare();
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);

  await clock.advance(8_000);
  native.settingsRequests[0].reject(cancellationError());
  await clock.flush();
  await clock.advance(10_000);

  assert.equal(native.stats.settingsStarts, 1);
  await collector.dispose();
  await rejected;
}

async function settingsAccessibilityRecoveryRestartsImmediatelyTest() {
  const authorization = deferred();
  const authorizationCalls = [];
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 20,
    accessibilityProvider(options) {
      authorizationCalls.push(options);
      return authorization.promise;
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();

  assert.equal(native.stats.settingsStarts, 1);
  assert.equal(native.stats.accessibilityStarts, 1);
  assert.equal(authorizationCalls.length, 1);
  assert.equal(authorizationCalls[0].signal.aborted, false);
  assert.equal(authorizationCalls[0].timeoutMs, 29_980);
  assert.equal(
    statuses.some(
      ({ status, source, attempt }) =>
        status === "settings_accessibility" && source === "settings" && attempt === 1
    ),
    true
  );

  authorization.resolve({ granted: true });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 2, "authorization must retry without a 5 second delay");

  native.settingsRequests[1].resolve({ code: "606060" });
  await clock.flush();
  assert.equal(await codePromise, "606060");
  assert.equal(
    audits.some(
      ({ phase, outcome }) => phase === "settings_accessibility" && outcome === "granted"
    ),
    true
  );
  await collector.dispose();
}

async function settingsAccessibilityDisposePreventsRestartTest() {
  const authorization = deferred();
  let authorizationSignal = null;
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    accessibilityProvider({ signal }) {
      authorizationSignal = signal;
      return authorization.promise;
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  const rejected = assert.rejects(codePromise, /disposed/i);

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  assert.equal(native.stats.accessibilityStarts, 1);

  await collector.dispose();
  assert.equal(authorizationSignal.aborted, true);
  authorization.resolve({ granted: true });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1);
  await rejected;
}

async function settingsAccessibilityWinnerPreventsRestartTest() {
  const authorization = deferred();
  let authorizationSignal = null;
  const { clock, native, collector } = createHarness({
    settingsFallbackAfterMs: 20,
    accessibilityProvider({ signal }) {
      authorizationSignal = signal;
      return authorization.promise;
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  native.setPopup("717171");
  await clock.advance(20);

  assert.equal(await codePromise, "717171");
  assert.equal(authorizationSignal.aborted, true);
  authorization.resolve({ granted: true });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1);
  await collector.dispose();
}

async function settingsAccessibilityDeadlinePreventsRestartTest() {
  const authorization = deferred();
  let authorizationSignal = null;
  const { clock, native, collector } = createHarness({
    timeoutMs: 100,
    settingsFallbackAfterMs: 20,
    accessibilityProvider({ signal }) {
      authorizationSignal = signal;
      return authorization.promise;
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();
  const timedOut = assert.rejects(codePromise, /超时/);

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  await clock.advance(80);
  await timedOut;

  assert.equal(authorizationSignal.aborted, true);
  authorization.resolve({ granted: true });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1);
  await collector.dispose();
}

async function settingsAccessibilityFailureIsFixedAndBoundedTest() {
  const secret = "private authorization failure 123456";
  const { clock, native, collector, audits, statuses } = createHarness({
    settingsFallbackAfterMs: 20,
    async accessibilityProvider() {
      throw new Error(secret);
    },
  });
  await collector.prepare();
  const codePromise = collector.getCode();

  await clock.advance(20);
  native.settingsRequests[0].reject(accessibilityDeniedError());
  await clock.flush();
  assert.equal(native.stats.accessibilityStarts, 1);
  assert.equal(native.stats.settingsStarts, 1);

  native.setPopup("818181");
  await clock.advance(20);
  assert.equal(await codePromise, "818181");
  const serialized = JSON.stringify({ audits, statuses });
  assert.equal(serialized.includes(secret), false);
  assert.equal(
    audits.some(
      ({ phase, reason, outcome }) =>
        phase === "settings_accessibility" &&
        reason === "accessibility_unavailable" &&
        outcome === "unavailable"
    ),
    true
  );
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

  await clock.advance(8_100);

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

async function automaticWinnerAbortsManualFallbackTest() {
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
  assert.equal(await codePromise, "234567");
  assert.equal(manual.calls[0].aborted, true);
  await collector.dispose();
}

async function automaticWinnerAbortsManualBeforeSlowSettingsCleanupTest() {
  const manual = createManualProviderHarness();
  const { clock, native, collector } = createHarness({
    timeoutMs: 240_000,
    manualFallback: true,
    manualCodeProvider: manual.provider,
    isTTY: true,
    pollIntervalMs: 1_000,
    settingsCancelSettles: false,
    settingsForceStopSettles: false,
  });
  await collector.prepare();
  const codePromise = collector.getCode({ generation: 1 });
  await clock.advance(90_000);
  assert.equal(manual.calls.length, 1);
  assert.equal(native.stats.settingsStarts, 1);

  native.setPopup("765432");
  await clock.advance(2_000);
  assert.equal(
    manual.calls[0].aborted,
    true,
    "automatic winner must restore hidden input before waiting for Settings cleanup"
  );

  await clock.advance(100);
  assert.equal(await codePromise, "765432");
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
    statuses.filter(({ status }) => status === "manual_unavailable"),
    [{ status: "manual_unavailable", source: "manual", remainingSec: 240 }]
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
  native.setPopup("111111");
  await clock.advance(200);
  assert.equal(await collector.getCode({ generation: 1 }), "111111");

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

  await clock.advance(2_000);
  let secondSettled = false;
  const second = collector
    .getCode({ generation: 2, rejectPrevious: true })
    .finally(() => {
      secondSettled = true;
    });
  await clock.flush();
  assert.equal(native.stats.settingsStarts, 1, "generation 2 must not request immediately");

  await clock.advance(4_999);
  assert.equal(native.stats.settingsStarts, 1, "generation 2 must keep the full retry delay");
  await clock.advance(1);
  assert.equal(native.stats.settingsStarts, 2, "generation 2 may request after five seconds");

  native.settingsRequests[1].resolve({ code: "111111" });
  await clock.flush();
  assert.equal(secondSettled, false, "generation 2 must reject the previous Settings code");

  native.setPopup("222222");
  await clock.advance(200);
  assert.equal(await second, "222222");
  assert.equal(native.stats.settingsStarts, 2, "Settings attempts must remain globally bounded");
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

  native.setPopup("333333");
  await clock.advance(200);
  assert.equal(await collector.getCode({ generation: 1 }), "333333");
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
  assert.equal(returned, false);

  await clock.advance(49);
  assert.equal(native.stats.settingsForceStops, 0);
  assert.equal(returned, false);
  await clock.advance(1);
  assert.equal(await codePromise, "121212");
  assert.equal(native.stats.settingsForceStops, 1);
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

  await clock.advance(50);
  assert.equal(native.stats.settingsForceStops, 1);
  assert.equal(returned, false);
  await clock.advance(49);
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
  const watcherProbe = deferred();
  let probeCalls = 0;
  let allowAttempts = 0;
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
      async probe2FAState() {
        probeCalls += 1;
        if (probeCalls === 1) return { action: "idle" };
        if (probeCalls === 2) return watcherProbe.promise;
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
  assert.equal(disposeSettled, false, "dispose must wait for the in-flight probe");

  watcherProbe.resolve({ action: "has_allow_dialog" });
  await disposePromise;

  assert.equal(allowAttempts, 0, "a probe that returns after disposal must not click Allow");
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
  "allow-remains": allowAttemptRemainingVisibleIsNotConfirmedTest,
  "allow-transition": allowIsConfirmedOnlyAfterStableStateTransitionTest,
  "preexisting-allow": preexistingAllowIsNeverAutomaticallyClickedTest,
  "preexisting-code": preexistingAllowCodeIsDismissedRejectedAndGateStaysClosedTest,
  "preexisting-clear": newAllowAfterPreexistingGateClearUsesAutomaticBudgetTest,
  "probe-error": probeErrorsResetAllowDisappearanceAndAuditSafelyTest,
  "probe-failure-variants": unknownMalformedAndThrownProbesNeverConfirmAllowTest,
  audit: auditIsThrottledAndSanitizedTest,
  "audit-labels": auditLabelsUseExplicitAllowListsTest,
  "popup-reader-options": popupReaderReceivesCodeOnlyOptionsTest,
  "ocr-permission-status": ocrPermissionStatusIsFixedOnceAndSettingsContinuesTest,
  "ocr-unavailable-status": unavailableOcrDoesNotEmitPermissionStatusTest,
  "timeout-status": sharedDeadlineEmitsTimeoutBeforeRejectingTest,
  "winner-status": winnerUsesStatusWithoutDynamicConsoleTest,
  "late-need": lateNeedStartsSettingsImmediatelyTest,
  "prepare-dispose": disposeWaitsForInProgressPreparationTest,
  "watcher-dispose": disposeDuringInFlightWatcherProbeStopsBeforeAllowActionTest,
  "settings-retry": settingsRetriesOnceAfterFiveSecondsTest,
  "settings-max": settingsNeverStartsThirdAttemptTest,
  "settings-cancel": cancelledSettingsDoesNotRetryTest,
  "settings-accessibility": settingsAccessibilityRecoveryRestartsImmediatelyTest,
  "settings-accessibility-dispose": settingsAccessibilityDisposePreventsRestartTest,
  "settings-accessibility-winner": settingsAccessibilityWinnerPreventsRestartTest,
  "settings-accessibility-deadline": settingsAccessibilityDeadlinePreventsRestartTest,
  "settings-accessibility-failure": settingsAccessibilityFailureIsFixedAndBoundedTest,
  "allow-budget": allowBudgetStopsAtTwoAndReportsManualOnceTest,
  "manual-start": manualFallbackStartsAtNinetySecondsTest,
  "manual-window": manualFallbackReservesNinetySecondInputWindowTest,
  "manual-auto": automaticWinnerAbortsManualFallbackTest,
  "manual-auto-order": automaticWinnerAbortsManualBeforeSlowSettingsCleanupTest,
  "manual-settings": manualWinnerCancelsActiveSettingsTest,
  "settings-manual": settingsWinnerAbortsManualFallbackTest,
  "settings-winner-probe": settingsWinnerStopsInFlightPopupActionsTest,
  "manual-winner-probe": manualWinnerStopsInFlightPopupActionsTest,
  "manual-nontty": nonTtyNeverStartsManualFallbackTest,
  "manual-env": manualFallbackEnvironmentToggleTest,
  "manual-cleanup": timeoutAndDisposeAbortManualFallbackTest,
  "manual-noncooperative": disposeDoesNotWaitForNonCooperativeManualProviderTest,
  "manual-provider-error": manualProviderFailureDoesNotStopPopupWinnerTest,
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
  await collectorCarriesPreparationBoundaryIntoAllowFlowTest();
  await preexistingAllowIsNeverAutomaticallyClickedTest();
  await preexistingAllowCodeIsDismissedRejectedAndGateStaysClosedTest();
  await newAllowAfterPreexistingGateClearUsesAutomaticBudgetTest();
  await allowAttemptRemainingVisibleIsNotConfirmedTest();
  await allowIsConfirmedOnlyAfterStableStateTransitionTest();
  await probeErrorsResetAllowDisappearanceAndAuditSafelyTest();
  await unknownMalformedAndThrownProbesNeverConfirmAllowTest();
  await auditIsThrottledAndSanitizedTest();
  await auditLabelsUseExplicitAllowListsTest();
  await popupReaderReceivesCodeOnlyOptionsTest();
  await ocrPermissionStatusIsFixedOnceAndSettingsContinuesTest();
  await unavailableOcrDoesNotEmitPermissionStatusTest();
  await sharedDeadlineEmitsTimeoutBeforeRejectingTest();
  await winnerUsesStatusWithoutDynamicConsoleTest();
  await lateNeedStartsSettingsImmediatelyTest();
  await popupCodeWaitsForDialogCleanupTest();
  await popupCodeFallsBackToGenericDialogCleanupTest();
  await popupCodeIsNotPublishedUntilCleanupSucceedsTest();
  await settingsGracePeriodTest();
  await settingsRetriesOnceAfterFiveSecondsTest();
  await settingsNeverStartsThirdAttemptTest();
  await cancelledSettingsDoesNotRetryTest();
  await settingsAccessibilityRecoveryRestartsImmediatelyTest();
  await settingsAccessibilityDisposePreventsRestartTest();
  await settingsAccessibilityWinnerPreventsRestartTest();
  await settingsAccessibilityDeadlinePreventsRestartTest();
  await settingsAccessibilityFailureIsFixedAndBoundedTest();
  await allowBudgetStopsAtTwoAndReportsManualOnceTest();
  await manualFallbackStartsAtNinetySecondsTest();
  await manualFallbackReservesNinetySecondInputWindowTest();
  await automaticWinnerAbortsManualFallbackTest();
  await automaticWinnerAbortsManualBeforeSlowSettingsCleanupTest();
  await manualWinnerCancelsActiveSettingsTest();
  await settingsWinnerAbortsManualFallbackTest();
  await settingsWinnerStopsInFlightPopupActionsTest();
  await manualWinnerStopsInFlightPopupActionsTest();
  await nonTtyNeverStartsManualFallbackTest();
  await manualFallbackEnvironmentToggleTest();
  await timeoutAndDisposeAbortManualFallbackTest();
  await disposeDoesNotWaitForNonCooperativeManualProviderTest();
  await manualProviderFailureDoesNotStopPopupWinnerTest();
  await generationTwoRejectsAndCannotReusePreviousCodeTest();
  await generationTwoSettingsWaitsBeforeRequestingFreshCodeTest();
  await generationSequenceIsStrictTest();
  await generationsShareOneDeadlineTest();
  await disposeCancelsSettingsRetryDelayTest();
  sidecarHasNoScreenshotOrAppleScriptAuditContractTest();
  await latePopupBeatsSettingsTest();
  await settingsWinnerEnablesCleanupOnlyTest();
  await staleCodeIsRejectedTest();
  await providerFailureFallsBackTest();
  await popupForcesUnresponsiveSettingsCleanupTest();
  await popupWaitsAfterForceStopForBoundedCloseTest();
  await disposalStopsAllWorkTest();
  await disposeDuringInFlightWatcherProbeStopsBeforeAllowActionTest();
  await disposeWaitsForInProgressPreparationTest();
  await disposalClosesVisiblePopupTest();

  console.log("two-fa collector: ok");
}
