import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeMacSettingsPostSmsFinalization,
  isMacSettingsPostSmsFinalizationEnabled,
  macSettingsPostSmsModuleIdentity,
  normalizeMacSettingsPostSmsState,
} from "./lib/mac-settings-post-sms-finalization.js";
import {
  isTrustedMacSettingsPostSmsHelperOverride,
  normalizeMacSettingsPostSmsFailureReason,
  normalizeMacSettingsPostSmsBinding,
  sanitizeMacSettingsPostSmsProcessFailure,
  sanitizeMacSettingsPostSmsResult,
} from "./lib/mac-settings-post-sms-finalization-ax.js";
import { sanitizeMacSettingsEvent } from "./apple-id-full-flow.mjs";

const binding = { axOwnerPid: 401, visualOwnerPid: 402, windowId: 403 };
const alternateBinding = { axOwnerPid: 401, visualOwnerPid: 402, windowId: 404 };

assert.equal(
  macSettingsPostSmsModuleIdentity({ stage: "terms", binding }),
  "terms:401:402:403"
);
assert.equal(
  macSettingsPostSmsModuleIdentity({ stage: "location", binding }),
  "location:401:402:403"
);
assert.equal(
  macSettingsPostSmsModuleIdentity({ stage: "terms", binding: alternateBinding }),
  "terms:401:402:404"
);
assert.equal(macSettingsPostSmsModuleIdentity({ stage: "waiting", binding: null }), null);
assert.equal(macSettingsPostSmsModuleIdentity({ stage: "terms", binding: null }), null);

assert.equal(isMacSettingsPostSmsFinalizationEnabled({}), true);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({ APPLE_AUTOMATION_SMS_ENABLED: "1" }),
  true
);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({ APPLE_AUTOMATION_SMS_ENABLED: "0" }),
  true
);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({ APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED: "1" }),
  true
);
assert.equal(
  isMacSettingsPostSmsFinalizationEnabled({
    APPLE_AUTOMATION_SMS_ENABLED: "1",
    APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED: "0",
  }),
  false
);
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "waiting" }), {
  ok: true,
  stage: "waiting",
  digits: null,
  binding: null,
});
for (const stage of ["terms", "mac_password", "location"]) {
  assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage, binding }), {
    ok: true,
    stage,
    digits: null,
    binding,
  });
}
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "iphone_unlock", digits: 4, binding }), {
  ok: true,
  stage: "iphone_unlock",
  digits: 4,
  binding,
});
assert.deepEqual(normalizeMacSettingsPostSmsState({ ok: true, stage: "iphone_unlock", digits: 5 }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
});
assert.equal(normalizeMacSettingsPostSmsBinding(binding)?.windowId, 403);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, windowId: 0 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, axOwnerPid: 1.5 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, visualOwnerPid: 0x80000000 }), null);
assert.equal(normalizeMacSettingsPostSmsBinding({ ...binding, windowId: 0x1_0000_0000 }), null);
for (const reason of [
  "visual_unavailable",
  "binding_invalid",
  "helper_exit",
  "invalid_request",
  "timeout",
  "manual_required",
  "invalid",
]) {
  assert.equal(normalizeMacSettingsPostSmsFailureReason(reason), reason);
}
assert.equal(normalizeMacSettingsPostSmsFailureReason("raw AX text 123456"), "invalid");
assert.deepEqual(sanitizeMacSettingsPostSmsResult("state", { ok: true, stage: "iphone_unlock", digits: 6, binding }), {
  ok: true,
  stage: "iphone_unlock",
  digits: 6,
  binding,
});
assert.deepEqual(sanitizeMacSettingsPostSmsResult("state", { ok: true, stage: "iphone_unlock", digits: 6 }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
  reason: "binding_invalid",
});
assert.deepEqual(
  sanitizeMacSettingsPostSmsResult("state", {
    ok: false,
    stage: "visual_unavailable",
    rawAx: "RAW_AX_CANARY 123456",
  }),
  {
    ok: false,
    stage: "invalid",
    digits: null,
    binding: null,
    reason: "visual_unavailable",
  }
);
assert.deepEqual(
  sanitizeMacSettingsPostSmsResult("state", {
    ok: false,
    stage: "raw AX text 123456",
    stderr: "RAW_AX_CANARY",
  }),
  {
    ok: false,
    stage: "invalid",
    digits: null,
    binding: null,
    reason: "invalid",
  }
);
assert.deepEqual(
  sanitizeMacSettingsPostSmsProcessFailure(
    "state",
    Object.assign(new Error("helper exited"), {
      stdout: JSON.stringify({
        ok: false,
        stage: "visual_unavailable",
        rawAx: "RAW_AX_CANARY 123456",
      }),
    })
  ),
  {
    ok: false,
    stage: "invalid",
    digits: null,
    binding: null,
    reason: "visual_unavailable",
  }
);
assert.deepEqual(
  sanitizeMacSettingsPostSmsProcessFailure(
    "state",
    Object.assign(new Error("helper timed out"), {
      code: "ETIMEDOUT",
      stdout: "RAW_AX_CANARY 123456",
    })
  ),
  {
    ok: false,
    stage: "invalid",
    digits: null,
    binding: null,
    reason: "timeout",
  }
);
for (const [phase, stage] of [
  ["terms", "terms_submitted"],
  ["mac-password", "mac_password_submitted"],
  ["unlock-code", "iphone_unlock_submitted"],
  ["location", "location_submitted"],
]) {
  assert.deepEqual(sanitizeMacSettingsPostSmsResult(phase, { ok: true, stage }), {
    ok: true,
    stage,
    digits: null,
    binding: null,
  });
}
assert.deepEqual(sanitizeMacSettingsPostSmsResult("unlock-code", { ok: true, stage: "waiting" }), {
  ok: false,
  stage: "invalid",
  digits: null,
  binding: null,
  reason: "invalid",
});

