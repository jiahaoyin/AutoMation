import assert from "node:assert/strict";
import fs from "node:fs";

import { normalizeAxFillResult } from "./lib/mac-settings-ax-fill.js";
import {
  appleScriptPhaseFromStep,
  mayUseAppleScriptFallback,
} from "./lib/mac-settings-login.js";
import { waitUntil } from "./lib/prompt.js";
import {
  resolveMacSettingsFailureStatus,
  sanitizeMacSettingsEvent,
  sanitizeMacSettingsFailureCode,
} from "./apple-id-full-flow.mjs";

const SECRET = "person@example.com TOP-SECRET 123456 AXWindow helper stderr";

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  for (const fragment of ["person@example.com", "TOP-SECRET", "123456", "AXWindow", "helper stderr"]) {
    assert.equal(text.includes(fragment), false, `diagnostic leaked ${fragment}`);
  }
}

function structuredSwiftFailureIsAllowlistedTest() {
  const result = normalizeAxFillResult(
    JSON.stringify({
      ok: false,
      phase: "email",
      message: "target_unavailable_before_write",
      loginState: "email",
      inputRoute: null,
      textFieldCount: 3,
      rawAx: SECRET,
    }),
    "email"
  );
  assert.deepEqual(result, {
    ok: false,
    route: "swift_ax",
    phase: "email",
    reason: "target_unavailable_before_write",
    loginState: "email",
    inputRoute: "unknown",
    textFieldCount: 3,
  });
  assertNoSecret(result);
}

function unsafeHelperFieldsAreDiscardedTest() {
  const result = normalizeAxFillResult(
    JSON.stringify({
      ok: false,
      phase: "password",
      message: SECRET,
      loginState: "not-a-state",
      inputRoute: "manual_paste",
      textFieldCount: 999,
    }),
    "password"
  );
  assert.deepEqual(result, {
    ok: false,
    route: "swift_ax",
    phase: "password",
    reason: "unknown",
    loginState: "unknown",
    inputRoute: "unknown",
    textFieldCount: null,
  });
  assertNoSecret(result);
}

function malformedHelperOutputIsFixedTest() {
  const result = normalizeAxFillResult(SECRET, "email", { reason: "helper_exit" });
  assert.deepEqual(result, {
    ok: false,
    route: "swift_ax",
    phase: "email",
    reason: "helper_exit",
    loginState: "unknown",
    inputRoute: "unknown",
    textFieldCount: null,
  });
  assertNoSecret(result);
}

function credentialReplayGateTest() {
  const base = {
    route: "swift_ax",
    loginState: "password",
    inputRoute: "unknown",
  };
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "email",
      reason: "target_unavailable_before_write",
    }),
    true
  );
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "password",
      reason: "exact_password_field_not_found",
    }),
    true
  );
  assert.equal(
    mayUseAppleScriptFallback({ ...base, phase: "dump", reason: "helper_exit" }),
    true
  );
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "password",
      reason: "enabled_login_button_not_found_after_password",
      inputRoute: "ax_value",
    }),
    false
  );
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "password",
      reason: "keyboard_unconfirmed",
      inputRoute: "keyboard",
    }),
    false
  );
  assert.equal(
    mayUseAppleScriptFallback({ ...base, phase: "email", reason: "helper_exit" }),
    false
  );
  assert.equal(
    mayUseAppleScriptFallback({ ...base, phase: "password", reason: "helper_invalid_output" }),
    false
  );
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "password",
      reason: "keyboard_fallback_unsafe",
    }),
    false
  );
  assert.equal(
    mayUseAppleScriptFallback({
      ...base,
      phase: "continue",
      reason: "enabled_login_button_not_found",
    }),
    false
  );
}

function appleScriptFailurePhaseTest() {
  assert.equal(appleScriptPhaseFromStep(0), "state");
  assert.equal(appleScriptPhaseFromStep(3), "state");
  assert.equal(appleScriptPhaseFromStep(4), "email");
  assert.equal(appleScriptPhaseFromStep(6), "email");
  assert.equal(appleScriptPhaseFromStep(7), "continue");
  assert.equal(appleScriptPhaseFromStep(8), "continue");
  assert.equal(appleScriptPhaseFromStep(9), "password");
  assert.equal(appleScriptPhaseFromStep(12), "password");
}

function postLoginFailureDoesNotReuseSuccessTest() {
  const succeeded = {
    route: "swift_ax",
    phase: "password",
    outcome: "succeeded",
    reason: "ok",
    loginState: "password",
    inputRoute: "ax_value",
    textFieldCount: 1,
  };
  assert.deepEqual(resolveMacSettingsFailureStatus(new Error("post-login failure"), succeeded), {
    route: "unknown",
    phase: "unknown",
    outcome: "failed",
    reason: "unknown",
    loginState: "unknown",
    inputRoute: "unknown",
    textFieldCount: null,
  });

  const failed = {
    ...succeeded,
    outcome: "failed",
    reason: "keyboard_unconfirmed",
    inputRoute: "keyboard",
  };
  assert.deepEqual(resolveMacSettingsFailureStatus(new Error("login failure"), failed), failed);
}

