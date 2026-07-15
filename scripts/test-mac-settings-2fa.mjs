import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start2FASettingsCodeRequest } from "./lib/mac-settings-2fa.js";
import * as settingsModule from "./lib/mac-settings-2fa.js";
import { isAccessibilityDeniedError } from "./lib/accessibility.js";

const SECRETS = [
  "person@example.com",
  "123456",
  "TOP-SECRET",
  "?token=SECRET",
];
const SECRET_TEXT = SECRETS.join(" ");

function assertNoSecrets(value) {
  const text = String(value ?? "");
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `unexpected secret in output: ${secret}`);
  }
}

function assertSafeError(error) {
  assertNoSecrets(error?.message);
  assertNoSecrets(error?.stack);
  assertNoSecrets(JSON.stringify(Object.fromEntries(Object.entries(error ?? {}))));
}

function readNormalizedText(url) {
  return fs.readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

function readSettingsSwiftSource() {
  return readNormalizedText(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url)
  );
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

async function captureConsole(callback) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const output = [];
  const capture = (...args) => output.push(args.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { output, value: await callback() };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function swiftFunctionBodyFromSource(source, name) {
  const start = source.indexOf(`func ${name}`);
  assert.notEqual(start, -1, `missing Swift function ${name}`);
  const next = source.indexOf("\nfunc ", start + 5);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertSettingsOwnerSafetyContract(source) {
  const openSettings = swiftFunctionBodyFromSource(source, "openAppleAccountSettings");
  assert.match(
    openSettings,
    /openAppleAccountSettings\(deadline:\s*Date\)\s*->\s*NSRunningApplication\?/
  );
  assert.match(
    openSettings,
    /guard\s+let url\s*=\s*URL\(string:\s*s\),\s*NSWorkspace\.shared\.open\(url\)\s+else\s*\{\s*continue\s*\}/,
    "each account URL must use the NSWorkspace.open result as its fallback gate"
  );
  assert.match(
    openSettings,
    /guard\s+!expectsExtension,\s*Date\(\)\s*<\s*deadline\s+else\s*\{\s*return nil\s*\}[\s\S]{0,180}launchApplication/,
    "macOS 13+ must fail closed when every verified account-settings route fails"
  );

  const pageWait = swiftFunctionBodyFromSource(source, "waitForAppleAccountSettingsPage");
  assert.doesNotMatch(pageWait, /(?:true\s*\|\||\|\|\s*true)/);
  assert.match(
    pageWait,
    /if let owner\s*=\s*firstVisibleExactMatchOwner\([\s\S]{0,220}rootPid:\s*rootPid[\s\S]{0,180}names:\s*appleAccountPageEvidence[\s\S]{0,400}trustedSettingsUIOwner\([\s\S]{0,180}owner\.processIdentifier[\s\S]{0,180}return owner/,
    "page discovery must return the exact trusted owner of the visible evidence element"
  );
  assert.doesNotMatch(pageWait, /treeContainsExactText|stableHits|stableSince/);
  const fastEvidence = swiftFunctionBodyFromSource(source, "firstVisibleExactMatchOwner");
  assert.match(fastEvidence, /elementBelongsToProcess\(appElement,\s*pid:\s*rootPid\)/);
  assert.match(fastEvidence, /let nodePid\s*=\s*elementProcessIdentifier\(node\)/);
  assert.match(fastEvidence, /trustedSettingsUIOwner\(processIdentifier:\s*nodePid\)/);
  assert.match(fastEvidence, /owner\.processIdentifier\s*==\s*nodePid/);
  const exactMatch = fastEvidence.indexOf("if axBool(node", 0);
  const earlyReturn = fastEvidence.indexOf("return owner", exactMatch);
  const continuedTraversal = fastEvidence.indexOf("queue.append(contentsOf:", earlyReturn);
  assert.ok(
    exactMatch >= 0 && earlyReturn > exactMatch && continuedTraversal > earlyReturn,
    "owner discovery must return on the first visible exact evidence with a trusted element PID"
  );
  assert.match(pageWait, /let boundedDeadline\s*=\s*min\(deadline,\s*timeoutDeadline\)/);
  assert.match(pageWait, /stopIfCancelled\(\)/);
  assert.match(pageWait, /remainingMilliseconds\(until:\s*boundedDeadline/);
  assert.match(pageWait, /rootPids:\s*\[pid_t\]\s*=\s*matches\.map/);
  assert.match(pageWait, /uniqueTrustedSettingsApp\(\)/);
  assert.match(pageWait, /trustedSettingsUIOwner\([\s\S]{0,120}owner\.processIdentifier/);
  assert.match(pageWait, /return owner/);

  const exactTree = swiftFunctionBodyFromSource(source, "treeContainsExactText");
  assert.match(
    exactTree,
    /if elementBelongsToProcess\(node,\s*pid:\s*expectedPid\),[\s\S]{0,180}hasExactName\(node,\s*names:\s*names\)/,
    "page context may only come from nodes owned by the selected PID"
  );
  const codeTree = swiftFunctionBodyFromSource(source, "findSixDigitCodeInAlert");
  assert.match(
    codeTree,
    /if elementBelongsToProcess\(node,\s*pid:\s*expectedPid\),[\s\S]{0,180}kAXStaticTextRole[\s\S]{0,120}kAXGroupRole/,
    "verification-code text may only come from nodes owned by the alert PID"
  );

  const actionGate = swiftFunctionBodyFromSource(source, "actionMayProceed");
  assert.match(actionGate, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*expectedPid\)/);
  assert.match(actionGate, /isTrustedSystemSettingsProcess\(expectedPid\)/);
  assert.match(actionGate, /deadline\.map\s*\{\s*Date\(\)\s*<\s*\$0\s*\}/);

  const frameClick = swiftFunctionBodyFromSource(source, "clickElementAtVerifiedFrame");
  const uniqueSettings = swiftFunctionBodyFromSource(source, "uniqueTrustedSettingsApp");
  assert.match(uniqueSettings, /runningApplications\.filter\(isTrustedSystemSettings\)/);
  assert.match(uniqueSettings, /matches\.count\s*==\s*1\s*\?\s*matches\[0\]\s*:\s*nil/);
  assert.doesNotMatch(uniqueSettings, /stopIfCancelled|cancellablePause/);
  assert.match(frameClick, /let settingsApp\s*=\s*uniqueTrustedSettingsApp\(\)/);
  assert.doesNotMatch(frameClick, /waitForSettingsApp\(/);
  const mouseUpCreated = frameClick.indexOf("let mouseUp = CGEvent(");
  const finalOwnerCheck = frameClick.lastIndexOf("guard actionMayProceed(");
  const mouseDownPosted = frameClick.indexOf("mouseDown.post");
  assert.ok(
    mouseUpCreated >= 0 &&
      finalOwnerCheck > mouseUpCreated &&
      mouseDownPosted > finalOwnerCheck,
    "the current unique UI owner must be revalidated immediately before CGEvent posting"
  );
  assert.match(
    frameClick,
    /elementBelongsToProcess\(element,\s*pid:\s*expectedPid\)\s+else\s*\{\s*return false\s*\}[\s\S]{0,220}guard actionMayProceed\([\s\S]{0,180}\)\s+else\s*\{\s*return false\s*\}\s+defer/,
    "no AX query may occur between the final deadline gate and CGEvent posting"
  );
  assert.match(frameClick, /deadline:\s*Date\?\s*=\s*nil/);

  const press = swiftFunctionBodyFromSource(source, "pressElement");
  const scopeChecks = [...press.matchAll(/settingsActionScopeAllowsElement\(/g)].map(
    (match) => match.index
  );
  const pressActions = [...press.matchAll(/AXUIElementPerformAction/g)].map(
    (match) => match.index
  );
  const deadlineChecks = [...press.matchAll(/actionMayProceed\(/g)].map(
    (match) => match.index
  );
  assert.ok(
    scopeChecks.length >= 3 &&
      deadlineChecks.length >= 3 &&
      pressActions.length >= 2 &&
      scopeChecks[0] < pressActions[0] &&
      scopeChecks.at(-1) > pressActions[0] &&
      scopeChecks.at(-1) < pressActions.at(-1),
    "the complete action scope must be revalidated before every AX press"
  );
  assert.match(
    press,
    /guard actionMayProceed\([\s\S]{0,180}\)\s+else\s*\{\s*return false\s*\}\s+let err\s*=\s*AXUIElementPerformAction/,
    "the first AX press must immediately follow its final deadline gate"
  );
  assert.match(
    press,
    /elementBelongsToProcess\(element,\s*pid:\s*expectedPid\)\s+else\s*\{\s*return false\s*\}[\s\S]{0,220}guard actionMayProceed\([\s\S]{0,180}\)\s+else\s*\{\s*return false\s*\}\s+return AXUIElementPerformAction/,
    "the retry AX press must immediately follow its final deadline gate"
  );

  const request = swiftFunctionBodyFromSource(source, "requestVerificationCodeAlert");
  const requestAttemptFlag = request.indexOf("verificationCodeRequested = true");
  const requestActionBranch = request.indexOf("if attempt < 3");
  assert.ok(
    requestAttemptFlag >= 0 && requestAttemptFlag < requestActionBranch,
    "request cleanup state must be set before either button action is attempted"
  );

  const windowlessStatus = swiftFunctionBodyFromSource(
    source,
    "windowlessAppleIDSettingsStatus"
  );
  assert.match(
    windowlessStatus,
    /isTrustedAppleIDSettingsExtension\(owner\)/,
    "windowless actions require the exact AppleIDSettings ExtensionKit owner"
  );
  assert.match(windowlessStatus, /let role\s*=\s*axString\(candidate,\s*kAXRoleAttribute/);
  assert.match(windowlessStatus, /!role\.isEmpty\s+else\s*\{\s*return \.windowRoleInvalid\s*\}/);
  assert.match(windowlessStatus, /if role\s*==\s*kAXWindowRole/);
  assert.match(windowlessStatus, /axElementArrayStrict\(/);
  assert.match(
    windowlessStatus,
    /if hasStandardWindow\s*\{\s*return \.standardWindowPresent\s*\}/,
    "windowless actions must prove the same PID exposes no standard AXWindow"
  );
  const windowlessOwner = swiftFunctionBodyFromSource(
    source,
    "isWindowlessAppleIDSettingsOwner"
  );
  assert.match(windowlessOwner, /windowlessAppleIDSettingsStatus\(/);
  assert.match(windowlessOwner, /==\s*\.eligible/);

  const actionScope = swiftFunctionBodyFromSource(
    source,
    "settingsActionScopeAllowsElement"
  );
  assert.match(actionScope, /if let focusedWindow = focusedWindowForProcess\(expectedPid\)/);
  assert.match(actionScope, /return isWindowlessAppleIDSettingsOwner\(/);
  assert.doesNotMatch(actionScope, /focusedWindow\s*==\s*nil/);

  const activation = swiftFunctionBodyFromSource(source, "activateSystemSettings");
  assert.match(activation, /deadline:\s*Date/);
  assert.match(activation, /let boundedDeadline\s*=\s*min\(deadline,\s*timeoutDeadline\)/);
  assert.match(activation, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*expectedPid\)/);
  assert.match(activation, /focusTimeoutMs\s*=\s*remainingMilliseconds\([\s\S]{0,120}boundedDeadline/);
  const beforeHostActivation = activation.slice(0, activation.indexOf("app.unhide()"));
  assert.match(
    beforeHostActivation,
    /initialWindowlessStatus\s*==\s*\.eligible[\s\S]{0,500}treeContainsExactText\([\s\S]{0,500}return true/,
    "a verified windowless target page must return before host reactivation"
  );

  const ownerLoopStart = source.indexOf("for uiOwnerAttempt in 1...2");
  const ownerLoopEnd = source.indexOf(
    'emit(Output(ok: false, code: nil, message: "Apple Account settings UI unavailable"))',
    ownerLoopStart
  );
  const ownerLoop = source.slice(ownerLoopStart, ownerLoopEnd);
  const windowlessProbe = ownerLoop.indexOf("let verifiedWindowlessOwner");
  const modernHostBranch = ownerLoop.indexOf("if modernHostOwner", windowlessProbe);
  const preservingFocus = ownerLoop.indexOf(
    "focusExistingSettingsWindow(",
    modernHostBranch
  );
  const windowedBranch = ownerLoop.indexOf("if !verifiedWindowlessOwner", windowlessProbe);
  const activationCall = ownerLoop.indexOf("guard activateSystemSettings(", windowedBranch);
  const readyPause = ownerLoop.indexOf("let readyPauseMs");
  const postSettleEvidence = ownerLoop.indexOf(
    "let settledEvidence = visibleExactMatchCounts(",
    readyPause
  );
  const prepareCall = ownerLoop.indexOf("switch prepareVerificationCodeAlert(");
  assert.ok(
    windowlessProbe >= 0 &&
      modernHostBranch > windowlessProbe &&
      preservingFocus > modernHostBranch &&
      windowedBranch > preservingFocus &&
      activationCall > windowedBranch &&
      readyPause > activationCall &&
      postSettleEvidence > readyPause &&
      prepareCall > postSettleEvidence,
    "windowless verified owners must bypass activation while windowed owners are revalidated after settling"
  );
  const existingFocus = swiftFunctionBodyFromSource(source, "focusExistingSettingsWindow");
  assert.match(existingFocus, /focusedWindowForProcess\(expectedPid\)/);
  assert.match(existingFocus, /mainWindows\.count\s*==\s*1/);
  assert.match(existingFocus, /visibleWindows\.count\s*==\s*1/);
  assert.match(existingFocus, /focusTrustedSettingsWindow\(/);
  assert.doesNotMatch(
    existingFocus,
    /openApplication|OpenConfiguration|launchApplication/,
    "modern host preservation must never reopen System Settings"
  );
  const postSettleGuard = ownerLoop.slice(postSettleEvidence, prepareCall);
  assert.match(postSettleGuard, /names:\s*appleAccountPageEvidence/);
  assert.match(postSettleGuard, /expectedPid:\s*settingsPid/);
  assert.match(postSettleGuard, /guard settledEvidence\.visible\s*>\s*0 else \{ continue \}/);
  assert.match(postSettleGuard, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*settingsPid\)/);
  assert.match(postSettleGuard, /guard Date\(\)\s*<\s*deadline else \{ continue \}/);
  assert.match(
    ownerLoop,
    /case \.twoFactorNotFound:[\s\S]{0,100}if uiOwnerAttempt\s*<\s*2\s*\{\s*continue\s*\}[\s\S]{0,180}Two-Factor Authentication not found/,
    "a transient first navigation miss must reopen before failing"
  );

  const exactButton = swiftFunctionBodyFromSource(source, "findExactButton");
  assert.match(
    exactButton,
    /let frame\s*=\s*axFrame\(node\)/,
    "strict button discovery must use the node's real AX frame"
  );
  assert.match(exactButton, /pointIsOnActiveDisplay\(/);
  assert.match(
    exactButton,
    /return matches\.count\s*==\s*1\s*\?\s*matches\[0\]\s*:\s*nil/,
    "strict button discovery must fail closed unless one button exists"
  );
}

function runSettingsOwnerMutationResistanceTest() {
  const source = readSettingsSwiftSource();
  assertSettingsOwnerSafetyContract(source);

  const ignoredOpenResult = source.replace(
    "guard let url = URL(string: s), NSWorkspace.shared.open(url) else { continue }",
    "guard let url = URL(string: s) else { continue }\n        _ = NSWorkspace.shared.open(url)"
  );
  assert.notEqual(ignoredOpenResult, source, "open-result mutation fixture must apply");
  assert.throws(
    () => assertSettingsOwnerSafetyContract(ignoredOpenResult),
    /fallback gate/
  );

  const unconditionalPageEvidence = source.replace(
    "if let owner = firstVisibleExactMatchOwner(",
    "if let owner = trustedSettingsUIOwner("
  );
  assert.notEqual(
    unconditionalPageEvidence,
    source,
    "page-evidence mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(unconditionalPageEvidence),
    assert.AssertionError
  );

  const delayedEvidenceReturn = source.replace(
    "            return owner",
    "            _ = owner"
  );
  assert.notEqual(
    delayedEvidenceReturn,
    source,
    "early evidence-return mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(delayedEvidenceReturn),
    /first visible exact evidence/
  );

  const crossProcessPageEvidence = source.replace(
    "let nodePid = elementProcessIdentifier(node),",
    "let nodePid = Optional(rootPid),"
  );
  assert.notEqual(
    crossProcessPageEvidence,
    source,
    "same-process page-evidence mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(crossProcessPageEvidence),
    assert.AssertionError
  );

  const unboundVerifiedOwner = source.replace(
    "owner.processIdentifier == nodePid,",
    "true,"
  );
  assert.notEqual(
    unboundVerifiedOwner,
    source,
    "verified-owner PID mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(unboundVerifiedOwner),
    assert.AssertionError
  );

  const exactTreeBody = swiftFunctionBodyFromSource(source, "treeContainsExactText");
  const crossPidContextBody = exactTreeBody.replace(
    "if elementBelongsToProcess(node, pid: expectedPid),",
    "if true,"
  );
  const crossPidContext = source.replace(exactTreeBody, crossPidContextBody);
  assert.notEqual(crossPidContext, source, "cross-PID context mutation fixture must apply");
  assert.throws(
    () => assertSettingsOwnerSafetyContract(crossPidContext),
    /page context may only come/
  );

  const codeTreeBody = swiftFunctionBodyFromSource(source, "findSixDigitCodeInAlert");
  const crossPidCodeBody = codeTreeBody.replace(
    "if elementBelongsToProcess(node, pid: expectedPid),",
    "if true,"
  );
  const crossPidCode = source.replace(codeTreeBody, crossPidCodeBody);
  assert.notEqual(crossPidCode, source, "cross-PID code mutation fixture must apply");
  assert.throws(
    () => assertSettingsOwnerSafetyContract(crossPidCode),
    /verification-code text may only come/
  );

  const ownerLoopStart = source.indexOf("for uiOwnerAttempt in 1...2");
  const prepareCall = source.indexOf("switch prepareVerificationCodeAlert(", ownerLoopStart);
  const postSettleEvidence = source.lastIndexOf(
    "    let settledEvidence = visibleExactMatchCounts(",
    prepareCall
  );
  const postSettleEnd = source.indexOf('    logStep(2, "System Settings ready")', postSettleEvidence);
  assert.ok(
    postSettleEvidence > ownerLoopStart && postSettleEnd > postSettleEvidence,
    "post-settle evidence mutation fixture must locate the lifecycle guard"
  );
  const missingPostSettleEvidence =
    source.slice(0, postSettleEvidence) + source.slice(postSettleEnd);
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingPostSettleEvidence),
    /revalidated after settling|windowless verified owners/
  );

  const reopenedModernHost = source.replace(
    "              focusExistingSettingsWindow(\n                  app: app,",
    "              activateSystemSettings(\n                  app,"
  );
  assert.notEqual(
    reopenedModernHost,
    source,
    "modern-host reopen mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(reopenedModernHost),
    assert.AssertionError
  );

  const finalClickGuard = [
    "    guard actionMayProceed(",
    "        deadline: deadline,",
    "        appElement: appElement,",
    "        expectedPid: expectedPid",
    "    ) else { return false }",
    "    defer { mouseUp.post(tap: .cghidEventTap) }",
  ].join("\n");
  const missingFinalClickGuard = source.replace(
    finalClickGuard,
    "    defer { mouseUp.post(tap: .cghidEventTap) }"
  );
  assert.notEqual(
    missingFinalClickGuard,
    source,
    "final-action mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingFinalClickGuard),
    /final deadline gate|immediately before CGEvent/
  );

  const missingRequestAttemptState = source.replace(
    "verificationCodeRequested = true",
    "_ = verificationCodeRequested"
  );
  assert.notEqual(
    missingRequestAttemptState,
    source,
    "request-attempt state mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingRequestAttemptState),
    /before either button action/
  );

  const recursiveCancelCleanup = source.replace(
    "let settingsApp = uniqueTrustedSettingsApp()",
    "let settingsApp = waitForSettingsApp(timeoutMs: 0)"
  );
  assert.notEqual(
    recursiveCancelCleanup,
    source,
    "cleanup-cancellation mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(recursiveCancelCleanup),
    assert.AssertionError
  );

  const genericWindowlessOwner = source.replace(
    "isTrustedAppleIDSettingsExtension(owner) else { return .ownerUntrusted }",
    "isTrustedSystemSettings(owner) else { return .ownerUntrusted }"
  );
  assert.notEqual(
    genericWindowlessOwner,
    source,
    "windowless-owner identity mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(genericWindowlessOwner),
    /exact AppleIDSettings ExtensionKit owner/
  );

  const uncheckedStandardWindow = source.replace(
    "if hasStandardWindow { return .standardWindowPresent }",
    "_ = hasStandardWindow"
  );
  assert.notEqual(
    uncheckedStandardWindow,
    source,
    "standard-window mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(uncheckedStandardWindow),
    /no standard AXWindow/
  );

  const nonUniqueButton = source.replace(
    "return matches.count == 1 ? matches[0] : nil",
    "return matches.first"
  );
  assert.notEqual(nonUniqueButton, source, "button-uniqueness mutation fixture must apply");
  assert.throws(
    () => assertSettingsOwnerSafetyContract(nonUniqueButton),
    /unless one button exists/
  );

  const fabricatedButtonFrame = source.replace(
    "let frame = axFrame(node),",
    "let frame = CGRect(x: 0, y: 0, width: 100, height: 40),"
  );
  assert.notEqual(
    fabricatedButtonFrame,
    source,
    "button-frame mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(fabricatedButtonFrame),
    /real AX frame/
  );

  const pressBody = swiftFunctionBodyFromSource(source, "pressElement");
  const finalScopeIndex = pressBody.lastIndexOf("settingsActionScopeAllowsElement(");
  assert.ok(finalScopeIndex >= 0, "second-press mutation fixture must find final scope check");
  const weakenedPressBody =
    pressBody.slice(0, finalScopeIndex) +
    "isTrustedSystemSettingsProcess(" +
    pressBody.slice(finalScopeIndex + "settingsActionScopeAllowsElement(".length);
  const missingSecondPressScope = source.replace(pressBody, weakenedPressBody);
  assert.notEqual(
    missingSecondPressScope,
    source,
    "second-press scope mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingSecondPressScope),
    /before every AX press/
  );

  const ignoredActionDeadline = source.replace(
    "return deadline.map { Date() < $0 } ?? true",
    "return true"
  );
  assert.notEqual(
    ignoredActionDeadline,
    source,
    "action-deadline mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(ignoredActionDeadline),
    assert.AssertionError
  );

  const activationBody = swiftFunctionBodyFromSource(source, "activateSystemSettings");
  const weakenedActivationBody = activationBody.replace(
    "        return true",
    "        _ = initialWindowlessStatus"
  );
  const missingInitialWindowlessReturn = source.replace(
    activationBody,
    weakenedActivationBody
  );
  assert.notEqual(
    missingInitialWindowlessReturn,
    source,
    "initial-windowless-return mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingInitialWindowlessReturn),
    /return before host reactivation/
  );
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
}

function createHarness() {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-2fa-settings-"));
  const child = createChild();
  let spawnCall = null;
  const timers = [];
  const runtime = {
    platform: "darwin",
    helperPath: "/tmp/fake-mac-settings-2fa-code",
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay, active: true });
      return timers.length - 1;
    },
    clearTimeout(index) {
      if (timers[index]) timers[index].active = false;
    },
  };

  return {
    child,
    reportDir,
    runtime,
    timers,
    get spawnCall() {
      return spawnCall;
    },
    fireTimer(index) {
      const timer = timers[index];
      assert.equal(timer?.active, true, `timer ${index} is not active`);
      timer.active = false;
      timer.callback();
    },
    fireTimersThrough(elapsedMs) {
      for (const timer of timers) {
        if (!timer.active || timer.delay > elapsedMs) continue;
        timer.active = false;
        timer.callback();
      }
    },
    cancelFile() {
      const index = spawnCall.args.indexOf("--cancel-file");
      assert.notEqual(index, -1);
      return spawnCall.args[index + 1];
    },
    cleanup() {
      const cancelFile = spawnCall ? this.cancelFile() : null;
      if (cancelFile && fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile);
      fs.rmdirSync(reportDir);
    },
  };
}

function runStaleBinaryCompileFailureTest() {
  assert.equal(
    typeof settingsModule.is2FASettingsHelperAvailable,
    "function",
    "settings helper availability API is required"
  );
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-helper-compile-"));
  const sourcePath = path.join(fixtureDir, "mac-settings-2fa-code.swift");
  const binaryPath = path.join(fixtureDir, "mac-settings-2fa-code");
  const oldTime = new Date(Date.now() - 10_000);
  fs.writeFileSync(sourcePath, "// source\n");
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  fs.utimesSync(binaryPath, oldTime, oldTime);

  const compilerCalls = [];
  try {
    const availableAfterFailure = settingsModule.is2FASettingsHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      spawnSync(command, args) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath });
        fs.writeFileSync(outputPath, "partial-output\n", { mode: 0o755 });
        return { status: 1, stdout: "", stderr: "compile failed" };
      },
    });
    assert.equal(availableAfterFailure, false, "settings helper must reject the stale binary");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.equal(compilerCalls.length, 1, "settings helper must attempt recompilation");
    assert.equal(compilerCalls[0].command, "/usr/bin/xcrun");
    assert.equal(compilerCalls[0].args[0], "swiftc");
    assert.notEqual(compilerCalls[0].outputPath, binaryPath, "settings helper must compile to a temporary path");
    assert.equal(fs.existsSync(compilerCalls[0].outputPath), false, "failed output must be removed");

    const availableAfterSuccess = settingsModule.is2FASettingsHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      spawnSync(command, args) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath });
        fs.writeFileSync(outputPath, "new-binary\n", { mode: 0o755 });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(availableAfterSuccess, true, "settings helper should accept the new binary");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "new-binary\n");
    assert.equal(compilerCalls[1].command, "/usr/bin/xcrun");
    assert.equal(compilerCalls[1].args[0], "swiftc");
    assert.notEqual(compilerCalls[1].outputPath, binaryPath, "settings helper replacement must be atomic");
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

function runMissingSourceRejectsOldBinaryTest() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-helper-missing-source-"));
  const sourcePath = path.join(fixtureDir, "mac-settings-2fa-code.swift");
  const binaryPath = path.join(fixtureDir, "mac-settings-2fa-code");
  let compilerCalls = 0;
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  try {
    const available = settingsModule.is2FASettingsHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      spawnSync() {
        compilerCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(available, false, "settings helper must fail closed without its Swift source");
    assert.equal(compilerCalls, 0, "settings helper must not compile without source");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

function runNonExecutableCompilerOutputTest() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-helper-non-executable-"));
  const sourcePath = path.join(fixtureDir, "mac-settings-2fa-code.swift");
  const binaryPath = path.join(fixtureDir, "mac-settings-2fa-code");
  const oldTime = new Date(Date.now() - 10_000);
  let compilerOutput = null;
  fs.writeFileSync(sourcePath, "// source\n");
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  fs.utimesSync(binaryPath, oldTime, oldTime);
  try {
    const available = settingsModule.is2FASettingsHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      spawnSync(_command, args) {
        compilerOutput = args[args.indexOf("-o") + 1];
        fs.writeFileSync(compilerOutput, "non-executable-output\n", { mode: 0o644 });
        return { status: 0, stdout: "", stderr: "" };
      },
      accessSync(target, mode) {
        if (target === compilerOutput && mode === fs.constants.X_OK) {
          const error = new Error("compiler product is not executable");
          error.code = "EACCES";
          throw error;
        }
        return fs.accessSync(target, mode);
      },
    });

    assert.equal(available, false, "settings helper must reject a 0644 compiler product");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.ok(compilerOutput, "settings compiler output path was not captured");
    assert.equal(
      fs.existsSync(compilerOutput),
      false,
      "settings helper must remove the rejected compiler product"
    );
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

async function runSuccessTest() {
  const harness = createHarness();
  const screenshotDir = path.join(harness.reportDir, "must-not-exist");
  const screenshotPath = path.join(screenshotDir, "verification-code.png");
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
      screenshotPath,
    });
    assert.equal(fs.existsSync(harness.cancelFile()), false);
    assert.equal(harness.spawnCall.args.includes("--screenshot"), false);
    assert.equal(fs.existsSync(screenshotDir), false);

    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          code: "123 456",
          raw: SECRET_TEXT,
          screenshot: `C:/tmp/${SECRET_TEXT}`,
        }) + "\n"
      )
    );
    harness.child.emit("close", 0, null);

    assert.deepEqual(await request.promise, { code: "123456" });
    assert.equal(fs.existsSync(screenshotDir), false);
    assert.equal(fs.existsSync(harness.cancelFile()), false);
  } finally {
    if (fs.existsSync(screenshotDir)) fs.rmdirSync(screenshotDir);
    harness.cleanup();
  }
}

async function runSensitiveOutputSanitizationTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
    });
    const { output, value: error } = await captureConsole(async () => {
      harness.child.stderr.emit("data", Buffer.from(`${SECRET_TEXT}\n${SECRET_TEXT}\n`));
      harness.child.stdout.emit("data", Buffer.from(`not-json ${SECRET_TEXT}\n`));
      harness.child.emit("close", 23, "SIGTERM");
      return rejectionOf(request.promise);
    });

    assertSafeError(error);
    assertNoSecrets(output.join("\n"));
    assert.deepEqual(output, ["[2FA] helper reported diagnostics"]);
    assert.equal(error.code, "2FA_SETTINGS_INVALID_OUTPUT");
    assert.equal(error.hasHelperStderr, true);
    assert.match(error.message, /invalid output/i);
    assert.match(error.message, /signal SIGTERM/i);
  } finally {
    harness.cleanup();
  }
}

async function runHelperFailureSanitizationTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          reason: "two_factor_not_found",
          message: SECRET_TEXT,
        }) + "\n"
      )
    );
    harness.child.stderr.emit("data", Buffer.from(SECRET_TEXT));
    harness.child.emit("close", 7, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_TWO_FACTOR_NOT_FOUND");
    assert.equal(error.hasHelperStderr, true);
    assert.equal(error.hasHelperMessage, true);
    assert.match(error.message, /could not find Two-Factor Authentication/i);
    assert.doesNotMatch(error.message, /exit 7|helper failed/i);
  } finally {
    harness.cleanup();
  }
}

async function runAccessibilityFailureClassificationTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          reason: "accessibility_unavailable",
          message: SECRET_TEXT,
        }) +
          "\n"
      )
    );
    harness.child.emit("close", 1, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_ACCESSIBILITY_DENIED");
    assert.match(error.message, /requires Accessibility permission/);
    assert.equal(isAccessibilityDeniedError(error), true);
  } finally {
    harness.cleanup();
  }
}

async function runFixedHelperReasonMappingTest() {
  const cases = [
    ["two_factor_not_found", "2FA_SETTINGS_TWO_FACTOR_NOT_FOUND"],
    ["verification_alert_not_opened", "2FA_SETTINGS_ALERT_NOT_OPENED"],
    ["verification_alert_not_found", "2FA_SETTINGS_ALERT_NOT_FOUND"],
    ["verification_alert_cleanup_failed", "2FA_SETTINGS_ALERT_CLEANUP_FAILED"],
    ["settings_unavailable", "2FA_SETTINGS_UI_UNAVAILABLE"],
  ];
  for (const [reason, expectedCode] of cases) {
    const harness = createHarness();
    try {
      const request = start2FASettingsCodeRequest({
        reportDir: harness.reportDir,
        runtime: harness.runtime,
        verbose: false,
      });
      harness.child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ ok: false, reason, message: SECRET_TEXT }) + "\n"
        )
      );
      harness.child.emit("close", 1, null);

      const error = await rejectionOf(request.promise);
      assertSafeError(error);
      assert.equal(error.code, expectedCode, `${reason} must have a fixed error code`);
      assertNoSecrets(error.message);
    } finally {
      harness.cleanup();
    }
  }

  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({ ok: false, reason: SECRET_TEXT, message: SECRET_TEXT }) +
          "\n"
      )
    );
    harness.child.emit("close", 9, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_HELPER_EXIT");
    assertNoSecrets(error.message);
  } finally {
    harness.cleanup();
  }
}