{
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async () => ({
      ok: false,
      stage: "visual_unavailable",
      rawAx: "RAW_AX_CANARY 123456",
    }),
  });
  assert.deepEqual(result, { status: "retryable", reason: "visual_unavailable" });
}

{
  const events = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    onEvent: (event) => events.push(event),
    nativeRunner: async (phase) =>
      phase === "state"
        ? { ok: true, stage: "terms", binding }
        : { ok: false, stage: "manual_required", rawAx: "RAW_AX_CANARY 123456" },
  });
  assert.deepEqual(result, {
    status: "retryable",
    stage: "terms",
    binding,
    reason: "manual_required",
  });
  const actionFailure = events.find((event) => event.event === "action_unconfirmed");
  assert.deepEqual(actionFailure, {
    module: "post_sms",
    event: "action_unconfirmed",
    stage: "terms",
    phase: "terms",
    reason: "manual_required",
  });
  const safeAuditEvent = sanitizeMacSettingsEvent({
    ...actionFailure,
    stdout: "RAW_AX_CANARY 123456",
    rawAx: "RAW_AX_CANARY",
  });
  assert.deepEqual(safeAuditEvent, actionFailure);
  assert.equal(JSON.stringify(safeAuditEvent).includes("RAW_AX_CANARY"), false);
  assert.equal(JSON.stringify(safeAuditEvent).includes("123456"), false);
}

{
  const home = "C:\\Users\\post-sms-test";
  const helperDirectory = `${home}\\.apple-automation\\supervised-helpers`;
  const helperPath = `${helperDirectory}\\mac-settings-post-sms-finalization`;
  const stat = (kind, mode = 0o700) => ({
    mode,
    uid: 501,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  });
  const fsApi = {
    lstatSync(target) {
      if (target === helperDirectory) return stat("directory");
      if (target === helperPath) return stat("file", 0o500);
      throw new Error("unknown path");
    },
    realpathSync(target) {
      return target;
    },
  };
  const env = {
    HOME: home,
    APPLE_AUTOMATION_HELPER_DIR: helperDirectory,
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: "0123456789abcdef0123456789abcdef",
  };
  assert.equal(
    isTrustedMacSettingsPostSmsHelperOverride(env, { fs: fsApi, getuid: () => 501 }),
    true
  );
  assert.equal(
    isTrustedMacSettingsPostSmsHelperOverride(
      { ...env, APPLE_AUTOMATION_SUPERVISED_TOKEN: "bad" },
      { fs: fsApi, getuid: () => 501 }
    ),
    false
  );
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase, options) => {
      calls.push({ phase, ...options });
      return phase === "state"
        ? { ok: true, stage: "iphone_unlock", digits: 6, binding }
        : { ok: true, stage: "iphone_unlock_submitted" };
    },
  });
  assert.deepEqual(result, { status: "manual_required", stage: "iphone_unlock", binding });
  assert.deepEqual(
    calls.map(({ phase }) => phase),
    ["state"],
    "a device passcode page must stay manual and receive no placeholder input"
  );
}

