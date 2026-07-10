import { strict as assert } from "node:assert";

import { runAccountBrowserPhase } from "./lib/account-browser-flow.js";

function createRuntime(runBackend) {
  const calls = [];
  let collectorCount = 0;
  const runtime = {
    getBrowserEnvironmentSummary() {
      return {
        backend: "ruyipage",
        backendReason: "test",
        warnings: [],
      };
    },
    async isAccessibilityGranted() {
      return true;
    },
    createRuyiPageBackendRunner() {
      return { run: runBackend };
    },
    createMac2FACollector() {
      collectorCount += 1;
      return {
        async prepare() {
          calls.push("prepare");
        },
        async getCode() {
          calls.push("getCode");
          return "123456";
        },
        async dispose() {
          calls.push("dispose");
        },
      };
    },
  };
  return {
    runtime,
    calls,
    get collectorCount() {
      return collectorCount;
    },
  };
}

const params = {
  creds: { appleId: "person@example.com", password: "secret" },
  reportDir: "data/reports/account-browser-flow-test",
};

async function runTwoFactorLifecycleTest() {
  const harness = createRuntime(async (options) => {
    await options.prepare2FA();
    assert.equal(await options.get2FACode(), "123456");
    return {
      success: true,
      browserLogin: { success: true, backend: "ruyipage" },
      personalInfo: { fullName: "Test Person", birthday: null },
      screenshots: {},
    };
  });

  const result = await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(harness.calls, ["prepare", "getCode", "dispose"]);
  assert.equal(harness.collectorCount, 1);
  assert.equal(result.browserLogin.backend, "ruyipage");
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
    success: true,
    browserLogin: {
      success: true,
      backend: "ruyipage",
      skippedLogin: true,
      skipped2FA: true,
    },
    personalInfo: { fullName: "Test Person", birthday: null },
    screenshots: {},
  }));

  await runAccountBrowserPhase(params, harness.runtime);
  assert.deepEqual(harness.calls, ["dispose"]);
  assert.equal(harness.collectorCount, 1);
}

await runTwoFactorLifecycleTest();
await runFailureDisposalTest();
await runTrustedSessionDisposalTest();

console.log("account browser flow lifecycle: ok");
