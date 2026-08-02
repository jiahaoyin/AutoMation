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
console.log("sms provider coordinator: ok");
