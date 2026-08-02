import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeSupervisedMacSettingsSmsVerification,
  normalizeMacSettingsSmsState,
  normalizeManualSmsCode,
  trustedPhoneSuffix,
} from "./lib/mac-settings-sms-verification.js";
import {
  isTrustedMacSettingsSmsHelperOverride,
  sanitizeMacSettingsSmsNativeResult,
} from "./lib/mac-settings-sms-ax.js";

async function expectCode(code, callback) {
  await assert.rejects(callback, (error) => error?.code === code);
}

async function expectFixedCode(code, callback, forbiddenText) {
  await assert.rejects(callback, (error) => {
    assert.equal(error?.code, code);
    assert.doesNotMatch(String(error?.message ?? ""), forbiddenText);
    return true;
  });
}

function baseOptions(overrides = {}) {
  return {
    phoneNumber: "+86 138-0013-0051",
    platform: "darwin",
    supervised: true,
    isTTY: true,
    timeoutMs: 1_000,
    manualContinuationGraceMs: 50,
    pollIntervalMs: 1,
    sleep: async () => {},
    ...overrides,
  };
}

function createSequenceRunner(states, results = {}) {
  const calls = [];
  let stateIndex = 0;
  return {
    calls,
    async runner(phase, options) {
      calls.push({ phase, ...options });
      if (phase === "sms-state") {
        return states[Math.min(stateIndex++, states.length - 1)];
      }
      return results[phase] ?? { ok: true };
    },
  };
}

assert.equal(trustedPhoneSuffix("+86 138-0013-0051"), "51");
assert.equal(trustedPhoneSuffix(" 0046 "), "46");
assert.throws(() => trustedPhoneSuffix("x"), /MAC_SETTINGS_SMS_PHONE_INVALID/);
assert.throws(() => trustedPhoneSuffix("51"), /MAC_SETTINGS_SMS_PHONE_INVALID/);
assert.throws(() => trustedPhoneSuffix("abc1234"), /MAC_SETTINGS_SMS_PHONE_INVALID/);
assert.equal(normalizeManualSmsCode("123456"), "123456");
assert.equal(normalizeManualSmsCode(" 123456 "), "123456");
assert.equal(normalizeManualSmsCode("12 3456"), null);
assert.equal(normalizeManualSmsCode("12345"), null);
assert.deepEqual(normalizeMacSettingsSmsState({ ok: true, stage: "phone_selection" }), {
  ok: true,
  stage: "phone_selection",
});
assert.deepEqual(normalizeMacSettingsSmsState({ ok: true, stage: "unexpected" }), {
  ok: true,
  stage: "invalid",
});
assert.deepEqual(normalizeMacSettingsSmsState({ ok: false, stage: "code_entry" }), {
  ok: false,
  stage: "invalid",
});
assert.deepEqual(
  normalizeMacSettingsSmsState({
    ok: true,
    stage: "waiting",
    reason: "no_trusted_surface",
    secret: "must-not-leak",
  }),
  { ok: true, stage: "waiting", reason: "no_trusted_surface" }
);
assert.deepEqual(
  normalizeMacSettingsSmsState({ ok: true, stage: "waiting", reason: "secret" }),
  { ok: true, stage: "waiting" }
);
assert.deepEqual(sanitizeMacSettingsSmsNativeResult("sms-state", { ok: true, stage: "waiting" }), {
  ok: true,
  stage: "waiting",
});
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-state", {
    ok: true,
    stage: "waiting",
    reason: "no_trusted_surface",
  }),
  { ok: true, stage: "waiting", reason: "no_trusted_surface" }
);
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-state", {
    ok: true,
    stage: "code_entry",
    reason: "code_value_unreadable",
  }),
  { ok: true, stage: "code_entry", reason: "code_value_unreadable" }
);
assert.deepEqual(sanitizeMacSettingsSmsNativeResult("sms-select", { ok: true, stage: "selected" }), {
  ok: true,
  stage: "selected",
});
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-select", { ok: true, stage: "code_submitted" }),
  { ok: false, stage: "invalid", reason: "invalid" }
);
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-code", { ok: true, stage: "continued" }),
  { ok: false, stage: "invalid", reason: "invalid" }
);

