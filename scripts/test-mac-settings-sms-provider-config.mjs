import assert from "node:assert/strict";
import fs from "node:fs";
import {
  captureMacSettingsSmsRuntimeEnv,
  isMacSettingsSmsReconfigureRequested,
  promptForMacSettingsSmsProviderField,
  resolveMacSettingsSmsProviderConfig,
} from "./lib/mac-settings-sms-provider.js";
import {
  isMacSettingsSmsRuntimeEnabled,
  sanitizedMacSettingsChildEnv,
  waitForMacSettingsLoginComplete,
} from "./lib/mac-settings-login.js";
import { sanitizedAxFillChildEnv } from "./lib/mac-settings-ax-fill.js";

assert.equal(isMacSettingsSmsRuntimeEnabled({}), false);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_ENABLED: "1" }), true);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" }), true);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private" }), true);
assert.equal(
  isMacSettingsSmsRuntimeEnabled({
    APPLE_AUTOMATION_SMS_ENABLED: "0",
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
    APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
  }),
  false
);
assert.equal(isMacSettingsSmsRuntimeEnabled({ APPLE_AUTOMATION_SMS_RECONFIGURE: "1" }), true);
assert.equal(isMacSettingsSmsReconfigureRequested({ APPLE_AUTOMATION_SMS_RECONFIGURE: "1" }), true);
assert.equal(isMacSettingsSmsReconfigureRequested({ APPLE_AUTOMATION_SMS_RECONFIGURE: "0" }), false);
const secretEnvFixture = {
  PATH: "/test/bin",
  APPLE_AUTOMATION_SMS_ENABLED: "1",
  APPLE_AUTOMATION_SMS_RECONFIGURE: "1",
  APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
  APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
  APPLE_AUTOMATION_MANUAL_SMS_CODE: "123456",
  APPLE_SCRIPT_APPLE_ID: "fixture@example.test",
};
const capturedSmsEnv = captureMacSettingsSmsRuntimeEnv({ ...secretEnvFixture });
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_ENABLED, "1");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_RECONFIGURE, "1");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_PHONE, "+8613800130051");
assert.equal(capturedSmsEnv.APPLE_AUTOMATION_SMS_API_URL, "https://example.test/record?token=private");
const parentEnvFixture = { ...secretEnvFixture };
captureMacSettingsSmsRuntimeEnv(parentEnvFixture);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_PHONE"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_API_URL"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_MANUAL_SMS_CODE"), false);
assert.equal(Object.hasOwn(parentEnvFixture, "APPLE_AUTOMATION_SMS_RECONFIGURE"), false);
for (const sanitize of [sanitizedMacSettingsChildEnv, sanitizedAxFillChildEnv]) {
  const childEnv = sanitize(secretEnvFixture);
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(childEnv.APPLE_SCRIPT_APPLE_ID, "fixture@example.test");
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_SMS_PHONE"), false);
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_SMS_API_URL"), false);
  assert.equal(Object.hasOwn(childEnv, "APPLE_AUTOMATION_MANUAL_SMS_CODE"), false);
}
const config = await resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051", APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private" } });
assert.equal(config.phoneNumber, "+8613800130051");
assert.equal(config.source, "stored");
const prompted = await resolveMacSettingsSmsProviderConfig({ env: {}, prompt: async ({ field }) => field === "phone" ? "+8613800130051" : "https://example.test/record?token=private" });
assert.equal(prompted.phoneNumber, "+8613800130051");
assert.equal(prompted.source, "terminal");
const notices = [];
const retries = [];
const repaired = await resolveMacSettingsSmsProviderConfig({
  env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" },
  notify: (message) => notices.push(message),
  prompt: async ({ field, secret }) => {
    retries.push({ field, secret });
    return field === "phone" ? "+8613800130052" : "https://example.test/record?token=private";
  },
});
assert.equal(repaired.phoneNumber, "+8613800130052");
assert.equal(repaired.source, "terminal");
assert.deepEqual(retries, [
  { field: "phone", secret: false },
  { field: "apiUrl", secret: true },
]);
assert.equal(notices.length, 1);
const reconfigurePrompts = [];
const reconfigured = await resolveMacSettingsSmsProviderConfig({
  env: {
    APPLE_AUTOMATION_SMS_PHONE: "+8613800130051",
    APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private",
    APPLE_AUTOMATION_SMS_RECONFIGURE: "1",
  },
  notify: () => {},
  prompt: async ({ field, secret }) => {
    reconfigurePrompts.push({ field, secret });
    return field === "phone" ? "+8613800130053" : "https://example.test/new?token=private";
  },
});
assert.equal(reconfigured.phoneNumber, "+8613800130053");
assert.equal(reconfigured.source, "terminal");
assert.deepEqual(reconfigurePrompts, [
  { field: "phone", secret: false },
  { field: "apiUrl", secret: true },
]);
await assert.rejects(
  () => resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" } }),
  (error) => error?.code === "MAC_SETTINGS_SMS_TTY_REQUIRED"
);
assert.equal(await promptForMacSettingsSmsProviderField({ field: "phone", secret: false }), null, "non-TTY interactive config is rejected without emitting secrets");
let signedInChecks = 0;
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 100,
    intervalMs: 1,
    settleMs: 0,
    sleep: async () => {},
    isSignedIn: async () => {
      signedInChecks += 1;
      return true;
    },
  }),
  { signedIn: true }
);
assert.equal(signedInChecks, 2);
let finalizationSignedInChecks = 0;
let finalizationCalls = 0;
const initialPostSmsBinding = { axOwnerPid: 301, visualOwnerPid: 302, windowId: 303 };
const finalizationResults = [
  { status: "submitted", stage: "terms", binding: initialPostSmsBinding },
  { status: "not_required" },
];
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 3_000,
    intervalMs: 1,
    settleMs: 0,
    postSmsIntervalMs: 250,
    postSmsTransitionGraceMs: 300,
    sleep: async () => {},
    isSignedIn: async () => {
      finalizationSignedInChecks += 1;
      return finalizationCalls >= 2;
    },
    postSmsFinalization: async () => {
      finalizationCalls += 1;
      return finalizationResults.shift() ?? { status: "not_required" };
    },
  }),
  { signedIn: true }
);
assert.equal(finalizationCalls, 2);
let signedInWithModalCalls = 0;
let signedInWithModalStates = [
  { status: "submitted", stage: "terms", binding: initialPostSmsBinding },
  { status: "not_required" },
];
assert.deepEqual(
  await waitForMacSettingsLoginComplete({
    timeoutMs: 3_000,
    intervalMs: 1,
    settleMs: 0,
    postSmsIntervalMs: 250,
    postSmsTransitionGraceMs: 300,
    sleep: async () => {},
    isSignedIn: async () => true,
    postSmsFinalization: async () => {
      signedInWithModalCalls += 1;
      return signedInWithModalStates.shift() ?? { status: "not_required" };
    },
  }),
  { signedIn: true }
);
assert.equal(
  signedInWithModalCalls,
  2,
  "a signed-in probe must not skip a pending modal or the follow-up no-modal scan"
);

