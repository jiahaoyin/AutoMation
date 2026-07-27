import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyBrowserRunFailure,
  readBrowserAccountHomeConfirmed,
  readBrowserFailureCode,
  readBrowserFailureStage,
  runAccountBrowserPhase,
} from "./lib/account-browser-flow.js";
import {
  createFlowFailureEnvelope,
  createFlowReport,
  mergeMacSettingsSmsRuntimeEnv,
  recordAccountHomeAcceptanceMarker,
  summarizeAccountBrowserCompletion,
} from "./apple-id-full-flow.mjs";
import {
  loadEnvFile,
  maskAppleId,
  parseEnvValue,
  saveMacSettingsSmsProviderConfig,
  saveCredentialsToEnv,
  saveAppleProfileToEnv,
  shouldAutoConfirmAppleCredentials,
} from "./lib/credentials.js";
import {
  resolveReportRoot,
  writeReport,
  writeAccountHomeAcceptanceMarker,
} from "./lib/report.js";

const SECRET_FIXTURE =
  "person@example.com 123456 https://example.test/path?token=SECRET TOP-SECRET";
const READY_MODE_SECRET = "ruyipage-only?token=SECRET";

function createRuntime(runBackend, options = {}) {
  const calls = [];
  const codeRequests = [];
  let collectorOptions = null;
  let collectorCount = 0;
  const runtime = {
    getBrowserEnvironmentSummary() {
      return {
        backend: "ruyipage",
        backendReason: "test",
        warnings: options.environmentWarnings ?? [],
      };
    },
    async isAccessibilityGranted(checkOptions) {
      if (typeof options.isAccessibilityGranted === "function") {
        return options.isAccessibilityGranted(checkOptions);
      }
      return true;
    },
    createRuyiPageBackendRunner() {
      return { run: runBackend };
    },
    createMac2FACollector(collectorConfig) {
      collectorCount += 1;
      collectorOptions = collectorConfig;
      return {
        async prepare() {
          calls.push("prepare");
        },
        async getCode(request) {
          calls.push("getCode");
          codeRequests.push(request);
          return request?.generation === 2 ? "654321" : "123456";
        },
        async dispose() {
          calls.push("dispose");
          if (options.disposeError) throw options.disposeError;
        },
      };
    },
    saveAppleProfileToEnv(profile) {
      return options.saveAppleProfileToEnv?.(profile) ?? "/tmp/test-profile.env";
    },
    shouldPrintCapturedProfile() {
      return options.shouldPrintCapturedProfile === true;
    },
  };
  return {
    runtime,
    calls,
    codeRequests,
    emitStatus(payload) {
      collectorOptions?.onStatus?.(payload);
    },
    emitDiagnostic(payload) {
      collectorOptions?.onDiagnostic?.(payload);
    },
    get collectorCount() {
      return collectorCount;
    },
    get collectorTimeoutMs() {
      return collectorOptions?.timeoutMs ?? null;
    },
    get collectorOptions() {
      return collectorOptions;
    },
  };
}

const params = {
  creds: { appleId: "person@example.com", password: "secret" },
  reportDir: "data/reports/account-browser-flow-test",
};

function successfulResult() {
  return {
    success: true,
    browserLogin: {
      success: true,
      backend: "ruyipage",
      accountHomeConfirmed: true,
    },
    postLoginProfileCapture: {
      success: true,
      failureStage: "unknown",
      failureClass: "unknown",
      browserAlive: true,
      browserPreserved: true,
      browserPreservationRequested: false,
    },
    postLoginFinalization: {
      browserFinalizationCompleted: true,
      browserPreservationRequested: false,
      browserSessionPreserved: false,
      finalizationClass: "completed",
    },
    personalInfo: { name: "Test Given Test Family", birthday: "2000-01-02" },
    screenshots: {},
  };
}

async function captureConsole(method, operation) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.map(String).join(" "));
  try {
    await operation();
  } finally {
    console[method] = original;
  }
  return lines;
}

async function runTwoFactorLifecycleTest() {
  const harness = createRuntime(async (options) => {
    await options.prepare2FA();
    assert.equal(await options.get2FACode(), "123456");
    return successfulResult();
  });

  const result = await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(harness.calls, ["prepare", "getCode", "dispose"]);
  assert.equal(harness.collectorCount, 1);
  assert.equal(result.browserLogin.backend, "ruyipage");
}

async function runProductionPopupPrimaryConfigurationTest() {
  const harness = createRuntime(async (options) => {
    await options.prepare2FA();
    assert.equal(
      await options.get2FACode({ generation: 1, rejectPrevious: false }),
      "123456",
      "the popup-primary collector code must be forwarded to ruyiPage"
    );
    return successfulResult();
  });

  await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(
    {
      settingsOnly: harness.collectorOptions?.settingsOnly,
      settingsFallback: harness.collectorOptions?.settingsFallback,
      manualFallback: harness.collectorOptions?.manualFallback,
    },
    {
      settingsOnly: false,
      settingsFallback: undefined,
      manualFallback: undefined,
    }
  );
}

async function runTwoGenerationForwardingTest() {
  const requests = [
    { generation: 1, rejectPrevious: false },
    { generation: 2, rejectPrevious: true },
  ];
  const harness = createRuntime(async (options) => {
    assert.equal(await options.get2FACode(requests[0]), "123456");
    assert.equal(await options.get2FACode(requests[1]), "654321");
    return successfulResult();
  });

  await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(harness.codeRequests, requests);
}

async function runBrowserFallbackEnvironmentSwitchesTest() {
  const previousSettings = process.env.BROWSER_2FA_SETTINGS_FALLBACK;
  const previousManual = process.env.BROWSER_2FA_MANUAL_FALLBACK;
  try {
    process.env.BROWSER_2FA_SETTINGS_FALLBACK = "0";
    process.env.BROWSER_2FA_MANUAL_FALLBACK = "0";
    const harness = createRuntime(async () => successfulResult());
    await runAccountBrowserPhase(params, harness.runtime);
    assert.equal(harness.collectorOptions?.settingsFallback, undefined);
    assert.equal(harness.collectorOptions?.manualFallback, undefined);
  } finally {
    if (previousSettings === undefined) delete process.env.BROWSER_2FA_SETTINGS_FALLBACK;
    else process.env.BROWSER_2FA_SETTINGS_FALLBACK = previousSettings;
    if (previousManual === undefined) delete process.env.BROWSER_2FA_MANUAL_FALLBACK;
    else process.env.BROWSER_2FA_MANUAL_FALLBACK = previousManual;
  }
}

async function runFlowAuditForwardingTest() {
  const entries = [];
  const secrets = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, error, details = {}) {
      entries.push({ source, event, details, hasError: Boolean(error) });
    },
    addSecrets(values) {
      secrets.push(...values);
    },
  };
  const harness = createRuntime(async (options) => {
    harness.emitDiagnostic({
      source: "settings",
      phase: "settings_provider_failed",
      error: new Error("synthetic native settings failure"),
    });
    await options.onEvent?.({
      event: "status",
      status: "input_progress",
      field: "password",
      step: "owner_fallback_started",
      route: "owner",
    });
    await options.onEvent?.({
      event: "status",
      status: "browser_stage",
      stage: "twofa_input",
      previousStage: "twofa_code_wait",
      transition: "entered",
      secret: SECRET_FIXTURE,
    });
    await options.onEvent?.({
      event: "status",
      status: "browser_observation",
      checkpoint: "twofa_transition",
      generation: 1,
      pageKind: "account_manage",
      connectionAlive: true,
      inspectionAvailable: false,
      sessionConfirmed: true,
      accountHomeConfirmed: false,
      twofaVisible: true,
      inputReady: true,
      codeInputCount: 6,
      authenticationError: false,
      rootManageUrl: true,
      rootAccountMarker: false,
      rootAuthenticationError: false,
      rootSecurityCopyOnly: true,
      retiringChildError: true,
      childAuthUiPresent: false,
      secret: SECRET_FIXTURE,
    });
    await options.onEvent?.({
      event: "need_2fa",
      generation: 1,
      state: {
        twofaVisible: true,
        inputReady: false,
        codeInputCount: 0,
        elapsedMs: 1234,
        href: SECRET_FIXTURE,
        otp: SECRET_FIXTURE,
      },
    });
    await options.onEvent?.({
      event: "runner_status",
      status: "twofa_code_delivery_sent",
      generation: 1,
    });
    await options.onEvent?.({
      event: "status",
      status: "twofa_progress",
      phase: "target_resolved",
      generation: 1,
      targetCount: 6,
    });
    await options.onEvent?.({
      event: "diagnostic",
      kind: "python_exception",
      failureStage: "password_input",
      errorType: "RuntimeError",
      errorClass: "twofa_target_missing",
      hasTraceback: true,
    });
    await options.prepare2FA();
    await options.get2FACode({ generation: 1, rejectPrevious: false });
    return successfulResult();
  });

  await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);

  assert.deepEqual(secrets, ["123456", "Test Given Test Family", "2000-01-02"]);
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "status" &&
        entry.details.status === "input_progress" &&
        entry.details.field === "password" &&
        entry.details.step === "owner_fallback_started" &&
        entry.details.route === "owner"
    )
  );
  assert.deepEqual(
    entries.find(
      (entry) => entry.source === "ruyipage" && entry.event === "need_2fa"
    )?.details,
    {
      generation: 1,
      state: {
        twofaVisible: true,
        inputReady: false,
        codeInputCount: 0,
        elapsedMs: 1234,
      },
    }
  );
  assert.equal(JSON.stringify(entries).includes(SECRET_FIXTURE), false);
  assert.equal(JSON.stringify(entries).includes("Test Given Test Family"), false);
  assert.equal(JSON.stringify(entries).includes("2000-01-02"), false);
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "diagnostic" &&
        entry.details.failureStage === "password_input" &&
        entry.details.errorType === "backend_diagnostic" &&
        entry.details.diagnosticErrorType === "runtimeerror" &&
        entry.details.diagnosticErrorClass === "twofa_target_missing" &&
        entry.details.diagnosticMessageClass === "unknown" &&
        entry.details.hasDiagnosticMessage === false &&
        entry.details.hasTraceback === true &&
        !("message" in entry.details) &&
        !("traceback" in entry.details) &&
        !("diagnosticMessage" in entry.details) &&
        !("diagnosticTraceback" in entry.details)
    )
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "status" &&
        entry.details.status === "browser_stage" &&
        entry.details.stage === "twofa_input" &&
        entry.details.previousStage === "twofa_code_wait" &&
        entry.details.transition === "entered"
    )
  );
  assert.deepEqual(
    entries.find(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "status" &&
        entry.details.status === "browser_observation"
    )?.details,
    {
      status: "browser_observation",
      checkpoint: "twofa_transition",
      generation: 1,
      pageKind: "account_manage",
      connectionAlive: true,
      inspectionAvailable: false,
      sessionConfirmed: true,
      accountHomeConfirmed: false,
      twofaVisible: true,
      inputReady: true,
      codeInputCount: 6,
      authenticationError: false,
      rootManageUrl: true,
      rootAccountMarker: false,
      rootAuthenticationError: false,
      rootSecurityCopyOnly: true,
      retiringChildError: true,
      childAuthUiPresent: false,
    }
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "runner_status" &&
        entry.details.status === "twofa_code_delivery_sent" &&
        entry.details.generation === 1
    )
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "status" &&
        entry.details.status === "twofa_progress" &&
        entry.details.phase === "target_resolved" &&
        entry.details.generation === 1 &&
        entry.details.targetCount === 6
    )
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "two_factor" &&
        entry.event === "native_provider_diagnostic" &&
        entry.details.source === "settings" &&
        entry.details.phase === "settings_provider_failed" &&
        entry.details.helperFailureCode === "unknown" &&
        entry.details.hasHelperStderr === false &&
        entry.hasError === true
    )
  );
}