{
  const home = "C:\\Users\\sms-supervised-test";
  const helperDirectory = `${home}\\.apple-automation\\supervised-helpers`;
  const helperPath = `${helperDirectory}\\mac-settings-sms-verification`;
  const stat = (kind, mode = 0o700) => ({
    mode,
    uid: 501,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  });
  const trustedFs = {
    lstatSync(target) {
      if (target === helperDirectory) return stat("directory");
      if (target === helperPath) return stat("file", 0o500);
      throw new Error("unknown path");
    },
    realpathSync(target) {
      return target;
    },
  };
  const trustedEnv = {
    HOME: home,
    APPLE_AUTOMATION_HELPER_DIR: helperDirectory,
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: "0123456789abcdef0123456789abcdef",
  };
  assert.equal(
    isTrustedMacSettingsSmsHelperOverride(trustedEnv, { fs: trustedFs, getuid: () => 501 }),
    true
  );
  assert.equal(
    isTrustedMacSettingsSmsHelperOverride(
      { ...trustedEnv, APPLE_AUTOMATION_SUPERVISED_GUI: "0" },
      { fs: trustedFs, getuid: () => 501 }
    ),
    false
  );
  assert.equal(
    isTrustedMacSettingsSmsHelperOverride(
      { ...trustedEnv, APPLE_AUTOMATION_HELPER_DIR: `${home}\\tmp` },
      { fs: trustedFs, getuid: () => 501 }
    ),
    false
  );
  const writableFs = {
    ...trustedFs,
    lstatSync(target) {
      if (target === helperDirectory) return stat("directory", 0o777);
      return trustedFs.lstatSync(target);
    },
  };
  assert.equal(
    isTrustedMacSettingsSmsHelperOverride(trustedEnv, { fs: writableFs, getuid: () => 501 }),
    false
  );
}

await expectCode("MAC_SETTINGS_SMS_UNSUPPORTED_PLATFORM", () =>
  completeSupervisedMacSettingsSmsVerification(
    baseOptions({ platform: "win32", nativeRunner: async () => ({ ok: true, stage: "waiting" }) })
  )
);
await expectCode("MAC_SETTINGS_SMS_SUPERVISION_REQUIRED", () =>
  completeSupervisedMacSettingsSmsVerification(
    baseOptions({ supervised: false, nativeRunner: async () => ({ ok: true, stage: "waiting" }) })
  )
);
await expectCode("MAC_SETTINGS_SMS_TTY_REQUIRED", () =>
  completeSupervisedMacSettingsSmsVerification(
    baseOptions({ isTTY: false, nativeRunner: async () => ({ ok: true, stage: "waiting" }) })
  )
);
await expectCode("MAC_SETTINGS_SMS_TIMEOUT_INVALID", () =>
  completeSupervisedMacSettingsSmsVerification(
    baseOptions({ timeoutMs: 0, nativeRunner: async () => ({ ok: true, stage: "waiting" }) })
  )
);
await expectCode("MAC_SETTINGS_SMS_POLL_INTERVAL_INVALID", () =>
  completeSupervisedMacSettingsSmsVerification(
    baseOptions({ pollIntervalMs: 0, nativeRunner: async () => ({ ok: true, stage: "waiting" }) })
  )
);

{
  const sequence = createSequenceRunner([
    { ok: true, stage: "phone_selection" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_pending" },
    { ok: true, stage: "waiting" },
    { ok: true, stage: "waiting" },
  ]);
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: sequence.runner,
      manualCodeProvider: async () => "123456",
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(
    sequence.calls.map(({ phase }) => phase),
    [
      "sms-state",
      "sms-select",
      "sms-continue",
      "sms-state",
      "sms-state",
      "sms-code",
      "sms-state",
      "sms-state",
      "sms-state",
    ]
  );
  assert.equal(sequence.calls[1].suffix, "51");
  const codeCall = sequence.calls.find(({ phase }) => phase === "sms-code");
  assert.ok(codeCall, "the six-cell code page must be written only after stable detection");
  assert.equal(codeCall.suffix, "51");
  assert.equal(codeCall.code, "123456");
}

{
  const sequence = createSequenceRunner([
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_pending" },
    { ok: true, stage: "waiting" },
    { ok: true, stage: "waiting" },
  ]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: sequence.runner,
      manualCodeProvider: async () => "654321",
    })
  );
  assert.deepEqual(
    sequence.calls.map(({ phase }) => phase),
    ["sms-state", "sms-state", "sms-code", "sms-state", "sms-state", "sms-state"],
    "a single trusted phone reaches the code page without a selection action"
  );
}

