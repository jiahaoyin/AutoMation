import assert from "node:assert/strict";
import { completeSupervisedMacSettingsSmsVerification } from "./lib/mac-settings-sms-verification.js";

const calls = [];
const states = [
  { ok: true, stage: "code_entry" },
  { ok: true, stage: "code_entry" },
  { ok: true, stage: "code_pending" },
  { ok: true, stage: "waiting" },
  { ok: true, stage: "waiting" },
];
const result = await completeSupervisedMacSettingsSmsVerification({
  phoneNumber: "+86 138-0013-0051", platform: "darwin", supervised: true, isTTY: true,
  nativeRunner: async (phase) => {
    calls.push(phase);
    return phase === "sms-state"
      ? (states.shift() ?? { ok: true, stage: "waiting" })
      : { ok: true, stage: "code_submitted" };
  },
  codeProvider: async () => "123456",
  manualCodeProvider: async () => { throw new Error("manual fallback must not run"); },
});
assert.deepEqual(result, { status: "submitted" });
assert.deepEqual(calls, ["sms-state", "sms-state", "sms-code", "sms-state", "sms-state", "sms-state"]);

// Provider calls are one HTTP poll each.  The coordinator must start a new
// request every five seconds and surface the empty-poll heartbeat rather than
// appearing frozen while no SMS has arrived yet.
{
  let clock = 0;
  let codeWritten = false;
  let providerCalls = 0;
  const pollTimes = [];
  const progress = [];
  const result = await completeSupervisedMacSettingsSmsVerification({
    phoneNumber: "+86 138-0013-0051",
    platform: "darwin",
    supervised: true,
    isTTY: true,
    timeoutMs: 20_000,
    providerTimeoutMs: 12_000,
    providerPollIntervalMs: 5_000,
    pollIntervalMs: 1,
    stateReadAttempts: 1,
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
      return codeWritten
        ? { ok: true, stage: "waiting" }
        : { ok: true, stage: "code_entry" };
    },
    codeProvider: async () => {
      pollTimes.push(clock);
      providerCalls += 1;
      return providerCalls === 2 ? "123456" : null;
    },
    manualCodeProvider: async () => {
      assert.fail("manual fallback must not run after the provider returns a code");
    },
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(result, { status: "submitted" });
  assert.deepEqual(pollTimes, [0, 5_000]);
  assert.ok(
    progress.some(
      ({ event, polls, pollIntervalMs }) =>
        event === "code_provider_poll_started" && polls === 1 && pollIntervalMs === 5_000
    )
  );
  assert.ok(
    progress.some(
      ({ event, polls, pollIntervalMs }) =>
        event === "code_provider_poll_empty" && polls === 1 && pollIntervalMs === 5_000
    )
  );
}

// An exhausted provider must publish a fixed no-code state before the existing
// hidden manual-entry fallback runs.  Audit/progress metadata must not include
// the SMS body or verification code.
{
  let clock = 0;
  let providerCalls = 0;
  const pollTimes = [];
  const progress = [];
  await assert.rejects(
    () => completeSupervisedMacSettingsSmsVerification({
      phoneNumber: "+86 138-0013-0051",
      platform: "darwin",
      supervised: true,
      isTTY: true,
      timeoutMs: 12_000,
      providerTimeoutMs: 10_000,
      providerPollIntervalMs: 5_000,
      manualTimeoutMs: 1,
      pollIntervalMs: 1,
      stateReadAttempts: 1,
      stableCodeEntryReads: 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      nativeRunner: async () => ({ ok: true, stage: "code_entry" }),
      codeProvider: async () => {
        providerCalls += 1;
        pollTimes.push(clock);
        return null;
      },
      manualCodeProvider: async () => null,
      onProgress: (event) => progress.push(event),
    }),
    (error) => error?.code === "MAC_SETTINGS_SMS_MANUAL_CODE_INVALID"
  );
  assert.equal(providerCalls, 2);
  assert.deepEqual(pollTimes, [0, 5_000]);
  const noCode = progress.find(({ event }) => event === "sms_code_not_received");
  assert.deepEqual(noCode, { event: "sms_code_not_received", polls: 2, elapsedMs: 10_000 });
  assert.doesNotMatch(JSON.stringify(progress), /123456|body|messages/i);
}

console.log("sms provider coordinator: ok");