async function runTwoFactorInputUnconfirmedDiagnosticTest() {
  const entries = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, error, details = {}) {
      entries.push({ source, event, details, hasError: Boolean(error) });
    },
    addSecrets() {},
  };
  const harness = createRuntime(async (options) => {
    await options.onEvent?.({
      event: "status",
      status: "browser_stage",
      stage: "twofa_input",
    });
    await options.onEvent?.({
      event: "diagnostic",
      kind: "python_exception",
      failureStage: "twofa_input",
      errorType: "RuntimeError",
      errorClass: "twofa_input_unconfirmed",
      hasTraceback: true,
    });
    return successfulResult();
  });

  await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);

  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "ruyipage" &&
        entry.event === "diagnostic" &&
        entry.details.failureStage === "twofa_input" &&
        entry.details.diagnosticErrorClass === "twofa_input_unconfirmed" &&
        entry.details.diagnosticMessageClass === "unknown" &&
        entry.details.hasTraceback === true
    )
  );
}

async function runTwoFactorHandoffFailureContextTest() {
  const entries = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, error, details = {}) {
      entries.push({ source, event, details, hasError: Boolean(error) });
    },
    addSecrets() {},
  };
  const backendError = new Error("synthetic runner failure");
  Object.defineProperties(backendError, {
    ruyiPageFailureCode: { value: "twofa_handoff" },
    ruyiPageFailureStage: { value: "twofa_input" },
    ruyiPageFailureContext: {
      value: {
        stage: "twofa_input",
        twoFaPhase: "target_waiting",
        generation: 1,
        codeDeliveryAttempted: true,
        codeDeliverySent: true,
        codeDeliveryAcknowledged: true,
        codeDeliveryWriteStarted: true,
        codeDeliveryWriteCompleted: true,
        browserLaunchObserved: true,
        browserPreserved: true,
        directBrowserPreservationRequested: false,
        browserErrorClass: "twofa_target_missing",
        backendExitCode: 1,
        cleanupFailed: false,
      },
    },
  });
  const harness = createRuntime(async (options) => {
    await options.onEvent?.({
      event: "status",
      status: "browser_stage",
      stage: "twofa_input",
    });
    await options.onEvent?.({
      event: "runner_status",
      status: "twofa_code_delivery_sent",
      generation: 1,
    });
    await options.onEvent?.({
      event: "status",
      status: "twofa_progress",
      phase: "handoff_failed",
      generation: 1,
    });
    await options.onEvent?.({
      event: "status",
      status: "browser_preserved",
      failureStage: "twofa_input",
      preserved: true,
    });
    throw backendError;
  });

  await assert.rejects(
    runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime),
    (error) =>
      readBrowserFailureCode(error) === "twofa_handoff" &&
      readBrowserFailureStage(error) === "twofa_input"
  );
  const failure = entries.find(
    (entry) => entry.source === "account_browser" && entry.event === "runner_failed"
  );
  assert.deepEqual(failure?.details, {
    failureCode: "twofa_handoff",
    failureStage: "twofa_input",
    runnerStage: "twofa_input",
    twoFaPhase: "target_waiting",
    twoFaGeneration: 1,
    codeDeliveryAttempted: true,
    codeDeliverySent: true,
    codeDeliveryAcknowledged: true,
    codeDeliveryWriteStarted: true,
    codeDeliveryWriteCompleted: true,
    browserLaunchObserved: true,
    accountHomeConfirmed: false,
    browserPreserved: true,
    browserSessionPreserved: false,
    browserFinalizationCompleted: false,
    browserPreservationRequested: false,
    directBrowserPreservationRequested: false,
    directPostLoginRecoveryEligible: false,
    browserErrorClass: "twofa_target_missing",
    backendExitCode: 1,
    cleanupFailed: false,
  });
}

async function runPasswordBidiInputProgressTest() {
  const entries = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
    addSecrets() {},
  };
  const tokens = [
    "password_bidi_input_started",
    "password_bidi_input_sent",
    "password_input_verified",
    "password_input_failed",
  ];
  const unsafeDetails = {
    message: SECRET_FIXTURE,
    password: SECRET_FIXTURE,
    otp: "123456",
    traceback: SECRET_FIXTURE,
  };
  const harness = createRuntime(async (options) => {
    for (const event of [
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "owner_bidi_fallback_started",
        route: "owner",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "owner_bidi_typed",
        route: "owner",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "verified",
        route: "owner",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "failed",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "email",
        step: "owner_bidi_fallback_started",
        route: "owner",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "owner_bidi_unknown",
        route: "owner",
        ...unsafeDetails,
      },
      {
        event: "status",
        status: "input_progress",
        field: "password",
        step: "owner_bidi_typed",
        route: "owner?token=secret",
        ...unsafeDetails,
      },
    ]) {
      await options.onEvent(event);
    }
    return successfulResult();
  });

  const logs = await captureConsole("log", () =>
    runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime)
  );
  const statusEntries = entries.filter(
    (entry) => entry.source === "ruyipage" && entry.event === "status"
  );
  assert.deepEqual(
    statusEntries
      .filter((entry) => entry.details.status === "input_progress")
      .map((entry) => entry.details),
    [
      {
        status: "input_progress",
        field: "password",
        step: "owner_bidi_fallback_started",
        route: "owner",
        inputProgress: "password_bidi_input_started",
      },
      {
        status: "input_progress",
        field: "password",
        step: "owner_bidi_typed",
        route: "owner",
        inputProgress: "password_bidi_input_sent",
      },
      {
        status: "input_progress",
        field: "password",
        step: "verified",
        route: "owner",
        inputProgress: "password_input_verified",
      },
      {
        status: "input_progress",
        field: "password",
        step: "failed",
        route: "none",
        inputProgress: "password_input_failed",
      },
      {
        status: "input_progress",
        field: "email",
        step: "owner_bidi_fallback_started",
        route: "owner",
      },
      {
        status: "input_progress",
        field: "password",
        step: "owner_bidi_unknown",
        route: "owner",
      },
      {
        status: "input_progress",
        field: "password",
        step: "owner_bidi_typed",
        route: "none",
      },
    ]
  );
  assert.deepEqual(
    statusEntries
      .filter((entry) => entry.details.status === "unknown")
      .map((entry) => entry.details),
    []
  );
  for (const token of tokens) {
    assert.equal(logs.filter((line) => line === `[ruyipage] status:${token}`).length, 1);
  }
  assert.ok(logs.includes("[ruyipage] status:input:email:owner_bidi_fallback_started:owner"));
  assert.ok(logs.includes("[ruyipage] status:input:password:owner_bidi_unknown:owner"));
  assert.ok(logs.includes("[ruyipage] status:input:password:owner_bidi_typed:none"));
  assert.equal(logs.join(" ").includes(SECRET_FIXTURE), false);
  assert.equal(JSON.stringify(entries).includes(SECRET_FIXTURE), false);
  assert.equal(JSON.stringify(entries).includes("123456"), false);
  assert.equal(JSON.stringify(entries).includes("owner?token=secret"), false);
}

async function runCollectorTimeoutIsAlways240SecondsTest() {
  const previous = process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
  const supervised = createRuntime(async () => successfulResult());
  try {
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI = "1";
    await runAccountBrowserPhase(params, supervised.runtime);
    assert.equal(supervised.collectorTimeoutMs, 240_000);

    process.env.APPLE_AUTOMATION_SUPERVISED_GUI = "0";
    const regular = createRuntime(async () => successfulResult());
    await runAccountBrowserPhase(params, regular.runtime);
    assert.equal(regular.collectorTimeoutMs, 240_000);
  } finally {
    if (previous === undefined) delete process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
    else process.env.APPLE_AUTOMATION_SUPERVISED_GUI = previous;
  }
}

async function runPreparedAccessibilityCheckDoesNotBlockBrowserTest() {
  let checkOptions = null;
  const unavailable = new Error("prepared helper unavailable");
  unavailable.code = "2FA_ACCESSIBILITY_UNAVAILABLE";
  const harness = createRuntime(async () => successfulResult(), {
    async isAccessibilityGranted(options) {
      checkOptions = options;
      throw unavailable;
    },
  });

  const warnings = await captureConsole("warn", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );

  assert.deepEqual(checkOptions, { compileIfNeeded: false });
  assert.equal(harness.collectorCount, 1);
  assert.equal(
    warnings.some((line) => line.includes("辅助功能未授权")),
    true,
    "an unavailable prepared helper must leave the 2FA collector available"
  );
}