await expectCode("MAC_SETTINGS_SMS_PHONE_NOT_MATCHED", async () => {
  const sequence = createSequenceRunner([{ ok: true, stage: "phone_selection" }], {
    "sms-select": { ok: false },
  });
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({ nativeRunner: sequence.runner, manualCodeProvider: async () => "123456" })
  );
  assert.deepEqual(sequence.calls.map(({ phase }) => phase), ["sms-state", "sms-select"]);
});

await expectCode("MAC_SETTINGS_SMS_MANUAL_CODE_INVALID", async () => {
  const sequence = createSequenceRunner([{ ok: true, stage: "code_entry" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({ nativeRunner: sequence.runner, manualCodeProvider: async () => "not-a-code" })
  );
  assert.deepEqual(sequence.calls.map(({ phase }) => phase), ["sms-state"]);
});

await expectFixedCode(
  "MAC_SETTINGS_SMS_MANUAL_CODE_INVALID",
  async () => {
    const sequence = createSequenceRunner([{ ok: true, stage: "code_entry" }]);
    await completeSupervisedMacSettingsSmsVerification(
      baseOptions({
        nativeRunner: sequence.runner,
        manualCodeProvider: async () => {
          throw new Error("SENTINEL-OTP-123456");
        },
      })
    );
  },
  /SENTINEL-OTP-123456/
);

await expectCode("MAC_SETTINGS_SMS_TIMEOUT", async () => {
  const sequence = createSequenceRunner([{ ok: true, stage: "code_entry" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 25,
      nativeRunner: sequence.runner,
      manualCodeProvider: async () => new Promise(() => {}),
    })
  );
  assert.deepEqual(sequence.calls.map(({ phase }) => phase), ["sms-state"]);
});

// A native `waiting` reply is a valid short transition state, but a live page
// that remains unclassified must eventually enter the supervised handoff
// instead of silently polling until the overall SMS deadline.
{
  let clock = 0;
  let manualContext = null;
  let manualConfirmed = false;
  let codeWritten = false;
  const progress = [];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      surfaceUnreadyGraceMs: 20,
      stableCodeEntryReads: 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async (phase) => {
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        if (!manualConfirmed) return { ok: true, stage: "waiting" };
        if (!codeWritten) return { ok: true, stage: "code_entry" };
        return { ok: true, stage: "waiting" };
      },
      codeProvider: async () => "135790",
      manualContinuation: async (context) => {
        manualContext = context;
        manualConfirmed = true;
        return true;
      },
      onProgress: (event) => progress.push(event),
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.equal(manualContext?.module, "sms");
  assert.equal(manualContext?.stage, "surface_unavailable");
  assert.equal(manualContext?.reason, "state_waiting");
  assert.ok(manualContext?.attempts >= 2);
  assert.ok(
    progress.some(({ event }) => event === "waiting_for_sms_surface" || event === "sms_surface_loading")
  );
  assert.ok(progress.some(({ event }) => event === "manual_required"));
  assert.ok(progress.some(({ event }) => event === "code_entry_detected"));
}

// The six-cell page is mandatory. A surface-level manual acknowledgement may
// recover the dynamic UI, but persistent non-code observations must not skip
// directly into post-SMS or start provider polling before `code_entry` exists.
await expectCode("MAC_SETTINGS_SMS_TIMEOUT", async () => {
  let clock = 0;
  let manualContext = null;
  let providerCalls = 0;
  const calls = [];
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 25,
      pollIntervalMs: 5,
      surfaceUnreadyGraceMs: 1,
      stateReadAttempts: 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async (phase) => {
        calls.push(phase);
        return { ok: true, stage: "waiting" };
      },
      codeProvider: async () => {
        providerCalls += 1;
        return "135790";
      },
      manualContinuation: async (context) => {
        manualContext = context;
        return true;
      },
    })
  );
  assert.deepEqual(manualContext, {
    module: "sms",
    stage: "surface_unavailable",
    reason: "state_waiting",
    attempts: 2,
  });
  assert.equal(providerCalls, 0);
  assert.equal(calls.includes("sms-code"), false);
});