for (const [stateStage, phase, submittedStage] of [
  ["terms", "terms", "terms_submitted"],
  ["location", "location", "location_submitted"],
]) {
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (calledPhase, options) => {
      calls.push({ phase: calledPhase, ...options });
      return calledPhase === "state"
        ? { ok: true, stage: stateStage, binding }
        : { ok: true, stage: submittedStage };
    },
  });
  assert.deepEqual(result, { status: "submitted", stage: stateStage, binding });
  assert.deepEqual(calls.map(({ phase: calledPhase }) => calledPhase), ["state", phase]);
  assert.deepEqual(calls[1].binding, binding);
}

{
  const terminal = { logs: [], warnings: [] };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => terminal.logs.push(args.join(" "));
  console.warn = (...args) => terminal.warnings.push(args.join(" "));
  try {
    const completed = await completeMacSettingsPostSmsFinalization({
      platform: "darwin",
      supervised: true,
      isTTY: true,
      nativeRunner: async (phase) =>
        phase === "state"
          ? { ok: true, stage: "terms", binding }
          : { ok: true, stage: "terms_submitted" },
    });
    const failed = await completeMacSettingsPostSmsFinalization({
      platform: "darwin",
      supervised: true,
      isTTY: true,
      nativeRunner: async (phase) =>
        phase === "state"
          ? { ok: true, stage: "location", binding }
          : { ok: false, stage: "manual_required" },
    });
    assert.deepEqual(completed, { status: "submitted", stage: "terms", binding });
    assert.deepEqual(failed, {
      status: "retryable",
      stage: "location",
      binding,
      reason: "manual_required",
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  assert.deepEqual(terminal.logs, ["[Mac 设置] 已处理后置弹窗：条款确认"]);
  assert.deepEqual(terminal.warnings, ["[Mac 设置] 定位/查找 Mac 确认处理失败，保留页面供人工核对。"]);
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase) => {
      calls.push(phase);
      return phase === "state"
        ? { ok: true, stage: "iphone_unlock", digits: 4, binding }
        : { ok: true, stage: "iphone_unlock_submitted" };
    },
  });
  assert.deepEqual(result, { status: "manual_required", stage: "iphone_unlock", binding });
  assert.deepEqual(calls, ["state"]);
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase, options) => {
      calls.push({ phase, options });
      return phase === "state"
        ? { ok: true, stage: "mac_password", binding }
        : { ok: true, stage: "mac_password_submitted" };
    },
  });
  assert.deepEqual(result, { status: "submitted", stage: "mac_password", binding });
  assert.deepEqual(calls.map(({ phase }) => phase), ["state", "mac-password"]);
  assert.equal(
    calls[1].options.password,
    "000000",
    "the supervised Mac password page must try the six-zero fixture first"
  );
}

{
  const calls = [];
  const events = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    onEvent: (event) => events.push(event),
    nativeRunner: async (phase, options) => {
      calls.push({ phase, options });
      if (phase === "state") return { ok: true, stage: "mac_password", binding };
      return options.password === "0000"
        ? { ok: true, stage: "mac_password_submitted" }
        : { ok: false, stage: "manual_required" };
    },
  });
  assert.deepEqual(result, { status: "submitted", stage: "mac_password", binding });
  assert.deepEqual(calls.map(({ phase }) => phase), ["state", "mac-password", "mac-password"]);
  assert.deepEqual(
    calls.slice(1).map(({ options }) => options.password),
    ["000000", "0000"],
    "the supervised Mac password page must fall back from six zeroes to four zeroes"
  );
  const retry = events.find((event) => event.event === "action_retry");
  assert.deepEqual(retry, {
    module: "post_sms",
    event: "action_retry",
    stage: "mac_password",
    phase: "mac-password",
    attempt: 1,
    nextPasswordLength: 4,
  });
  assert.deepEqual(
    sanitizeMacSettingsEvent({ ...retry, password: "000000", rawAx: "RAW_AX_CANARY" }),
    retry,
    "a password retry audit event must retain only safe routing metadata"
  );
}