function macSettingsEventSanitizationTest() {
  const smsEvent = sanitizeMacSettingsEvent({
    module: "sms",
    event: "native_call_completed",
    phase: "sms-code",
    reason: "code_write_failed",
    attempts: 2,
    identity: "code_entry:401:402:403",
    rawAx: SECRET,
    code: "123456",
  });
  assert.deepEqual(smsEvent, {
    module: "sms",
    event: "native_call_completed",
    phase: "sms-code",
    reason: "code_write_failed",
    attempts: 2,
    stage: "code_entry",
    axOwnerPid: 401,
    visualOwnerPid: 402,
    windowId: 403,
  });
  assertNoSecret(smsEvent);

  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "login",
      event: "initial_signed_in_probe",
      outcome: "probe_failed",
      signedIn: false,
    }),
    {
      module: "login",
      event: "initial_signed_in_probe",
      outcome: "probe_failed",
      signedIn: false,
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "login",
      event: "mac_settings_phase_completed",
      outcome: "skipped",
    }),
    {
      module: "login",
      event: "mac_settings_phase_completed",
      outcome: "skipped",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "post_sms",
      event: "post_sms_module_disabled",
      outcome: "unavailable",
      unexpected: SECRET,
    }),
    {
      module: "post_sms",
      event: "post_sms_module_disabled",
      outcome: "unavailable",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "post_sms",
      event: "post_sms_manual_required",
      reason: "state_probe_unavailable",
    }),
    {
      module: "post_sms",
      event: "post_sms_manual_required",
      reason: "state_probe_unavailable",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "sms",
      event: "sms_module_failed",
      failureCode: "mac_settings_sms_code_fill_failed",
      diagnostic: SECRET,
    }),
    {
      module: "sms",
      event: "sms_module_failed",
      failureCode: "mac_settings_sms_code_fill_failed",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "sms",
      event: "sms_provider_config_failed",
      failureCode: "mac_settings_sms_provider_url_invalid",
    }),
    {
      module: "sms",
      event: "sms_provider_config_failed",
      failureCode: "mac_settings_sms_provider_url_invalid",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "login",
      event: "mac_settings_login_wait_failed",
      failureCode: "mac_settings_login_wait_timeout",
    }),
    {
      module: "login",
      event: "mac_settings_login_wait_failed",
      failureCode: "mac_settings_login_wait_timeout",
    }
  );
  assert.deepEqual(
    sanitizeMacSettingsEvent({
      module: "login",
      event: "mac_settings_login_wait_failed",
      failureCode: SECRET,
    }),
    {
      module: "login",
      event: "mac_settings_login_wait_failed",
    }
  );
}

function macSettingsFailureCodeSanitizationTest() {
  const timeout = Object.assign(new Error("ignored"), {
    code: "MAC_SETTINGS_LOGIN_WAIT_TIMEOUT",
  });
  assert.equal(sanitizeMacSettingsFailureCode(timeout), "mac_settings_login_wait_timeout");
  assert.equal(
    sanitizeMacSettingsFailureCode(new Error("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID")),
    "mac_settings_sms_provider_url_invalid"
  );
  assert.equal(sanitizeMacSettingsFailureCode(new Error(SECRET)), "unknown");
}

async function waitUntilTimeoutCodeTest() {
  await assert.rejects(
    () =>
      waitUntil("[test] timeout", () => false, {
        timeoutMs: 0,
        allowManualContinuation: false,
        timeoutCode: "MAC_SETTINGS_LOGIN_WAIT_TIMEOUT",
      }),
    (error) => error?.code === "MAC_SETTINGS_LOGIN_WAIT_TIMEOUT"
  );
}

function macSettingsEventAllowlistParityTest() {
  const flow = fs.readFileSync(new URL("./apple-id-full-flow.mjs", import.meta.url), "utf8");
  const sources = [
    fs.readFileSync(new URL("./lib/mac-settings-login.js", import.meta.url), "utf8"),
    fs.readFileSync(new URL("./lib/mac-settings-sms-verification.js", import.meta.url), "utf8"),
    fs.readFileSync(new URL("./lib/mac-settings-post-sms-finalization.js", import.meta.url), "utf8"),
  ];
  const literalEventPattern =
    /(?:emitMacSettingsEvent\s*\(\s*[^,]+,\s*|(?:reportEvent|reportProgress|emitEvent)\s*\()"([a-z_]+)"/g;
  const emitted = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(literalEventPattern)) emitted.add(match[1]);
  }
  const unlisted = [...emitted].filter((event) => !flow.includes(`"${event}"`));
  assert.deepEqual(unlisted, [], "every emitted settings event must survive the flow-audit allowlist");
  for (const event of emitted) {
    assert.equal(
      sanitizeMacSettingsEvent({ module: "login", event }).event,
      event,
      `settings event ${event} must not be downgraded to unknown`
    );
  }
}