async function runFixedTwoFactorStatusPromptsTest() {
  const harness = createRuntime(async () => {
    harness.emitStatus({ status: "popup_primary", source: "popup", remainingSec: 240 });
    harness.emitStatus({ status: "settings_fallback", source: "settings", remainingSec: 210 });
    harness.emitStatus({
      status: "settings_start",
      attempt: 1,
      source: "settings",
      remainingSec: 200,
    });
    harness.emitStatus({
      status: "settings_start",
      attempt: 2,
      source: "settings",
      remainingSec: 197,
      secret: SECRET_FIXTURE,
    });
    harness.emitStatus({
      status: "settings_retry",
      attempt: 2,
      source: "settings",
      remainingSec: 192,
    });
    harness.emitStatus({
      status: "settings_accessibility",
      attempt: 1,
      source: "settings",
      remainingSec: 190,
      secret: SECRET_FIXTURE,
    });
    harness.emitStatus({
      status: "settings_failed",
      attempt: 1,
      source: "settings",
      remainingSec: 189,
      reason: SECRET_FIXTURE,
    });
    harness.emitStatus({ status: "manual_allow", remainingSec: 185 });
    harness.emitStatus({ status: "manual_code", source: "manual", remainingSec: 150 });
    harness.emitStatus({
      status: "manual_unavailable",
      source: "manual",
      remainingSec: 150,
      secret: SECRET_FIXTURE,
    });
    harness.emitStatus({ status: "winner", source: "popup", remainingSec: 140 });
    harness.emitStatus({ status: "winner", source: "settings", remainingSec: 130 });
    harness.emitStatus({ status: "winner", source: "manual", remainingSec: 120 });
    harness.emitStatus({ status: "ocr_permission_missing", secret: SECRET_FIXTURE });
    harness.emitStatus({ status: "popup_accessibility", secret: SECRET_FIXTURE });
    harness.emitStatus({ status: "popup_scanning", secret: SECRET_FIXTURE });
    harness.emitStatus({ status: "popup_close_pending", secret: SECRET_FIXTURE });
    harness.emitStatus({ status: "timeout", secret: SECRET_FIXTURE });
    harness.emitStatus({ status: "winner", source: SECRET_FIXTURE, remainingSec: 1 });
    harness.emitStatus({ status: SECRET_FIXTURE, source: "popup", remainingSec: 1 });
    harness.emitStatus({ status: "winner", source: "constructor", remainingSec: 1 });
    harness.emitStatus({ status: "toString", source: "popup", remainingSec: 1 });
    return successfulResult();
  });

  const logs = await captureConsole("log", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );
  const statusLogs = logs.filter((line) => line.startsWith("[2FA]"));
  assert.deepEqual(statusLogs, [
    "[2FA] 优先等待 Apple 验证弹窗，暂不启动系统设置取码。",
    "[2FA] 弹窗未取得有效验证码，正在回退系统设置取码。",
    "[2FA] 正在尝试通过系统设置获取验证码（第 1/2 次）；如出现 macOS 辅助功能提示，请允许系统设置取码 helper。",
    "[2FA] 正在尝试通过系统设置获取验证码（第 2/2 次）...",
    "[2FA] 系统设置取码失败，5 秒后进行第 2/2 次尝试...",
    "[2FA] 系统设置取码需要辅助功能权限，正在等待授权；请按 macOS 提示完成勾选。",
    "[2FA] 系统设置取码未成功；将按串行顺序评估最终兜底。",
    "[2FA] 自动点击「允许」未成功，请在 Mac 上手动点击「允许」；取码仍在继续。",
    "[2FA] 自动取码仍未完成，请在终端隐藏输入 Mac 上显示的 6 位验证码。",
    "[2FA] 当前会话没有可用交互终端，无法安全地隐藏输入验证码；当前串行自动取码阶段将继续完成。",
    "[2FA] 已从 Apple 验证码弹窗取得验证码。",
    "[2FA] 已从系统设置取得验证码。",
    "[2FA] 已使用终端手动输入的验证码。",
    "[2FA] OCR 需要权限：系统设置 → 隐私与安全性 → 屏幕与系统音频录制；系统设置取码仍在工作。",
    "[2FA] 原生验证码弹窗未获辅助功能授权；将先尝试已授权的屏幕录制 OCR，无有效码才按顺序回退。",
    "[2FA] 网页已确认需要验证码，正在持续扫描受限 Apple 原生窗口。",
    "[2FA] 已读取验证码；系统弹窗尚未自动关闭，正在继续提交到网页。",
    "[2FA] 240 秒内未取得可用验证码。请确认 Mac 已登录同一 Apple ID、允许弹窗已处理，并检查系统设置取码与相关权限。",
  ]);
  assert.deepEqual(
    logs.filter((line) => !line.startsWith("[Firefox]") && !line.startsWith("[2FA]")),
    [
      "[ruyipage] status:runtime_resolving",
      "[ruyipage] status:backend_starting",
    ]
  );
  assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
}

async function runSupervisedManualUnavailableStatusTest() {
  const previous = process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
  try {
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI = "1";
    const harness = createRuntime(async () => {
      harness.emitStatus({
        status: "manual_unavailable",
        source: "manual",
        remainingSec: 240,
        secret: SECRET_FIXTURE,
      });
      return successfulResult();
    });
    const logs = await captureConsole("log", () =>
      runAccountBrowserPhase(params, harness.runtime)
    );
    assert.deepEqual(logs.filter((line) => line.startsWith("[2FA]")), [
      "[2FA] status:manual_unavailable",
        "[2FA] 当前会话没有可用交互终端，无法安全地隐藏输入验证码；当前串行自动取码阶段将继续完成。",
    ]);
    assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
  } finally {
    if (previous === undefined) delete process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
    else process.env.APPLE_AUTOMATION_SUPERVISED_GUI = previous;
  }
}

async function runSupervisedSettingsStatusWhitelistTest() {
  const previous = process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
  try {
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI = "1";
    const harness = createRuntime(async () => {
      harness.emitStatus({
        status: "settings_accessibility",
        source: "settings",
        reason: SECRET_FIXTURE,
      });
      harness.emitStatus({
        status: "settings_retry",
        source: "settings",
        secret: SECRET_FIXTURE,
      });
      harness.emitStatus({
        status: "settings_failed",
        source: "settings",
        reason: SECRET_FIXTURE,
      });
      harness.emitStatus({ status: "popup_primary", source: "popup", secret: SECRET_FIXTURE });
      harness.emitStatus({ status: "settings_fallback", source: "settings", secret: SECRET_FIXTURE });
      harness.emitStatus({ status: "popup_scanning", source: "popup", secret: SECRET_FIXTURE });
      harness.emitStatus({ status: "winner", source: "popup", otp: SECRET_FIXTURE });
      harness.emitStatus({ status: "winner", source: "settings", otp: SECRET_FIXTURE });
      harness.emitStatus({ status: "winner", source: "manual", otp: SECRET_FIXTURE });
      return successfulResult();
    });
    const logs = await captureConsole("log", () =>
      runAccountBrowserPhase(params, harness.runtime)
    );
    assert.deepEqual(logs.filter((line) => line.startsWith("[2FA] status:")), [
      "[2FA] status:settings_accessibility",
      "[2FA] status:settings_retry",
      "[2FA] status:settings_failed",
      "[2FA] status:popup_primary",
      "[2FA] status:settings_fallback",
      "[2FA] status:popup_scanning",
      "[2FA] status:winner:popup",
      "[2FA] status:winner:settings",
      "[2FA] status:winner:manual",
    ]);
    assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
  } finally {
    if (previous === undefined) delete process.env.APPLE_AUTOMATION_SUPERVISED_GUI;
    else process.env.APPLE_AUTOMATION_SUPERVISED_GUI = previous;
  }
}

async function runFailureDisposalTest() {
  const harness = createRuntime(async (options) => {
    await options.prepare2FA();
    throw new Error("backend failed");
  });

  const logs = await captureConsole("log", async () => {
    await assert.rejects(
      runAccountBrowserPhase(params, harness.runtime),
      (error) => {
        assert.match(error.message, /backend failed/);
        assert.equal(readBrowserFailureCode(error), "unknown");
        return true;
      }
    );
  });
  assert.ok(logs.includes("[ruyipage] status:node-failure:unknown"));
  assert.deepEqual(harness.calls, ["prepare", "dispose"]);
  assert.equal(harness.collectorCount, 1);
}

function runBrowserFailureClassificationTest() {
  const cases = [
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
    ["ruyipage backend exited 1", "backend_exit"],
    ["ruyipage backend timed out after 720000ms", "backend_timeout"],
    ["ruyipage 2FA preparation failed", "two_fa_preparation"],
    ["ruyipage 2FA code provider failed", "two_fa_provider"],
    [SECRET_FIXTURE, "unknown"],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classifyBrowserRunFailure(new Error(message)), expected);
  }
  assert.equal(classifyBrowserRunFailure(SECRET_FIXTURE), "unknown");
  assert.equal(readBrowserFailureCode({ browserFailureCode: SECRET_FIXTURE }), "unknown");
  assert.equal(readBrowserFailureStage({ browserFailureStage: SECRET_FIXTURE }), "unknown");
}

async function runFailureStageRetentionTest() {
  const entries = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
    addSecrets() {},
  };
  const harness = createRuntime(async (options) => {
    await options.onEvent({
      event: "status",
      status: "browser_failure",
      failureStage: "password_input",
    });
    await options.onEvent({
      event: "result",
      success: false,
      failureStage: SECRET_FIXTURE,
    });
    throw new Error("ruyipage backend failed");
  });

  await assert.rejects(
    runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime),
    (error) => {
      assert.equal(readBrowserFailureCode(error), "backend_failed");
      assert.equal(readBrowserFailureStage(error), "password_input");
      return true;
    }
  );
  const resultEvent = entries.find(
    (entry) => entry.source === "ruyipage" && entry.event === "result"
  );
  const runnerFailure = entries.find(
    (entry) => entry.source === "account_browser" && entry.event === "runner_failed"
  );
  assert.equal(resultEvent?.details.failureStage, "unknown");
  assert.equal(runnerFailure?.details.failureStage, "password_input");
  assert.equal(JSON.stringify(entries).includes(SECRET_FIXTURE), false);
}

function runFlowFailureEnvelopeTest() {
  const failedAt = new Date("2030-01-02T03:04:05.678Z");
  assert.deepEqual(
    createFlowFailureEnvelope(
      "credential_resolution",
      "credential_resolution_failed",
      failedAt
    ),
    {
      failureStage: "credential_resolution",
      failureCode: "credential_resolution_failed",
      failedAt: "2030-01-02T03:04:05.678Z",
      auditFile: "flow-audit.jsonl",
    }
  );
  assert.deepEqual(createFlowFailureEnvelope(SECRET_FIXTURE, SECRET_FIXTURE, failedAt), {
    failureStage: "unknown",
    failureCode: "unknown",
    failedAt: "2030-01-02T03:04:05.678Z",
    auditFile: "flow-audit.jsonl",
  });
}

