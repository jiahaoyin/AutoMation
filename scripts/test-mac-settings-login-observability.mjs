import assert from "node:assert/strict";
import fs from "node:fs";

import { normalizeAxFillResult } from "./lib/mac-settings-ax-fill.js";
import {
  appleScriptPhaseFromStep,
  mayUseAppleScriptFallback,
} from "./lib/mac-settings-login.js";
import { resolveMacSettingsFailureStatus } from "./apple-id-full-flow.mjs";

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
  assert.match(login, /await fillViaAppleScript\(creds, \{ onStatus: options\.onStatus \}\)/);
  assert.match(login, /appleScriptPhaseFromStep\(lastStep\)/);
  const fallbackGate = login.indexOf("if (!mayUseAppleScriptFallback(swiftStatus))");
  assert.ok(fallbackGate >= 0);
  assert.ok(fallbackGate < login.indexOf('outcome: "fallback"', fallbackGate));
  assert.match(swift, /if isEmail && valueMatchesRequest\(liveHit\.element, text, isEmail: true\)/);
  assert.match(swift, /waitForExactLoginValue\(/);
  assert.match(swift, /requireValueChange: !isEmail/);
  assert.match(appleScript, /on currentFrontmostLoginTarget\(/);
  assert.match(appleScript, /set loginTarget to my currentFrontmostLoginTarget\(18, 0\.25\)/);
  assert.match(
    swift,
    /message: "enabled login button not found after password",[\s\S]*?inputRoute: passwordResult\.route/
  );
  assert.match(flow, /"login_status", safeStatus/);
  assert.match(flow, /"login_failure", failureStatus/);
}

structuredSwiftFailureIsAllowlistedTest();
unsafeHelperFieldsAreDiscardedTest();
malformedHelperOutputIsFixedTest();
credentialReplayGateTest();
appleScriptFailurePhaseTest();
postLoginFailureDoesNotReuseSuccessTest();
sourceContractTest();

console.log("mac settings login observability: ok");