// A populated six-cell page may still be validating when the original overall
// deadline expires.  A supervised manual handoff extends observation only; two
// independent waiting reads are still required before post-SMS can begin.
{
  let clock = 0;
  let codeWritten = false;
  let manualCalls = 0;
  const calls = [];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 20,
      codeTransitionGraceMs: 1_000,
      manualContinuationGraceMs: 100,
      pollIntervalMs: 5,
      stateReadAttempts: 1,
      stableCodeEntryReads: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        if (!codeWritten) return { ok: true, stage: "code_entry" };
        if (manualCalls === 0) return { ok: true, stage: "code_pending" };
        return { ok: true, stage: "waiting" };
      },
      manualCodeProvider: async () => "246810",
      manualContinuation: async (context) => {
        manualCalls += 1;
        assert.deepEqual(context, {
          module: "sms",
          stage: "code_entry",
          reason: "timeout",
          attempts: 1,
        });
        return true;
      },
    })
  );
  assert.deepEqual(result, { status: "manual_completed", stage: "code_entry" });
  assert.equal(manualCalls, 1);
  assert.equal(calls.filter((phase) => phase === "sms-code").length, 1);
}

await expectCode("MAC_SETTINGS_SMS_STATE_UNAVAILABLE", async () => {
  let clock = 0;
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      surfaceUnreadyGraceMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async () => ({ ok: false }),
    })
  );
});

await expectCode("MAC_SETTINGS_SMS_STATE_UNAVAILABLE", async () => {
  let clock = 0;
  const sequence = createSequenceRunner([{ ok: true, stage: "unexpected" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      surfaceUnreadyGraceMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: sequence.runner,
    })
  );
  assert.deepEqual(sequence.calls.map(({ phase }) => phase), ["sms-state"]);
});

await expectCode("MAC_SETTINGS_SMS_TIMEOUT", async () => {
  let clock = 0;
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 100,
      pollIntervalMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      nativeRunner: async () => ({ ok: true, stage: "waiting" }),
    })
  );
});

await expectCode("MAC_SETTINGS_SMS_TIMEOUT", async () => {
  let clock = 0;
  const sequence = createSequenceRunner([{ ok: true, stage: "code_entry" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 100,
      now: () => clock,
      nativeRunner: sequence.runner,
      manualCodeProvider: async () => {
        clock = 100;
        return "123456";
      },
    })
  );
  assert.deepEqual(sequence.calls.map(({ phase }) => phase), ["sms-state"]);
});

await expectCode("MAC_SETTINGS_SMS_TIMEOUT", async () => {
  let clock = 0;
  const calls = [];
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 100,
      now: () => clock,
      nativeRunner: async (phase, options) => {
        calls.push({ phase, ...options });
        if (phase === "sms-state") return { ok: true, stage: "code_entry" };
        if (phase === "sms-code") {
          clock = 101;
          return { ok: true };
        }
        return { ok: false };
      },
      manualCodeProvider: async () => "123456",
    })
  );
  assert.deepEqual(calls.map(({ phase }) => phase), ["sms-state", "sms-code"]);
});

// The AX surface can be temporarily absent while System Settings hydrates.
// `waiting` is a valid transient state, not a failure, and the mandatory code
// page must still be discovered before the provider is polled.
{
  const sequence = createSequenceRunner([
    { ok: true, stage: "waiting" },
    { ok: true, stage: "waiting" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_pending" },
    { ok: true, stage: "waiting" },
    { ok: true, stage: "waiting" },
  ]);
  const progress = [];
  let providerObservedAfterStateReads = null;
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: sequence.runner,
      codeProvider: async () => {
        providerObservedAfterStateReads = sequence.calls.filter(
          ({ phase }) => phase === "sms-state"
        ).length;
        return "246810";
      },
      manualCodeProvider: async () => {
        throw new Error("provider code must be used after the stable six-cell page");
      },
      onProgress: (event) => progress.push(event),
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.equal(
    providerObservedAfterStateReads,
    4,
    "provider polling must wait for two consecutive code-entry reads, after the transient waiting probes"
  );
  assert.deepEqual(
    sequence.calls.map(({ phase }) => phase),
    [
      "sms-state",
      "sms-state",
      "sms-state",
      "sms-state",
      "sms-code",
      "sms-state",
      "sms-state",
      "sms-state",
    ]
  );
  assert.deepEqual(
    progress.map(({ event }) => event),
    ["waiting_for_sms_surface", "sms_surface_loading", "code_entry_detected", "code_polling_started", "code_written", "code_transition_waiting", "code_transition_observed"]
  );
}

// Three transient invalid probes are tolerated inside one read window; a
// loading race must not turn into an early SMS_STATE_UNAVAILABLE failure.
{
  let stateReads = 0;
  let codeWritten = false;
  const calls = [];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        if (phase !== "sms-state") return { ok: true, stage: "code_submitted" };
        stateReads += 1;
        if (codeWritten) {
          return stateReads === 6 ? { ok: true, stage: "code_pending" } : { ok: true, stage: "waiting" };
        }
        return stateReads < 3 ? { ok: false } : { ok: true, stage: "code_entry" };
      },
      manualCodeProvider: async () => "135790",
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(calls, [
    "sms-state",
    "sms-state",
    "sms-state",
    "sms-state",
    "sms-state",
    "sms-code",
    "sms-state",
    "sms-state",
    "sms-state",
  ]);
}

