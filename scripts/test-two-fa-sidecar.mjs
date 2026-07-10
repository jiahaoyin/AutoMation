import { strict as assert } from "node:assert";

import { shouldDismissCodeBeforeAllow } from "./lib/mac-2fa-allow.js";
import { createMac2FACollector } from "./lib/two-fa-sidecar.js";

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

function createNativeHarness(
  clock,
  {
    staleCodes = [],
    settingsCancelSettles = true,
    settingsForceStopSettles = true,
    popupCloseWait = null,
    popupPrimaryCloseSucceeds = true,
    popupFallbackCloseFailures = 0,
  } = {}
) {
  let popup = null;
  let allowVisible = false;
  let fallbackCloseFailuresRemaining = popupFallbackCloseFailures;
  const settingsRequests = [];
  const stats = {
    allowClicks: 0,
    cleanupDismissals: 0,
    popupWinnerClosures: 0,
    settingsStarts: 0,
    settingsCancels: 0,
    settingsForceStops: 0,
    allowAttempts: [],
    fullAllowWaits: 0,
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
      if (allowVisible) {
        return { action: "has_allow_dialog", code: null };
      }
      if (popup) {
        return { action: "has_code_dialog", code: popup.code };
      }
      return { action: "none", code: null };
    },
    async tryAllowOnce(timeoutSec, options) {
      stats.allowAttempts.push({ timeoutSec, options });
      if (!allowVisible) return { clicked: false, strategy: "none" };
      allowVisible = false;
      stats.allowClicks += 1;
      return { clicked: true, strategy: "test-allow", source: "test" };
    },
    async waitForAllowClick() {
      stats.fullAllowWaits += 1;
      throw new Error("collector must not enter the full Allow wait loop");
    },
    async readPopupCode() {
      if (!popup) return null;
      return { code: popup.code, raw: popup.raw, source: "test-popup" };
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
        return { action: "dismissed_stale", code };
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
      const request = {
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
  };
}

function createHarness(options = {}) {
  const clock = new ManualClock();
  const native = createNativeHarness(clock, options);
  const collector = createMac2FACollector({
    timeoutMs: 30_000,
    settingsFallbackAfterMs: options.settingsFallbackAfterMs ?? 8_000,
    pollIntervalMs: options.pollIntervalMs ?? 10,
    cleanupGraceMs: 50,
    runtime: native.runtime,
  });
  return { clock, native, collector };
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

function preparedBoundaryNeverDismissesCurrentCodeTest() {
  assert.equal(
    shouldDismissCodeBeforeAllow({
      staleBoundaryEstablished: true,
      sawAllowDialog: false,
      allowExplicitlyClicked: false,
    }),
    false
  );
  assert.equal(
    shouldDismissCodeBeforeAllow({
      staleBoundaryEstablished: false,
      sawAllowDialog: false,
      allowExplicitlyClicked: false,
    }),
    true
  );
}

async function collectorCarriesPreparationBoundaryIntoAllowFlowTest() {
  const { clock, native, collector } = createHarness();
  await collector.prepare();
  native.setAllowVisible(true);
  await clock.advance(10);

  assert.equal(native.stats.allowAttempts.length, 1);
  assert.equal(native.stats.allowAttempts[0].options.confirmClick, false);
  assert.equal(native.stats.allowAttempts[0].options.maxStrategies, 1);
  assert.equal(native.stats.allowAttempts[0].options.strategyOffset, 0);
  assert.equal(native.stats.fullAllowWaits, 0);
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

  native.settingsRequests[0].resolve({ code: "654321", raw: "654 321", screenshot: null });
  await clock.flush();
  assert.equal(await codePromise, "654321");
  await collector.dispose();
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

async function disposalClosesVisiblePopupTest() {
  const { native, collector } = createHarness();
  await collector.prepare();
  native.setPopup("998877");

  await collector.dispose();
  assert.equal(native.stats.cleanupDismissals, 1);
}

preparedBoundaryNeverDismissesCurrentCodeTest();
await bufferEarlyPopupTest();
await collectorCarriesPreparationBoundaryIntoAllowFlowTest();
await popupCodeWaitsForDialogCleanupTest();
await popupCodeFallsBackToGenericDialogCleanupTest();
await popupCodeIsNotPublishedUntilCleanupSucceedsTest();
await settingsGracePeriodTest();
await latePopupBeatsSettingsTest();
await settingsWinnerEnablesCleanupOnlyTest();
await staleCodeIsRejectedTest();
await providerFailureFallsBackTest();
await popupForcesUnresponsiveSettingsCleanupTest();
await popupWaitsAfterForceStopForBoundedCloseTest();
await disposalStopsAllWorkTest();
await disposalClosesVisiblePopupTest();

console.log("two-fa collector: ok");