function runAccountBrowserCompletionSummaryTest() {
  assert.deepEqual(summarizeAccountBrowserCompletion({ skipped: true }), {
    accountHomeConfirmed: false,
    profileCaptureState: "skipped",
    postLoginFinalizationState: "skipped",
    backendCleanupCompleted: null,
    collectorDisposed: null,
    browserFinalizationCompleted: null,
    browserPreservationRequested: null,
    browserSessionPreserved: null,
    finalizationClass: null,
  });
  assert.deepEqual(
    summarizeAccountBrowserCompletion({
      browserLogin: { accountHomeConfirmed: true },
      postLoginProfileCapture: { success: true },
    }),
    {
      accountHomeConfirmed: true,
      profileCaptureState: "succeeded",
      postLoginFinalizationState: "unknown",
      backendCleanupCompleted: null,
      collectorDisposed: null,
      browserFinalizationCompleted: null,
      browserPreservationRequested: null,
      browserSessionPreserved: null,
      finalizationClass: null,
    }
  );
  assert.deepEqual(
    summarizeAccountBrowserCompletion({
      browserLogin: { accountHomeConfirmed: true },
      postLoginProfileCapture: { success: false },
      postLoginFinalization: {
        backendCleanupCompleted: true,
        collectorDisposed: true,
        browserFinalizationCompleted: true,
        browserPreservationRequested: false,
        browserSessionPreserved: false,
        finalizationClass: "backend_cleanup_failed",
      },
    }),
    {
      accountHomeConfirmed: true,
      profileCaptureState: "partial",
      postLoginFinalizationState: "partial",
      backendCleanupCompleted: false,
      collectorDisposed: true,
      browserFinalizationCompleted: true,
      browserPreservationRequested: false,
      browserSessionPreserved: false,
      finalizationClass: "backend_cleanup_failed",
    }
  );
  assert.deepEqual(
    summarizeAccountBrowserCompletion({
      browserLogin: { accountHomeConfirmed: true },
      postLoginProfileCapture: { success: true },
      postLoginFinalization: {
        backendCleanupCompleted: true,
        collectorDisposed: true,
        browserFinalizationCompleted: true,
        browserPreservationRequested: false,
        browserSessionPreserved: false,
      },
    }),
    {
      accountHomeConfirmed: true,
      profileCaptureState: "succeeded",
      postLoginFinalizationState: "completed",
      backendCleanupCompleted: true,
      collectorDisposed: true,
      browserFinalizationCompleted: true,
      browserPreservationRequested: false,
      browserSessionPreserved: false,
      finalizationClass: "unknown",
    }
  );
}

async function runMissingAccountHomeConfirmationTest() {
  const harness = createRuntime(async () => ({
    success: true,
    browserLogin: { success: true, backend: "ruyipage" },
    personalInfo: { name: "Test Given Test Family", birthday: "2000-01-02" },
    screenshots: {},
  }));

  await assert.rejects(
    runAccountBrowserPhase(params, harness.runtime),
    /authenticated Apple account home/
  );
  assert.deepEqual(harness.calls, ["dispose"]);
}

async function runTrustedSessionDisposalTest() {
  const harness = createRuntime(async () => ({
    ...successfulResult(),
    browserLogin: {
      success: true,
      backend: "ruyipage",
      accountHomeConfirmed: true,
      skippedLogin: true,
      skipped2FA: true,
    },
  }));

  await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(harness.calls, ["dispose"]);
  assert.equal(harness.collectorCount, 1);
}

async function runProfilePersistenceAndAuditRedactionTest() {
  const storedProfiles = [];
  const auditEntries = [];
  const auditSecrets = [];
  const profile = {
    name: "Test Given Test Family",
    birthday: "2000-01-02",
  };
  const harness = createRuntime(async () => ({
    ...successfulResult(),
    personalInfo: profile,
  }), {
    saveAppleProfileToEnv(value) {
      storedProfiles.push(value);
      return "/tmp/test-profile.env";
    },
    shouldPrintCapturedProfile: true,
  });
  const flowAudit = {
    addSecrets(values) {
      auditSecrets.push(...values);
    },
    write(source, event, details = {}) {
      auditEntries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      auditEntries.push({ source, event, details });
    },
  };

  let browserResult;
  const logs = await captureConsole("log", async () => {
    browserResult = await runAccountBrowserPhase(
      { ...params, flowAudit },
      harness.runtime
    );
    assert.deepEqual(browserResult.personalInfo, {
      collected: true,
      nameStored: true,
      birthdayStored: true,
    });
  });

  assert.deepEqual(storedProfiles, [profile]);
  assert.deepEqual(auditSecrets, [profile.name, profile.birthday]);
  assert.ok(logs.some((line) => line.includes(profile.name)));
  assert.ok(logs.some((line) => line.includes(profile.birthday)));
  const auditText = JSON.stringify(auditEntries);
  assert.equal(auditText.includes(profile.name), false);
  assert.equal(auditText.includes(profile.birthday), false);

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-profile-report-"));
  const reportFile = path.join(reportDir, "report.json");
  try {
    writeReport(reportDir, { phases: { accountBrowser: browserResult } });
    const reportText = fs.readFileSync(reportFile, "utf8");
    assert.equal(reportText.includes(profile.name), false);
    assert.equal(reportText.includes(profile.birthday), false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);
    }
  } finally {
    if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
    fs.rmdirSync(reportDir);
  }
}

async function runBrowserResultMetadataAllowlistTest() {
  const profile = { name: "Test Given Test Family", birthday: "2000-01-02" };
  const harness = createRuntime(async () => ({
    success: true,
    browserLogin: {
      success: true,
      backend: "ruyipage",
      accountHomeConfirmed: true,
      skippedLogin: true,
      skipped2FA: false,
      sessionReused: true,
      rememberAccount: false,
      appleId: SECRET_FIXTURE,
      profileName: SECRET_FIXTURE,
    },
    postLoginProfileCapture: {
      success: true,
      failureStage: SECRET_FIXTURE,
      failureClass: SECRET_FIXTURE,
      browserAlive: true,
      browserPreserved: true,
      browserPreservationRequested: true,
      rawProfile: SECRET_FIXTURE,
    },
    postLoginFinalization: {
      browserFinalizationCompleted: true,
      browserPreservationRequested: true,
      browserSessionPreserved: true,
      rawFinalization: SECRET_FIXTURE,
    },
    personalInfo: profile,
    screenshots: {
      afterLogin: "/private/run/02-ruyipage-after-login.png",
      personalInformation: "/private/run/03-account-information.png",
      extra: SECRET_FIXTURE,
    },
    unexpected: SECRET_FIXTURE,
  }));

  const result = await runAccountBrowserPhase(params, harness.runtime);

  assert.deepEqual(result.browserLogin, {
    success: true,
    backend: "ruyipage",
    accountHomeConfirmed: true,
    skippedLogin: true,
    skipped2FA: false,
    sessionReused: true,
    rememberAccount: false,
  });
  assert.deepEqual(result.screenshots, {
    afterLogin: "02-ruyipage-after-login.png",
    personalInformation: "03-account-information.png",
  });
  assert.deepEqual(result.postLoginProfileCapture, {
    success: true,
    failureStage: "unknown",
    failureClass: "unknown",
    browserAlive: true,
    browserPreserved: true,
    browserPreservationRequested: true,
  });
  assert.deepEqual(result.postLoginFinalization, {
    success: true,
    backendCleanupCompleted: true,
    collectorDisposed: true,
    browserFinalizationCompleted: true,
    browserPreservationRequested: true,
    browserSessionPreserved: true,
    finalizationClass: "unknown",
  });
  assert.equal(JSON.stringify(result).includes(SECRET_FIXTURE), false);
}

async function runPostHomeProfileFailureRetentionTest() {
  const entries = [];
  const storedProfiles = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async (options) => {
    await options.onEvent({ event: "status", status: "account_home_confirmed" });
    await options.onEvent({
      event: "status",
      status: "profile_capture_failed",
      failureStage: "profile_name",
      failureClass: "profile_data_incomplete",
      browserAlive: true,
      browserPreservationRequested: true,
    });
    await options.onEvent({
      event: "status",
      status: "browser_session_preserved",
      preserved: true,
    });
    await options.onEvent({
      event: "status",
      status: "browser_finalization_completed",
      browserFinalizationCompleted: true,
      browserPreservationRequested: true,
      browserSessionPreserved: true,
    });
    return {
      ...successfulResult(),
      postLoginProfileCapture: {
        success: false,
        failureStage: "profile_name",
        failureClass: "profile_data_incomplete",
        browserAlive: true,
        browserPreserved: true,
        browserPreservationRequested: true,
      },
      personalInfo: {
        name: SECRET_FIXTURE,
        birthday: SECRET_FIXTURE,
      },
      postLoginFinalization: {
        browserFinalizationCompleted: true,
        browserPreservationRequested: true,
        browserSessionPreserved: true,
      },
    };
  }, {
    saveAppleProfileToEnv(profile) {
      storedProfiles.push(profile);
    },
  });

  let result;
  const warnings = await captureConsole("warn", async () => {
    result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
  });

  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.deepEqual(result.personalInfo, {
    collected: false,
    nameStored: false,
    birthdayStored: false,
  });
  assert.deepEqual(result.postLoginProfileCapture, {
    success: false,
    failureStage: "profile_name",
    failureClass: "profile_data_incomplete",
    browserAlive: true,
    browserPreserved: true,
    browserPreservationRequested: true,
  });
  assert.deepEqual(result.postLoginFinalization, {
    success: true,
    backendCleanupCompleted: true,
    collectorDisposed: true,
    browserFinalizationCompleted: true,
    browserPreservationRequested: true,
    browserSessionPreserved: true,
    finalizationClass: "unknown",
  });
  assert.deepEqual(storedProfiles, []);
  const partial = entries.find(
    (entry) => entry.source === "account_browser" && entry.event === "profile_capture_partial"
  );
  assert.equal(partial?.details.failureStage, "profile_name");
  assert.equal(partial?.details.failureClass, "profile_data_incomplete");
  assert.equal(partial?.details.browserPreserved, true);
  assert.ok(warnings.some((line) => line.includes("profile_capture_partial")));
  assert.equal(JSON.stringify(entries).includes(SECRET_FIXTURE), false);
}

async function runProfilePersistenceFailureReturnsPartialTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async () => successfulResult(), {
    saveAppleProfileToEnv() {
      throw new Error(`profile persistence ${SECRET_FIXTURE}`);
    },
  });

  let result;
  const warnings = await captureConsole("warn", async () => {
    result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
  });

  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.deepEqual(result.postLoginProfileCapture, {
    success: false,
    failureStage: "profile_capture",
    failureClass: "profile_persistence_failed",
    browserAlive: true,
    browserPreserved: true,
    browserPreservationRequested: false,
  });
  assert.deepEqual(result.personalInfo, {
    collected: false,
    nameStored: false,
    birthdayStored: false,
  });
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "account_browser" &&
        entry.event === "profile_persistence_failed" &&
        entry.details.failureClass === "profile_persistence_failed"
    )
  );
  assert.ok(warnings.some((line) => line.includes("profile_capture_partial")));
  assert.equal(JSON.stringify(entries).includes(SECRET_FIXTURE), false);
}

async function runMissingProfileResultReturnsPartialTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async () => ({
    ...successfulResult(),
    personalInfo: {},
  }));

  const result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.equal(result.postLoginProfileCapture.success, false);
  assert.equal(result.postLoginProfileCapture.failureStage, "profile_capture");
  assert.equal(result.postLoginProfileCapture.failureClass, "profile_result_missing");
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "account_browser" &&
        entry.event === "profile_result_invalid" &&
        entry.details.failureClass === "profile_result_missing"
    )
  );
}

async function runBrowserStageTerminalOutputTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async (options) => {
    await options.onEvent({
      event: "status",
      status: "browser_stage",
      stage: "account_information",
      previousStage: "signed_in",
      transition: "entered",
    });
    await options.onEvent({
      event: "status",
      status: "browser_observation",
      checkpoint: "account_information",
      pageKind: "account_information",
      connectionAlive: true,
      sessionConfirmed: true,
      accountHomeConfirmed: true,
      twofaVisible: false,
      inputReady: false,
      codeInputCount: 0,
      authenticationError: false,
    });
    await options.onEvent({
      event: "status",
      status: "screenshot_capture",
      checkpoint: "account_home",
      path: SECRET_FIXTURE,
    });
    await options.onEvent({
      event: "status",
      status: "screenshot_failed",
      checkpoint: "account_information",
      error: SECRET_FIXTURE,
    });
    return successfulResult();
  });

  let logs;
  const warnings = await captureConsole("warn", async () => {
    logs = await captureConsole("log", () =>
      runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime)
    );
  });
  assert.ok(
    logs.includes(
      "[ruyipage] stage:account_information:from:signed_in:transition:entered"
    )
  );
  assert.ok(
    logs.includes(
      "[ruyipage] observation:account_information:generation:0:page:account_information:session:1:home:1:alive:1:inspection_available:1:twofa:0:input:0:cells:0:auth_error:0:root_manage:0:root_marker:0:root_error:0:root_security_copy:0:retiring_child:0:child_auth:0"
    )
  );
  assert.ok(logs.includes("[ruyipage] status:screenshot_capture:checkpoint:account_home"));
  assert.ok(
    warnings.includes("[ruyipage] status:screenshot_failed:checkpoint:account_information")
  );
  assert.deepEqual(
    entries
      .filter(
        (entry) =>
          entry.source === "ruyipage" &&
          entry.event === "status" &&
          entry.details.status.startsWith("screenshot_")
      )
      .map((entry) => entry.details),
    [
      { status: "screenshot_capture", checkpoint: "account_home" },
      { status: "screenshot_failed", checkpoint: "account_information" },
    ]
  );
  assert.equal(JSON.stringify({ entries, logs, warnings }).includes(SECRET_FIXTURE), false);
}

async function runWarningSanitizationTest() {
  const harness = createRuntime(async (options) => {
    await options.onEvent({ event: "warning", message: SECRET_FIXTURE });
    return successfulResult();
  });

  const warnings = await captureConsole("warn", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );
  assert.deepEqual(warnings, ["[ruyipage] backend warning"]);
  assert.equal(warnings.join(" ").includes(SECRET_FIXTURE), false);
}

async function runEnvironmentWarningSanitizationTest() {
  const harness = createRuntime(async () => successfulResult(), {
    environmentWarnings: [SECRET_FIXTURE],
  });

  const logs = await captureConsole("log", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );
  assert.ok(logs.includes("[Firefox] 环境提示: browser environment warning"));
  assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
}

async function runReadyModeSanitizationTest() {
  const harness = createRuntime(async (options) => {
    await options.onEvent({ event: "ready", mode: READY_MODE_SECRET });
    await options.onEvent({ event: "ready", mode: "ruyipage-only" });
    await options.onEvent({ event: "ready", mode: "unexpected-mode" });
    await options.onEvent({ event: "ready" });
    await options.onEvent({
      event: "status",
      status: "browser_failure",
      failureStage: "email_wait",
      secret: SECRET_FIXTURE,
    });
    await options.onEvent({
      event: "result",
      success: false,
      failureStage: "email_wait",
      secret: SECRET_FIXTURE,
    });
    await options.onEvent({
      event: "status",
      status: "browser_failure",
      failureStage: SECRET_FIXTURE,
    });
    return successfulResult();
  });

  const logs = await captureConsole("log", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );
  const readyLogs = logs.filter((line) => line.includes("[ruyipage] 浏览器已就绪"));
  assert.deepEqual(
    {
      count: readyLogs.length,
      mappedUnknownCount: readyLogs.filter((line) => line.endsWith("(browser)")).length,
      preservedKnown: readyLogs.some((line) => line.endsWith("(ruyipage-only)")),
      leaked: logs.some((line) => line.includes(READY_MODE_SECRET)),
    },
    { count: 4, mappedUnknownCount: 3, preservedKnown: true, leaked: false }
  );
  assert.ok(logs.includes("[ruyipage] status:runtime_resolving"));
  assert.ok(logs.includes("[ruyipage] status:backend_starting"));
  assert.equal(
    logs.filter((line) => line === "[ruyipage] status:failure:email_wait").length,
    1
  );
  assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
}

async function runCleanupErrorSanitizationTest() {
  const harness = createRuntime(
    async () => {
      throw new Error("backend failed");
    },
    { disposeError: new Error(SECRET_FIXTURE) }
  );

  const warnings = await captureConsole("warn", async () => {
    await assert.rejects(
      runAccountBrowserPhase(params, harness.runtime),
      /backend failed/
    );
  });
  assert.deepEqual(warnings, ["[2FA] collector cleanup failed"]);
  assert.equal(warnings.join(" ").includes(SECRET_FIXTURE), false);
}

async function runPostLoginCollectorCleanupPartialTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async () => successfulResult(), {
    disposeError: new Error(`collector cleanup ${SECRET_FIXTURE}`),
  });

  let result;
  let logs;
  const warnings = await captureConsole("warn", async () => {
    logs = await captureConsole("log", async () => {
      result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
    });
  });

  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.deepEqual(result.postLoginFinalization, {
    success: false,
    backendCleanupCompleted: true,
    collectorDisposed: false,
    browserFinalizationCompleted: true,
    browserPreservationRequested: false,
    browserSessionPreserved: false,
    finalizationClass: "collector_dispose_failed",
  });
  assert.deepEqual(harness.calls, ["dispose"]);
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "two_factor" &&
        entry.event === "collector_dispose_partial" &&
        entry.details.accountHomeConfirmed === true
    )
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "account_browser" &&
        entry.event === "post_login_finalization_partial" &&
        entry.details.backendCleanupCompleted === true &&
        entry.details.collectorDisposed === false
    )
  );
  assert.equal(logs.some((line) => line.includes("status:node-failure")), false);
  assert.ok(
    warnings.includes("[2FA] collector cleanup partial after account-home confirmation")
  );
  assert.ok(
    warnings.some((line) => line.includes("post_login_finalization_partial"))
  );
  assert.equal(JSON.stringify({ entries, logs, warnings }).includes(SECRET_FIXTURE), false);
}

async function runMissingPostLoginFinalizationRemainsUnknownTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async () => {
    const result = successfulResult();
    delete result.postLoginFinalization;
    return result;
  });

  let result;
  const warnings = await captureConsole("warn", async () => {
    result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
  });

  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.equal(result.postLoginFinalization, null);
  assert.deepEqual(summarizeAccountBrowserCompletion(result), {
    accountHomeConfirmed: true,
    profileCaptureState: "succeeded",
    postLoginFinalizationState: "unknown",
    backendCleanupCompleted: null,
    collectorDisposed: null,
    browserFinalizationCompleted: null,
    browserPreservationRequested: null,
    browserSessionPreserved: null,
    finalizationClass: null,
  });
  assert.equal(
    entries.some(
      (entry) =>
        entry.source === "account_browser" && entry.event === "post_login_finalization_partial"
    ),
    false
  );
  assert.equal(warnings.some((line) => line.includes("post_login_finalization_partial")), false);
}

async function runBrowserFinalizationPartialRetentionTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async (options) => {
    await options.onEvent({
      event: "status",
      status: "browser_finalization_started",
      browserPreservationRequested: true,
      secret: SECRET_FIXTURE,
    });
    await options.onEvent({
      event: "status",
      status: "browser_finalization_partial",
      browserFinalizationCompleted: false,
      browserPreservationRequested: true,
      browserSessionPreserved: false,
      secret: SECRET_FIXTURE,
    });
    return {
      ...successfulResult(),
      postLoginFinalization: {
        browserFinalizationCompleted: false,
        browserPreservationRequested: true,
        browserSessionPreserved: false,
        rawFinalization: SECRET_FIXTURE,
      },
    };
  });

  let result;
  let logs;
  const warnings = await captureConsole("warn", async () => {
    logs = await captureConsole("log", async () => {
      result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
    });
  });

  assert.equal(result.browserLogin.accountHomeConfirmed, true);
  assert.deepEqual(result.postLoginFinalization, {
    success: false,
    backendCleanupCompleted: true,
    collectorDisposed: true,
    browserFinalizationCompleted: false,
    browserPreservationRequested: true,
    browserSessionPreserved: false,
    finalizationClass: "unknown",
  });
  assert.ok(
    logs.includes("[ruyipage] status:browser_finalization_started:preserve_requested:1")
  );
  assert.ok(
    warnings.includes(
      "[ruyipage] status:browser_finalization_partial:completed:0:preserve_requested:1:preserved:0:class:unknown"
    )
  );
  assert.ok(warnings.some((line) => line.includes("post_login_finalization_partial")));
  assert.deepEqual(
    entries
      .filter(
        (entry) =>
          entry.source === "ruyipage" &&
          entry.event === "status" &&
          entry.details.status.startsWith("browser_finalization_")
      )
      .map((entry) => entry.details),
    [
      {
        status: "browser_finalization_started",
        browserPreservationRequested: true,
      },
      {
        status: "browser_finalization_partial",
        browserFinalizationCompleted: false,
        browserPreservationRequested: true,
        browserSessionPreserved: false,
        finalizationClass: "unknown",
      },
    ]
  );
  assert.equal(JSON.stringify({ result, entries, logs, warnings }).includes(SECRET_FIXTURE), false);
}

async function runFinalizationFailureClassInvariantTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const harness = createRuntime(async () => ({
    ...successfulResult(),
    postLoginFinalization: {
      backendCleanupCompleted: true,
      collectorDisposed: true,
      browserFinalizationCompleted: true,
      browserPreservationRequested: false,
      browserSessionPreserved: false,
      finalizationClass: "backend_cleanup_failed",
    },
  }));

  const result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);

  assert.deepEqual(result.postLoginFinalization, {
    success: false,
    backendCleanupCompleted: false,
    collectorDisposed: true,
    browserFinalizationCompleted: true,
    browserPreservationRequested: false,
    browserSessionPreserved: false,
    finalizationClass: "backend_cleanup_failed",
  });
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "account_browser" &&
        entry.event === "post_login_finalization_partial" &&
        entry.details.backendCleanupCompleted === false &&
        entry.details.finalizationClass === "backend_cleanup_failed"
    )
  );
}