// A phone-selection action is bounded to three attempts. After Enter, the
// coordinator must keep scanning until the mandatory six-cell page appears;
// it must not return to post-SMS after manual phone selection alone.
{
  const calls = [];
  const progress = [];
  let manualContext = null;
  let manualConfirmed = false;
  let codeWritten = false;
  let postCodeStateReads = 0;
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-state") {
          if (manualConfirmed && codeWritten) {
            postCodeStateReads += 1;
            return postCodeStateReads === 1
              ? { ok: true, stage: "code_pending" }
              : { ok: true, stage: "waiting" };
          }
          return manualConfirmed
            ? { ok: true, stage: "code_entry" }
            : { ok: true, stage: "phone_selection" };
        }
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        return { ok: false };
      },
      actionRetryDelayMs: 1,
      phoneTransitionGraceMs: 5,
      onProgress: (event) => progress.push(event),
      manualContinuation: async (context) => {
        manualContext = context;
        manualConfirmed = true;
        return true;
      },
      manualCodeProvider: async () => "123456",
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.equal(calls.filter((phase) => phase === "sms-select").length, 3);
  assert.equal(calls.filter((phase) => phase === "sms-continue").length, 0);
  assert.equal(calls.filter((phase) => phase === "sms-code").length, 1);
  assert.deepEqual(manualContext, {
    module: "sms",
    stage: "phone_selection",
    reason: "action_attempt_limit",
    attempts: 3,
  });
  assert.ok(progress.some(({ event }) => event === "manual_required"));
}

// If the helper loses its reply during a slow final-cell transition, a still
// visible empty code page is retried with the same verified code, at most three
// times. The provider itself is polled only once for that code.
{
  const calls = [];
  let codeProviderCalls = 0;
  let codeWrites = 0;
  let postSuccessStateReads = 0;
  const states = [
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_entry" },
    { ok: true, stage: "code_entry" },
  ];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-state") {
          if (codeWrites >= 3) {
            postSuccessStateReads += 1;
            return postSuccessStateReads === 1
              ? { ok: true, stage: "code_pending" }
              : { ok: true, stage: "waiting" };
          }
          return states.shift() ?? { ok: true, stage: "code_entry" };
        }
        if (phase === "sms-code") {
          codeWrites += 1;
          return codeWrites === 3 ? { ok: true, stage: "code_submitted" } : { ok: false };
        }
        return { ok: false };
      },
      codeProvider: async () => {
        codeProviderCalls += 1;
        return "112233";
      },
      actionRetryDelayMs: 1,
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.equal(codeProviderCalls, 1);
  assert.equal(codeWrites, 3);
  // Every retry re-probes the stable six-cell surface before and after the
  // write.  The exact interleaving is an implementation detail; the hard
  // contract is stable probing around every write plus the final populated
  // code page and two transition observations, with no fourth write.
  assert.ok(calls.filter((phase) => phase === "sms-state").length >= 10);
  assert.equal(calls.filter((phase) => phase === "sms-code").length, 3);
  assert.equal(calls.at(-1), "sms-state");
}

// A code page that stays live after all bounded writes is handed to the
// operator. After manual entry, the next stable waiting state is required;
// Enter itself never counts as a submitted code and no fourth write occurs.
{
  const calls = [];
  let providerCalls = 0;
  let manualContext = null;
  let manualConfirmed = false;
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-state") {
          return manualConfirmed
            ? { ok: true, stage: "waiting" }
            : { ok: true, stage: "code_entry" };
        }
        return { ok: false };
      },
      codeProvider: async () => {
        providerCalls += 1;
        return "445566";
      },
      actionRetryDelayMs: 1,
      manualContinuation: async (context) => {
        manualContext = context;
        manualConfirmed = true;
        return true;
      },
    })
  );
  assert.deepEqual(result, { status: "manual_completed", stage: "code_entry" });
  assert.equal(providerCalls, 1);
  assert.equal(calls.filter((phase) => phase === "sms-code").length, 3);
  assert.deepEqual(manualContext, {
    module: "sms",
    stage: "code_entry",
    reason: "action_attempt_limit",
    attempts: 3,
  });
}