for (const [stage, digits] of [
  ["mac_password", null],
  ["iphone_unlock", 6],
]) {
  const events = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    probeOnly: true,
    onEvent: (event) => events.push(event),
    nativeRunner: async (phase) => {
      assert.equal(phase, "state");
      return { ok: true, stage, digits, binding };
    },
  });
  assert.deepEqual(result, { status: "state_observed", stage, binding });
  assert.ok(
    events.some((event) => event.event === "state_observed_probe_only" && event.stage === stage),
    "a probe-only manual handoff must be observed without requesting another prompt"
  );
  assert.equal(
    events.some((event) => event.event === "manual_required"),
    false,
    "a probe-only manual handoff must not duplicate the manual prompt"
  );
}

{
  const calls = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase) => {
      calls.push(phase);
      return { ok: true, stage: "iphone_unlock", digits: 4 };
    },
    passcodeProvider: async () => {
      throw new Error("a state without its original binding must not prompt");
    },
  });
  assert.deepEqual(result, { status: "retryable", reason: "invalid" });
  assert.deepEqual(calls, ["state"]);
}

{
  let clock = 0;
  const stateTimeouts = [];
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    scanTimeoutMs: 1_000,
    pollIntervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    nativeRunner: async (_phase, options) => {
      stateTimeouts.push(options.timeoutMs);
      return { ok: true, stage: "waiting" };
    },
  });
  assert.deepEqual(result, { status: "not_required" });
  assert.ok(stateTimeouts.length >= 1);
  assert.ok(
    stateTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 1_000),
    "a no-modal state probe must stay bounded by the short scan window"
  );
}

{
  const calls = [];
  let policyCalls = 0;
  const result = await completeMacSettingsPostSmsFinalization({
    platform: "darwin",
    supervised: true,
    isTTY: true,
    nativeRunner: async (phase) => {
      calls.push(phase);
      return phase === "state"
        ? { ok: true, stage: "terms", binding }
        : { ok: true, stage: "terms_submitted" };
    },
    beforeSubmit: (state) => {
      policyCalls += 1;
      assert.deepEqual(state, { ok: true, stage: "terms", digits: null, binding });
      return false;
    },
  });
  assert.equal(result.status, "manual_required");
  assert.equal(result.stage, "terms");
  assert.deepEqual(result.binding, binding);
  assert.equal(policyCalls, 1);
  assert.deepEqual(
    calls,
    ["state"],
    "a rejected round policy must prevent the native action phase from running"
  );
}

assert.deepEqual(
  await completeMacSettingsPostSmsFinalization({ platform: "win32", supervised: true, isTTY: true }),
  { status: "manual_required" }
);

