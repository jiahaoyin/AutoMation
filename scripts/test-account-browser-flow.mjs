import { strict as assert } from "node:assert";
import fs from "node:fs";

import { runAccountBrowserPhase } from "./lib/account-browser-flow.js";
import { maskAppleId } from "./lib/credentials.js";

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
    async isAccessibilityGranted() {
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
    get collectorCount() {
      return collectorCount;
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
    browserLogin: { success: true, backend: "ruyipage" },
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

async function runFixedTwoFactorStatusPromptsTest() {
  const harness = createRuntime(async () => {
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
    harness.emitStatus({ status: "manual_allow", remainingSec: 185 });
    harness.emitStatus({ status: "manual_code", source: "manual", remainingSec: 150 });
    harness.emitStatus({ status: "winner", source: "popup", remainingSec: 140 });
    harness.emitStatus({ status: "winner", source: "settings", remainingSec: 130 });
    harness.emitStatus({ status: "winner", source: "manual", remainingSec: 120 });
    harness.emitStatus({ status: "ocr_permission_missing", secret: SECRET_FIXTURE });
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
    "[2FA] 正在尝试通过系统设置获取验证码（第 2/2 次）...",
    "[2FA] 系统设置取码失败，5 秒后进行第 2/2 次尝试...",
    "[2FA] 自动点击「允许」未成功，请在 Mac 上手动点击「允许」；取码仍在继续。",
    "[2FA] 自动取码仍未完成，请在终端隐藏输入 Mac 上显示的 6 位验证码。",
    "[2FA] 已从 Apple 验证码弹窗取得验证码。",
    "[2FA] 已从系统设置取得验证码。",
    "[2FA] 已使用终端手动输入的验证码。",
    "[2FA] OCR 需要权限：系统设置 → 隐私与安全性 → 屏幕与系统音频录制；系统设置取码仍在工作。",
    "[2FA] 240 秒内未取得可用验证码。请确认 Mac 已登录同一 Apple ID、允许弹窗已处理，并检查系统设置取码与相关权限。",
  ]);
  assert.deepEqual(
    logs.filter((line) => !line.startsWith("[Firefox]") && !line.startsWith("[2FA]")),
    []
  );
  assert.equal(logs.some((line) => line.includes(SECRET_FIXTURE)), false);
}

async function runFailureDisposalTest() {
  const harness = createRuntime(async (options) => {
    await options.prepare2FA();
    throw new Error("backend failed");
  });

  await assert.rejects(
    runAccountBrowserPhase(params, harness.runtime),
    /backend failed/
  );
  assert.deepEqual(harness.calls, ["prepare", "dispose"]);
  assert.equal(harness.collectorCount, 1);
}

async function runTrustedSessionDisposalTest() {
  const harness = createRuntime(async () => ({
    ...successfulResult(),
    browserLogin: {
      success: true,
      backend: "ruyipage",
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
    return successfulResult();
  });

  const logs = await captureConsole("log", () =>
    runAccountBrowserPhase(params, harness.runtime)
  );
  const readyLogs = logs.filter((line) => line.includes("[ruyipage]"));
  assert.deepEqual(
    {
      count: readyLogs.length,
      mappedUnknownCount: readyLogs.filter((line) => line.endsWith("(browser)")).length,
      preservedKnown: readyLogs.some((line) => line.endsWith("(ruyipage-only)")),
      leaked: logs.some((line) => line.includes(READY_MODE_SECRET)),
    },
    { count: 4, mappedUnknownCount: 3, preservedKnown: true, leaked: false }
  );
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

function runFullFlowSourceContractTest() {
  const source = fs.readFileSync(
    new URL("./apple-id-full-flow.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /import\s+\{\s*confirmOrPromptAppleCredentials,\s*maskAppleId\s*\}\s+from\s+"\.\/lib\/credentials\.js";/
  );
  assert.match(source, /appleId:\s*maskAppleId\(creds\.appleId\)/);
  assert.doesNotMatch(source, /creds\.appleId\.replace\(/);
  assert.match(source, /report\.error\s*=\s*"Apple ID flow failed"/);
  assert.doesNotMatch(source, /e\.message|String\(e\)/);
  assert.match(source, /process\.exitCode\s*=\s*1/);
  assert.doesNotMatch(source, /process\.exit\(1\)/);
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
    runFullFlowSourceContractTest();
  },
  "ready-mode": runReadyModeSanitizationTest,
  "sidecar-screenshot": runTwoFASidecarSettingsScreenshotSourceContractTest,
  generations: runTwoGenerationForwardingTest,
  "status-prompts": runFixedTwoFactorStatusPromptsTest,
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
await runTwoGenerationForwardingTest();
await runFixedTwoFactorStatusPromptsTest();
await runFailureDisposalTest();
await runTrustedSessionDisposalTest();
await runWarningSanitizationTest();
await runEnvironmentWarningSanitizationTest();
await runReadyModeSanitizationTest();
await runCleanupErrorSanitizationTest();
runAppleIdMaskingTest();
runFullFlowSourceContractTest();
runTwoFASidecarSettingsScreenshotSourceContractTest();

console.log("account browser flow lifecycle: ok");