// If AXValue remains unavailable after a native write, the page is not a fresh
// empty form. Give the transition grace window once, then hand off without a
// second automatic write.
{
  let clock = 0;
  let codeWritten = false;
  let manualContext = null;
  let manualCalls = 0;
  let postHandoffCodeReads = 0;
  const calls = [];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 1_000,
      pollIntervalMs: 5,
      stateReadAttempts: 1,
      stableCodeEntryReads: 1,
      codeTransitionGraceMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async (phase) => {
        calls.push(phase);
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        if (!codeWritten) {
          return { ok: true, stage: "code_entry", reason: "code_value_unreadable" };
        }
        if (manualCalls === 0) {
          return { ok: true, stage: "code_entry", reason: "code_value_unreadable" };
        }
        postHandoffCodeReads += 1;
        if (postHandoffCodeReads <= 2) {
          return { ok: true, stage: "code_entry", reason: "code_value_unreadable" };
        }
        return { ok: true, stage: "waiting" };
      },
      codeProvider: async () => "135790",
      manualContinuation: async (context) => {
        manualCalls += 1;
        manualContext = context;
        return true;
      },
    })
  );
  assert.deepEqual(result, { status: "manual_completed", stage: "code_entry" });
  assert.equal(manualContext?.reason, "code_value_unreadable");
  assert.equal(manualCalls, 1);
  assert.equal(calls.filter((phase) => phase === "sms-code").length, 1);
}