{
  const transitionGraceMs = 700;
  let postSmsCalls = 0;
  let submissionAt = 0;
  const probeOnlyStates = [];
  const signedInProbeTimes = [];

  assert.deepEqual(
    await waitForMacSettingsLoginComplete({
      timeoutMs: 2_000,
      intervalMs: 1,
      settleMs: 0,
      postSmsIntervalMs: 1,
      postSmsTransitionGraceMs: transitionGraceMs,
      sleep: async () => {},
      isSignedIn: async () => {
        signedInProbeTimes.push(Date.now());
        return true;
      },
      postSmsFinalization: async ({ probeOnly }) => {
        postSmsCalls += 1;
        probeOnlyStates.push(probeOnly);
        if (postSmsCalls === 1) {
          submissionAt = Date.now();
          return { status: "submitted", stage: "terms", binding: initialPostSmsBinding };
        }
        return { status: "not_required" };
      },
    }),
    { signedIn: true }
  );
  assert.equal(probeOnlyStates[0], false);
  assert.ok(
    probeOnlyStates.slice(1).some(Boolean),
    "a post-submit waiting observation must remain probe-only"
  );
  assert.ok(
    signedInProbeTimes[0] - submissionAt >= transitionGraceMs,
    "a transient no-modal observation must not release signed-in detection before transition grace"
  );
}

