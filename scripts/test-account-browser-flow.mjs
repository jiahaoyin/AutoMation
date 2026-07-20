import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyBrowserRunFailure,
  readBrowserFailureCode,
  readBrowserFailureStage,
  runAccountBrowserPhase,
} from "./lib/account-browser-flow.js";
import { createFlowFailureEnvelope } from "./apple-id-full-flow.mjs";
import {
  loadEnvFile,
  maskAppleId,
  parseEnvValue,
  shouldAutoConfirmAppleCredentials,
} from "./lib/credentials.js";
import {
  resolveReportRoot,
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
    personalInfo: { fullName: "Test Person", birthday: null },
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

  assert.deepEqual(secrets, ["123456"]);
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
        entry.details.stage === "twofa_input"
    )
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
    browserPreserved: true,
    directBrowserPreservationRequested: false,
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

async function runMissingAccountHomeConfirmationTest() {
  const harness = createRuntime(async () => ({
    success: true,
    browserLogin: { success: true, backend: "ruyipage" },
    personalInfo: { fullName: "Test Person", birthday: null },
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
  const originalExternal = process.env[externalKey];
  const originalLoaded = process.env[loadedKey];
  try {
    fs.writeFileSync(
      envPath,
      `${externalKey}=from-file\n${loadedKey}="a\\\\b\\\"c # $HOME"\n`,
      "utf8"
    );
    process.env[externalKey] = "";
    delete process.env[loadedKey];
    process.chdir(tempDir);
    assert.equal(loadEnvFile(), envPath);
    assert.equal(process.env[externalKey], "");
    assert.equal(process.env[loadedKey], 'a\\b"c # $HOME');
  } finally {
    process.chdir(originalCwd);
    if (originalExternal === undefined) delete process.env[externalKey];
    else process.env[externalKey] = originalExternal;
    if (originalLoaded === undefined) delete process.env[loadedKey];
    else process.env[loadedKey] = originalLoaded;
    if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    fs.rmdirSync(tempDir);
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
    /import\s+\{\s*confirmOrPromptAppleCredentials,\s*maskAppleId\s*\}\s+from\s+"\.\/lib\/credentials\.js";/
  );
  assert.match(source, /report\.appleId\s*=\s*maskAppleId\(creds\.appleId\)/);
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
    runFullFlowSourceContractTest();
    runSupervisedCredentialConfirmationTest();
    runReportRootOverrideTest();
    runAcceptanceMarkerTest();
  },
  "ready-mode": runReadyModeSanitizationTest,
  "sidecar-screenshot": runTwoFASidecarSettingsScreenshotSourceContractTest,
  "collector-timeout": runCollectorTimeoutIsAlways240SecondsTest,
  "popup-primary": runProductionPopupPrimaryConfigurationTest,
  generations: runTwoGenerationForwardingTest,
  "flow-audit-forwarding": runFlowAuditForwardingTest,
  "twofa-handoff-failure": runTwoFactorHandoffFailureContextTest,
  "password-bidi-progress": runPasswordBidiInputProgressTest,
  "prepared-accessibility": runPreparedAccessibilityCheckDoesNotBlockBrowserTest,
  "status-prompts": runFixedTwoFactorStatusPromptsTest,
  "manual-unavailable-status": runSupervisedManualUnavailableStatusTest,
  "settings-status": runSupervisedSettingsStatusWhitelistTest,
  "failure-stage": runFailureStageRetentionTest,
  "failure-envelope": () => {
    runFlowFailureEnvelopeTest();
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
await runWarningSanitizationTest();
await runEnvironmentWarningSanitizationTest();
await runReadyModeSanitizationTest();
await runCleanupErrorSanitizationTest();
await runFailureStageRetentionTest();
runAppleIdMaskingTest();
runBrowserFailureClassificationTest();
runFlowFailureEnvelopeTest();
runEnvDataParsingTest();
runFullFlowSourceContractTest();
runSupervisedCredentialConfirmationTest();
runReportRootOverrideTest();
runAcceptanceMarkerTest();
runTwoFASidecarSettingsScreenshotSourceContractTest();

console.log("account browser flow lifecycle: ok");