function sourceContractTest() {
  const wrapper = fs.readFileSync(new URL("./lib/mac-settings-ax-fill.js", import.meta.url), "utf8");
  const login = fs.readFileSync(new URL("./lib/mac-settings-login.js", import.meta.url), "utf8");
  const flow = fs.readFileSync(new URL("./apple-id-full-flow.mjs", import.meta.url), "utf8");
  const swift = fs.readFileSync(
    new URL("./swift/mac-settings-ax-fill.swift", import.meta.url),
    "utf8"
  );
  const appleScript = fs.readFileSync(
    new URL("./mac-settings-apple-login.applescript", import.meta.url),
    "utf8"
  );

  assert.match(wrapper, /export function normalizeAxFillResult/);
  assert.match(wrapper, /onStatus/);
  assert.match(wrapper, /return \{ ok: false, reason: "compile_failed" \}/);
  assert.doesNotMatch(wrapper, /console\.warn\("\[Mac 设置\] Swift AX helper 编译失败:", r\.stderr/);
  assert.match(login, /export function mayUseAppleScriptFallback/);
  assert.match(login, /MAC_LOGIN_PREWRITE_FAILURE_REASONS\.has\(status\?\.reason\)/);
  assert.match(login, /if \(!mayUseAppleScriptFallback\(swiftStatus\)\)/);
  assert.match(
    login,
    /await fillViaAppleScript\(creds, \{ onStatus: options\.onStatus, onEvent: options\.onEvent \}\)/
  );
  assert.match(login, /appleScriptPhaseFromStep\(lastStep\)/);
  const fallbackGate = login.indexOf("if (!mayUseAppleScriptFallback(swiftStatus))");
  assert.ok(fallbackGate >= 0);
  assert.ok(fallbackGate < login.indexOf('outcome: "fallback"', fallbackGate));
  assert.match(swift, /if isEmail && valueMatchesRequest\(liveHit\.element, text, isEmail: true\)/);
  assert.match(swift, /waitForExactLoginValue\(/);
  assert.match(swift, /let keyboardTargetIsCleared: Bool/);
  assert.match(swift, /if keyboardTargetIsCleared \{/);
  assert.match(swift, /postUnicodeText\(text\)/);
  assert.match(swift, /requireValueChange: false/);
  assert.match(swift, /requireValueChange: true/);
  assert.doesNotMatch(swift, /postCmdA|postCommandKey/);
  assert.match(appleScript, /on currentFrontmostLoginTarget\(/);
  assert.match(appleScript, /set loginTarget to my currentFrontmostLoginTarget\(18, 0\.25\)/);
  assert.match(
    swift,
    /message: "enabled login button not found after password",[\s\S]*?inputRoute: passwordResult\.route/
  );
  assert.match(flow, /"login_status", safeStatus/);
  assert.match(flow, /"login_failure", failureStatus/);
  assert.match(flow, /"initial_signed_in_probe"/);
  assert.match(flow, /"sms_provider_not_configured"/);
  assert.match(flow, /"post_sms_module_disabled"/);
  assert.match(flow, /MAC_SETTINGS_FAILURE_CODES/);
  assert.match(flow, /diagnosticFailureCode/);
  assert.match(flow, /"mac_settings_login_wait_timeout"/);
  assert.match(flow, /"mac_settings_sms_provider_url_invalid"/);
  assert.match(login, /"sms_provider_config_failed"/);
  assert.match(login, /"sms_module_failed"/);
  assert.match(login, /"mac_settings_login_wait_failed"/);
  assert.match(login, /timeoutCode: "MAC_SETTINGS_LOGIN_WAIT_TIMEOUT"/);
  assert.match(
    login,
    /if \(!canConfirmMacSettingsManually\) \{[\s\S]*?error\.code = "MAC_SETTINGS_SMS_HELPER_UNAVAILABLE";[\s\S]*?"sms_module_failed"[\s\S]*?failureCode: macSettingsFailureCode\(error\),[\s\S]*?throw error;/
  );
}

structuredSwiftFailureIsAllowlistedTest();
unsafeHelperFieldsAreDiscardedTest();
malformedHelperOutputIsFixedTest();
credentialReplayGateTest();
appleScriptFailurePhaseTest();
postLoginFailureDoesNotReuseSuccessTest();
macSettingsEventSanitizationTest();
macSettingsFailureCodeSanitizationTest();
macSettingsEventAllowlistParityTest();
await waitUntilTimeoutCodeTest();
sourceContractTest();

console.log("mac settings login observability: ok");