async function runChildErrorSanitizationTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    const childError = new Error(SECRET_TEXT);
    childError.code = "EACCES";
    harness.child.emit("error", childError);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.match(error.message, /failed to run/i);
  } finally {
    harness.cleanup();
  }
}

async function runCancelTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    request.cancel();
    assert.equal(fs.existsSync(harness.cancelFile()), true);

    const rejected = assert.rejects(
      request.promise,
      (error) => error?.code === "2FA_SETTINGS_CANCELLED"
    );
    harness.child.stdout.emit("data", Buffer.from('{"ok":false,"message":"cancelled"}\n'));
    harness.child.emit("close", 2, null);
    await rejected;

    assert.equal(fs.existsSync(harness.cancelFile()), false);
    assert.deepEqual(harness.child.killSignals, []);
  } finally {
    harness.cleanup();
  }
}

async function runForceStopAllowsLatePopupCleanupTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    const rejected = assert.rejects(
      request.promise,
      (error) => error?.code === "2FA_SETTINGS_CANCELLED"
    );

    assert.equal(request.forceStop(), true);
    assert.equal(fs.existsSync(harness.cancelFile()), true);
    assert.deepEqual(harness.child.killSignals, []);
    assert.equal(harness.timers.length, 2);
    assert.ok(
      harness.timers[1].delay >= 4_000,
      "force stop must allow the Swift helper's 3-second late-alert cleanup plus polling margin"
    );
    harness.fireTimersThrough(3_200);
    assert.deepEqual(
      harness.child.killSignals,
      [],
      "a helper cleaning a late alert after 3 seconds must not be killed"
    );

    harness.child.stdout.emit("data", Buffer.from('{"ok":false,"message":"cancelled"}\n'));
    harness.child.emit("close", 2, null);
    await rejected;
    assert.equal(fs.existsSync(harness.cancelFile()), false);
    assert.deepEqual(harness.child.killSignals, []);
    assert.equal(harness.timers.every((timer) => timer.active === false), true);
  } finally {
    harness.cleanup();
  }
}

async function runInvalidCodeTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    const rejected = rejectionOf(request.promise);
    harness.child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: true, code: `1234567 ${SECRET_TEXT}` }) + "\n")
    );
    harness.child.emit("close", 0, null);
    const error = await rejected;
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_INVALID_CODE");
    assert.match(error.message, /invalid verification code/i);
    assert.equal(fs.existsSync(harness.cancelFile()), false);
  } finally {
    harness.cleanup();
  }
}

async function runSixtySecondBudgetIncludesCleanupGraceTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      timeoutMs: 60_000,
      verbose: false,
    });
    const rejected = rejectionOf(request.promise);

    assert.equal(harness.timers.length, 1);
    assert.equal(
      harness.timers[0].delay,
      56_000,
      "the four-second alert cleanup grace must be inside the 60-second budget"
    );
    harness.fireTimer(0);
    assert.equal(fs.existsSync(harness.cancelFile()), true);
    assert.deepEqual(harness.child.killSignals, []);
    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[1].delay, 4_000);
    assert.ok(
      harness.timers[0].delay + harness.timers[1].delay <= 60_000,
      "cancel delay plus force-kill grace must not exceed the requested budget"
    );

    harness.fireTimer(1);
    assert.deepEqual(harness.child.killSignals, ["SIGKILL"]);
    harness.child.emit("close", null, "SIGKILL");
    const error = await rejected;
    assert.equal(error.code, "2FA_SETTINGS_TIMEOUT");
    assert.equal(fs.existsSync(harness.cancelFile()), false);
  } finally {
    harness.cleanup();
  }
}

async function runTimeoutKeepsMarkerUntilChildClosesTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      timeoutMs: 1_000,
      verbose: false,
    });
    assert.equal(harness.timers.length, 1);
    assert.equal(
      harness.timers[0].delay,
      0,
      "a timeout shorter than cleanup grace must begin cancellation immediately"
    );
    let settled = false;
    request.promise.catch(() => {
      settled = true;
    });

    harness.fireTimer(0);
    await Promise.resolve();
    assert.deepEqual(harness.child.killSignals, []);
    assert.equal(fs.existsSync(harness.cancelFile()), true);
    assert.equal(settled, false);
    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[1].delay, 1_000);
    assert.ok(
      harness.timers[0].delay + harness.timers[1].delay <= 1_000,
      "tiny timeout cleanup must fail closed within its total budget"
    );

    harness.fireTimer(1);
    assert.deepEqual(harness.child.killSignals, ["SIGKILL"]);

    const rejected = rejectionOf(request.promise);
    harness.child.emit("close", null, "SIGKILL");
    const error = await rejected;
    assert.equal(error.code, "2FA_SETTINGS_TIMEOUT");
    assert.equal(fs.existsSync(harness.cancelFile()), false);
    assert.equal(harness.timers.every((timer) => timer.active === false), true);
  } finally {
    harness.cleanup();
  }
}