const helperSourceUrl = new URL(
  "./swift/mac-settings-post-sms-finalization.swift",
  import.meta.url
);
const helperSourcePath = fileURLToPath(helperSourceUrl);
const helperSource = fs.readFileSync(helperSourceUrl, "utf8");
if (process.platform === "darwin") {
  const typecheck = spawnSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      path.join(os.tmpdir(), "apple-automation-swift-module-cache"),
      "-typecheck",
      helperSourcePath,
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "-framework",
      "Vision",
      "-framework",
      "CoreGraphics",
      "-framework",
      "ScreenCaptureKit",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  assert.equal(
    typecheck.status,
    0,
    typecheck.stderr || typecheck.stdout || typecheck.error?.message
  );
}
assert.match(helperSource, /CFGetTypeID\(positionValue\) == AXValueGetTypeID\(\)/);
assert.match(helperSource, /CFGetTypeID\(sizeValue\) == AXValueGetTypeID\(\)/);
assert.doesNotMatch(helperSource, /as\?\s+AXValue/);
assert.match(helperSource, /VNRecognizeTextRequest/);
assert.match(helperSource, /VNDetectRectanglesRequest/);
assert.match(helperSource, /request\.maximumAspectRatio = 1\.0/);
assert.doesNotMatch(helperSource, /request\.maximumAspectRatio = 1\.35/);
assert.match(helperSource, /guard !windows\.isEmpty else \{ continue \}/);
assert.match(helperSource, /private func isSurfaceRole\(/);
assert.match(helperSource, /role == kAXWindowRole as String \|\| role == "AXDialog" \|\| role == "AXSheet"/);
assert.match(helperSource, /private func surfaceRoots\(/);
assert.match(helperSource, /surfaceRoots\(for: appElement, allowedPIDs: allowedPIDs\)/);
assert.match(helperSource, /if textContainsAny\(directTexts\(element\), passwordMarkers\)/);
assert.match(helperSource, /private func hasMacPasswordEvidence\(/);
assert.match(helperSource, /hasMacPasswordEvidence\(passwordText\)/);
assert.match(helperSource, /private func hasPasswordFieldEvidence\(/);
assert.match(helperSource, /hasMacPasswordEvidence\(passwordText\) \|\| hasPasswordFieldEvidence\(fields\[0\]\)/);
assert.match(helperSource, /private func isMacPasswordField\(/);
assert.match(helperSource, /private func nearestButton\(/);
assert.match(helperSource, /excludingIdentifiers: Set<String> = \[\]/);
assert.match(helperSource, /excludingIdentifiers: \["LOGIN_BUTTON"\]/);
assert.match(helperSource, /elements: \[fields\[0\], cancelButtons\[0\], continueButton\]/);
assert.doesNotMatch(
  helperSource.slice(
    helperSource.indexOf("private func isMacPasswordField"),
    helperSource.indexOf("private func checkboxIsSelected")
  ),
  /axChildren\(element\)\.isEmpty/
);
assert.match(helperSource, /private func hasTermsEvidence\(/);
assert.match(helperSource, /private func hasLocationEvidence\(/);
assert.match(helperSource, /find my mac/);
assert.match(helperSource, /value\.contains\("enter"\)/);
assert.match(helperSource, /apple\\u\{8D26\}\\u\{53F7\}/);
assert.match(helperSource, /apple\\u\{5E33\}\\u\{865F\}/);
assert.match(helperSource, /\\u\{4E0D\}\\u\{77E5\}\\u\{9053\}\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /\\u\{5FD8\}\\u\{8A18\}\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /\\u\{89E3\}\\u\{9396\}/);
assert.match(helperSource, /\\u\{5BC6\}\\u\{78BC\}/);
assert.match(helperSource, /private func titleLinesAreAdjacent\(/);
assert.ok(
  helperSource.includes('looksLikeVisionUnlockTitle("\\(upper.text) \\(lower.text)")')
);
const targetBindingBody = helperSource.slice(
  helperSource.indexOf("private func uniqueUnlockTarget"),
  helperSource.indexOf("private func sameTarget")
);
assert.match(targetBindingBody, /guard hasUnlockSecondaryEvidence\(text\) else/);
assert.doesNotMatch(targetBindingBody, /looksLikeIPhoneUnlockSheet\(text\)/);
assert.match(helperSource, /candidate[s]?\.count == 4 \|\| candidate[s]?\.count == 6/);
assert.match(helperSource, /cellGroupsAreStable/);
assert.match(helperSource, /private func unlockCellsAreVisuallyEmpty\(/);
assert.match(helperSource, /private func cellInteriorHasVisibleMark\(/);
assert.match(helperSource, /targetWindowIsTopmostAtPoint/);
assert.match(helperSource, /hitTestMatchesBoundTarget/);
assert.match(helperSource, /private func axElementsEqual\(/);
assert.match(helperSource, /private func isDescendant\(/);
assert.match(helperSource, /private func hitTestMatchesBoundSurface\(/);
assert.match(helperSource, /private func activateBoundModalTarget\(/);
assert.match(helperSource, /private func submitTerms\(/);
assert.match(helperSource, /private func submitMacPassword\(/);
assert.match(helperSource, /private func submitLocation\(/);
assert.match(helperSource, /fixedMacPasswords: Set<String> = \["0000", "000000"\]/);
assert.match(helperSource, /private func isNotExplicitlyDisabled\(/);
assert.match(
  helperSource,
  /private func isEnabled\([\s\S]*?axBool\(element, kAXEnabledAttribute as String\) == true/
);
assert.match(
  helperSource,
  /private func bindingForSurfaceElements\([\s\S]*?directWindowID = elementWindowID\(surface\)\.flatMap/
);
assert.match(helperSource, /resolveOnScreenWindowID\(\n\s+pid: visualOwnerPID,/);
assert.match(helperSource, /private func onScreenWindowFrame\(/);
assert.doesNotMatch(helperSource, /surfaceWindowID != visualWindow\.windowID/);
const hitTestBody = helperSource.slice(
  helperSource.indexOf("private func hitTestMatchesBoundTarget"),
  helperSource.indexOf("private func activateBoundSettingsWindow")
);
assert.match(hitTestBody, /if hitPID == target\.binding\.visualOwnerPID/);
assert.match(hitTestBody, /isTrustedDescendant\(/);
assert.doesNotMatch(hitTestBody, /isTrustedAppleIDSettingsExtension\(axOwner\)[\s\S]*?return true\s*\n\}/);
assert.match(helperSource, /private func activateBoundSettingsWindow\(/);
assert.match(helperSource, /visualHost\.activate\(options: \[\.activateIgnoringOtherApps\]\)/);
assert.match(helperSource, /AXUIElementPerformAction\(visualWindow, kAXRaiseAction as CFString\)/);
assert.match(helperSource, /private func waitForUnlockAdvanceOrPressContinue\(/);
assert.match(helperSource, /for attempt in 0\.\.<25/);
const advanceBody = helperSource.slice(
  helperSource.indexOf("private func waitForUnlockAdvanceOrPressContinue"),
  helperSource.indexOf("private func submitUnlockPasscode")
);
assert.match(advanceBody, /let automaticAdvanceGracePolls = 7/);
assert.match(
  advanceBody,
  /if attempt >= automaticAdvanceGracePolls && isEnabled\(remainingTarget\.continueButton\)/
);
assert.match(helperSource, /FileHandle\.standardInput\.readDataToEndOfFile/);
assert.match(helperSource, /case "unlock-code"/);
assert.match(helperSource, /case "terms"/);
assert.match(helperSource, /case "mac-password"/);
assert.match(helperSource, /case "location"/);
assert.match(helperSource, /\["terms", "mac-password", "unlock-code", "location"\]/);
assert.match(helperSource, /identifier: "action-button-2"/);
assert.doesNotMatch(helperSource, /AXUIElementPerformAction\(target\.secondaryButton/);
assert.match(helperSource, /--ax-owner-pid/);
assert.match(helperSource, /--visual-owner-pid/);
assert.match(helperSource, /--window-id/);
assert.doesNotMatch(helperSource, /NSPasteboard|writeToFile|createFile|ProcessInfo\.processInfo\.environment/);
assert.doesNotMatch(helperSource, /APPLE_AUTOMATION_MANUAL_SMS_CODE|APPLE_ID|APPLE_PASSWORD/);
const submitBody = helperSource.slice(
  helperSource.indexOf("private func submitUnlockPasscode"),
  helperSource.indexOf("private struct Invocation")
);
assert.match(
  submitBody,
  /let preActivationTarget = uniqueUnlockTarget\(\),[\s\S]*?preActivationTarget\.binding == expectedBinding,[\s\S]*?await activateBoundSettingsWindow\(preActivationTarget\)/
);
assert.ok(
  submitBody.indexOf("await activateBoundSettingsWindow(preActivationTarget)") <
    submitBody.indexOf("stableUnlockCellTarget("),
  "the trusted System Settings window must be foregrounded before visual cell capture and input"
);
assert.match(submitBody, /expectedBinding: expectedBinding/);
assert.match(submitBody, /currentTarget\.binding == expectedBinding/);
assert.match(submitBody, /refreshedTarget\.binding == expectedBinding/);
assert.match(submitBody, /await waitForUnlockAdvanceOrPressContinue\(/);
assert.doesNotMatch(submitBody, /Task\.sleep\(nanoseconds: 900_000_000\)/);

const stableTargetBody = helperSource.slice(
  helperSource.indexOf("private func stableUnlockCellTarget"),
  helperSource.indexOf("private func postClickUnicodeDigit")
);
assert.match(stableTargetBody, /captureWindowByID\(firstWindow\.binding\.windowID\)/);
assert.match(stableTargetBody, /captureWindowByID\(currentWindow\.binding\.windowID\)/);
assert.doesNotMatch(stableTargetBody, /\b(?:firstWindow|currentWindow)\.windowID\b/);
assert.match(
  stableTargetBody,
  /let firstPoint = screenPointForCell\(firstCells\[0\], in: firstWindow\),[\s\S]*?targetWindowIsTopmostAtPoint\(firstWindow, point: firstPoint\),[\s\S]*?hitTestMatchesBoundTarget\(firstTarget, window: firstWindow, point: firstPoint\)/
);
assert.match(
  stableTargetBody,
  /let currentPoint = screenPointForCell\(secondCells\[0\], in: currentWindow\),[\s\S]*?targetWindowIsTopmostAtPoint\(currentWindow, point: currentPoint\),[\s\S]*?hitTestMatchesBoundTarget\(currentTarget, window: currentWindow, point: currentPoint\)/
);

const wrapperSource = fs.readFileSync(
  new URL("./lib/mac-settings-post-sms-finalization-ax.js", import.meta.url),
  "utf8"
);
assert.match(wrapperSource, /stdinExec/);
assert.match(wrapperSource, /child\.stdin\.end\(input\)/);
assert.match(wrapperSource, /phase === "unlock-code"/);
assert.match(wrapperSource, /phase === "mac-password"/);
assert.match(wrapperSource, /new Set\(\["state", "terms", "mac-password", "unlock-code", "location"\]\)/);
assert.match(wrapperSource, /!\/\^\(\?:0\{4\}\|0\{6\}\)\$\/.test\(options\.password \?\? ""\)/);
assert.match(wrapperSource, /normalizeMacSettingsPostSmsBinding\(options\.binding\)/);
assert.match(wrapperSource, /"--ax-owner-pid"/);
assert.match(wrapperSource, /"--visual-owner-pid"/);
assert.match(wrapperSource, /"--window-id"/);
assert.match(wrapperSource, /CHILD_SECRET_ENV_KEYS/);
assert.match(wrapperSource, /for \(const key of CHILD_SECRET_ENV_KEYS\) delete env\[key\]/);
assert.doesNotMatch(wrapperSource, /args\.push\("--(?:value|passcode)/);
assert.doesNotMatch(wrapperSource, /https?:\/\/|\bfetch\s*\(/i);

const controllerSource = fs.readFileSync(
  new URL("./lib/mac-settings-post-sms-finalization.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(controllerSource, /promptForHiddenDevicePasscode/);
assert.match(controllerSource, /const MANUAL_STAGES = new Set\(\["iphone_unlock"\]\)/);
assert.match(
  controllerSource,
  /if \(MANUAL_STAGES\.has\(state\.stage\)\) \{[\s\S]*?return resultFor\("manual_required", state\)/
);
assert.doesNotMatch(controllerSource, /"0"\.repeat\(state\.digits\)/);
assert.match(controllerSource, /const FIXED_MAC_PASSWORDS = Object\.freeze\(\["000000", "0000"\]\)/);
assert.match(controllerSource, /function macPasswordCandidates\(/);
assert.match(controllerSource, /passwordLength: password\.length/);
assert.match(controllerSource, /emitEvent\("action_retry"/);
assert.match(controllerSource, /mac-password/);
assert.match(controllerSource, /location/);
assert.match(controllerSource, /APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED/);
assert.match(controllerSource, /export function macSettingsPostSmsModuleIdentity\(/);
assert.match(controllerSource, /options\.beforeSubmit/);
const defaultScanTimeout = /const scanTimeoutMs = boundedPositive\(options\.scanTimeoutMs,\s*([0-9_]+)\)/.exec(
  controllerSource
);
assert.ok(defaultScanTimeout, "the controller must retain an explicit short state-scan default");
assert.ok(
  Number(defaultScanTimeout[1].replaceAll("_", "")) <= 5_000,
  "a missing modal must remain a bounded probe rather than monopolizing signed-in detection"
);
assert.doesNotMatch(controllerSource, /boundedPositive\(options\.scanTimeoutMs,\s*45_000\)/);
assert.doesNotMatch(controllerSource, /readFile(?:Sync)?\([^)]*\.env/);
assert.doesNotMatch(controllerSource, /APPLE_PASSWORD|APPLE_ID(?:\W|$)/);

console.log("mac settings post-SMS finalization: ok");