function createPostLoginRunnerError({
  failureCode = "backend_exit",
  accountHomeConfirmed = true,
  browserPreserved = false,
  browserSessionPreserved = true,
  directPostLoginRecoveryEligible = true,
} = {}) {
  const error = new Error(SECRET_FIXTURE);
  Object.defineProperties(error, {
    ruyiPageFailureCode: { value: failureCode },
    ruyiPageFailureStage: { value: "profile_capture" },
    ruyiPageFailureContext: {
      value: {
        stage: "profile_capture",
        twoFaPhase: "transition_confirmed",
        generation: 1,
        codeDeliveryAttempted: true,
        codeDeliverySent: true,
        codeDeliveryAcknowledged: true,
        codeDeliveryWriteStarted: true,
        codeDeliveryWriteCompleted: true,
        browserLaunchObserved: true,
        accountHomeConfirmed,
        browserPreserved,
        browserSessionPreserved,
        browserFinalizationCompleted: false,
        browserPreservationRequested: browserSessionPreserved,
        directBrowserPreservationRequested: false,
        directPostLoginRecoveryEligible,
        browserErrorClass: "unknown",
        backendExitCode: 1,
        cleanupFailed: false,
      },
    },
  });
  return error;
}

async function runPostLoginRunnerPartialTest() {
  const entries = [];
  const flowAudit = {
    addSecrets() {},
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
    writeError(source, event, _error, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const runnerError = createPostLoginRunnerError();
  const harness = createRuntime(async (options) => {
    await options.onEvent({ event: "status", status: "account_home_confirmed" });
    await options.onEvent({
      event: "status",
      status: "browser_session_preserved",
      preserved: true,
      profileCaptureSuccess: false,
    });
    throw runnerError;
  });

  let result;
  let logs;
  const warnings = await captureConsole("warn", async () => {
    logs = await captureConsole("log", async () => {
      result = await runAccountBrowserPhase({ ...params, flowAudit }, harness.runtime);
    });
  });

  assert.deepEqual(result.browserLogin, {
    success: true,
    backend: "ruyipage",
    accountHomeConfirmed: true,
    skippedLogin: false,
    skipped2FA: false,
    sessionReused: false,
    rememberAccount: null,
  });
  assert.deepEqual(result.personalInfo, {
    collected: false,
    nameStored: false,
    birthdayStored: false,
  });
  assert.deepEqual(result.postLoginProfileCapture, {
    success: false,
    failureStage: "profile_capture",
    failureClass: "runner_post_login_failed",
    browserAlive: false,
    browserPreserved: true,
    browserPreservationRequested: true,
  });
  assert.deepEqual(result.postLoginFinalization, {
    success: false,
    backendCleanupCompleted: true,
    collectorDisposed: true,
    browserFinalizationCompleted: false,
    browserPreservationRequested: true,
    browserSessionPreserved: true,
    finalizationClass: "runner_post_login_failed",
  });
  assert.deepEqual(harness.calls, ["dispose"]);
  assert.ok(
    entries.some(
      (entry) =>
        entry.source === "account_browser" &&
        entry.event === "runner_post_login_partial" &&
        entry.details.failureCode === "backend_exit" &&
        entry.details.browserSessionPreserved === true
    )
  );
  assert.equal(
    entries.some((entry) => entry.source === "account_browser" && entry.event === "runner_failed"),
    false
  );
  assert.ok(
    warnings.includes(
      "[ruyipage] runner_post_login_partial:stage:profile_capture:code:backend_exit:preserve_requested:1:preserved:1:browser_finalized:0"
    )
  );
  assert.equal(logs.some((line) => line.includes("status:node-failure")), false);
  assert.equal(JSON.stringify({ result, entries, logs, warnings }).includes(SECRET_FIXTURE), false);
}

async function runPostLoginRunnerPartialBoundaryTest() {
  for (const options of [
    { browserSessionPreserved: false },
    { browserPreserved: true, browserSessionPreserved: false },
    { failureCode: "backend_timeout", browserSessionPreserved: false },
  ]) {
    const harness = createRuntime(async () => {
      throw createPostLoginRunnerError(options);
    });
    const result = await runAccountBrowserPhase(params, harness.runtime);
    assert.equal(result.browserLogin.accountHomeConfirmed, true);
    assert.equal(result.postLoginProfileCapture.failureClass, "runner_post_login_failed");
    assert.equal(
      result.postLoginProfileCapture.browserPreserved,
      options.browserSessionPreserved ?? true,
      "post-login partial must not treat a generic failure-preservation signal as session evidence"
    );
    assert.equal(result.postLoginFinalization.finalizationClass, "runner_post_login_failed");
    assert.equal(
      result.postLoginFinalization.browserSessionPreserved,
      options.browserSessionPreserved ?? true
    );
  }

  for (const options of [
    { accountHomeConfirmed: false },
    { failureCode: "backend_interrupted" },
    { directPostLoginRecoveryEligible: false },
    { failureCode: "backend_protocol" },
  ]) {
    const harness = createRuntime(async () => {
      throw createPostLoginRunnerError(options);
    });
    await assert.rejects(
      runAccountBrowserPhase(params, harness.runtime),
      (error) => readBrowserFailureCode(error) === (options.failureCode ?? "backend_exit")
    );
  }
}

function runAppleIdMaskingTest() {
  const cases = [
    ["person@example.com", "pe***@example.com"],
    ["a@b", "***@b"],
    ["ab@b", "***@b"],
    ["person", "pe***"],
    ["a", "***"],
    ["ab", "***"],
    ["", "***"],
    [null, "***"],
    [undefined, "***"],
  ];
  for (const [value, expected] of cases) {
    const masked = maskAppleId(value);
    assert.equal(masked, expected);
    if (value) assert.notEqual(masked, String(value).trim());
  }
}

function runEnvDataParsingTest() {
  assert.equal(parseEnvValue(String.raw`"a\\b\"c"`), 'a\\b"c');
  assert.equal(parseEnvValue(String.raw`'a\\b"c'`), String.raw`a\\b"c`);
  assert.equal(parseEnvValue('" leading # $ value "'), " leading # $ value ");
  assert.equal(parseEnvValue("plain#value$HOME"), "plain#value$HOME");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-env-data-"));
  const envPath = path.join(tempDir, ".env");
  const originalCwd = process.cwd();
  const externalKey = "APPLE_AUTOMATION_TEST_EXTERNAL";
  const loadedKey = "APPLE_AUTOMATION_TEST_LOADED";
  const smsKeys = [
    "APPLE_AUTOMATION_SMS_ENABLED",
    "APPLE_AUTOMATION_SMS_PHONE",
    "APPLE_AUTOMATION_SMS_API_URL",
    "APPLE_AUTOMATION_SMS_RECONFIGURE",
    "APPLE_AUTOMATION_MANUAL_SMS_CODE",
  ];
  const originalExternal = process.env[externalKey];
  const originalLoaded = process.env[loadedKey];
  const originalSmsValues = Object.fromEntries(smsKeys.map((key) => [key, process.env[key]]));
  try {
    fs.writeFileSync(
      envPath,
      `${externalKey}=from-file\r\n${loadedKey}="a\\\\b\\\"c # $HOME"\r\nAPPLE_AUTOMATION_SMS_ENABLED=1\r\nAPPLE_AUTOMATION_SMS_PHONE=+8613800130051\r\nAPPLE_AUTOMATION_SMS_API_URL=https://example.test/record?token=private\r\nAPPLE_AUTOMATION_SMS_RECONFIGURE=1\r\nAPPLE_AUTOMATION_MANUAL_SMS_CODE=123456\r\nname=old\r\nname=duplicate\r\nbirthday=1900-01-01\r\nbirthday=1900-01-02\r\n`,
      "utf8"
    );
    fs.chmodSync(envPath, 0o644);
    process.env[externalKey] = "";
    delete process.env[loadedKey];
    for (const key of smsKeys) delete process.env[key];
    process.chdir(tempDir);
    assert.equal(loadEnvFile(), envPath);
    assert.equal(process.env[externalKey], "");
    assert.equal(process.env[loadedKey], 'a\\b"c # $HOME');
    assert.equal(process.env.APPLE_AUTOMATION_SMS_ENABLED, "1");
    assert.equal(process.env.APPLE_AUTOMATION_SMS_PHONE, "+8613800130051");
    assert.equal(process.env.APPLE_AUTOMATION_SMS_API_URL, "https://example.test/record?token=private");
    assert.equal(process.env.APPLE_AUTOMATION_SMS_RECONFIGURE, "1");
    assert.equal(Object.hasOwn(process.env, "APPLE_AUTOMATION_MANUAL_SMS_CODE"), false);
    assert.equal(
      saveCredentialsToEnv({ appleId: "person@example.com", password: "secret" }),
      envPath
    );
    assert.equal(
      saveAppleProfileToEnv({
        name: "Test Given Test Family",
        birthday: "2000-01-02",
      }),
      envPath
    );
    assert.equal(
      saveMacSettingsSmsProviderConfig({
        phoneNumber: "+8613800130052",
        apiUrl: "https://example.test/record?token=replaced",
      }),
      envPath
    );
    const saved = fs.readFileSync(envPath, "utf8");
    assert.match(saved, /^name="Test Given Test Family"$/m);
    assert.match(saved, /^birthday=2000-01-02$/m);
    assert.equal((saved.match(/^name=/gm) ?? []).length, 1);
    assert.equal((saved.match(/^birthday=/gm) ?? []).length, 1);
    assert.match(saved, /^APPLE_AUTOMATION_SMS_ENABLED=1$/m);
    assert.match(saved, /^APPLE_AUTOMATION_SMS_PHONE=\+8613800130052$/m);
    assert.match(saved, /^APPLE_AUTOMATION_SMS_API_URL=https:\/\/example\.test\/record\?token=replaced$/m);
    assert.match(saved, /^APPLE_AUTOMATION_SMS_RECONFIGURE=0$/m);
    assert.equal((saved.match(/^APPLE_AUTOMATION_SMS_PHONE=/gm) ?? []).length, 1);
    assert.equal((saved.match(/^APPLE_AUTOMATION_SMS_API_URL=/gm) ?? []).length, 1);
    assert.equal((saved.match(/^APPLE_AUTOMATION_MANUAL_SMS_CODE=/gm) ?? []).length, 0);
    const credentialsSource = fs.readFileSync(
      new URL("./lib/credentials.js", import.meta.url),
      "utf8"
    );
    assert.match(credentialsSource, /fs\.openSync\(candidate, "wx", 0o600\)/);
    assert.match(credentialsSource, /fs\.fsyncSync\(descriptor\)/);
    assert.match(credentialsSource, /fs\.renameSync\(tempPath, envPath\)/);
    assert.equal(saved.includes("\r\n"), true);
    assert.equal(/(?<!\r)\n/.test(saved), false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    }
    assert.throws(
      () => saveAppleProfileToEnv({ name: "line\nbreak", birthday: "2000-01-02" }),
      /profile name/
    );
  } finally {
    process.chdir(originalCwd);
    if (originalExternal === undefined) delete process.env[externalKey];
    else process.env[externalKey] = originalExternal;
    if (originalLoaded === undefined) delete process.env[loadedKey];
    else process.env[loadedKey] = originalLoaded;
    for (const key of smsKeys) {
      if (originalSmsValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalSmsValues[key];
    }
    if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    fs.rmdirSync(tempDir);
  }
}

function runSmsRuntimeEnvMergeTest() {
  const initialPartial = {
    APPLE_AUTOMATION_SMS_ENABLED: "1",
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130053",
  };
  const persistedPair = {
    APPLE_AUTOMATION_SMS_ENABLED: "1",
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
    APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=stored",
  };
  const mergedPartial = mergeMacSettingsSmsRuntimeEnv(initialPartial, persistedPair);
  assert.equal(mergedPartial.APPLE_AUTOMATION_SMS_PHONE, "+8613800130053");
  assert.equal(Object.hasOwn(mergedPartial, "APPLE_AUTOMATION_SMS_API_URL"), false);

  const mergedStored = mergeMacSettingsSmsRuntimeEnv({}, persistedPair);
  assert.equal(mergedStored.APPLE_AUTOMATION_SMS_PHONE, "+8613800130051");
  assert.equal(
    mergedStored.APPLE_AUTOMATION_SMS_API_URL,
    "https://example.test/record?token=stored"
  );
}

function runFlowReportPrivacyTest() {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-flow-report-"));
  const reportFile = path.join(reportDir, "report.json");
  try {
    const report = createFlowReport(new Date("2030-01-02T03:04:05.678Z"));
    writeReport(reportDir, report);
    const saved = fs.readFileSync(reportFile, "utf8");
    assert.deepEqual(JSON.parse(saved), report);
    assert.equal(Object.hasOwn(report, "appleId"), false);
    assert.equal(saved.includes(params.creds.appleId), false);
    assert.equal(saved.includes(maskAppleId(params.creds.appleId)), false);
  } finally {
    if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
    fs.rmdirSync(reportDir);
  }
}

function runFullFlowSourceContractTest() {
  const browserFlowSource = fs.readFileSync(
    new URL("./lib/account-browser-flow.js", import.meta.url),
    "utf8"
  );
  assert.match(
    browserFlowSource,
    /SUPERVISED_TWO_FACTOR_STATUS_PREFIX = "\[2FA\] status:"[\s\S]*APPLE_AUTOMATION_SUPERVISED_GUI[\s\S]*winner:\$\{event\.source\}/
  );
  const source = fs.readFileSync(
    new URL("./apple-id-full-flow.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /import\s+\{\s*confirmOrPromptAppleCredentials\s*\}\s+from\s+"\.\/lib\/credentials\.js";/
  );
  assert.match(source, /export function createFlowReport/);
  assert.doesNotMatch(source, /maskAppleId|report\.appleId/);
  assert.doesNotMatch(source, /creds\.appleId\.replace\(/);
  assert.match(source, /report\.error\s*=\s*"Apple ID flow failed"/);
  assert.match(source, /readBrowserFailureStage/);
  assert.match(source, /failureCode\s*=\s*readBrowserFailureCode\(e\)/);
  assert.match(source, /failureStage\s*=\s*readBrowserFailureStage\(e\)/);
  assert.doesNotMatch(source, /e\.message|String\(e\)/);
  assert.match(source, /process\.exitCode\s*=\s*1/);
  assert.doesNotMatch(source, /process\.exit\(1\)/);
  assert.match(
    source,
    /report\.phases\.accountBrowser\?\.browserLogin\?\.accountHomeConfirmed\s*===\s*true/
  );
  assert.match(source, /REAL_ACCOUNT_HOME_CONFIRMED/);
  assert.match(source, /\[apple-automation\] stage:flow_main_started/);
  assert.match(source, /\[apple-automation\] stage:credentials_ready/);
  assert.match(source, /flowAudit\.addSecrets\(\[creds\.appleId, creds\.password\]\)/);
  assert.match(source, /auditFile:\s*"flow-audit\.jsonl"/);
  assert.match(source, /flowAudit\.write\("flow", "credential_resolution_failed", \{/);
  assert.ok(
    source.indexOf('const reportDir = createReportDir("apple-id-flow")') <
      source.indexOf("await ensureEnvironment")
  );
  assert.ok(
    source.indexOf('const reportDir = createReportDir("apple-id-flow")') <
      source.indexOf("await confirmOrPromptAppleCredentials")
  );
}

function readEmbeddedRuyiPageJavaScript(pythonSource, functionName) {
  const functionStart = pythonSource.indexOf(`def ${functionName}(`);
  assert.ok(functionStart >= 0, `missing Python function ${functionName}`);
  const stringStart = pythonSource.indexOf('r"""', functionStart);
  assert.ok(stringStart >= 0, `missing embedded JavaScript for ${functionName}`);
  const bodyStart = pythonSource.indexOf("\n", stringStart) + 1;
  const bodyEnd = pythonSource.indexOf(
    '""".replace("__OTP_REJECTION_PATTERN__"',
    bodyStart
  );
  assert.ok(bodyEnd > bodyStart, `unterminated embedded JavaScript for ${functionName}`);
  return pythonSource.slice(bodyStart, bodyEnd).replace(
    "__OTP_REJECTION_PATTERN__",
    "never-match"
  );
}

function createAccountSecurityDetectorFixture({
  pageText,
  cardText,
  assertiveErrorText = null,
  assertiveErrorAttributes = { role: "alert" },
}) {
  const style = { display: "block", visibility: "visible" };
  const ownerDocument = {
    defaultView: { getComputedStyle: () => style },
  };
  const createElement = (text, parentElement = null, attributes = {}) => ({
    innerText: text,
    textContent: text,
    parentElement,
    ownerDocument,
    tagName: "DIV",
    disabled: false,
    getBoundingClientRect: () => ({ width: 200, height: 30 }),
    getAttribute: (name) => attributes[name] ?? null,
  });
  const page = createElement(pageText);
  const card = createElement(cardText, page);
  const feature = createElement("\u53cc\u91cd\u8ba4\u8bc1", card);
  const elements = [feature, card, page];
  if (assertiveErrorText) {
    elements.unshift(createElement(assertiveErrorText, page, assertiveErrorAttributes));
  }
  return {
    window: { getComputedStyle: () => style },
    document: {
      body: { innerText: pageText },
      querySelectorAll: (selector) => (selector === "*" ? elements : []),
    },
    shadowRoot: {
      querySelectorAll: (selector) => (selector === "*" ? elements : []),
    },
  };
}

function runAccountManageSecurityCardDetectorTest() {
  const pythonSource = fs.readFileSync(
    new URL("./ruyipage/apple_account_flow.py", import.meta.url),
    "utf8"
  );
  const rootScript = readEmbeddedRuyiPageJavaScript(
    pythonSource,
    "detect_scope_login_state"
  );
  const shadowScript = readEmbeddedRuyiPageJavaScript(
    pythonSource,
    "detect_shadow_root_state"
  );
  const rootDetector = new Function("document", "location", "window", rootScript);
  const shadowDetector = new Function(`return (${shadowScript});`)();
  const staticSecurityCard = createAccountSecurityDetectorFixture({
    pageText:
      "\u767b\u5f55\u4e0e\u5b89\u5168 \u7ba1\u7406\u4e0e\u767b\u5f55\u8d26\u6237\u3001\u8d26\u6237\u5b89\u5168\u4ee5\u53ca\u65e0\u6cd5\u767b\u5f55\u65f6\u8fdb\u884c\u6570\u636e\u6062\u590d\u6709\u5173\u7684\u8bbe\u7f6e\u3002 \u8d26\u6237\u5b89\u5168 \u53cc\u91cd\u8ba4\u8bc1 1\u4e2a\u53d7\u4fe1\u4efb\u7535\u8bdd\u53f7\u7801 1\u53f0\u53d7\u4fe1\u4efb\u8bbe\u5907",
    cardText:
      "\u8d26\u6237\u5b89\u5168 \u53cc\u91cd\u8ba4\u8bc1 1\u4e2a\u53d7\u4fe1\u4efb\u7535\u8bdd\u53f7\u7801 1\u53f0\u53d7\u4fe1\u4efb\u8bbe\u5907",
  });
  const liveError = createAccountSecurityDetectorFixture({
    pageText: "Account Security Unable to sign in with two-factor authentication",
    cardText: "Account Security Unable to sign in with two-factor authentication",
  });
  const plainErrorBesideStaticCard = createAccountSecurityDetectorFixture({
    pageText:
      "Account Security Two-Factor Authentication Trusted Phone Number Unable to sign in with two-factor authentication",
    cardText: "Account Security Two-Factor Authentication Trusted Phone Number",
    assertiveErrorText: "Unable to sign in with two-factor authentication",
    assertiveErrorAttributes: {},
  });
  const assertiveErrorBesideStaticCard = createAccountSecurityDetectorFixture({
    pageText:
      "Account Security Two-Factor Authentication Trusted Phone Number Unable to sign in with two-factor authentication",
    cardText: "Account Security Two-Factor Authentication Trusted Phone Number",
    assertiveErrorText: "Unable to sign in with two-factor authentication",
  });
  const ariaLiveErrorBesideStaticCard = createAccountSecurityDetectorFixture({
    pageText:
      "Account Security Two-Factor Authentication Trusted Phone Number Unable to sign in with two-factor authentication",
    cardText: "Account Security Two-Factor Authentication Trusted Phone Number",
    assertiveErrorText: "Unable to sign in with two-factor authentication",
    assertiveErrorAttributes: { "aria-live": "assertive" },
  });

  const rootStatic = JSON.parse(
    rootDetector(
      staticSecurityCard.document,
      { href: "https://account.apple.com/account/manage" },
      staticSecurityCard.window
    )
  );
  const rootError = JSON.parse(
    rootDetector(
      liveError.document,
      { href: "https://account.apple.com/account/manage" },
      liveError.window
    )
  );
  const rootPlainError = JSON.parse(
    rootDetector(
      plainErrorBesideStaticCard.document,
      { href: "https://account.apple.com/account/manage" },
      plainErrorBesideStaticCard.window
    )
  );
  const rootAssertiveError = JSON.parse(
    rootDetector(
      assertiveErrorBesideStaticCard.document,
      { href: "https://account.apple.com/account/manage" },
      assertiveErrorBesideStaticCard.window
    )
  );
  const rootAriaLiveError = JSON.parse(
    rootDetector(
      ariaLiveErrorBesideStaticCard.document,
      { href: "https://account.apple.com/account/manage" },
      ariaLiveErrorBesideStaticCard.window
    )
  );
  assert.equal(rootStatic.genericAuthText, true);
  assert.equal(rootStatic.securityFeatureCopy, true);
  assert.equal(rootError.genericAuthText, true);
  assert.equal(rootError.securityFeatureCopy, false);
  assert.equal(rootPlainError.securityFeatureCopy, true);
  assert.equal(rootPlainError.hardAuthenticationError, true);
  assert.equal(rootAssertiveError.securityFeatureCopy, true);
  assert.equal(rootAssertiveError.hardAuthenticationError, true);
  assert.equal(rootAriaLiveError.securityFeatureCopy, true);
  assert.equal(rootAriaLiveError.hardAuthenticationError, true);

  const shadowStatic = JSON.parse(shadowDetector.call(staticSecurityCard.shadowRoot));
  const shadowError = JSON.parse(shadowDetector.call(liveError.shadowRoot));
  const shadowPlainError = JSON.parse(
    shadowDetector.call(plainErrorBesideStaticCard.shadowRoot)
  );
  const shadowAssertiveError = JSON.parse(
    shadowDetector.call(assertiveErrorBesideStaticCard.shadowRoot)
  );
  const shadowAriaLiveError = JSON.parse(
    shadowDetector.call(ariaLiveErrorBesideStaticCard.shadowRoot)
  );
  assert.equal(shadowStatic.genericAuthText, true);
  assert.equal(shadowStatic.securityFeatureCopy, true);
  assert.equal(shadowError.genericAuthText, true);
  assert.equal(shadowError.securityFeatureCopy, false);
  assert.equal(shadowPlainError.securityFeatureCopy, true);
  assert.equal(shadowPlainError.hardAuthenticationError, true);
  assert.equal(shadowAssertiveError.securityFeatureCopy, true);
  assert.equal(shadowAssertiveError.hardAuthenticationError, true);
  assert.equal(shadowAriaLiveError.securityFeatureCopy, true);
  assert.equal(shadowAriaLiveError.hardAuthenticationError, true);
}

function runSupervisedCredentialConfirmationTest() {
  assert.equal(
    shouldAutoConfirmAppleCredentials({ APPLE_AUTOMATION_SUPERVISED_GUI: "1" }),
    true
  );
  assert.equal(shouldAutoConfirmAppleCredentials({}), false);
  assert.equal(
    shouldAutoConfirmAppleCredentials({ APPLE_AUTOMATION_SUPERVISED_GUI: "0" }),
    false
  );
}

function runReportRootOverrideTest() {
  const requested = "tmp/mac-supervised-reports";
  assert.equal(
    resolveReportRoot({ APPLE_AUTOMATION_REPORT_ROOT: requested }),
    path.resolve(requested)
  );
  assert.match(resolveReportRoot({}), /[\\/]data[\\/]reports$/);
}

function runAcceptanceMarkerTest() {
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apple-account-marker-"));
  const markerPath = path.join(reportRoot, ".account-home-confirmed");
  try {
    assert.equal(
      writeAccountHomeAcceptanceMarker({
        APPLE_AUTOMATION_REPORT_ROOT: reportRoot,
        APPLE_AUTOMATION_ACCEPTANCE_MARKER: markerPath,
      }),
      markerPath
    );
    assert.equal(fs.readFileSync(markerPath, "utf8"), "REAL_ACCOUNT_HOME_CONFIRMED\n");
    assert.throws(
      () =>
        writeAccountHomeAcceptanceMarker({
          APPLE_AUTOMATION_REPORT_ROOT: reportRoot,
          APPLE_AUTOMATION_ACCEPTANCE_MARKER: path.join(reportRoot, "nested", "marker"),
        }),
      /direct child/
    );
  } finally {
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    fs.rmdirSync(reportRoot);
  }
}

function runAcceptanceMarkerFailureIsNonfatalTest() {
  const entries = [];
  const logs = [];
  const warnings = [];
  const flowAudit = {
    write(source, event, details = {}) {
      entries.push({ source, event, details });
    },
  };
  const result = recordAccountHomeAcceptanceMarker(true, {
    writeMarker() {
      throw new Error(SECRET_FIXTURE);
    },
    flowAudit,
    logger: {
      log(line) {
        logs.push(line);
      },
      warn(line) {
        warnings.push(line);
      },
    },
  });

  assert.equal(result, "partial");
  assert.deepEqual(entries, [
    {
      source: "flow",
      event: "acceptance_marker_partial",
      details: { accountHomeConfirmed: true },
    },
  ]);
  assert.deepEqual(logs, []);
  assert.deepEqual(warnings, ["[apple-automation] status:acceptance_marker_partial:home:1"]);
  assert.equal(
    recordAccountHomeAcceptanceMarker(false, {
      writeMarker() {
        throw new Error("must not run");
      },
      flowAudit,
      logger: {
        log(line) {
          logs.push(line);
        },
        warn(line) {
          warnings.push(line);
        },
      },
    }),
    "skipped"
  );
  assert.deepEqual(entries.at(-1), {
    source: "flow",
    event: "acceptance_marker_skipped",
    details: { accountHomeConfirmed: false },
  });
  assert.equal(logs.at(-1), "[apple-automation] status:acceptance_marker_skipped:home:0");
  assert.equal(JSON.stringify({ entries, logs, warnings }).includes(SECRET_FIXTURE), false);
}

function runTwoFASidecarSettingsScreenshotSourceContractTest() {
  const source = fs.readFileSync(
    new URL("./lib/two-fa-sidecar.js", import.meta.url),
    "utf8"
  );
  assert.equal(source.includes("screenshotPathFor"), false);
  assert.equal(source.includes("screenshotPath:"), false);
}

const focusedTests = {
  "mask-apple-id": () => {
    runAppleIdMaskingTest();
    runEnvDataParsingTest();
    runSmsRuntimeEnvMergeTest();
    runFlowReportPrivacyTest();
    runFullFlowSourceContractTest();
    runSupervisedCredentialConfirmationTest();
    runReportRootOverrideTest();
    runAcceptanceMarkerTest();
    runAcceptanceMarkerFailureIsNonfatalTest();
  },
  "profile-persistence": runProfilePersistenceAndAuditRedactionTest,
  "profile-persistence-partial": runProfilePersistenceFailureReturnsPartialTest,
  "profile-result-missing": runMissingProfileResultReturnsPartialTest,
  "result-allowlist": runBrowserResultMetadataAllowlistTest,
  "post-home-profile-failure": runPostHomeProfileFailureRetentionTest,
  "browser-stage-terminal": runBrowserStageTerminalOutputTest,
  "collector-cleanup-partial": runPostLoginCollectorCleanupPartialTest,
  "finalization-unknown": runMissingPostLoginFinalizationRemainsUnknownTest,
  "browser-finalization-partial": runBrowserFinalizationPartialRetentionTest,
  "finalization-class-invariant": runFinalizationFailureClassInvariantTest,
  "runner-post-login-partial": runPostLoginRunnerPartialTest,
  "runner-post-login-boundary": runPostLoginRunnerPartialBoundaryTest,
  "ready-mode": runReadyModeSanitizationTest,
  "sidecar-screenshot": runTwoFASidecarSettingsScreenshotSourceContractTest,
  "collector-timeout": runCollectorTimeoutIsAlways240SecondsTest,
  "popup-primary": runProductionPopupPrimaryConfigurationTest,
  generations: runTwoGenerationForwardingTest,
  "flow-audit-forwarding": runFlowAuditForwardingTest,
  "twofa-input-unconfirmed": runTwoFactorInputUnconfirmedDiagnosticTest,
  "twofa-handoff-failure": runTwoFactorHandoffFailureContextTest,
  "password-bidi-progress": runPasswordBidiInputProgressTest,
  "prepared-accessibility": runPreparedAccessibilityCheckDoesNotBlockBrowserTest,
  "status-prompts": runFixedTwoFactorStatusPromptsTest,
  "manual-unavailable-status": runSupervisedManualUnavailableStatusTest,
  "settings-status": runSupervisedSettingsStatusWhitelistTest,
  "failure-stage": runFailureStageRetentionTest,
  "security-card-detector": runAccountManageSecurityCardDetectorTest,
  "failure-envelope": () => {
    runFlowFailureEnvelopeTest();
    runAccountBrowserCompletionSummaryTest();
    runFullFlowSourceContractTest();
  },
};

const focusedTest = process.env.ACCOUNT_BROWSER_FLOW_FOCUSED_TEST;
if (focusedTest) {
  const test = focusedTests[focusedTest];
  assert.ok(test, `unknown focused test: ${focusedTest}`);
  await test();
  console.log(`account browser flow focused test: ${focusedTest} ok`);
  process.exit(0);
}

await runTwoFactorLifecycleTest();
await runProductionPopupPrimaryConfigurationTest();
await runTwoGenerationForwardingTest();
await runBrowserFallbackEnvironmentSwitchesTest();
await runFlowAuditForwardingTest();
await runTwoFactorInputUnconfirmedDiagnosticTest();
await runTwoFactorHandoffFailureContextTest();
await runPasswordBidiInputProgressTest();
await runCollectorTimeoutIsAlways240SecondsTest();
await runPreparedAccessibilityCheckDoesNotBlockBrowserTest();
await runFixedTwoFactorStatusPromptsTest();
await runSupervisedManualUnavailableStatusTest();
await runSupervisedSettingsStatusWhitelistTest();
await runFailureDisposalTest();
await runMissingAccountHomeConfirmationTest();
await runTrustedSessionDisposalTest();
await runProfilePersistenceAndAuditRedactionTest();
await runBrowserResultMetadataAllowlistTest();
await runPostHomeProfileFailureRetentionTest();
await runProfilePersistenceFailureReturnsPartialTest();
await runMissingProfileResultReturnsPartialTest();
await runBrowserStageTerminalOutputTest();
await runWarningSanitizationTest();
await runEnvironmentWarningSanitizationTest();
await runReadyModeSanitizationTest();
await runCleanupErrorSanitizationTest();
await runPostLoginCollectorCleanupPartialTest();
await runMissingPostLoginFinalizationRemainsUnknownTest();
await runBrowserFinalizationPartialRetentionTest();
await runFinalizationFailureClassInvariantTest();
await runPostLoginRunnerPartialTest();
await runPostLoginRunnerPartialBoundaryTest();
await runFailureStageRetentionTest();
runAppleIdMaskingTest();
runBrowserFailureClassificationTest();
runFlowFailureEnvelopeTest();
runAccountBrowserCompletionSummaryTest();
runEnvDataParsingTest();
runSmsRuntimeEnvMergeTest();
runFlowReportPrivacyTest();
runFullFlowSourceContractTest();
runAccountManageSecurityCardDetectorTest();
runSupervisedCredentialConfirmationTest();
runReportRootOverrideTest();
runAcceptanceMarkerTest();
runAcceptanceMarkerFailureIsNonfatalTest();
runTwoFASidecarSettingsScreenshotSourceContractTest();

console.log("account browser flow lifecycle: ok");