function runSwiftCancellationContractTest() {
  const nodeSource = fs.readFileSync(
    new URL("./lib/mac-settings-2fa.js", import.meta.url),
    "utf8"
  );
  const source = readSettingsSwiftSource();
  assert.doesNotMatch(nodeSource, /screenshotPath|--screenshot/);
  assert.match(nodeSource, /let forceKillTimer/);
  const finishBody = nodeSource.slice(
    nodeSource.indexOf("const finish ="),
    nodeSource.indexOf("const appendOutput =")
  );
  assert.match(finishBody, /cancelScheduled\(forceKillTimer\)/);

  const executableCheck = nodeSource.slice(
    nodeSource.indexOf("function binaryIsExecutable"),
    nodeSource.indexOf("export function compile2FASettingsHelper")
  );
  const compileBody = nodeSource.slice(
    nodeSource.indexOf("export function compile2FASettingsHelper"),
    nodeSource.indexOf("export function is2FASettingsHelperAvailable")
  );
  const validate = compileBody.indexOf("binaryIsExecutable(temporaryBin, options)");
  const replace = compileBody.indexOf("renameSync(temporaryBin");
  assert.match(executableCheck, /\.isFile\(\)/);
  assert.match(executableCheck, /fs\.constants\.X_OK/);
  assert.doesNotMatch(compileBody, /chmodSync/);
  assert.ok(
    validate >= 0 && replace > validate,
    "settings helper must validate the untouched compiler product before replacement"
  );

  assert.match(source, /--cancel-file/);
  assert.match(source, /func stopIfCancelled/);
  const normalStart = source.indexOf(
    "stopIfCancelled()\nguard AXIsProcessTrusted() else"
  );
  const accessibilityGate = source.indexOf("guard AXIsProcessTrusted() else", normalStart);
  const ownerAttempts = source.indexOf("for uiOwnerAttempt in 1...2", normalStart);
  assert.ok(
    normalStart >= 0 && accessibilityGate > normalStart && ownerAttempts > accessibilityGate,
    "the Settings helper must fail with a fixed Accessibility classification before AX discovery"
  );
  assert.match(
    source.slice(accessibilityGate, ownerAttempts),
    /Accessibility permission unavailable/
  );
  assert.match(source, /func closeVerificationCodeAlert/);
  assert.match(source, /verificationCodeRequested/);
  assert.match(source, /waitForAlertMs/);
  assert.match(source, /func findExactButton\(/);
  assert.match(
    source,
    /let verificationAlertCloseButtons\s*=\s*\[[\s\S]*"好"[\s\S]*"OK"[\s\S]*"Done"[\s\S]*"完成"[\s\S]*\]/
  );
  assert.match(
    source,
    /closeVerificationCodeAlert\(\s*appElement: appElement,\s*expectedPid: settingsPid,\s*waitForAlertMs: 2_000\s*\)/
  );
  assert.ok(
    source.match(/stopIfCancelled\(/g)?.length >= 6,
    "Swift helper must check cancellation throughout navigation and polling"
  );

  assert.doesNotMatch(source, /alert blob:/i);
  assert.doesNotMatch(source, /\braw\s*:/);
  assert.doesNotMatch(source, /--screenshot/);
  assert.doesNotMatch(source, /screencapture/);
  assert.doesNotMatch(source, /captureSheetScreenshot|captureWindowScreenshot/);
  assert.doesNotMatch(source, /\bscreenshot\s*:/);

  const timeoutFailure = source.slice(
    source.indexOf("guard Date() < deadline, stableHits >= 2, let finalCode = code else"),
    source.indexOf('logStep(7, "verification code detected")')
  );
  const timeoutClose = timeoutFailure.indexOf("closeVerificationCodeAlert");
  const timeoutEmit = timeoutFailure.indexOf("emit(Output");
  assert.ok(timeoutClose >= 0, "normal timeout must attempt alert cleanup");
  assert.ok(timeoutEmit > timeoutClose, "timeout cleanup must precede failure output");

  const finder = swiftFunctionBodyFromSource(source, "waitForSettingsApp");
  const ownerLoop = source.indexOf("for uiOwnerAttempt in 1...2");
  const verifiedOwnerCall = source.indexOf(
    "let settingsUIApp = openAppleAccountSettings(deadline: deadline)",
    ownerLoop
  );
  const axCreate = source.indexOf(
    "AXUIElementCreateApplication(settingsUIApp.processIdentifier)"
  );
  assert.match(source, /func isAppleSystemExecutable/);
  assert.match(source, /executableURL\.lastPathComponent/);
  assert.doesNotMatch(source, /\bfindSettingsApp\s*\(/);
  assert.match(finder, /runningApplications\.filter\(isTrustedSystemSettings\)/);
  assert.doesNotMatch(finder, /localizedName/);
  const settingsWaitStart = source.indexOf("func waitForSettingsApp(");
  const settingsWait = source.slice(
    settingsWaitStart,
    source.indexOf("\nfunc ", settingsWaitStart + 5)
  );
  assert.match(settingsWait, /matches\.count\s*==\s*1/);
  assert.match(settingsWait, /matches\.count\s*>\s*1/);
  assert.match(settingsWait, /Date\(\)\s*>=\s*deadline/);
  assert.ok(
    ownerLoop >= 0 &&
      verifiedOwnerCall > ownerLoop &&
      axCreate > verifiedOwnerCall,
    "each bounded owner attempt must preserve the verified UI owner before AX enumeration"
  );
  const ownerLoopEnd = source.indexOf(
    'emit(Output(ok: false, code: nil, message: "Apple Account settings UI unavailable"))',
    ownerLoop
  );
  const ownerRecovery = source.slice(ownerLoop, ownerLoopEnd);
  assert.match(ownerRecovery, /guard isTrustedSystemSettingsProcess\(settingsPid\) else \{ continue \}/);
  assert.match(ownerRecovery, /case \.ownerLost:\s*continue/);
  assert.match(ownerRecovery, /if ownerLost \{ continue \}/);
  assert.match(ownerRecovery, /waitForSettingsApp\(/);
  assert.match(ownerRecovery, /remainingMilliseconds\(until:\s*deadline,\s*cappedAt:\s*4_000\)/);
  assert.match(ownerRecovery, /openAppleAccountSettings\(deadline:\s*deadline\)/);
  const verifiedOpen = ownerRecovery.indexOf(
    "openAppleAccountSettings(deadline: deadline)"
  );
  const immediateRoot = ownerRecovery.indexOf(
    "let appElement = AXUIElementCreateApplication(",
    verifiedOpen
  );
  assert.ok(verifiedOpen >= 0 && immediateRoot > verifiedOpen);
  assert.doesNotMatch(
    ownerRecovery.slice(verifiedOpen, immediateRoot),
    /cancellablePause|settleMs|waitForSettingsApp/,
    "the verified ExtensionKit owner must become the AX root without a blind delay or re-resolution"
  );
  assert.match(
    ownerRecovery,
    /activateSystemSettings\([\s\S]{0,220}deadline:\s*deadline/,
    "the settings activation phase must share the global deadline"
  );
  assert.match(
    ownerRecovery,
    /let verifiedWindowlessOwner\s*=\s*windowlessAppleIDSettingsStatus\([\s\S]{0,180}==\s*\.eligible[\s\S]{0,180}if modernHostOwner\s*\{[\s\S]{0,300}focusExistingSettingsWindow\([\s\S]{0,220}else if !verifiedWindowlessOwner\s*\{/,
    "modern host and verified windowless owners must bypass host reopening"
  );
  assert.doesNotMatch(source, /func waitForSettingsUIOwner\(/);
  assert.match(
    ownerRecovery,
    /let settingsUIApp\s*=\s*openAppleAccountSettings\(deadline:\s*deadline\)[\s\S]{0,500}let settingsPid\s*=\s*settingsUIApp\.processIdentifier/
  );
  assert.match(
    ownerRecovery,
    /guard !settingsUIApp\.isTerminated,[\s\S]{0,180}isTrustedSystemSettingsProcess\(settingsPid\)[\s\S]{0,260}if isTrustedSystemSettings\(settingsUIApp\)[\s\S]{0,180}else\s*\{[\s\S]{0,120}isTrustedAppleIDSettingsExtension\(settingsUIApp\)/,
    "the exact owner that passed page verification must remain trusted before AX traversal"
  );

  assert.match(
    source,
    /appleIDSettingsExecutablePaths[\s\S]*\/System\/Library\/ExtensionKit\/Extensions\/AppleIDSettings\.appex\/Contents\/MacOS\/AppleIDSettings/
  );
  assert.match(source, /let signInSecurity\s*=\s*\[[\s\S]*"Password & Security"/);
  assert.match(source, /let signInSecurity\s*=\s*\[[\s\S]*"密码与安全性"/);
  assert.match(source, /let signInSecurity\s*=\s*\[[\s\S]*"密碼與安全性"/);
  assert.match(source, /let appleAccountPageEvidence\s*=\s*signInSecurity\s*\+/);
  const extensionTrustStart = source.indexOf("func isTrustedAppleIDSettingsExtension(");
  const extensionTrust = source.slice(
    extensionTrustStart,
    source.indexOf("\nfunc ", extensionTrustStart + 5)
  );
  assert.match(extensionTrust, /standardizedFileURL\.path/);
  assert.match(extensionTrust, /appleIDSettingsExecutablePaths\.contains\(path\)/);
  assert.doesNotMatch(extensionTrust, /hasPrefix|localizedName/);

  const processTrustStart = source.indexOf("func isTrustedSystemSettingsProcess(");
  const processTrust = source.slice(
    processTrustStart,
    source.indexOf("\nfunc ", processTrustStart + 5)
  );
  assert.match(processTrust, /trustedSettingsUIOwner\(processIdentifier:\s*pid\)\s*!=\s*nil/);
  const trustedOwner = swiftFunctionBodyFromSource(source, "trustedSettingsUIOwner");
  assert.match(trustedOwner, /NSRunningApplication\(processIdentifier:\s*pid\)/);
  assert.match(trustedOwner, /!app\.isTerminated/);
  assert.match(trustedOwner, /isTrustedAppleIDSettingsExtension\(app\)/);
  assert.match(trustedOwner, /extensions\.count\s*==\s*1/);
  assert.match(trustedOwner, /isTrustedSystemSettings\(app\)/);
  assert.match(trustedOwner, /settingsApps\.count\s*==\s*1/);
  assert.doesNotMatch(trustedOwner, /localizedName|hasPrefix/);

  const accountUrlBlock = source.slice(
    source.indexOf("let modernAccountUrls"),
    source.indexOf("func logStep")
  );
  assert.ok(
    accountUrlBlock.indexOf("com.apple.AccountSettings.AccountsSettingsExtension") <
      accountUrlBlock.indexOf("com.apple.systempreferences.AppleIDSettings"),
    "macOS 15 Apple Account extension URL must be tried first"
  );
  assert.match(accountUrlBlock, /majorVersion\s*>=\s*13/);

  const openSettingsStart = source.indexOf("func openAppleAccountSettings(");
  const openSettings = source.slice(
    openSettingsStart,
    source.indexOf("\nfunc ", openSettingsStart + 5)
  );
  assert.match(openSettings, /for s in orderedAccountUrls\(\)/);
  assert.match(openSettings, /NSWorkspace\.shared\.open\(url\)/);
  assert.match(openSettings, /else\s*\{\s*continue\s*\}/);
  assert.match(openSettings, /waitForAppleAccountSettingsPage/);
  assert.match(openSettings, /stopIfCancelled\(\)/);
  assert.match(openSettings, /guard Date\(\)\s*<\s*deadline else \{ return nil \}/);
  assert.match(
    openSettings,
    /guard\s+!expectsExtension,\s*Date\(\)\s*<\s*deadline\s+else\s*\{\s*return nil\s*\}/
  );
  assert.ok(
    openSettings.indexOf("continue") < openSettings.indexOf("return owner"),
    "a rejected URL must fall through to the next account-settings route"
  );

  const pageWaitStart = source.indexOf("func waitForAppleAccountSettingsPage(");
  const pageWait = source.slice(
    pageWaitStart,
    source.indexOf("\nfunc ", pageWaitStart + 5)
  );
  assert.match(pageWait, /matches\.count\s*>\s*1[\s\S]{0,80}return nil/);
  assert.match(pageWait, /AXUIElementCreateApplication\(rootPid\)/);
  assert.match(pageWait, /firstVisibleExactMatchOwner\(/);
  assert.match(pageWait, /names:\s*appleAccountPageEvidence/);
  assert.match(pageWait, /rootPid:\s*rootPid/);
  assert.match(pageWait, /if let owner\s*=\s*firstVisibleExactMatchOwner/);
  assert.doesNotMatch(pageWait, /stablePid|stableHits|stableSince|timeIntervalSince/);
  assert.match(pageWait, /cappedAt:\s*50/);
  assert.match(
    openSettings,
    /waitForAppleAccountSettingsPage\([\s\S]{0,100}timeoutMs:\s*5_000,[\s\S]{0,80}deadline:\s*deadline/
  );
  assert.match(pageWait, /let boundedDeadline\s*=\s*min\(deadline,\s*timeoutDeadline\)/);
  assert.match(pageWait, /Date\(\)\s*>=\s*boundedDeadline/);
  assert.match(pageWait, /stopIfCancelled\(\)/);
  assert.ok(
    pageWait.indexOf("firstVisibleExactMatchOwner(") < pageWait.indexOf("return owner"),
    "a pre-existing extension is not success until the target Apple Account page is visible"
  );

  const actionGate = swiftFunctionBodyFromSource(source, "actionMayProceed");
  assert.match(actionGate, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*expectedPid\)/);
  assert.match(actionGate, /isTrustedSystemSettingsProcess\(expectedPid\)/);
  assert.match(actionGate, /deadline\.map\s*\{\s*Date\(\)\s*<\s*\$0\s*\}/);

  const guardedFunctions = [
    "findExactButton",
    "visibleExactMatchCounts",
    "findVerificationCodeAlertRoot",
    "findSixDigitCodeInAlert",
    "findGetCodeButton",
    "clickNamed",
    "focusTrustedSettingsWindow",
    "requestVerificationCodeAlert",
  ];
  for (const name of guardedFunctions) {
    const start = source.indexOf(`func ${name}`);
    const body = source.slice(start, source.indexOf("\nfunc ", start + 5));
    assert.match(
      body,
      /(?:isTrustedSystemSettingsProcess\(expectedPid\)|actionMayProceed\()/,
      `${name} must revalidate the current unique Settings UI owner`
    );
  }

  const pressStart = source.indexOf("func pressElement(");
  const pressBody = source.slice(pressStart, source.indexOf("\nfunc ", pressStart + 5));
  assert.match(pressBody, /expectedPid:\s*pid_t/);
  assert.ok(
    pressBody.indexOf("actionMayProceed(") <
      pressBody.indexOf("AXUIElementPerformAction"),
    "AX press must revalidate the UI owner immediately before acting"
  );

  const systemPath = source.slice(
    source.indexOf("func isAppleSystemExecutable"),
    source.indexOf("func isTrustedSystemSettings")
  );
  assert.match(systemPath, /\/System\/Library\//);
  assert.match(systemPath, /\/System\/Applications\//);
  assert.match(systemPath, /\/usr\/libexec\//);
  assert.doesNotMatch(systemPath, /hasPrefix\("\/System\/"\)/);
  assert.doesNotMatch(systemPath, /\/System\/Volumes\/Data/);

  const logCalls = source.match(/^\s*logStep\([^\n]+\)$/gm) ?? [];
  assert.ok(logCalls.length >= 6, "Swift helper should retain fixed state diagnostics");
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\\\(/, `logStep must not interpolate runtime text: ${call}`);
  }
}

function runStrictVerificationCodeSourceContractTest() {
  const source = readSettingsSwiftSource();
  const functionBody = (name) => {
    const start = source.indexOf("func " + name);
    assert.notEqual(start, -1, "missing Swift function " + name);
    const next = source.indexOf("\nfunc ", start + 5);
    return source.slice(start, next === -1 ? source.length : next);
  };
  const assertOrdered = (body, fragments, message) => {
    let previous = -1;
    for (const fragment of fragments) {
      const current = body.indexOf(fragment);
      assert.ok(current > previous, message + ": missing or out-of-order " + fragment);
      previous = current;
    }
  };

  const exactButton = functionBody("findExactButton");
  assert.match(exactButton, /axRole\(node\)\s*==\s*kAXButtonRole\s+as\s+String/);
  assert.match(exactButton, /elementBelongsToProcess\(node,\s*pid:\s*expectedPid\)/);
  assert.match(exactButton, /hasExactName\(node,\s*names:\s*names\)/);
  assert.match(exactButton, /supportsPressAction\(node\)/);
  assert.doesNotMatch(
    exactButton,
    /blob\.contains|AXLink|kAXMenuItemRole|kAXStaticTextRole|kAXGroupRole/,
    "Get Verification Code matching must not accept prose, links, menu items, text, or containers"
  );

  const exactName = functionBody("hasExactName");
  assert.match(exactName, /axExactTexts\(element\)/);
  assert.match(exactName, /expected\.contains/);
  assert.doesNotMatch(exactName, /blob\.contains|\.contains\(\$0\)/);

  const getCodeFinder = functionBody("findGetCodeButton");
  assert.match(getCodeFinder, /twoFactorNames/);
  assert.match(getCodeFinder, /collectSheetRoots\(appElement,\s*expectedPid:\s*expectedPid\)/);
  assert.match(getCodeFinder, /if roots\.isEmpty \{ roots = \[appElement\] \}/);
  assert.match(getCodeFinder, /elementBelongsToProcess\(root,\s*pid:\s*expectedPid\)/);
  assert.match(getCodeFinder, /treeContainsExactText\(\s*root,/);
  assert.match(getCodeFinder, /let button = findExactButton\(\s*in:\s*root,/);
  assert.match(getCodeFinder, /matches\.count\s*==\s*1/);
  assert.match(
    getCodeFinder,
    /(?:guard|if)[\s\S]{0,300}twoFactorNames/,
    "Get Verification Code must verify the Two-Factor Authentication scope before finding its button"
  );
  assert.ok(
    getCodeFinder.indexOf("twoFactorNames") < getCodeFinder.indexOf("findExactButton("),
    "Two-Factor Authentication scope verification must precede strict button lookup"
  );
  assert.doesNotMatch(
    getCodeFinder,
    /clickNamed|blob\.contains|AXLink|kAXMenuItemRole/,
    "Get Verification Code must use the strict button path"
  );
  assert.match(
    getCodeFinder,
    /settingsActionScopeAllowsElement\(\s*button,\s*appElement:\s*appElement,/
  );
  const sheetRoots = functionBody("collectSheetRoots");
  assert.match(source, /let axSheetsAttribute\s*=\s*"AXSheets"/);
  assert.match(functionBody("axSheets"), /axCopy\(element,\s*axSheetsAttribute\)/);
  assert.match(sheetRoots, /kAXFocusedWindowAttribute/);
  assert.match(sheetRoots, /traversalRoot\s*=\s*focusedWindow/);
  assert.match(sheetRoots, /traversalRoot\s*=\s*appElement/);
  assert.match(sheetRoots, /axSheets\(traversalRoot\)\s*\+\s*axChildren\(traversalRoot\)/);
  assert.match(sheetRoots, /queue\.append\(contentsOf:\s*axSheets\(node\)\)/);
  assert.match(sheetRoots, /seen\.contains/);
  assert.match(sheetRoots, /kAXHiddenAttribute/);
  assert.match(sheetRoots, /isDedicatedDialogWindow\(traversalRoot\)/);
  assert.match(sheetRoots, /kAXWindowRole[\s\S]*isDedicatedDialogWindow\(node\)/);
  assert.doesNotMatch(sheetRoots, /collectWindows\(/);

  const navigationClick = functionBody("clickNamed");
  const navigationAncestor = functionBody("nearestNavigationPressableAncestor");
  assert.match(navigationClick, /expectedPid/);
  assert.match(navigationClick, /hasExactName\(node,\s*names:\s*names\)/);
  assert.match(navigationClick, /nearestNavigationPressableAncestor\(/);
  assert.match(navigationAncestor, /axParent\(candidate\)/);
  assert.match(navigationAncestor, /kAXHiddenAttribute/);
  assert.match(navigationAncestor, /kAXEnabledAttribute[\s\S]{0,100}==\s*true/);
  assert.doesNotMatch(navigationAncestor, /kAXEnabledAttribute[\s\S]{0,100}!=\s*false/);
  assert.match(navigationAncestor, /supportsPressAction\(candidate\)/);
  assert.ok(
    (navigationAncestor.match(/settingsActionScopeAllowsElement\(/g) ?? []).length >= 1 &&
      (navigationClick.match(/settingsActionScopeAllowsElement\(/g) ?? []).length >= 1,
    "window scope must be revalidated during ancestor discovery and immediately before navigation press"
  );
  assert.match(navigationClick, /matches\.count\s*==\s*1/);
  assert.doesNotMatch(navigationClick, /blob\.contains|blob\s*=|names\.contains/);

  const navigationWait = functionBody("waitForTwoFactorNavigationTarget");
  const getCodeWait = functionBody("waitForGetCodeButton");
  assert.match(navigationWait, /findGetCodeButton\(/);
  assert.match(navigationWait, /hasNavigableNamedElement\(/);
  assert.match(navigationWait, /cappedAt:\s*100/);
  assert.match(getCodeWait, /findGetCodeButton\(/);
  assert.match(getCodeWait, /cappedAt:\s*100/);
  assert.doesNotMatch(getCodeWait, /hasNavigableNamedElement\(/);

  assert.match(source, /enum OutputReason: String/);
  assert.match(source, /case twoFactorNotFound = "two_factor_not_found"/);
  assert.match(source, /case accessibilityUnavailable = "accessibility_unavailable"/);
  assert.match(source, /case settingsUnavailable = "settings_unavailable"/);

  const windowlessStatus = functionBody("windowlessAppleIDSettingsStatus");
  assert.match(windowlessStatus, /isTrustedAppleIDSettingsExtension\(owner\)/);
  assert.match(windowlessStatus, /kAXWindowsAttribute/);
  assert.match(windowlessStatus, /axElementArrayStrict\(/);
  assert.match(windowlessStatus, /let role\s*=\s*axString\(candidate,\s*kAXRoleAttribute/);
  assert.match(windowlessStatus, /!role\.isEmpty\s+else\s*\{\s*return \.windowRoleInvalid\s*\}/);
  assert.match(windowlessStatus, /if role\s*==\s*kAXWindowRole/);
  assert.match(windowlessStatus, /if hasStandardWindow\s*\{\s*return \.standardWindowPresent\s*\}/);
  const windowlessOwner = functionBody("isWindowlessAppleIDSettingsOwner");
  assert.match(windowlessOwner, /windowlessAppleIDSettingsStatus\(/);
  assert.match(windowlessOwner, /==\s*\.eligible/);

  const actionScope = functionBody("settingsActionScopeAllowsElement");
  assert.match(actionScope, /if let focusedWindow = focusedWindowForProcess\(expectedPid\)/);
  assert.match(
    actionScope,
    /axWindowForElement\([\s\S]{0,160}expectedPid:\s*expectedPid[\s\S]{0,80}==\s*focusedWindow/
  );
  assert.match(actionScope, /return isWindowlessAppleIDSettingsOwner\(/);

  assert.doesNotMatch(
    source,
    /func logNavigationState\(/,
    "the short-lived ExtensionKit owner must not be consumed by redundant diagnostic traversals"
  );

  const activation = functionBody("activateSystemSettings");
  assertOrdered(
    activation,
    ["let initialWindowlessStatus", "treeContainsExactText(", "app.unhide()", "NSWorkspace.OpenConfiguration()"],
    "a verified windowless Apple Account page must be accepted before host reactivation can reset it"
  );
  assert.match(activation, /initialWindowlessStatus\s*==\s*\.eligible/);
  assert.match(activation, /NSWorkspace\.OpenConfiguration\(\)/);
  assert.match(activation, /app\.unhide\(\)/);
  assert.match(activation, /configuration\.activates\s*=\s*true/);
  assert.match(activation, /activate\(options:\s*\[\.activateAllWindows\]\)/);
  assert.match(activation, /visibleWindows\.filter/);
  assert.match(activation, /dialogs\.count\s*==\s*1/);
  assert.match(activation, /mainWindows\.count\s*==\s*1/);
  assert.match(activation, /visibleWindows\.count\s*==\s*1/);
  assert.match(activation, /focusTrustedSettingsWindow\(/);
  assert.match(activation, /activation state trusted=/);
  assert.match(activation, /AXIsProcessTrusted\(\)/);
  assert.match(activation, /windows=/);
  assert.match(activation, /visible=/);
  assert.match(activation, /dialogs=/);
  assert.match(activation, /main=/);
  assert.match(activation, /kAXHiddenAttribute[\s\S]*kCFBooleanFalse/);
  assert.match(activation, /kAXMinimizedAttribute[\s\S]*kCFBooleanFalse/);
  assert.match(activation, /focusedWindowForProcess\(expectedPid\)[\s\S]{0,180}kAXHiddenAttribute[\s\S]{0,120}axFrame\(focusedWindow\)/);
  assert.match(
    activation,
    /windowlessAppleIDSettingsStatus\([\s\S]{0,260}windowlessStatus\s*==\s*\.eligible[\s\S]{0,220}treeContainsExactText\([\s\S]{0,260}names:\s*appleAccountPageEvidence[\s\S]{0,220}return true/
  );
  assert.ok(
    activation.indexOf("treeContainsExactText(") < activation.indexOf("let windows = collectWindows("),
    "windowless target-page evidence must be checked before window diagnostics"
  );
  assert.doesNotMatch(activation, /AXUIElementPerformAction\(window,\s*kAXRaiseAction/);
  assert.match(activation, /pid=/);
  assert.match(activation, /roleWindow=/);
  assert.match(activation, /roleEmpty=/);
  assert.match(activation, /roleSheet=/);
  assert.match(activation, /roleGroup=/);
  assert.match(activation, /roleOther=/);
  assert.match(activation, /hidden=/);
  assert.match(activation, /frameMissing=/);
  assert.match(activation, /windowless=/);
  assert.match(activation, /unhidden=/);
  assert.match(activation, /framed=/);
  assert.match(activation, /minimized=/);
  assert.doesNotMatch(activation, /activateIgnoringOtherApps/);

  const focusWindow = functionBody("focusTrustedSettingsWindow");
  assert.match(focusWindow, /isTrustedSystemSettings\(app\)/);
  assert.match(focusWindow, /app\.unhide\(\)/);
  assert.match(focusWindow, /elementBelongsToProcess\(window,\s*pid:\s*expectedPid\)/);
  assert.match(focusWindow, /kAXRaiseAction/);
  assert.match(focusWindow, /kAXMainAttribute/);
  assert.match(focusWindow, /kAXFocusedAttribute/);
  assert.match(focusWindow, /focusedWindowForProcess\(expectedPid\)\s*==\s*window/);
  assert.doesNotMatch(source, /activateIgnoringOtherApps/);

  const request = functionBody("requestVerificationCodeAlert");
  assert.match(request, /deadline:\s*Date/);
  assert.match(request, /actionMayProceed\([\s\S]{0,120}deadline:\s*deadline/);
  assert.match(
    request,
    /pressExactButton\([\s\S]{0,180}deadline:\s*deadline/
  );
  assert.match(
    request,
    /waitForVerificationCodeAlert\([\s\S]{0,180}deadline:\s*deadline/
  );
  const retryMatch = request.match(/for\s+\w+\s+in\s+1\.\.\.([0-9_]+)/);
  assert.ok(retryMatch, "verification-code request must have a bounded retry loop");
  assert.ok(
    Number(retryMatch[1].replaceAll("_", "")) <= 5,
    "verification-code request retries must remain bounded"
  );
  const loopStart = request.indexOf("for ");
  const loopEnd = request.indexOf(
    "\n    }\n    return waitForVerificationCodeAlert(",
    loopStart
  );
  const retryBody = request.slice(loopStart, loopEnd);
  assert.match(retryBody, /findGetCodeButton\(/);
  const postActionBody = retryBody.slice(retryBody.indexOf("if attempt < 3"));
  assertOrdered(
    postActionBody,
    ["pressExactButton(", "clickElementAtVerifiedFrame(", "waitForVerificationCodeAlert(", "return true"],
    "each click attempt must be followed by bounded alert confirmation"
  );
  assert.doesNotMatch(
    postActionBody.slice(0, postActionBody.indexOf("waitForVerificationCodeAlert(")),
    /return\s+true/,
    "button action success must not be treated as request success"
  );
  const waitTimeout = request.match(
    /waitForVerificationCodeAlert\([\s\S]*?timeoutMs:\s*([0-9_]+)/
  );
  assert.ok(waitTimeout, "verification-code request must use an explicit bounded alert wait");
  assert.ok(
    Number(waitTimeout[1].replaceAll("_", "")) <= 5_000,
    "post-click alert confirmation must not consume the provider timeout"
  );

  const frameClick = functionBody("clickElementAtVerifiedFrame");
  assert.match(frameClick, /axRole\(element\)\s*==\s*kAXButtonRole\s+as\s+String/);
  assert.match(frameClick, /elementBelongsToProcess\(element,\s*pid:\s*expectedPid\)/);
  assert.match(frameClick, /supportsPressAction\(element\)/);
  assert.match(frameClick, /axFrame\(element\)/);
  assertOrdered(
    frameClick,
    ["let mouseDown = CGEvent(", "let mouseUp = CGEvent("],
    "coordinate fallback must construct both mouse events before posting"
  );
  assert.match(frameClick, /mouseDown\.post/);
  assert.match(frameClick, /defer[\s\S]*mouseUp\.post/);
  assert.doesNotMatch(frameClick, /screenshot|ocr|screencapture|CGWindowList/i);
  assert.match(
    request,
    /clickElementAtVerifiedFrame\(\s*button,\s*appElement:\s*appElement,\s*expectedPid:[\s\S]{0,120}deadline:\s*deadline/
  );

  const prepare = functionBody("prepareVerificationCodeAlert");
  assert.match(prepare, /deadline:\s*Date/);
  assert.match(prepare, /clickNamed\([\s\S]{0,180}deadline:\s*deadline/);
  assert.match(
    prepare,
    /requestVerificationCodeAlert\([\s\S]{0,220}deadline:\s*deadline/
  );
  assert.match(prepare, /\.timedOut/);

  const alertRoot = functionBody("findVerificationCodeAlertRoot");
  assert.match(alertRoot, /roots\.append\(appElement\)/);
  assert.match(alertRoot, /queue\.append\(contentsOf:\s*axSheets\(node\)\)/);
  assert.match(alertRoot, /hasExactName\(node,\s*names:\s*verificationAlertTitles\)/);
  assert.match(alertRoot, /for\s+_\s+in\s+0\.\.<10/);
  assert.match(alertRoot, /elementBelongsToProcess\(\w+,\s*pid:\s*expectedPid\)/);
  assert.match(alertRoot, /findExactButton\([\s\S]*?names:\s*verificationAlertCloseButtons[\s\S]*?expectedPid:\s*expectedPid/);
  assert.match(alertRoot, /axParent\(\w+\)/);
  assert.match(alertRoot, /kAXWindowRole/);
  assert.match(alertRoot, /kAXApplicationRole/);
  assertOrdered(
    alertRoot,
    ["hasExactName(node, names: verificationAlertTitles)", "findExactButton(", "return current"],
    "the exact title node and exact close button must resolve to one verified alert container"
  );
  assert.match(alertRoot, /isDedicatedDialogWindow\(current\)/);
  assert.ok(
    alertRoot.indexOf("kAXApplicationRole") < alertRoot.indexOf("return current"),
    "verification-code alert lookup must reject an AXApplication before returning a container"
  );

  const codeCandidate = functionBody("sixDigitCodeCandidates");
  assert.match(codeCandidate, /NSRegularExpression/);
  assert.match(codeCandidate, /\.matches\s*\(/);
  assert.match(codeCandidate, /range/);
  assert.match(codeCandidate, /\[0-9\]\{6\}/);
  assert.match(codeCandidate, /\[0-9\]\{3\}\s+\[0-9\]\{3\}/);
  assert.ok(
    /(?:\(\?<\!|\(\?!|\\b)/.test(codeCandidate),
    "verification-code extraction must use digit boundaries inside alert prose"
  );

  const splitNodeCandidate = functionBody("sixWhitespaceSeparatedDigitNodeCandidate");
  assert.match(splitNodeCandidate, /texts\.count\s*==\s*6/);
  assert.match(splitNodeCandidate, /joined\(separator:\s*" "\)/);
  assert.match(splitNodeCandidate, /\^\[0-9\]\(\?: \[0-9\]\)\{5\}\$/);
  assert.match(splitNodeCandidate, /replacingOccurrences\(of:\s*" ",\s*with:\s*""\)/);

  const acceptsSixSeparatedSingleDigitNodes = (texts) =>
    texts.length === 6 && /^[0-9](?: [0-9]){5}$/.test(texts.join(" "));
  assert.equal(acceptsSixSeparatedSingleDigitNodes(Array(6).fill("7")), true);
  assert.equal(acceptsSixSeparatedSingleDigitNodes(Array(7).fill("7")), false);
  assert.equal(
    acceptsSixSeparatedSingleDigitNodes(["7", "7", "7", "7", "7", "77"]),
    false
  );

  const codeScan = functionBody("findSixDigitCodeInAlert");
  assert.match(codeScan, /kAXStaticTextRole/);
  assert.match(codeScan, /kAXGroupRole/);
  assert.match(codeScan, /sixDigitCodeCandidates\(/);
  assert.match(codeScan, /Set<String>\(\)/);
  assert.match(codeScan, /candidates\.(?:insert|formUnion)/);
  assert.match(codeScan, /candidates\.count\s*==\s*1/);
  assert.match(codeScan, /var singleDigitTextNodes:\s*\[String\]\s*=\s*\[\]/);
  assert.match(codeScan, /role == kAXStaticTextRole as String/);
  assert.match(codeScan, /let nodeTexts = Set\(texts\)/);
  assert.match(
    codeScan,
    /sixWhitespaceSeparatedDigitNodeCandidate\(singleDigitTextNodes\)[\s\S]*candidates\.insert\(code\)/
  );
  assert.doesNotMatch(codeScan, /blobDeep|axDescription\(node\)|extractSixDigit/);

  const scan = functionBody("scanCodeFromAlertOnly");
  assertOrdered(
    scan,
    ["findVerificationCodeAlertRoot(", "findSixDigitCodeInAlert("],
    "code text may only be read after the alert root is verified"
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /findVerificationCodeAlertRoot\(/);
  assert.match(closeAlert, /findExactButton\(/);
  assert.match(closeAlert, /verificationAlertCloseButtons/);
  assert.doesNotMatch(closeAlert, /clickNamed/);

  assert.match(source, /let settingsPid\s*=\s*settingsUIApp\.processIdentifier/);
  const prepareCall = source.slice(source.indexOf("switch prepareVerificationCodeAlert("));
  assert.match(prepareCall, /expectedPid:\s*settingsPid/);
  assert.match(prepareCall, /deadline:\s*deadline/);
  assert.doesNotMatch(source, /blobDeep|findFormattedCodeInTree|extractSixDigit|looksLikeFormattedCode/);
  assert.doesNotMatch(source, /screencapture|captureWindowScreenshot|captureSheetScreenshot|OCR/i);
}

function runVerificationCodeHardeningSourceContractTest() {
  const source = readSettingsSwiftSource();
  const functionBody = (name) => {
    const start = source.indexOf("func " + name);
    assert.notEqual(start, -1, "missing Swift function " + name);
    const next = source.indexOf("\nfunc ", start + 5);
    return source.slice(start, next === -1 ? source.length : next);
  };

  for (const name of [
    "findExactButton",
    "pressExactButton",
    "clickElementAtVerifiedFrame",
  ]) {
    const body = functionBody(name);
    assert.match(
      body,
      /axBool\(\s*\w+\s*,\s*kAXEnabledAttribute\s+as\s+String\s*\)\s*==\s*true/,
      name + " must require AXEnabled == true rather than treating nil as enabled"
    );
    assert.doesNotMatch(
      body,
      /axBool\([\s\S]*kAXEnabledAttribute[\s\S]*\)\s*!=\s*false/,
      name + " must not accept an unknown enabled state"
    );
  }

  const codeCandidates = functionBody("sixDigitCodeCandidates");
  assert.match(codeCandidates, /NSRegularExpression/);
  assert.match(codeCandidates, /\.matches\s*\(/);
  assert.match(
    codeCandidates,
    /(?:for\s+\w+\s+in\s+(?:regex\.)?matches|matches\.(?:map|compactMap))/
  );
  assert.match(codeCandidates, /range/);
  assert.match(codeCandidates, /\[0-9\]\{6\}/);
  assert.match(codeCandidates, /\[0-9\]\{3\}\s+\[0-9\]\{3\}/);
  assert.ok(
    /(?:\(\?<\!|\(\?!|\\b)/.test(codeCandidates),
    "verification-code matching must use digit boundaries inside AX text"
  );

  const codeScan = functionBody("findSixDigitCodeInAlert");
  assert.match(codeScan, /kAXStaticTextRole/);
  assert.match(codeScan, /kAXGroupRole/);
  assert.match(codeScan, /sixDigitCodeCandidates\(/);
  assert.match(codeScan, /Set<String>\(\)/);
  assert.match(codeScan, /candidates\.(?:insert|formUnion)/);
  assert.match(codeScan, /candidates\.count\s*==\s*1/);

  const request = functionBody("requestVerificationCodeAlert");
  const loopStart = request.search(/for\s+\w+\s+in\s+1\.\.\./);
  assert.ok(loopStart >= 0, "verification-code request must retain a bounded retry loop");
  const buttonIndex = request.indexOf("findGetCodeButton(", loopStart);
  assert.ok(buttonIndex > loopStart, "each retry must freshly resolve the Get Verification Code button");

  const closeBeforeLoop = request.indexOf("closeVerificationCodeAlert(");
  assert.ok(
    closeBeforeLoop >= 0 && closeBeforeLoop < loopStart,
    "requestVerificationCodeAlert must close a pre-existing alert before starting retries"
  );
  const preLoop = request.slice(0, loopStart);
  assert.doesNotMatch(
    preLoop,
    /if\s+hasVerificationCodeAlert\([\s\S]{0,240}return\s+true/,
    "a dialog visible before the request must not be accepted as the new request result"
  );

  const alertChecks = [...request.matchAll(/hasVerificationCodeAlert\(/g)].map(
    (match) => match.index
  );
  assert.ok(
    alertChecks.length >= 3,
    "each retry needs pre-button, post-missing-button, and final late-alert checks"
  );
  assert.ok(alertChecks[0] < buttonIndex, "new-alert check must precede button lookup");

  const missingButtonEnd = request.indexOf("continue", buttonIndex);
  assert.ok(missingButtonEnd > buttonIndex, "missing-button path must remain bounded");
  const missingButtonPath = request.slice(request.indexOf("else", buttonIndex), missingButtonEnd);
  assert.match(
    missingButtonPath,
    /(?:hasVerificationCodeAlert|waitForVerificationCodeAlert)\(/,
    "missing-button path must check for a late verification alert before continuing"
  );
  assert.match(
    request,
    /\n    \}\n    return\s+waitForVerificationCodeAlert\(/,
    "retry loop must perform a final bounded late-alert check before failing"
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(
    source,
    /func closeVerificationCodeAlert\([\s\S]*?\)\s*->\s*Bool\s*\{/,
    "alert close helper must report whether cleanup was confirmed"
  );
  assert.match(closeAlert, /waitForAlertMs/);
  assert.match(closeAlert, /deadline/);
  assert.match(closeAlert, /Date\(\)\s*>=\s*deadline/);
  assert.match(closeAlert, /guard isTrustedSystemSettingsProcess\(expectedPid\) else \{ return false \}/);
  assert.match(closeAlert, /findVerificationCodeAlertRoot\(/);
  assert.match(
    closeAlert,
    /return\s+isTrustedSystemSettingsProcess\(expectedPid\)/,
    "an absent alert is success only while the same trusted UI owner is still current"
  );
  assert.match(closeAlert, /let alertGone\s*=\s*findVerificationCodeAlertRoot\(/);
  assert.match(closeAlert, /return alertGone/);
  assert.doesNotMatch(
    closeAlert,
    /guard\s+let\s+\w+\s*=\s*findVerificationCodeAlertRoot\([\s\S]*?else\s*\{\s*return\s*\}/,
    "an initially absent alert must be watched until the bounded deadline"
  );
  assert.ok(
    /findVerificationCodeAlertRoot\([\s\S]{0,200}==\s*nil/.test(
      closeAlert
    ),
    "observed verification alerts must be confirmed gone before close returns true"
  );

  const successStart = source.lastIndexOf(
    'logStep(7, "verification code candidate detected")'
  );
  const successEnd = source.lastIndexOf("emit(Output(ok: true");
  const successPath = source.slice(successStart, successEnd);
  assert.match(
    successPath,
    /(?:guard|if)[\s\S]{0,500}closeVerificationCodeAlert/,
    "the success path must require a true alert-close result"
  );
  assert.match(
    source.slice(successStart),
    /guard closed else[\s\S]{0,280}logStep\(8, "verification code retrieval completed"\)[\s\S]{0,180}emit\(Output\(ok: true/,
    "completion must only be logged after alert cleanup succeeds and immediately before success JSON"
  );
  assert.doesNotMatch(successPath, /verification code detected/);

  const ownerRecoveryStart = source.indexOf("for uiOwnerAttempt in 1...2");
  const ownerRecoveryEnd = source.lastIndexOf(
    'emit(Output(ok: false, code: nil, message: "Apple Account settings UI unavailable"))'
  );
  const ownerRecovery = source.slice(ownerRecoveryStart, ownerRecoveryEnd);
  assert.ok(
    (ownerRecovery.match(/guard\s+isTrustedSystemSettingsProcess\(settingsPid\)\s+else\s*\{\s*continue\s*\}/g) ?? []).length >= 4,
    "every cleanup result must revalidate the ExtensionKit owner before it is consumed"
  );
  assert.match(
    closeAlert,
    /let alertGone\s*=\s*findVerificationCodeAlertRoot\([\s\S]{0,240}guard isTrustedSystemSettingsProcess\(expectedPid\) else \{ return false \}[\s\S]{0,100}return alertGone/,
    "alert disappearance must be followed by a final owner revalidation"
  );

  const stabilityPath = source.slice(
    source.lastIndexOf("var stableHits", successStart),
    successStart
  );
  assert.match(
    stabilityPath,
    /guard\s+Date\(\)\s*<\s*deadline,\s*stableHits\s*>=\s*2/,
    "a single candidate at the deadline must not become the returned code"
  );

  const alertRoot = functionBody("findVerificationCodeAlertRoot");
  const dialogWindow = functionBody("isDedicatedDialogWindow");
  assert.match(source, /kAXSubroleAttribute/);
  assert.match(source, /(?:["']AXDialog["']|kAXDialogSubrole)/);
  assert.match(source, /(?:["']AXSystemDialog["']|kAXSystemDialogSubrole)/);
  assert.match(alertRoot, /kAXWindowRole/);
  assert.match(alertRoot, /kAXApplicationRole/);
  assert.match(alertRoot, /isDedicatedDialogWindow\(current\)/);
  assert.match(
    dialogWindow,
    /(?:kAXSubroleAttribute|subrole)[\s\S]{0,500}(?:AXDialog|AXSystemDialog)/,
    "an AXWindow may be accepted only for an exact dialog subrole"
  );

  const frameClick = functionBody("clickElementAtVerifiedFrame");
  assert.match(
    frameClick,
    /(?:kAXFocusedWindowAttribute|focusedWindow|focused.*window)/i,
    "coordinate fallback must use the focused System Settings window"
  );
  assert.match(frameClick, /axFrame\(element\)/);
  assert.match(
    frameClick,
    /focusedFrame\.contains\(buttonFrame\)/,
    "button center must be contained by the focused window frame"
  );
  assert.match(source, /func hitTestMatchesButton[\s\S]*AXUIElementCopyElementAtPosition/);
  assert.match(frameClick, /defer[\s\S]*mouseUp\.post/);

  assert.doesNotMatch(
    source,
    /OCR|screencapture|captureWindowScreenshot|captureSheetScreenshot|--screenshot/i
  );
  assert.doesNotMatch(source, /\braw\s*:/);
}

function runTraditionalChineseStateContractTest() {
  const source = readSettingsSwiftSource();
  const functionBody = (name) => {
    const start = source.indexOf(`func ${name}`);
    assert.notEqual(start, -1, `missing Swift function ${name}`);
    const next = source.indexOf("\nfunc ", start + 5);
    return source.slice(start, next === -1 ? source.length : next);
  };

  assert.match(
    source,
    /let verificationAlertTitles\s*=\s*\[[\s\S]*"Apple 帳戶驗證碼"[\s\S]*\]/
  );
  assert.match(
    source,
    /let verificationAlertTitles\s*=\s*\[[\s\S]*"Apple 帐户验证码"[\s\S]*\]/
  );

  const scanAlert = functionBody("scanCodeFromAlertOnly");
  assert.match(
    scanAlert,
    /findVerificationCodeAlertRoot\([\s\S]*findSixDigitCodeInAlert\(alert,\s*expectedPid:\s*expectedPid\)/
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /findVerificationCodeAlertRoot\(/);
  assert.match(closeAlert, /findExactButton\(/);
  assert.match(closeAlert, /verificationAlertCloseButtons/);
  assert.match(source, /let verificationAlertCloseButtons\s*=\s*\[[^\]]*"好"/);

  assert.match(source, /let signInSecurity\s*=\s*\[[^\]]*"登入與安全性"/);
  assert.match(source, /let twoFactor\s*=\s*\[[^\]]*"雙重認證"/);
  assert.match(source, /let getCodeBtn\s*=\s*\[[^\]]*"取得驗證碼"/);

  const resumeProbe = source.indexOf(
    "let existingButton = findGetCodeButton(",
    source.indexOf("func prepareVerificationCodeAlert(")
  );
  const signInClick = source.indexOf("if clickNamed(", resumeProbe);
  assert.ok(
    resumeProbe >= 0 && resumeProbe < signInClick,
    "Settings navigation must resume an already-open Two-Factor Authentication sheet"
  );
  assert.match(source.slice(resumeProbe, signInClick), /Two-Factor Authentication already open/);
  assert.doesNotMatch(
    source.slice(signInClick, source.lastIndexOf("requestVerificationCodeAlert(")),
    /treeContainsExactText\(appElement/,
    "resumed navigation must not trust hidden application-tree text"
  );

  const getCodeRequest = source.lastIndexOf("requestVerificationCodeAlert(");
  const scan = source.indexOf("scanCodeFromAlertOnly(", getCodeRequest);
  const requestCall = source.slice(getCodeRequest, scan);
  assert.ok(
    getCodeRequest >= 0 &&
      scan > getCodeRequest &&
      /buttonNames:\s*getCodeBtn/.test(requestCall),
    "zh-Hant navigation must still transition through request, alert scan, and code return"
  );
}

function runManualSettingsPrivacyContractTest() {
  const source = fs.readFileSync(
    new URL("./test-2fa-settings-code.mjs", import.meta.url),
    "utf8"
  );
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(
    packageJson.scripts["test:2fa-settings"],
    "node scripts/test-2fa-settings-code.mjs"
  );
  assert.match(source, /const\s+\{\s*code\s*\}\s*=\s*await fetch2FACodeFromSystemSettings/);
  assert.doesNotMatch(source, /\braw\b|screenshot/i);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:\$\{|\bcode\b)/i);
  assert.match(source, /console\.log\("系统设置验证码测试成功"\)/);
  assert.match(source, /console\.error\("系统设置验证码测试失败"\)/);
  assert.match(source, /catch\s*\{/);
  assert.match(source, /process\.exitCode\s*=\s*1/);
  assert.doesNotMatch(source, /process\.exit\(/);
}

await runSuccessTest();
await runSensitiveOutputSanitizationTest();
await runHelperFailureSanitizationTest();
await runAccessibilityFailureClassificationTest();
await runFixedHelperReasonMappingTest();
await runChildErrorSanitizationTest();
await runCancelTest();
runMissingSourceRejectsOldBinaryTest();
runStaleBinaryCompileFailureTest();
runNonExecutableCompilerOutputTest();
await runForceStopAllowsLatePopupCleanupTest();
await runInvalidCodeTest();
await runSixtySecondBudgetIncludesCleanupGraceTest();
await runTimeoutKeepsMarkerUntilChildClosesTest();
runSettingsOwnerMutationResistanceTest();
runSwiftCancellationContractTest();
runVerificationCodeHardeningSourceContractTest();
runStrictVerificationCodeSourceContractTest();
runTraditionalChineseStateContractTest();
runManualSettingsPrivacyContractTest();

console.log("mac settings 2fa lifecycle: ok");