const postSmsTermsBinding = { axOwnerPid: 401, visualOwnerPid: 402, windowId: 403 };
const postSmsAlternateBinding = { axOwnerPid: 401, visualOwnerPid: 402, windowId: 404 };

{
  let postSmsCalls = 0;
  let actionCalls = 0;
  let manualCalls = 0;
  let signedInChecks = 0;
  const roundDecisions = [];
  const repeatedState = {
    ok: true,
    stage: "terms",
    digits: null,
    binding: postSmsTermsBinding,
  };

  assert.deepEqual(
    await waitForMacSettingsLoginComplete({
      timeoutMs: 2_500,
      intervalMs: 1,
      settleMs: 0,
      postSmsIntervalMs: 250,
      postSmsTransitionGraceMs: 1,
      sleep: async () => {},
      isSignedIn: async () => {
        signedInChecks += 1;
        return manualCalls === 1 && signedInChecks >= 2;
      },
      postSmsFinalization: async ({ beforeSubmit }) => {
        postSmsCalls += 1;
        const allowed = beforeSubmit(repeatedState);
        roundDecisions.push(allowed);
        if (allowed) {
          actionCalls += 1;
          return { status: "submitted", stage: "terms", binding: postSmsTermsBinding };
        }
        return { status: "manual_required", stage: "terms", binding: postSmsTermsBinding };
      },
      manualContinuation: async (context) => {
        manualCalls += 1;
        assert.equal(context.stage, "terms");
        assert.deepEqual(context.binding, postSmsTermsBinding);
        assert.equal(context.identity, "terms:401:402:403");
        return false;
      },
    }),
    { signedIn: true }
  );
  assert.equal(postSmsCalls, 4, "the fourth identical modal must be blocked before action");
  assert.equal(actionCalls, 3, "one stable stage/binding can receive at most three actions");
  assert.deepEqual(roundDecisions, [true, true, true, false]);
  assert.equal(manualCalls, 1, "a declined manual continuation remains suppressed");
  assert.ok(signedInChecks >= 2, "manual handling cannot itself be treated as signed-in success");
}

{
  const stages = [
    { stage: "terms", binding: postSmsTermsBinding },
    { stage: "terms", binding: postSmsTermsBinding },
    { stage: "terms", binding: postSmsTermsBinding },
    { stage: "location", binding: postSmsTermsBinding },
    { stage: "terms", binding: postSmsAlternateBinding },
  ];
  let postSmsCalls = 0;
  let actionCalls = 0;
  const roundDecisions = [];

  assert.deepEqual(
    await waitForMacSettingsLoginComplete({
      timeoutMs: 3_000,
      intervalMs: 1,
      settleMs: 0,
      postSmsIntervalMs: 250,
      postSmsTransitionGraceMs: 1,
      sleep: async () => {},
      isSignedIn: async () => actionCalls === stages.length && postSmsCalls > stages.length,
      postSmsFinalization: async ({ beforeSubmit }) => {
        postSmsCalls += 1;
        const current = stages[actionCalls];
        if (!current) return { status: "not_required" };
        const state = { ok: true, ...current, digits: null };
        const allowed = beforeSubmit(state);
        roundDecisions.push(allowed);
        assert.equal(
          allowed,
          true,
          "a changed stage or window binding must start a fresh three-round budget"
        );
        actionCalls += 1;
        return { status: "submitted", ...current };
      },
      manualContinuation: async () => {
        assert.fail("fresh stage/binding identities must not request manual handling");
      },
    }),
    { signedIn: true }
  );
  assert.equal(actionCalls, stages.length);
  assert.deepEqual(roundDecisions, [true, true, true, true, true]);
}

