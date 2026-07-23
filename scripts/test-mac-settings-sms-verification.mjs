import assert from "node:assert/strict";
import fs from "node:fs";

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
assert.deepEqual(sanitizeMacSettingsSmsNativeResult("sms-state", { ok: true, stage: "waiting" }), {
  ok: true,
  stage: "waiting",
});
assert.deepEqual(sanitizeMacSettingsSmsNativeResult("sms-select", { ok: true, stage: "selected" }), {
  ok: true,
  stage: "selected",
});
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-select", { ok: true, stage: "code_submitted" }),
  { ok: false, stage: "invalid" }
);
assert.deepEqual(
  sanitizeMacSettingsSmsNativeResult("sms-code", { ok: true, stage: "continued" }),
  { ok: false, stage: "invalid" }
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
    ["sms-state", "sms-select", "sms-continue", "sms-state", "sms-code"]
  );
  assert.equal(sequence.calls[1].suffix, "51");
  assert.equal(sequence.calls[4].suffix, "51");
  assert.equal(sequence.calls[4].code, "123456");
}

{
  const sequence = createSequenceRunner([{ ok: true, stage: "code_entry" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({
      nativeRunner: sequence.runner,
      manualCodeProvider: async () => "654321",
    })
  );
  assert.deepEqual(
    sequence.calls.map(({ phase }) => phase),
    ["sms-state", "sms-code"],
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

await expectCode("MAC_SETTINGS_SMS_STATE_UNAVAILABLE", async () => {
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({ nativeRunner: async () => ({ ok: false }) })
  );
});

await expectCode("MAC_SETTINGS_SMS_STATE_UNAVAILABLE", async () => {
  const sequence = createSequenceRunner([{ ok: true, stage: "unexpected" }]);
  await completeSupervisedMacSettingsSmsVerification(
    baseOptions({ nativeRunner: sequence.runner })
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

const source = fs.readFileSync(
  new URL("./lib/mac-settings-sms-verification.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(source, /\bfetch\s*\(/);
assert.doesNotMatch(source, /https?:\/\//i);
assert.doesNotMatch(source, /smsrecord|smsapi|lixsms|xsd20vip/i);
assert.match(source, /manual-verification-prompt/);
assert.doesNotMatch(source, /manual-2fa-prompt/);

const swiftSource = fs.readFileSync(
  new URL("./swift/mac-settings-sms-verification.swift", import.meta.url),
  "utf8"
);
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
assert.match(swiftSource, /codeSnapshots\.count == 1, phoneSnapshots\.isEmpty/);
assert.match(swiftSource, /phoneSnapshots\.count == 1, codeSnapshots\.isEmpty/);
assert.match(swiftSource, /let entries = matchingCodeEntries\(suffix: suffix\)/);
assert.match(swiftSource, /matches\.count == 1/);
assert.match(swiftSource, /axBool\(element, kAXEnabledAttribute as String\) == true/);
assert.match(swiftSource, /private let phoneMarkers = \[/);
assert.match(swiftSource, /phoneMarkers\.contains/);
assert.match(swiftSource, /fields\.count == 1/);
assert.doesNotMatch(swiftSource, /fields\.count == 1, isSemanticCodeField\(fields\[0\]\) \|\|/);
assert.doesNotMatch(swiftSource, /private func hasCodeContext/);
assert.match(swiftSource, /private func hasCodeDeliverySuffix/);
assert.match(swiftSource, /hasCodeDeliverySuffix\(in: \$0\.nodes, pid: \$0\.pid, suffix: suffix\)/);
assert.match(swiftSource, /deliverySuffixes\.count == 1/);
assert.match(swiftSource, /axChildren\(\$0\)\.isEmpty/);
assert.match(swiftSource, /let semanticCodeFields = fields\.filter\(isSemanticCodeField\)/);
assert.match(swiftSource, /fields\.count == 6 \? fields : \[\]/);
assert.match(swiftSource, /codeFields\.count == 6/);
assert.match(swiftSource, /transitionSuffix: suffix/);
assert.match(swiftSource, /matchingCodeEntries\(suffix: suffix\)\.isEmpty/);
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
  /if \(!isMacSettingsSmsHelperAvailable\(\)\)[\s\S]{0,320}complete SMS verification manually/
);

console.log("mac settings supervised sms verification: ok");