const source = fs.readFileSync(
  new URL("./lib/mac-settings-sms-verification.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(source, /\bfetch\s*\(/);
assert.doesNotMatch(source, /https?:\/\//i);
assert.doesNotMatch(source, /smsrecord|smsapi|lixsms|xsd20vip/i);
assert.match(source, /manual-verification-prompt/);
assert.doesNotMatch(source, /manual-2fa-prompt/);

const swiftSourceUrl = new URL(
  "./swift/mac-settings-sms-verification.swift",
  import.meta.url
);
const swiftSourcePath = fileURLToPath(swiftSourceUrl);
const swiftSource = fs.readFileSync(swiftSourceUrl, "utf8");
if (process.platform === "darwin") {
  const typecheck = spawnSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      path.join(os.tmpdir(), "apple-automation-swift-module-cache"),
      "-typecheck",
      swiftSourcePath,
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  assert.equal(
    typecheck.status,
    0,
    typecheck.stderr || typecheck.stdout || typecheck.error?.message
  );
}

// A dynamically hydrated Settings page can stay AX-blank across multiple
// complete probe windows.  The mandatory six-cell page must still be awaited;
// provider polling cannot begin and a manual handoff cannot be requested just
// because a short diagnostic threshold was crossed.
{
  let clock = 0;
  let stateReads = 0;
  let codeWritten = false;
  let providerObservedAfterStateReads = null;
  const progress = [];
  const result = await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      timeoutMs: 1_000,
      pollIntervalMs: 5,
      stateReadAttempts: 2,
      maxStateFailureWindows: 2,
      surfaceUnreadyGraceMs: 300,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async (phase) => {
        if (phase === "sms-code") {
          codeWritten = true;
          return { ok: true, stage: "code_submitted" };
        }
        stateReads += 1;
        if (!codeWritten) {
          if (stateReads <= 3) return { ok: false };
          return { ok: true, stage: "code_entry" };
        }
        if (stateReads === 7) return { ok: true, stage: "code_pending" };
        return { ok: true, stage: "waiting" };
      },
      codeProvider: async () => {
        providerObservedAfterStateReads = stateReads;
        return "864209";
      },
      manualCodeProvider: async () => {
        throw new Error("provider polling must wait for the stable six-cell page");
      },
      onProgress: (event) => progress.push(event),
    })
  );
  assert.deepEqual(result, { status: "submitted" });
  assert.equal(
    providerObservedAfterStateReads,
    6,
    "provider polling begins only after the two stable code-entry observations"
  );
  assert.ok(
    progress.some(({ event }) => event === "sms_surface_loading"),
    "extended dynamic loading must be observable without forcing a manual handoff"
  );
  assert.equal(
    progress.some(({ event }) => event === "manual_required"),
    false,
    "a short AX blank before the mandatory code page must not enter manual mode"
  );
}
assert.match(swiftSource, /CFGetTypeID\(positionValue\) == AXValueGetTypeID\(\)/);
assert.match(swiftSource, /CFGetTypeID\(sizeValue\) == AXValueGetTypeID\(\)/);
assert.doesNotMatch(swiftSource, /as\?\s+AXValue/);
assert.match(swiftSource, /case "sms-state"/);
assert.match(swiftSource, /case "sms-select"/);
assert.match(swiftSource, /case "sms-continue"/);
assert.match(swiftSource, /case "sms-code"/);
assert.match(swiftSource, /AppleIDSettings\.appex/);
assert.match(swiftSource, /AccountsSettingsExtension\.appex/);
assert.match(swiftSource, /isTrustedAppleIDSettingsExtension/);
assert.match(
  swiftSource,
  /if roots\.isEmpty, let surface = activeSurfaceRoot\(appElement, pid: pid\)/
);
assert.doesNotMatch(
  swiftSource,
  /private func visibleNodes[\s\S]*?queue\.append\(contentsOf: axSheets\(node\)\)/
);
assert.match(
  swiftSource,
  /if stableCodeCandidates\.count == 1,\s*phoneSnapshots\.isEmpty/
);
assert.match(swiftSource, /phoneSnapshots\.count == 1,[\s\n]+populatedCodeCandidates\.isEmpty/);
assert.match(swiftSource, /private let nativePhoneControlRoles/);
assert.match(swiftSource, /private let wrappedPhoneControlRoles/);
assert.match(swiftSource, /private func hasNestedPhoneControl/);
assert.match(swiftSource, /private func activeTrustedSettingsApplications/);
assert.match(swiftSource, /let allowedPIDs = Set\(applications\.map\(\\\.processIdentifier\)\)/);
assert.match(swiftSource, /var surfaceRoots: \[AXUIElement\] = \[\]/);
assert.match(swiftSource, /visibleNodes\(in: \[root\], allowedPIDs: allowedPIDs\)/);
assert.doesNotMatch(swiftSource, /visibleNodes\(in: roots, allowedPIDs: allowedPIDs\)/);
assert.match(swiftSource, /var seenNodes: \[AXUIElement\] = \[\]/);
assert.match(
  swiftSource,
  /guard !seenNodes\.contains\(where: \{ \$0 == node \}\) else \{ return false \}[\s\S]*?seenNodes\.append\(node\)/
);
assert.match(swiftSource, /private func rowTextsForPhoneControl/);
assert.doesNotMatch(swiftSource, /"AXStaticText"|"AXGroup"/);
assert.match(swiftSource, /let entries = matchingCodeEntries\(suffix: suffix\)/);
assert.match(
  swiftSource,
  /let populatedCodeCandidates = matchingCodeEntries\(suffix: suffix, requireEmpty: false\)/
);
assert.match(swiftSource, /emit\(true, "code_pending"\)/);
assert.match(swiftSource, /private func isSixCellCodeEntry\(_ entry: CodeEntry\) -> Bool/);
assert.match(swiftSource, /let fallbackCandidates = candidates\.filter \{ isSixCellCodeEntry\(\$0\.1\) \}/);
assert.match(swiftSource, /sixCellCandidates\.isEmpty/);
assert.match(swiftSource, /matches\.count == 1/);
assert.match(swiftSource, /axBool\(element, kAXEnabledAttribute as String\) != false/);
assert.match(swiftSource, /private let phoneMarkers = \[/);
assert.match(swiftSource, /phoneMarkers\.contains/);
assert.doesNotMatch(swiftSource, /fields\.count == 1/);
assert.match(swiftSource, /fields\.count == 6/);
assert.doesNotMatch(swiftSource, /fields\.count == 1, isSemanticCodeField\(fields\[0\]\) \|\|/);
assert.doesNotMatch(swiftSource, /private func hasCodeContext/);
assert.match(swiftSource, /private func sixCellFieldGroups/);
assert.match(swiftSource, /private func fieldGroups/);
assert.match(swiftSource, /ancestor\(of: field, distance: sharedAncestorDistance\)/);
assert.match(swiftSource, /for distance in 2\.\.\.3/);
assert.match(swiftSource, /\$0\.count == 6 && isValidSixCellLayout/);
assert.match(swiftSource, /let semanticGroups = sixCellFieldGroups/);
assert.match(swiftSource, /sixCellFieldGroups\(fields, requireEmpty: requireEmpty\)/);
assert.match(swiftSource, /private func hasCodeDeliverySuffix/);
assert.match(swiftSource, /private func codeEntryHasUnreadableValue/);
assert.match(swiftSource, /emit\(true, "waiting", "no_trusted_surface"\)/);
assert.match(swiftSource, /emit\(true, "waiting", waitingReason\)/);
assert.match(swiftSource, /hasCodeDeliverySuffix\([\s\S]*?in: snapshot\.nodes,[\s\S]*?allowedPIDs: snapshot\.allowedPIDs,[\s\S]*?suffix: suffix/);
assert.match(swiftSource, /deliverySuffixes\.count == 1/);
assert.match(swiftSource, /axChildren\(\$0\)\.isEmpty/);
assert.match(swiftSource, /private func hasSharedDirectParent/);
assert.match(swiftSource, /private func isValidSixCellLayout/);
assert.match(swiftSource, /requireEmpty: Bool = true/);
assert.match(swiftSource, /private func codeEntry\([\s\S]*?requireEmpty: Bool = true/);
assert.match(swiftSource, /isValidSixCellLayout\(\$0, requireEmpty: requireEmpty\)/);
assert.match(swiftSource, /let phoneSelectionPresent = snapshots\.contains/);
assert.match(swiftSource, /private func sameCodeEntryShape/);
assert.match(swiftSource, /usleep\(140_000\)/);
assert.match(
  swiftSource,
  /let transitionSuffix = index == fields\.count - 1 \? suffix : nil/
);
assert.match(swiftSource, /transitionSuffix:\s*transitionSuffix/);
assert.match(swiftSource, /matchingCodeEntries\(suffix: suffix, requireEmpty: false\)\.isEmpty/);
assert.match(swiftSource, /if axString\(element, kAXValueAttribute as String\) == value \{/);
const smsCodeCase = swiftSource.slice(
  swiftSource.indexOf('case "sms-code"'),
  swiftSource.indexOf("default:", swiftSource.indexOf('case "sms-code"'))
);
assert.doesNotMatch(smsCodeCase, /continueButton|AXUIElementPerformAction/);
assert.match(swiftSource, /readManualCodeFromStandardInput/);
assert.match(swiftSource, /FileHandle\.standardInput\.readDataToEndOfFile/);
assert.doesNotMatch(swiftSource, /APPLE_AUTOMATION_MANUAL_SMS_CODE/);
assert.doesNotMatch(swiftSource, /URLSession|https?:\/\/|OCR|screenshot|NSPasteboard|CGEvent/i);

const nativeRunnerSource = fs.readFileSync(
  new URL("./lib/mac-settings-sms-ax.js", import.meta.url),
  "utf8"
);
assert.match(nativeRunnerSource, /execFileWithStdin/);
assert.match(nativeRunnerSource, /child\.stdin\.end\(input\)/);
assert.doesNotMatch(nativeRunnerSource, /APPLE_AUTOMATION_MANUAL_SMS_CODE = options\.code/);
assert.match(nativeRunnerSource, /SUCCESS_STAGES_BY_PHASE/);
assert.match(nativeRunnerSource, /sanitizeMacSettingsSmsNativeResult\(phase, JSON\.parse\(stdout\)\)/);
assert.match(nativeRunnerSource, /phase === "sms-state"/);
assert.match(nativeRunnerSource, /phase === "sms-code"/);
assert.doesNotMatch(nativeRunnerSource, /args\.push\("--value"/);
assert.doesNotMatch(nativeRunnerSource, /https?:\/\/|\bfetch\s*\(/i);
assert.doesNotMatch(nativeRunnerSource, /spawnSync|swiftc/);
assert.doesNotMatch(nativeRunnerSource, /Math\.max\(1_000/);

const loginSource = fs.readFileSync(
  new URL("./lib/mac-settings-login.js", import.meta.url),
  "utf8"
);
assert.match(loginSource, /isMacSettingsSmsHelperAvailable/);
assert.match(
  loginSource,
  /if \(!isMacSettingsSmsHelperAvailable\(\)\)[\s\S]{0,320}请在系统设置中人工完成短信验证/
);
assert.doesNotMatch(loginSource, /\[Mac Settings\]|\[SMS\]/);
assert.match(loginSource, /按回车键/);
assert.match(loginSource, /postSmsInitialObservationGraceMs/);
assert.match(loginSource, /initialPostSmsObservation: postSmsEnabled && smsCompletionObserved/);
assert.match(
  loginSource,
  /smsResult\?\.status === "submitted"[\s\S]*?smsResult\?\.status === "manual_completed" && smsResult\?\.stage === "code_entry"/
);

console.log("mac settings supervised sms verification: ok");