{
  let postSmsCalls = 0;
  let actionCalls = 0;
  let manualCalls = 0;
  let probeOnlyCalls = 0;
  const roundDecisions = [];
  const repeatedState = {
    ok: true,
    stage: "terms",
    digits: null,
    binding: postSmsTermsBinding,
  };

  assert.deepEqual(
    await waitForMacSettingsLoginComplete({
      timeoutMs: 6_000,
      intervalMs: 1,
      settleMs: 0,
      postSmsIntervalMs: 250,
      postSmsTransitionGraceMs: 300,
      sleep: async () => {},
      isSignedIn: async () => manualCalls === 1 && probeOnlyCalls >= 1,
      postSmsFinalization: async ({ beforeSubmit, probeOnly }) => {
        postSmsCalls += 1;
        if (probeOnly) {
          probeOnlyCalls += 1;
          return manualCalls === 0
            ? { status: "not_required" }
            : { status: "state_observed", stage: "terms", binding: postSmsTermsBinding };
        }
        if (manualCalls > 0) {
          // The test operator has completed the retained page. Once its
          // transition grace expires, the next ordinary scan sees no module.
          return { status: "not_required" };
        }
        const allowed = beforeSubmit(repeatedState);
        roundDecisions.push(allowed);
        if (allowed) {
          actionCalls += 1;
          return { status: "submitted", stage: "terms", binding: postSmsTermsBinding };
        }
        return { status: "manual_required", stage: "terms", binding: postSmsTermsBinding };
      },
      manualContinuation: async (context) => {
        manualCalls += 1;
        assert.equal(context.stage, "terms");
        assert.deepEqual(context.binding, postSmsTermsBinding);
        return true;
      },
    }),
    { signedIn: true }
  );
  assert.equal(manualCalls, 1);
  assert.ok(probeOnlyCalls >= 1, "manual confirmation must resume as probe-only observation");
  assert.equal(actionCalls, 3, "a confirmed manual handoff must not reset the blocked identity budget");
  assert.deepEqual(
    roundDecisions,
    [true, true, true, false],
    "the same stage/binding remains blocked after manual continuation until it advances"
  );
}

{
  let postSmsCalls = 0;
  let actionCalls = 0;
  const transitionEvents = [];
  const repeatedState = {
    ok: true,
    stage: "terms",
    digits: null,
    binding: postSmsTermsBinding,
  };

  assert.deepEqual(
    await waitForMacSettingsLoginComplete({
      timeoutMs: 2_000,
      intervalMs: 1,
      settleMs: 0,
      postSmsIntervalMs: 1,
      postSmsTransitionGraceMs: 1_000,
      isSignedIn: async () => postSmsCalls >= 4,
      onEvent: (event) => transitionEvents.push(event),
      postSmsFinalization: async ({ beforeSubmit, probeOnly }) => {
        postSmsCalls += 1;
        if (postSmsCalls === 1) {
          assert.equal(probeOnly, false);
          assert.equal(beforeSubmit(repeatedState), true);
          actionCalls += 1;
          return { status: "submitted", stage: "terms", binding: postSmsTermsBinding };
        }
        if (postSmsCalls === 2) {
          assert.equal(probeOnly, true);
          return { status: "retryable", reason: "state_probe_unavailable" };
        }
        if (postSmsCalls === 3) {
          assert.equal(probeOnly, true, "a transient unbound probe must keep the same grace window");
          return { status: "state_observed", stage: "terms", binding: postSmsTermsBinding };
        }
        assert.equal(probeOnly, true);
        return { status: "not_required" };
      },
    }),
    { signedIn: true }
  );
  assert.equal(actionCalls, 1, "the same terms page must not be submitted again after AX hydration blanks");
  assert.ok(
    transitionEvents.some(
      (event) => event.event === "post_sms_transition_waiting" && event.identity === "terms:401:402:403"
    ),
    "the retained transition identity must be observable in the audit stream"
  );
}

