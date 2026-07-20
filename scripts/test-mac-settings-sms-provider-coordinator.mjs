import assert from "node:assert/strict";
import { completeSupervisedMacSettingsSmsVerification } from "./lib/mac-settings-sms-verification.js";

const calls = [];
const result = await completeSupervisedMacSettingsSmsVerification({
  phoneNumber: "+86 138-0013-0051", platform: "darwin", supervised: true, isTTY: true,
  nativeRunner: async (phase) => { calls.push(phase); return phase === "sms-state" ? { ok: true, stage: "code_entry" } : { ok: true }; },
  codeProvider: async () => "123456",
  manualCodeProvider: async () => { throw new Error("manual fallback must not run"); },
});
assert.deepEqual(result, { status: "submitted" });
assert.deepEqual(calls, ["sms-state", "sms-code"]);
console.log("sms provider coordinator: ok");
