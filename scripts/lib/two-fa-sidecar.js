import path from "node:path";

import { append2FAAudit, screenshotPathFor } from "./2fa-audit.js";
import { waitForAllowClick, readPopupCode, probe2FAState } from "./mac-2fa-allow.js";
import { dismissStale2FAPopups, runPopupPhase } from "./mac-2fa-popup.js";
import { start2FASettingsCodeRequest } from "./mac-settings-2fa.js";

function numberFromEnv(key, fallback) {
  const value = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveConfig(options) {
  return {
    timeoutMs: options.timeoutMs ?? 240_000,
    settingsFallbackAfterMs:
      options.settingsFallbackAfterMs ?? numberFromEnv("BROWSER_2FA_SETTINGS_AFTER_MS", 8_000),
    settingsFallback:
      options.settingsFallback ?? process.env.BROWSER_2FA_SETTINGS_FALLBACK !== "0",
    pollIntervalMs: Math.max(
      1,
      options.pollIntervalMs ?? numberFromEnv("BROWSER_2FA_POLL_MS", 800)
    ),
    cleanupGraceMs: options.cleanupGraceMs ?? 5_000,
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
    waitForAllowClick: overrides.waitForAllowClick ?? waitForAllowClick,
    readPopupCode: overrides.readPopupCode ?? readPopupCode,
    runPopupPhase: overrides.runPopupPhase ?? runPopupPhase,
    start2FASettingsCodeRequest:
      overrides.start2FASettingsCodeRequest ?? start2FASettingsCodeRequest,
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pre-arms native popup monitoring and races it with a cancellable System
 * Settings request after the configured grace period.
 *
 * @param {object} [options]
 * @returns {{ prepare: () => Promise<void>, getCode: () => Promise<string>, dispose: () => Promise<void> }}
 */
export function createMac2FACollector(options = {}) {
  const config = resolveConfig(options);
  const runtime = resolveRuntime(options.runtime);
  const reportDir = options.reportDir;
  const popupDebugDir = reportDir ? path.join(reportDir, "screenshots") : undefined;
  const rejectedCodes = new Set();
  const popupReady = createDeferred();
  const delays = new Set();

  let prepared = false;
  let preparePromise = null;
  let preparedAt = 0;
  let disposed = false;
  let disposePromise = null;
  let popupWatcherPromise = null;
  let popupCandidate = null;
  let cleanupOnly = false;
  let lastStableCode = null;
  let stableHits = 0;
  let allowStrategy = "none";
  let settingsRequest = null;
  let settingsCompletion = null;
  let settingsStartDelay = null;
  let getCodePromise = null;
  let activeAcquisition = null;

  const audit = (entry) => {
    try {
      append2FAAudit(reportDir, entry);
    } catch (error) {
      console.warn(`[2FA] 写入审计记录失败: ${errorMessage(error)}`);
    }
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

  const cancelAllDelays = () => {
    for (const delay of [...delays]) delay.cancel();
  };

  const resetStablePopup = () => {
    lastStableCode = null;
    stableHits = 0;
  };

  const dismissRejectedPopup = async (code) => {
    const result = await runtime.runPopupPhase("dismiss_stale", 2);
    const dismissedCode = normalizeSixDigitCode(result?.code) || code;
    if (dismissedCode) rejectedCodes.add(dismissedCode);
    audit({
      phase: "dismiss_rejected_popup",
      code: dismissedCode,
      action: result?.action ?? "none",
    });
    resetStablePopup();
  };

  const pollPopupOnce = async () => {
    const state = await runtime.probe2FAState(2);

    if (cleanupOnly) {
      if (state?.action === "has_code_dialog") {
        const result = await runtime.runPopupPhase("dismiss_stale", 2);
        audit({
          phase: "popup_cleanup_only",
          action: result?.action ?? "none",
          code: normalizeSixDigitCode(result?.code),
        });
      }
      return;
    }

    if (popupCandidate) return;

    if (state?.action === "has_allow_dialog") {
      const allow = await runtime.waitForAllowClick({
        timeoutMs: Math.max(800, config.pollIntervalMs),
      });
      if (allow?.clicked) {
        allowStrategy = allow.strategy ?? allow.source ?? "auto";
        audit({
          phase: "popup_allow",
          allowClicked: true,
          allowStrategy,
          allowSource: allow.source ?? null,
        });
      }
      resetStablePopup();
      return;
    }

    if (state?.action !== "has_code_dialog") {
      resetStablePopup();
      return;
    }

    const stateCode = normalizeSixDigitCode(state.code);
    if (stateCode && rejectedCodes.has(stateCode)) {
      await dismissRejectedPopup(stateCode);
      return;
    }

    const result = await runtime.readPopupCode(4, {
      preferOcr: true,
      debugDir: popupDebugDir,
      rejectCodes: rejectedCodes,
      requireFormattedRaw: true,
    });
    const code = normalizeSixDigitCode(result?.code);
    if (!code) {
      resetStablePopup();
      return;
    }
    if (rejectedCodes.has(code)) {
      await dismissRejectedPopup(code);
      return;
    }

    if (code === lastStableCode) stableHits += 1;
    else {
      lastStableCode = code;
      stableHits = 1;
    }

    if (stableHits < 2) return;
    popupCandidate = {
      source: "popup",
      code,
      raw: result?.raw ? String(result.raw) : null,
      allowStrategy,
    };
    audit({
      phase: "popup_code_buffered",
      code,
      raw: popupCandidate.raw,
      allowStrategy,
      source: result?.source ?? "popup",
    });
    popupReady.resolve(popupCandidate);
  };

  const watchPopup = async () => {
    while (!disposed) {
      try {
        await pollPopupOnce();
      } catch (error) {
        if (!disposed) {
          audit({ phase: "popup_provider_error", error: errorMessage(error) });
        }
      }
      if (disposed) break;
      const delay = scheduleDelay(config.pollIntervalMs);
      if (!(await delay.promise)) break;
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

      const stale = await runtime.dismissStale2FAPopups(6);
      for (const value of stale?.codes ?? []) {
        const code = normalizeSixDigitCode(value);
        if (code) rejectedCodes.add(code);
      }

      const visible = await runtime.probe2FAState(2);
      if (visible?.action === "has_code_dialog") {
        const visibleCode = normalizeSixDigitCode(visible.code);
        if (visibleCode) rejectedCodes.add(visibleCode);
        const dismissed = await runtime.runPopupPhase("dismiss_stale", 2);
        const dismissedCode = normalizeSixDigitCode(dismissed?.code);
        if (dismissedCode) rejectedCodes.add(dismissedCode);
      }

      preparedAt = runtime.now();
      prepared = true;
      audit({
        phase: "prepare_2fa",
        dismissedCount: stale?.count ?? 0,
        rejectedStaleCodes: [...rejectedCodes],
      });
      popupWatcherPromise = watchPopup();
    })();

    return preparePromise;
  };

  const startSettingsProvider = async (acquisition) => {
    if (!config.settingsFallback) return;
    const waitMs = Math.max(0, preparedAt + config.settingsFallbackAfterMs - runtime.now());
    if (waitMs > 0) {
      settingsStartDelay = scheduleDelay(waitMs);
      const elapsed = await settingsStartDelay.promise;
      settingsStartDelay = null;
      if (!elapsed) return;
    }
    if (disposed || acquisition.winner.settled) return;

    const remainingMs = Math.max(1, acquisition.deadline - runtime.now());
    audit({
      phase: "settings_provider_start",
      elapsedSincePrepareMs: runtime.now() - preparedAt,
    });
    try {
      settingsRequest = runtime.start2FASettingsCodeRequest({
        timeoutMs: remainingMs,
        reportDir,
        screenshotPath: screenshotPathFor(reportDir, "2fa-settings-code.png"),
      });
    } catch (error) {
      audit({ phase: "settings_provider_failed", error: errorMessage(error) });
      return;
    }

    settingsCompletion = settingsRequest.promise
      .then((result) => {
        const code = normalizeSixDigitCode(result?.code);
        if (!code) throw new Error(`验证码格式异常: ${result?.code ?? "empty"}`);
        acquisition.offer({
          source: "settings",
          code,
          raw: result?.raw ? String(result.raw) : null,
          screenshot: result?.screenshot ?? null,
        });
      })
      .catch((error) => {
        const cancelled = error?.code === "2FA_SETTINGS_CANCELLED";
        audit({
          phase: cancelled ? "settings_provider_cancelled" : "settings_provider_failed",
          error: errorMessage(error),
        });
      });
  };

  const cancelSettingsProvider = async (reason) => {
    if (!settingsRequest) return;
    const cancelSignalled = settingsRequest.cancel();
    audit({ phase: "settings_provider_cancel", reason, cancelSignalled });

    if (!settingsCompletion) return;
    const cleanupTimeout = scheduleDelay(config.cleanupGraceMs);
    const cleaned = await Promise.race([
      settingsCompletion.then(() => true),
      cleanupTimeout.promise.then(() => false),
    ]);
    cleanupTimeout.cancel();
    if (!cleaned) {
      const forceStopped = settingsRequest.forceStop();
      audit({ phase: "settings_provider_force_stop", reason, forceStopped });
    }
  };

  const acquireCode = async () => {
    if (!prepared) throw new Error("2FA collector must be prepared before requesting a code");
    if (disposed) throw new Error("2FA collector is disposed");

    if (popupCandidate) {
      audit({ phase: "2fa_winner", source: "popup", buffered: true, code: popupCandidate.code });
      console.log(`[2FA] 已使用提前到达的弹窗验证码 ${popupCandidate.code}`);
      return popupCandidate.code;
    }

    const winner = createDeferred();
    const acquisition = {
      winner,
      deadline: runtime.now() + config.timeoutMs,
      offer(candidate) {
        if (disposed) return false;
        return winner.resolve(candidate);
      },
    };
    activeAcquisition = acquisition;
    popupReady.promise.then((candidate) => acquisition.offer(candidate));
    if (popupCandidate) acquisition.offer(popupCandidate);

    const deadlineDelay = scheduleDelay(config.timeoutMs);
    deadlineDelay.promise.then((elapsed) => {
      if (elapsed) winner.reject(new Error("macOS 2FA 验证码获取超时"));
    });
    void startSettingsProvider(acquisition).catch((error) => {
      audit({ phase: "settings_provider_failed", error: errorMessage(error) });
    });

    try {
      const candidate = await winner.promise;
      settingsStartDelay?.cancel();
      if (candidate.source === "popup") {
        await cancelSettingsProvider("popup_won");
      } else {
        cleanupOnly = true;
      }

      audit({
        phase: "2fa_winner",
        source: candidate.source,
        code: candidate.code,
        raw: candidate.raw ?? null,
        screenshot: candidate.screenshot ?? null,
      });
      console.log(`[2FA] ★ 验证码: ${candidate.code} 来源=${candidate.source}`);
      return candidate.code;
    } finally {
      deadlineDelay.cancel();
      settingsStartDelay?.cancel();
      if (activeAcquisition === acquisition) activeAcquisition = null;
    }
  };

  const getCode = () => {
    if (getCodePromise) return getCodePromise;
    getCodePromise = acquireCode();
    return getCodePromise;
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    activeAcquisition?.winner.reject(new Error("2FA collector was disposed"));
    cancelAllDelays();

    disposePromise = (async () => {
      await cancelSettingsProvider("collector_disposed");
      if (popupWatcherPromise) await popupWatcherPromise;
      cancelAllDelays();
    })();
    return disposePromise;
  };

  return { prepare, getCode, dispose };
}