assert.doesNotMatch(fs.readFileSync(new URL("./lib/mac-settings-sms-ax.js", import.meta.url), "utf8"), /env\.APPLE_AUTOMATION_SMS_API_URL =/);
assert.match(fs.readFileSync(new URL("./lib/mac-settings-sms-provider.js", import.meta.url), "utf8"), /promptForSecretLine/);
const loginSource = fs.readFileSync(new URL("./lib/mac-settings-login.js", import.meta.url), "utf8");
assert.match(loginSource, /manualContinuation/);
assert.match(loginSource, /macSettingsPostSmsModuleIdentity/);
assert.match(loginSource, /allowManualContinuation: false/);
assert.match(loginSource, /sanitizedMacSettingsChildEnv\(\)/);
assert.match(loginSource, /clearMacSettingsSmsRuntimeSecrets\(\)/);
assert.match(loginSource, /saveMacSettingsSmsProviderConfig\(smsConfig\)/);
assert.match(loginSource, /postSmsFinalization:/);
assert.match(loginSource, /beforeSubmit/);
assert.doesNotMatch(loginSource, /scanTimeoutMs:\s*30_000/);
const runtimeScanTimeout = /scanTimeoutMs:\s*([0-9_]+)/.exec(loginSource);
assert.ok(runtimeScanTimeout, "the post-SMS runtime must configure a bounded state scan");
assert.ok(
  Number(runtimeScanTimeout[1].replaceAll("_", "")) <= 5_000,
  "the normal signed-in probe must use a bounded modal scan"
);
assert.match(loginSource, /const smsEnv = \{ \.\.\.process\.env, \.\.\.\(options\.smsEnv \?\? \{\}\) \};/);
assert.match(
  fs.readFileSync(new URL("./apple-id-full-flow.mjs", import.meta.url), "utf8"),
  /captureMacSettingsSmsRuntimeEnv\(\)/
);
assert.match(
  fs.readFileSync(new URL("./lib/mac-settings-ax-fill.js", import.meta.url), "utf8"),
  /sanitizedAxFillChildEnv\(\{ \.\.\.process\.env, \.\.\.\(opts\.env \?\? \{\}\) \}\)/
);
assert.match(
  fs.readFileSync(new URL("./lib/credentials.js", import.meta.url), "utf8"),
  /RUNTIME_ONLY_SMS_ENV_KEYS[\s\S]*?APPLE_AUTOMATION_MANUAL_SMS_CODE/
);
assert.doesNotMatch(
  fs.readFileSync(new URL("./lib/credentials.js", import.meta.url), "utf8").match(/RUNTIME_ONLY_SMS_ENV_KEYS[\s\S]*?\]\);/)?.[0] ?? "",
  /APPLE_AUTOMATION_SMS_API_URL/
);
assert.match(
  fs.readFileSync(new URL("../run.sh", import.meta.url), "utf8"),
  /unset APPLE_AUTOMATION_SMS_PHONE APPLE_AUTOMATION_SMS_API_URL APPLE_AUTOMATION_MANUAL_SMS_CODE/
);
assert.match(
  fs.readFileSync(new URL("./check-environment.mjs", import.meta.url), "utf8"),
  /loadEnvFile\(\);\s*captureMacSettingsSmsRuntimeEnv\(\);/
);
console.log("sms provider config: ok");
