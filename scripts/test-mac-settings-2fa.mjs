import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensure2FASettingsAccessibility,
  start2FASettingsCodeRequest,
} from "./lib/mac-settings-2fa.js";
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

function readVisualHelperSwiftSource() {
  return readNormalizedText(
    new URL("./swift/mac-2fa-popup-ocr.swift", import.meta.url)
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
  const requestActionBranch = request.indexOf("if actionAttempts < 2");
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
    /case \.twoFactorNotFound:[\s\S]{0,180}Two-Factor Authentication not found/,
    "a fully elapsed navigation deadline must report a fixed missing-control result"
  );
  assert.match(
    ownerLoop,
    /case \.twoFactorAXUnavailable:[\s\S]{0,220}OutputReason\.twoFactorAXUnavailable\.rawValue/,
    "a fully elapsed sparse AX transition must report a fixed unavailable reason"
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

  const navigationWait = swiftFunctionBodyFromSource(
    source,
    "waitForTwoFactorNavigationTarget"
  );
  const navigationRetry = swiftFunctionBodyFromSource(
    source,
    "pressTwoFactorNavigationUntilGetCode"
  );
  const navigationTimeout = swiftFunctionBodyFromSource(
    source, "navigationTimeoutReadiness"
  );
  const navigationRecovery = swiftFunctionBodyFromSource(
    source, "recoverTrustedSettingsNavigationFocus"
  );
  const navigationPrepare = swiftFunctionBodyFromSource(
    source, "prepareVerificationCodeAlert"
  );
  const navigationEvidence = swiftFunctionBodyFromSource(
    source, "hasVisibleAppleAccountNavigationEvidence"
  );
  const navigationOwnerElement = swiftFunctionBodyFromSource(
    source, "trustedSettingsNavigationOwnerElement"
  );
  assert.match(source, /let navigationAXRecoveryIntervalMs\s*=\s*2_000/);
  assert.doesNotMatch(
    source,
    /twoFactorNavigationTimeoutMs|signInSecurityDeadline|twoFactorDeadline/,
    "a temporary ExtensionKit AX gap must use the request-wide deadline"
  );
  assert.match(
    source,
    /case twoFactorAXUnavailable = "two_factor_ax_unavailable"/,
    "a fully empty AX transition needs a fixed, sanitized terminal reason"
  );
  assert.match(
    navigationTimeout,
    /guard let lastNavigationEvidenceAt else \{ return \.axUnavailable \}/
  );
  assert.match(navigationTimeout, /navigationAXRecoveryIntervalMs/);
  assert.match(
    navigationOwnerElement,
    /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)\.contains\(navigationOwnerPid\)[\s\S]{0,240}AXUIElementCreateApplication\(navigationOwnerPid\)[\s\S]{0,220}elementBelongsToProcess\(ownerElement,\s*pid:\s*navigationOwnerPid/
  );
  assert.match(
    navigationEvidence,
    /trustedSettingsNavigationOwnerElement\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid[\s\S]{0,220}expectedPid:\s*navigationOwnerPid/
  );
  assert.match(
    navigationRecovery,
    /trustedSettingsNavigationOwnerElement\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid[\s\S]{0,320}NSRunningApplication\(processIdentifier:\s*navigationOwnerPid\)[\s\S]{0,220}isTrustedSystemSettings\(settingsOwner\)/,
    "focus recovery may only target the current verified navigation owner"
  );
  assert.match(
    navigationRecovery,
    /focusExistingSettingsWindow\([\s\S]{0,220}expectedPid:\s*navigationOwnerPid/
  );
  assert.doesNotMatch(
    navigationRecovery,
    /uniqueTrustedSettingsApp/,
    "AX recovery must not rebound to another Settings owner"
  );
  for (const body of [navigationWait, navigationRetry]) {
    assert.match(body, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*expectedPid\)/);
    assert.match(body, /var lastNavigationEvidenceAt:\s*Date\?/);
    assert.match(body, /var nextNavigationRecoveryAt\s*=\s*Date\(\)/);
    assert.match(body, /recoverTrustedSettingsNavigationFocus\(/);
    assert.match(body, /navigationTimeoutReadiness\(/);
    assert.match(body, /cancellablePause\(/);
    assert.match(body, /let navigationOwnerPid = twoFactorNavigationOwnerPid \?\? expectedPid/);
    assert.match(body, /hasVisibleAppleAccountNavigationEvidence\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid/);
    assert.match(body, /recoverTrustedSettingsNavigationFocus\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid/);
    assert.match(
      body,
      /if let trackedOwnerPid = twoFactorNavigationOwnerPid,[\s\S]{0,260}trustedSettingsNavigationOwnerElement\([\s\S]{0,200}navigationOwnerPid:\s*trackedOwnerPid[\s\S]{0,180}twoFactorNavigationOwnerPid\s*=\s*nil/
    );
  }
  assert.match(
    navigationPrepare,
    /clickNamedInTrustedSettingsOwners\([\s\S]{0,220}deadline:\s*deadline[\s\S]{0,280}waitForTwoFactorNavigationTarget\([\s\S]{0,240}deadline:\s*deadline/
  );
  assert.match(
    navigationPrepare,
    /pressTwoFactorNavigationUntilGetCode\([\s\S]{0,560}deadline:\s*deadline/
  );
  const navigationOwnerProbe = swiftFunctionBodyFromSource(
    source, "navigableNamedElementOwnerInTrustedSettingsOwners"
  );
  const pinnedNavigationClick = swiftFunctionBodyFromSource(
    source, "clickNamedInTrustedSettingsOwnerPid"
  );
  assert.match(
    navigationWait,
    /twoFactorNavigationOwnerPid:\s*inout\s+pid_t\?/
  );
  assert.match(
    navigationWait,
    /if let ownerPid = navigableNamedElementOwnerInTrustedSettingsOwners\([\s\S]{0,320}twoFactorNavigationOwnerPid\s*=\s*ownerPid/
  );
  assert.match(
    navigationRetry,
    /let targetOwnerPid = twoFactorNavigationOwnerPid \?\?[\s\S]{0,320}navigableNamedElementOwnerInTrustedSettingsOwners\([\s\S]{0,620}clickNamedInTrustedSettingsOwnerPid\([\s\S]{0,180}ownerPid:\s*targetOwnerPid/
  );
  assert.doesNotMatch(
    navigationRetry,
    /clickNamedInTrustedSettingsOwner\(/,
    "a detected Two-Factor owner must not be replaced by a fresh cross-owner click search"
  );
  assert.match(navigationOwnerProbe, /return ownerPid/);
  assert.match(
    pinnedNavigationClick,
    /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)\.contains\(ownerPid\)[\s\S]{0,260}clickNamed\([\s\S]{0,180}expectedPid:\s*ownerPid/
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

  const requestStart = source.indexOf("func requestVerificationCodeAlert");
  assert.ok(requestStart >= 0, "request state mutation needs the normal AX action path");
  const missingRequestAttemptState =
    source.slice(0, requestStart) +
    source.slice(requestStart).replace(
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

  const missingNavigationRecovery = source.replace(
    "            _ = recoverTrustedSettingsNavigationFocus(",
    "            _ = ignoredNavigationFocusRecovery("
  );
  assert.notEqual(
    missingNavigationRecovery,
    source,
    "AX recovery mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingNavigationRecovery),
    /recoverTrustedSettingsNavigationFocus/
  );

  const legacyNavigationCutoff = source.replace(
    "let navigationAXRecoveryIntervalMs = 2_000",
    "let twoFactorNavigationTimeoutMs = 15_000"
  );
  assert.notEqual(
    legacyNavigationCutoff,
    source,
    "legacy navigation-cutoff mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(legacyNavigationCutoff),
    /request-wide deadline|navigationAXRecoveryIntervalMs/
  );

  const missingAxUnavailableReason = source.replace(
    'case twoFactorAXUnavailable = "two_factor_ax_unavailable"',
    'case twoFactorAXUnavailable = "navigation_transition_failed"'
  );
  assert.notEqual(
    missingAxUnavailableReason,
    source,
    "AX-unavailable reason mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(missingAxUnavailableReason),
    /empty AX transition/
  );

  const unpinnedNavigationEvidence = source.replace(
    "let navigationOwnerPid = twoFactorNavigationOwnerPid ?? expectedPid",
    "let navigationOwnerPid = expectedPid"
  );
  assert.notEqual(
    unpinnedNavigationEvidence,
    source,
    "tracked navigation-owner mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(unpinnedNavigationEvidence),
    assert.AssertionError
  );

  const retryBody = swiftFunctionBodyFromSource(
    source,
    "pressTwoFactorNavigationUntilGetCode"
  );
  const crossOwnerRetryBody = retryBody.replace(
    "clickNamedInTrustedSettingsOwnerPid(",
    "clickNamedInTrustedSettingsOwner("
  );
  const crossOwnerRetry = source.replace(retryBody, crossOwnerRetryBody);
  assert.notEqual(
    crossOwnerRetry,
    source,
    "detected-owner click mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsOwnerSafetyContract(crossOwnerRetry),
    /fresh cross-owner click search|clickNamedInTrustedSettingsOwnerPid/
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
      compileIfNeeded: true,
      spawnSync(command, args, options) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath, options });
        fs.writeFileSync(outputPath, "partial-output\n", { mode: 0o755 });
        return { status: 1, stdout: "", stderr: "compile failed" };
      },
    });
    assert.equal(availableAfterFailure, false, "settings helper must reject the stale binary");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.equal(compilerCalls.length, 1, "settings helper must attempt recompilation");
    assert.equal(compilerCalls[0].command, "/usr/bin/xcrun");
    assert.equal(compilerCalls[0].args[0], "swiftc");
    assert.equal(compilerCalls[0].options.timeout, 120_000);
    assert.notEqual(compilerCalls[0].outputPath, binaryPath, "settings helper must compile to a temporary path");
    assert.equal(fs.existsSync(compilerCalls[0].outputPath), false, "failed output must be removed");

    const availableAfterSuccess = settingsModule.is2FASettingsHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      compileIfNeeded: true,
      spawnSync(command, args, options) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath, options });
        fs.writeFileSync(outputPath, "new-binary\n", { mode: 0o755 });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(availableAfterSuccess, true, "settings helper should accept the new binary");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "new-binary\n");
    assert.equal(compilerCalls[1].command, "/usr/bin/xcrun");
    assert.equal(compilerCalls[1].args[0], "swiftc");
    assert.equal(compilerCalls[1].options.timeout, 120_000);
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

function runPreparedOnlySettingsStartNeverCompilesTest() {
  let compilerCalls = 0;
  let spawnCalls = 0;
  const sourcePath = path.join(os.tmpdir(), "missing-active-settings-helper.swift");
  const binaryPath = path.join(os.tmpdir(), "missing-active-settings-helper");

  assert.throws(
    () =>
      start2FASettingsCodeRequest({
        runtime: {
          platform: "darwin",
          compileIfNeeded: false,
          sourcePath,
          binaryPath,
          spawnSync() {
            compilerCalls += 1;
            return { status: 1 };
          },
          spawn() {
            spawnCalls += 1;
            throw new Error("an unprepared helper must not spawn");
          },
        },
      }),
    (error) => {
      assert.equal(error?.code, "2FA_SETTINGS_UNAVAILABLE");
      return true;
    }
  );
  assert.equal(compilerCalls, 0);
  assert.equal(spawnCalls, 0);
}

function runRuntimeSettingsStartNeverCompilesTest() {
  let compilerCalls = 0;
  let spawnCalls = 0;
  const sourcePath = path.join(os.tmpdir(), "missing-runtime-settings-helper.swift");
  const binaryPath = path.join(os.tmpdir(), "missing-runtime-settings-helper");

  assert.throws(
    () =>
      start2FASettingsCodeRequest({
        runtime: {
          platform: "darwin",
          sourcePath,
          binaryPath,
          spawnSync() {
            compilerCalls += 1;
            return { status: 0 };
          },
          spawn() {
            spawnCalls += 1;
            throw new Error("an unprepared runtime helper must not spawn");
          },
        },
      }),
    (error) => {
      assert.equal(error?.code, "2FA_SETTINGS_UNAVAILABLE");
      return true;
    }
  );
  assert.equal(compilerCalls, 0);
  assert.equal(spawnCalls, 0);
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
      compileIfNeeded: true,
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
          reason: "ok",
          message: "ok",
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

async function runVerificationAlertReadyEventTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    let ready = null;
    void request.alertReady.then((value) => {
      ready = value;
    });

    harness.child.stdout.emit(
      "data",
      Buffer.from('{"event":"verification_alert_ready"}\n')
    );
    await Promise.resolve();
    assert.equal(ready, true, "the fixed readiness event must open this helper's OCR gate");

    harness.child.stdout.emit(
      "data",
      Buffer.from('{"ok":true,"reason":"ok","message":"ok","code":"123456"}\n')
    );
    harness.child.emit("close", 0, null);
    assert.deepEqual(await request.promise, { code: "123456" });
  } finally {
    harness.cleanup();
  }
}

async function runMissingVerificationAlertReadyEventFailsClosedTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    harness.child.stdout.emit(
      "data",
      Buffer.from('{"ok":true,"reason":"ok","message":"ok","code":"123456"}\n')
    );
    harness.child.emit("close", 0, null);
    assert.equal(
      await request.alertReady,
      false,
      "a completed helper without the current alert event must not authorize Settings OCR"
    );
    assert.deepEqual(await request.promise, { code: "123456" });
  } finally {
    harness.cleanup();
  }
}

async function runSettingsAccessibilityPreflightTest() {
  const harness = createHarness();
  try {
    const result = ensure2FASettingsAccessibility({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    assert.equal(harness.spawnCall.args[0], "--preflight-accessibility");
    assert.equal(harness.spawnCall.args[1], "--timeout");
    assert.equal(harness.spawnCall.args[2], "90");

    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          reason: "accessibility_ready",
          message: "ready",
          code: null,
          raw: SECRET_TEXT,
        }) + "\n"
      )
    );
    harness.child.emit("close", 0, null);

    assert.deepEqual(await result, { granted: true });
    assert.equal(fs.existsSync(harness.cancelFile()), false);
  } finally {
    harness.cleanup();
  }
}

async function runFixedSuccessStateTest() {
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
          ok: true,
          reason: "unexpected",
          message: SECRET_TEXT,
          code: "123456",
        }) + "\n"
      )
    );
    harness.child.emit("close", 0, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_HELPER_EXIT");
    assert.match(error.message, /helper failed/i);
  } finally {
    harness.cleanup();
  }
}

async function runSequentialSettingsCodeRequestsTest() {
  const codes = ["123456", "654321"];
  const cancelFiles = new Set();
  for (const code of codes) {
    const harness = createHarness();
    try {
      const request = start2FASettingsCodeRequest({
        reportDir: harness.reportDir,
        runtime: harness.runtime,
        verbose: false,
      });
      cancelFiles.add(harness.cancelFile());
      harness.child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ ok: true, reason: "ok", message: "ok", code }) +
            "\n"
        )
      );
      harness.child.emit("close", 0, null);

      assert.deepEqual(await request.promise, { code });
      assert.equal(fs.existsSync(harness.cancelFile()), false);
    } finally {
      harness.cleanup();
    }
  }
  assert.equal(cancelFiles.size, codes.length);
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
    ["two_factor_ax_unavailable", "2FA_SETTINGS_TWO_FACTOR_AX_UNAVAILABLE"],
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

async function runCancellationCleanupFailureIsPreservedTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    assert.equal(request.cancel(), true);
    harness.child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          reason: "verification_alert_cleanup_failed",
          message: SECRET_TEXT,
        }) + "\n"
      )
    );
    harness.child.emit("close", 1, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.equal(error.code, "2FA_SETTINGS_ALERT_CLEANUP_FAILED");
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
      Buffer.from(
        JSON.stringify({
          ok: true,
          reason: "ok",
          message: "ok",
          code: `1234567 ${SECRET_TEXT}`,
        }) + "\n"
      )
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
  const normalStart = source.lastIndexOf("let deadline = Date().addingTimeInterval(");
  const accessibilityGate = source.indexOf(
    "guard waitForAccessibilityPermission(deadline: deadline) else",
    normalStart
  );
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

function runAccessibilityPromptSourceContractTest() {
  const source = readSettingsSwiftSource();
  const prompt = swiftFunctionBodyFromSource(
    source,
    "requestAccessibilityPermissionPrompt"
  );
  const wait = swiftFunctionBodyFromSource(
    source,
    "waitForAccessibilityPermission"
  );

  assert.match(
    prompt,
    /kAXTrustedCheckOptionPrompt\.takeUnretainedValue\(\)\s+as\s+String:\s*true/
  );
  assert.match(prompt, /AXIsProcessTrustedWithOptions\(options\)/);
  assert.match(wait, /stopIfCancelled\(\)/);
  assert.match(wait, /if AXIsProcessTrusted\(\)\s*\{ return true \}/);
  assert.match(wait, /guard Date\(\) < deadline else \{ return false \}/);
  assert.match(
    wait,
    /if requestAccessibilityPermissionPrompt\(\), Date\(\) < deadline \{ return true \}/
  );
  assert.equal(
    (wait.match(/requestAccessibilityPermissionPrompt\(\)/g) ?? []).length,
    1,
    "the Accessibility prompt must be requested once before polling"
  );
  assert.match(wait, /remainingMilliseconds\(\s*until:\s*deadline,\s*cappedAt:\s*accessibilityPermissionPollIntervalMs\s*\)/);
  assert.match(wait, /cancellablePause\(UInt32\(pauseMs \* 1_000\)\)/);
  assert.match(source, /let accessibilityPermissionPollIntervalMs\s*=\s*250/);
  assert.doesNotMatch(
    source,
    /NSAppleScript|osascript|import\s+ScreenCaptureKit|import\s+Vision|VNRecognize|SCScreenshotManager/i
  );
  assert.match(source, /mac-2fa-popup-ocr/);

  const mainStart = source.lastIndexOf("let deadline = Date().addingTimeInterval(");
  const accessibilityGate = source.indexOf(
    "guard waitForAccessibilityPermission(deadline: deadline) else",
    mainStart
  );
  const ownerAttempts = source.indexOf("for uiOwnerAttempt in 1...2", mainStart);
  const mainPrefix = source.slice(mainStart, ownerAttempts);
  assert.ok(
    mainStart >= 0 && accessibilityGate > mainStart && ownerAttempts > accessibilityGate,
    "the global timeout must bound permission waiting before Settings AX discovery"
  );
  assert.match(mainPrefix, /TimeInterval\(max\(0, timeoutSec\)\)/);
  assert.match(
    source.slice(accessibilityGate, ownerAttempts),
    /OutputReason\.accessibilityUnavailable\.rawValue/
  );
  assert.match(
    source.slice(accessibilityGate, ownerAttempts),
    /emit\(Output\(ok: false, code: nil, message: "Accessibility permission unavailable"/
  );
  const preflightFlag = source.indexOf('args[i] == "--preflight-accessibility"');
  const preflightSuccess = source.indexOf("if preflightAccessibilityOnly {");
  assert.ok(
    preflightFlag >= 0 &&
      preflightSuccess > accessibilityGate &&
      preflightSuccess < ownerAttempts,
    "the Settings helper accessibility preflight must return before Settings AX discovery"
  );
  assert.match(
    source.slice(preflightSuccess, ownerAttempts),
    /OutputReason\.accessibilityReady\.rawValue/
  );

  const originalPath = source.slice(ownerAttempts);
  assert.match(originalPath, /openAppleAccountSettings\(deadline: deadline\)/);
  assert.match(originalPath, /prepareVerificationCodeAlert\(/);
  assert.match(originalPath, /scanCodeFromAlertOnly\(/);
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

  const getCodeFinder = functionBody("findGetCodeControl");
  const getCodeWrapper = functionBody("findGetCodeButton");
  assert.match(getCodeWrapper, /isTrustedSystemSettingsProcess\(expectedPid\)/);
  assert.match(getCodeWrapper, /findGetCodeControl\(/);
  assert.match(getCodeFinder, /twoFactorNames/);
  assert.match(getCodeFinder, /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)/);
  assert.match(getCodeFinder, /AXUIElementCreateApplication\(ownerPid\)/);
  assert.match(getCodeFinder, /collectSheetRoots\(ownerElement,\s*expectedPid:\s*ownerPid\)/);
  assert.match(
    getCodeFinder,
    /if !roots\.contains\(where:\s*\{ \$0 == ownerElement \}\)\s*\{\s*roots\.append\(ownerElement\)/,
    "Get Verification Code lookup must retain the normal settings root when sheets are present"
  );
  assert.match(getCodeFinder, /elementBelongsToProcess\(root,\s*pid:\s*ownerPid\)/);
  assert.match(getCodeFinder, /treeContainsNavigationName\(\s*root,/);
  assert.match(getCodeFinder, /let button = findExactControlButton\(\s*in:\s*root,/);
  assert.match(getCodeFinder, /contextualMatches\.count\s*==\s*1/);
  assert.match(
    getCodeFinder,
    /if treeContainsNavigationName\([\s\S]{0,260}contextualMatches\.append\(control\)/,
    "Get Verification Code must retain the Two-Factor Authentication scope as its primary lookup"
  );
  assert.doesNotMatch(
    getCodeFinder,
    /clickNamed|blob\.contains|AXLink|kAXMenuItemRole/,
    "Get Verification Code must use the strict button path"
  );
  assert.match(getCodeFinder, /settingsActionScopeAllowsElement\(\s*button,\s*appElement:\s*ownerElement,/);
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
  const crossOwnerNavigationClick = functionBody(
    "clickNamedInTrustedSettingsOwners"
  );
  const crossOwnerNavigationOwner = functionBody(
    "clickNamedInTrustedSettingsOwner"
  );
  const pinnedOwnerNavigationClick = functionBody(
    "clickNamedInTrustedSettingsOwnerPid"
  );
  const crossOwnerNavigationProbe = functionBody(
    "navigableNamedElementOwnerInTrustedSettingsOwners"
  );
  const crossOwnerNavigationProbeBoolean = functionBody(
    "hasNavigableNamedElementInTrustedSettingsOwners"
  );
  const navigationAncestor = functionBody("nearestNavigationPressableAncestor");
  assert.match(navigationClick, /expectedPid/);
  assert.match(navigationClick, /hasNavigationName\(node,\s*names:\s*names\)/);
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
  for (const body of [pinnedOwnerNavigationClick, crossOwnerNavigationProbe]) {
    assert.match(body, /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)/);
    assert.match(body, /AXUIElementCreateApplication\(ownerPid\)/);
    assert.match(body, /ownerPid == expectedPid\s*\?\s*appElement/);
    assert.match(body, /elementBelongsToProcess\(ownerElement,\s*pid:\s*ownerPid\)/);
  }
  assert.match(crossOwnerNavigationOwner, /clickNamedInTrustedSettingsOwnerPid\([\s\S]{0,180}ownerPid:\s*ownerPid[\s\S]{0,160}return ownerPid/);
  assert.match(pinnedOwnerNavigationClick, /clickNamed\([\s\S]{0,180}in:\s*ownerElement[\s\S]{0,180}expectedPid:\s*ownerPid/);
  assert.match(crossOwnerNavigationClick, /clickNamedInTrustedSettingsOwner\([\s\S]{0,220}\)\s*!=\s*nil/);
  assert.match(crossOwnerNavigationProbe, /hasNavigableNamedElement\([\s\S]{0,180}in:\s*ownerElement[\s\S]{0,180}expectedPid:\s*ownerPid/);
  assert.match(crossOwnerNavigationProbeBoolean, /navigableNamedElementOwnerInTrustedSettingsOwners\([\s\S]{0,180}\)\s*!=\s*nil/);

  const navigationWait = functionBody("waitForTwoFactorNavigationTarget");
  const getCodeWait = functionBody("waitForGetCodeButton");
  assert.match(navigationWait, /twoFactorNavigationOwnerPid:\s*inout\s+pid_t\?/);
  assert.match(navigationWait, /confirmedTwoFactorOwnerPid:\s*inout\s+pid_t\?/);
  assert.match(navigationWait, /findGetCodeControl\(/);
  assert.match(navigationWait, /confirmedTwoFactorOwnerPid\s*=\s*control\.ownerPid/);
  assert.match(navigationWait, /twoFactorNavigationOwnerPid\s*=\s*control\.ownerPid/);
  assert.match(
    navigationWait,
    /if let ownerPid = navigableNamedElementOwnerInTrustedSettingsOwners\([\s\S]{0,180}appElement:\s*appElement,[\s\S]{0,120}expectedPid:\s*expectedPid,[\s\S]{0,120}names:\s*twoFactor[\s\S]{0,180}twoFactorNavigationOwnerPid\s*=\s*ownerPid/
  );
  assert.match(navigationWait, /cappedAt:\s*100/);
  assert.match(getCodeWait, /findGetCodeButton\(/);
  assert.match(getCodeWait, /cappedAt:\s*100/);
  assert.doesNotMatch(getCodeWait, /hasNavigableNamedElement\(/);

  const navigationPrepare = functionBody("prepareVerificationCodeAlert");
  assert.match(
    navigationPrepare,
    /_ = clickNamedInTrustedSettingsOwners\([\s\S]{0,180}appElement:\s*appElement,[\s\S]{0,120}expectedPid:\s*expectedPid,[\s\S]{0,120}names:\s*signInSecurity,[\s\S]{0,160}deadline:\s*deadline[\s\S]{0,260}waitForTwoFactorNavigationTarget\([\s\S]{0,220}twoFactorNavigationOwnerPid:\s*&twoFactorNavigationOwnerPid[\s\S]{0,180}deadline:\s*deadline/
  );
  assert.match(
    navigationPrepare,
    /pressTwoFactorNavigationUntilGetCode\([\s\S]{0,180}appElement:\s*appElement,[\s\S]{0,120}expectedPid:\s*expectedPid,[\s\S]{0,220}twoFactorNavigationOwnerPid:\s*&twoFactorNavigationOwnerPid[\s\S]{0,360}deadline:\s*deadline/
  );
  assert.doesNotMatch(source, /twoFactorNavigationTimeoutMs|signInSecurityDeadline|twoFactorDeadline/);

  assert.match(source, /enum OutputReason: String/);
  assert.match(source, /case twoFactorNotFound = "two_factor_not_found"/);
  assert.match(source, /case twoFactorAXUnavailable = "two_factor_ax_unavailable"/);
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
    /pressElement\([\s\S]{0,320}deadline:\s*deadline/
  );
  assert.match(
    request,
    /waitForVerificationCodeAlert\([\s\S]{0,320}deadline:\s*deadline/
  );
  const loopStart = request.indexOf("while Date() < deadline");
  assert.ok(loopStart >= 0, "verification-code request must remain bounded by the global deadline");
  const retryBody = request.slice(loopStart);
  assert.match(retryBody, /findGetCodeControl\(/);
  const postActionBody = retryBody.slice(retryBody.indexOf("if actionAttempts < 2"));
  assertOrdered(
    postActionBody,
    ["pressElement(", "clickElementAtVerifiedFrame(", "waitForVerificationCodeAlert(", "return true"],
    "each click attempt must be followed by bounded alert confirmation"
  );
  assert.doesNotMatch(
    postActionBody.slice(0, postActionBody.indexOf("waitForVerificationCodeAlert(")),
    /return\s+true/,
    "button action success must not be treated as request success"
  );
  assert.match(
    request,
    /timeoutMs:\s*actionAttempts <= 3[\s\S]{0,180}cappedAt:\s*2_000[\s\S]{0,180}cappedAt:\s*250/,
    "post-click confirmation must be short while delayed alerts remain eligible until the global deadline"
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
    /clickElementAtVerifiedFrame\(\s*control\.element,\s*appElement:\s*control\.appElement,\s*expectedPid:\s*control\.ownerPid[\s\S]{0,120}deadline:\s*deadline/
  );

  const prepare = functionBody("prepareVerificationCodeAlert");
  assert.match(prepare, /deadline:\s*Date/);
  assert.match(
    prepare,
    /clickNamedInTrustedSettingsOwners\([\s\S]{0,220}deadline:\s*deadline[\s\S]{0,260}waitForTwoFactorNavigationTarget\([\s\S]{0,240}deadline:\s*deadline/
  );
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
    ["locateVerificationCodeAlert(", "findSixDigitCodeInAlert("],
    "code text may only be read after the alert root is verified"
  );
  assert.match(scan, /alert\.root/);
  assert.match(scan, /expectedPid:\s*alert\.ownerPid/);

  const crossOwnerAlert = functionBody("locateVerificationCodeAlert");
  assert.match(crossOwnerAlert, /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)/);
  assert.match(crossOwnerAlert, /AXUIElementCreateApplication\(ownerPid\)/);
  assert.match(crossOwnerAlert, /findVerificationCodeAlertRoot\([\s\S]{0,180}expectedPid:\s*ownerPid/);
  const alertOwners = functionBody("trustedSettingsOwnerPids");
  assert.match(alertOwners, /runningApplications\.filter\(\s*isTrustedAppleIDSettingsExtension/);
  assert.match(alertOwners, /uniqueTrustedSettingsApp\(\)/);
  assert.match(alertOwners, /isTrustedSystemSettingsProcess\(settingsHost\.processIdentifier\)/);

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /locateVerificationCodeAlert\(/);
  assert.match(closeAlert, /findExactButton\(/);
  assert.match(closeAlert, /verificationAlertCloseButtons/);
  assert.match(closeAlert, /appElement:\s*alert\.appElement/);
  assert.match(closeAlert, /expectedPid:\s*alert\.ownerPid/);
  assert.doesNotMatch(closeAlert, /clickNamed/);

  assert.match(source, /let settingsPid\s*=\s*settingsUIApp\.processIdentifier/);
  const prepareCall = source.slice(source.indexOf("switch prepareVerificationCodeAlert("));
  assert.match(prepareCall, /expectedPid:\s*settingsPid/);
  assert.match(prepareCall, /deadline:\s*deadline/);
  assert.doesNotMatch(source, /blobDeep|findFormattedCodeInTree|extractSixDigit|looksLikeFormattedCode/);
  assert.doesNotMatch(
    source,
    /import\s+ScreenCaptureKit|import\s+Vision|VNRecognize|SCScreenshotManager|captureWindowScreenshot|captureSheetScreenshot/i
  );
  assert.match(source, /mac-2fa-popup-ocr/);
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
  const loopStart = request.indexOf("while Date() < deadline");
  assert.ok(loopStart >= 0, "verification-code request must wait only within its global deadline");
  const buttonIndex = request.indexOf("findGetCodeControl(", loopStart);
  assert.ok(buttonIndex > loopStart, "each poll must freshly resolve the Get Verification Code control");
  assert.match(request, /var actionAttempts\s*=\s*0/);
  assert.match(request, /var currentRequestActionSucceeded\s*=\s*false/);
  assert.match(
    request,
    /if actionAttempts < 2\s*\{[\s\S]{0,280}pressElement\([\s\S]{0,180}control\.element[\s\S]{0,180}control\.ownerPid/
  );
  assert.match(
    request,
    /else if actionAttempts == 2\s*\{[\s\S]{0,320}clickElementAtVerifiedFrame\([\s\S]{0,180}control\.element[\s\S]{0,180}control\.ownerPid/
  );
  assert.match(request, /actionAttempts\s*\+=\s*1/);

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
    "each poll needs stale-alert cleanup and a pre-action absence check"
  );
  assert.ok(alertChecks[0] < buttonIndex, "new-alert check must precede button lookup");

  const missingButtonEnd = request.indexOf("continue", buttonIndex);
  assert.ok(missingButtonEnd > buttonIndex, "missing-button path must remain bounded");
  const missingButtonPath = request.slice(request.indexOf("else", buttonIndex), missingButtonEnd);
  assert.match(
    missingButtonPath,
    /cancellablePause\(/,
    "missing-button path must wait for the control instead of accepting an unbound alert"
  );
  assert.doesNotMatch(
    missingButtonPath,
    /waitForVerificationCodeAlert\(/,
    "missing-button path must not accept a stale alert without a current action"
  );
  const actionSucceeded = request.indexOf("var actionSucceeded = false");
  const currentAction = request.indexOf("currentRequestActionSucceeded = true", actionSucceeded);
  const confirmationWait = request.indexOf("if waitForVerificationCodeAlert(", currentAction);
  const confirmationGateCleared = request.indexOf(
    "currentRequestActionSucceeded = false",
    confirmationWait
  );
  assert.ok(
    actionSucceeded >= 0 &&
      currentAction > actionSucceeded &&
      confirmationWait > currentAction &&
      confirmationGateCleared > confirmationWait,
    "only a successful current Get Verification Code action may confirm an alert"
  );
  const preActionAlert = request.lastIndexOf("if hasVerificationCodeAlert(", actionSucceeded);
  assert.ok(
    preActionAlert > buttonIndex && preActionAlert < actionSucceeded,
    "an alert that appears after control discovery must be handled before pressing"
  );
  assert.match(
    request,
    /timeoutMs:\s*actionAttempts <= 3[\s\S]{0,180}cappedAt:\s*2_000[\s\S]{0,180}cappedAt:\s*250/,
    "button actions must receive a short confirmation window while delayed alerts remain eligible until the global deadline"
  );
  assert.match(request, /\n    return false\n\}/);

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
  assert.match(closeAlert, /locateVerificationCodeAlert\(/);
  assert.match(
    closeAlert,
    /return\s+isTrustedSystemSettingsProcess\(expectedPid\)/,
    "an absent alert is success only while the same trusted UI owner is still current"
  );
  assert.match(closeAlert, /let alertGone\s*=\s*locateVerificationCodeAlert\(/);
  assert.match(closeAlert, /return alertGone/);
  assert.doesNotMatch(
    closeAlert,
    /guard\s+let\s+\w+\s*=\s*locateVerificationCodeAlert\([\s\S]*?else\s*\{\s*return\s*\}/,
    "an initially absent alert must be watched until the bounded deadline"
  );
  assert.ok(
    /locateVerificationCodeAlert\([\s\S]{0,200}==\s*nil/.test(
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
    /let alertGone\s*=\s*locateVerificationCodeAlert\([\s\S]{0,240}guard isTrustedSystemSettingsProcess\(expectedPid\) else \{ return false \}[\s\S]{0,100}return alertGone/,
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
    /import\s+ScreenCaptureKit|import\s+Vision|VNRecognize|SCScreenshotManager|captureWindowScreenshot|captureSheetScreenshot|--screenshot/i
  );
  assert.match(source, /mac-2fa-popup-ocr/);
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
    /locateVerificationCodeAlert\([\s\S]*findSixDigitCodeInAlert\(\s*alert\.root,\s*expectedPid:\s*alert\.ownerPid\s*\)/
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /locateVerificationCodeAlert\(/);
  assert.match(closeAlert, /findExactButton\(/);
  assert.match(closeAlert, /verificationAlertCloseButtons/);
  assert.match(source, /let verificationAlertCloseButtons\s*=\s*\[[^\]]*"好"/);

  assert.match(source, /let signInSecurity\s*=\s*\[[^\]]*"登入與安全性"/);
  assert.match(source, /let twoFactor\s*=\s*\[[^\]]*"雙重認證"/);
  assert.match(source, /let getCodeBtn\s*=\s*\[[^\]]*"取得驗證碼"/);

  const resumeProbe = source.indexOf(
    "let existingControl = findGetCodeControl(",
    source.indexOf("func prepareVerificationCodeAlert(")
  );
  const signInClick = source.indexOf("_ = clickNamedInTrustedSettingsOwners(", resumeProbe);
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

function simulateSparseAxNavigation({
  deadlineMs,
  targetAtMs,
  readableAtMs = [],
  siblingReadableAtMs = [],
}) {
  const readableAt = new Set(readableAtMs);
  const siblingReadableAt = new Set(siblingReadableAtMs);
  const pollMs = 100;
  const recoveryIntervalMs = 2_000;
  let lastEvidenceAt = null;
  let nextRecoveryAt = 0;
  let recoveries = 0;
  let siblingEvidenceSeen = false;

  for (let now = 0; now < deadlineMs; now += pollMs) {
    const readable = readableAt.has(now) || (targetAtMs != null && now >= targetAtMs);
    const siblingReadable = siblingReadableAt.has(now);
    if (siblingReadable) siblingEvidenceSeen = true;
    if (readable) lastEvidenceAt = now;
    else if (now >= nextRecoveryAt) {
      recoveries += 1;
      nextRecoveryAt = now + recoveryIntervalMs;
    }
    if (targetAtMs != null && now >= targetAtMs) {
      return { outcome: "get_code_ready", recoveries, siblingEvidenceSeen };
    }
  }

  const axUnavailable =
    lastEvidenceAt == null || deadlineMs - lastEvidenceAt >= recoveryIntervalMs;
  return {
    outcome: axUnavailable ? "ax_unavailable" : "two_factor_not_found",
    recoveries,
    siblingEvidenceSeen,
  };
}

function runSparseAxNavigationRecoveryStateTest() {
  const delayedControl = simulateSparseAxNavigation({
    deadlineMs: 60_000,
    targetAtMs: 16_000,
  });
  assert.equal(
    delayedControl.outcome,
    "get_code_ready",
    "a sparse AX surface that recovers after the old 15-second cutoff must continue"
  );
  assert.ok(
    delayedControl.recoveries <= 8,
    "sparse AX recovery must be bounded instead of focusing on every poll"
  );

  const missingAx = simulateSparseAxNavigation({ deadlineMs: 60_000, targetAtMs: null });
  assert.equal(missingAx.outcome, "ax_unavailable");
  assert.ok(
    missingAx.recoveries <= 30,
    "an empty AX tree must use the bounded recovery cadence until the global deadline"
  );

  const readableButMissing = simulateSparseAxNavigation({
    deadlineMs: 60_000,
    targetAtMs: null,
    readableAtMs: Array.from({ length: 600 }, (_, index) => index * 100),
  });
  assert.equal(
    readableButMissing.outcome,
    "two_factor_not_found",
    "a readable page without a target remains distinct from an unavailable AX surface"
  );

  const siblingEvidenceMustNotMask = simulateSparseAxNavigation({
    deadlineMs: 60_000,
    targetAtMs: null,
    siblingReadableAtMs: Array.from({ length: 600 }, (_, index) => index * 100),
  });
  assert.equal(
    siblingEvidenceMustNotMask.outcome,
    "ax_unavailable",
    "a sibling ExtensionKit owner cannot mask the selected owner's empty AX tree"
  );
  assert.equal(
    siblingEvidenceMustNotMask.siblingEvidenceSeen,
    true,
    "the owner-isolation case must include continuously readable sibling evidence"
  );
}

function runEvidenceDrivenSettingsNavigationContractTest() {
  const source = readSettingsSwiftSource();
  const functionBody = (name) => {
    const start = source.indexOf(`func ${name}`);
    assert.notEqual(start, -1, `missing Swift function ${name}`);
    const next = source.indexOf("\nfunc ", start + 5);
    return source.slice(start, next === -1 ? source.length : next);
  };

  const controlTexts = functionBody("axControlTexts");
  const exactControlName = functionBody("hasExactControlName");
  const exactControlButton = functionBody("findExactControlButton");
  const navigationName = functionBody("hasNavigationName");
  assert.match(source, /let controlTextAttributes\s*=\s*exactTextAttributes[\s\S]*kAXIdentifierAttribute/);
  assert.match(controlTexts, /controlTextAttributes/);
  assert.match(navigationName, /axControlTexts\(element\)/);
  assert.match(navigationName, /text\.hasPrefix\(name\)/);
  assert.match(navigationName, /remainder\.first/);
  assert.doesNotMatch(navigationName, /blob\.contains/);
  assert.match(exactControlName, /axControlTexts\(element\)/);
  assert.match(exactControlName, /expected\.contains/);
  assert.match(exactControlButton, /hasExactControlName\(node,\s*names:\s*names\)/);
  assert.match(exactControlButton, /nearestNavigationPressableAncestor\(/);
  assert.match(exactControlButton, /axRole\(button\)\s*==\s*kAXButtonRole/);

  const navigationClick = functionBody("clickNamed");
  const navigationProbe = functionBody("hasNavigableNamedElement");
  const navigationScope = functionBody("treeContainsNavigationName");
  assert.match(navigationClick, /hasNavigationName\(node,\s*names:\s*names\)/);
  assert.match(navigationProbe, /hasNavigationName\(node,\s*names:\s*names\)/);
  assert.match(navigationScope, /hasNavigationName\(node,\s*names:\s*names\)/);
  assert.match(navigationScope, /elementBelongsToProcess\(node,\s*pid:\s*expectedPid\)/);

  const retry = functionBody("pressTwoFactorNavigationUntilGetCode");
  assert.match(retry, /var pressAttempts\s*=\s*0/);
  assert.match(retry, /twoFactorNavigationOwnerPid:\s*inout\s+pid_t\?/);
  assert.match(retry, /confirmedTwoFactorOwnerPid:\s*inout\s+pid_t\?/);
  assert.match(retry, /pressAttempts\s*<\s*3/);
  assert.match(retry, /findGetCodeControl\(/);
  assert.match(
    retry,
    /let targetOwnerPid = twoFactorNavigationOwnerPid \?\?[\s\S]{0,320}navigableNamedElementOwnerInTrustedSettingsOwners\([\s\S]{0,620}clickNamedInTrustedSettingsOwnerPid\([\s\S]{0,180}ownerPid:\s*targetOwnerPid[\s\S]{0,240}confirmedTwoFactorOwnerPid\s*=\s*targetOwnerPid/,
    "the sparse-sheet permission must retain the exact owner that supplied the Two-Factor target"
  );
  assert.doesNotMatch(retry, /clickNamedInTrustedSettingsOwner\(/);
  assert.match(retry, /cappedAt:\s*450/);
  assert.match(retry, /deadline:\s*deadline/);

  const getCodeControl = functionBody("findGetCodeControl");
  const getCodeButton = functionBody("findGetCodeButton");
  const navigationWait = functionBody("waitForTwoFactorNavigationTarget");
  const navigationTimeout = functionBody("navigationTimeoutReadiness");
  const navigationFocusRecovery = functionBody("recoverTrustedSettingsNavigationFocus");
  const navigationEvidence = functionBody("hasVisibleAppleAccountNavigationEvidence");
  const navigationOwnerElement = functionBody("trustedSettingsNavigationOwnerElement");
  const requestAlert = functionBody("requestVerificationCodeAlert");
  const prepare = functionBody("prepareVerificationCodeAlert");
  assert.match(source, /let navigationAXRecoveryIntervalMs\s*=\s*2_000/);
  assert.doesNotMatch(source, /twoFactorNavigationTimeoutMs/);
  assert.match(source, /enum NavigationTargetReadiness[\s\S]*case axUnavailable/);
  assert.match(source, /enum VerificationPreparationResult[\s\S]*case twoFactorAXUnavailable/);
  assert.match(navigationOwnerElement, /trustedSettingsOwnerPids\(expectedPid:\s*expectedPid\)\.contains\(navigationOwnerPid\)/);
  assert.match(navigationOwnerElement, /AXUIElementCreateApplication\(navigationOwnerPid\)/);
  assert.match(navigationOwnerElement, /elementBelongsToProcess\(ownerElement,\s*pid:\s*navigationOwnerPid\)/);
  assert.match(navigationEvidence, /trustedSettingsNavigationOwnerElement\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid/);
  assert.match(navigationEvidence, /visibleExactMatchCounts\([\s\S]{0,260}expectedPid:\s*navigationOwnerPid[\s\S]{0,160}names:\s*appleAccountPageEvidence/);
  assert.match(navigationTimeout, /guard let lastNavigationEvidenceAt else \{ return \.axUnavailable \}/);
  assert.match(navigationTimeout, /navigationAXRecoveryIntervalMs/);
  assert.match(navigationFocusRecovery, /NSRunningApplication\(processIdentifier:\s*navigationOwnerPid\)/);
  assert.match(navigationFocusRecovery, /isTrustedSystemSettings\(settingsOwner\)/);
  assert.match(navigationFocusRecovery, /focusExistingSettingsWindow\([\s\S]{0,200}expectedPid:\s*navigationOwnerPid/);
  assert.doesNotMatch(navigationFocusRecovery, /uniqueTrustedSettingsApp/);
  for (const body of [navigationWait, retry]) {
    assert.match(body, /stopIfCancelled\(appElement:\s*appElement,\s*expectedPid:\s*expectedPid\)/);
    assert.match(body, /var lastNavigationEvidenceAt:\s*Date\?/);
    assert.match(body, /var nextNavigationRecoveryAt\s*=\s*Date\(\)/);
    assert.match(body, /hasVisibleAppleAccountNavigationEvidence\(/);
    assert.match(body, /recoverTrustedSettingsNavigationFocus\(/);
    assert.match(body, /navigationTimeoutReadiness\(/);
    assert.match(body, /cancellablePause\(/);
    assert.match(body, /let navigationOwnerPid = twoFactorNavigationOwnerPid \?\? expectedPid/);
    assert.match(body, /hasVisibleAppleAccountNavigationEvidence\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid/);
    assert.match(body, /recoverTrustedSettingsNavigationFocus\([\s\S]{0,180}navigationOwnerPid:\s*navigationOwnerPid/);
    assert.match(body, /if let trackedOwnerPid = twoFactorNavigationOwnerPid,[\s\S]{0,600}twoFactorNavigationOwnerPid\s*=\s*nil/);
  }
  assert.match(getCodeControl, /confirmedTwoFactorOwnerPid:\s*pid_t\?\s*=\s*nil/);
  assert.match(getCodeControl, /var contextualMatches:\s*\[TrustedSettingsControl\]/);
  assert.match(getCodeControl, /var sparseMatches:\s*\[TrustedSettingsControl\]/);
  assert.match(
    getCodeControl,
    /if treeContainsNavigationName\([\s\S]{0,700}else if let confirmedTwoFactorOwnerPid,[\s\S]{0,180}confirmedTwoFactorOwnerPid\s*==\s*ownerPid[\s\S]{0,700}sparseMatches\.append\(control\)/,
    "the sparse-sheet fallback must remain behind the contextual AX lookup"
  );
  assert.match(
    getCodeControl,
    /guard contextualMatches\.isEmpty,\s*confirmedTwoFactorOwnerPid\s*!=\s*nil,\s*sparseMatches\.count\s*==\s*1 else \{ return nil \}/,
    "a sparse sheet may resolve only one exact Get Verification Code control in its confirmed owner"
  );
  assert.match(
    getCodeButton,
    /confirmedTwoFactorOwnerPid:\s*confirmedTwoFactorOwnerPid/,
    "the button helper must preserve the explicit sparse-sheet owner"
  );
  const navigationLookup = navigationWait.slice(
    navigationWait.indexOf("if let control = findGetCodeControl("),
    navigationWait.indexOf("if let ownerPid = navigableNamedElementOwnerInTrustedSettingsOwners(")
  );
  assert.doesNotMatch(navigationLookup, /confirmedTwoFactorOwnerPid:/,
    "unconfirmed navigation must not use the sparse-sheet fallback");
  assert.match(
    retry,
    /findGetCodeControl\([\s\S]{0,220}confirmedTwoFactorOwnerPid:\s*confirmedTwoFactorOwnerPid/,
    "only the already-confirmed Two-Factor transition may enable sparse lookup"
  );
  assert.match(
    requestAlert,
    /confirmedTwoFactorOwnerPid:\s*inout\s+pid_t\?[\s\S]*findGetCodeControl\([\s\S]{0,260}confirmedTwoFactorOwnerPid:\s*confirmedTwoFactorOwnerPid/,
    "Get Verification Code retries must retain the confirmed navigation owner"
  );
  assert.match(
    requestAlert,
    /guard let control else \{[\s\S]{0,520}confirmedTwoFactorOwnerPid\s*=\s*control\.ownerPid/,
    "a strict cross-owner Get Verification Code control must rebind the sparse fallback owner"
  );
  assert.match(prepare, /var confirmedTwoFactorOwnerPid\s*=\s*existingControl\?\.ownerPid/);
  assert.match(prepare, /var twoFactorNavigationOwnerPid\s*=\s*existingControl\?\.ownerPid/);
  assert.match(
    prepare,
    /waitForTwoFactorNavigationTarget\([\s\S]{0,220}twoFactorNavigationOwnerPid:\s*&twoFactorNavigationOwnerPid[\s\S]{0,180}confirmedTwoFactorOwnerPid:\s*&confirmedTwoFactorOwnerPid/,
    "strict Get Verification Code discovery must preserve its detected navigation owner before a sparse sheet can follow"
  );
  const postNavigationProbe = prepare.slice(
    prepare.indexOf("switch waitForTwoFactorNavigationTarget("),
    prepare.indexOf("logStep(5, \"click Get Verification Code\")")
  );
  assert.match(
    postNavigationProbe,
    /if let control = findGetCodeControl\([\s\S]{0,300}\)\s*\{\s*confirmedTwoFactorOwnerPid\s*=\s*control\.ownerPid/,
    "the post-navigation strict probe must retain its owner through sparse rehydration"
  );
  assert.match(
    prepare,
    /pressTwoFactorNavigationUntilGetCode\([\s\S]{0,240}twoFactorNavigationOwnerPid:\s*&twoFactorNavigationOwnerPid[\s\S]{0,180}confirmedTwoFactorOwnerPid:\s*&confirmedTwoFactorOwnerPid[\s\S]{0,300}twoFactorNavigationVisualTarget:\s*&twoFactorNavigationVisualTarget/,
    "a visible Two-Factor row must stay pinned to its detected owner before sparse lookup"
  );
  assert.match(
    prepare,
    /requestVerificationCodeAlert\([\s\S]{0,320}confirmedTwoFactorOwnerPid:\s*&confirmedTwoFactorOwnerPid/,
    "the request action must inherit only the confirmed navigation owner"
  );

  const masked = functionBody("isMaskedVerificationAlertRoot");
  const maskedFinder = functionBody("findMaskedVerificationAlertRoot");
  const alertFinder = functionBody("findVerificationCodeAlertRoot");
  const alertLocator = functionBody("locateVerificationCodeAlert");
  const closeAlert = functionBody("closeVerificationCodeAlert");
  const alertReadyEvent = functionBody("emitVerificationAlertReady");
  assert.match(source, /let verificationAlertFallbackCloseButtons\s*=\s*\[/);
  assert.match(source, /let maskedVerificationAlertImageNames\s*=\s*\[/);
  assert.match(masked, /guard verificationCodeRequested/);
  assert.match(masked, /treeContainsNavigationName\(/);
  assert.match(masked, /findExactButton\(/);
  assert.match(maskedFinder, /collectWindows\(/);
  assert.match(maskedFinder, /let windowMatches\s*=\s*roots\.filter/);
  assert.match(maskedFinder, /if windowMatches\.count\s*==\s*1/);
  assert.match(maskedFinder, /guard windowMatches\.isEmpty/);
  assert.match(maskedFinder, /isMaskedVerificationAlertRoot\(appElement/);
  assert.match(alertFinder, /findMaskedVerificationAlertRoot\(/);
  assert.match(alertLocator, /usesMaskedCloseButton/);
  assert.match(closeAlert, /verificationAlertFallbackCloseButtons/);
  assert.match(closeAlert, /alert\.usesMaskedCloseButton/);
  assert.match(alertReadyEvent, /verification_alert_ready/);
  assert.ok(
    requestAlert.indexOf("verificationCodeRequested = true") <
      requestAlert.indexOf("if hasVerificationCodeAlert"),
    "stale masked alerts must be recognized before the first Get Verification Code action"
  );
  const prepareCall = source.indexOf("switch prepareVerificationCodeAlert(");
  const readyEvent = source.indexOf("emitVerificationAlertReady()", prepareCall);
  const alertWait = source.indexOf('logStep(6, "waiting for verification code alert', prepareCall);
  assert.ok(
    prepareCall >= 0 && readyEvent > prepareCall && alertWait > readyEvent,
    "the fixed readiness event must be emitted only after the current alert preparation succeeds"
  );
  assert.doesNotMatch(source, /import\s+ScreenCaptureKit|import\s+Vision|VNRecognize|SCScreenshotManager/i);
  assert.match(source, /mac-2fa-popup-ocr/);
}

function assertSettingsVisualFallbackContract(settingsSource, visualSource, nodeSource) {
  const functionBody = (source, name) => swiftFunctionBodyFromSource(source, name);
  const press = functionBody(settingsSource, "pressTwoFactorNavigationUntilGetCode");
  const bindWindow = functionBody(settingsSource, "bindTrustedSettingsNavigationVisualTarget");
  const retainedWindow = functionBody(settingsSource, "retainsTrustedSettingsNavigationVisualTarget");
  const refreshWindow = functionBody(settingsSource, "refreshTrustedSettingsNavigationVisualTarget");
  const invokeVisual = functionBody(settingsSource, "requestVisualGetCodeButton");
  const prepare = functionBody(settingsSource, "prepareVerificationCodeAlert");
  const visualClick = functionBody(visualSource, "clickVisualSettingsGetCode");
  const exactBoxes = functionBody(visualSource, "exactVisualSettingsGetCodeBoxes");
  const stableBox = functionBody(visualSource, "visualSettingsGetCodeBoxIsStable");
  const boundWindow = functionBody(visualSource, "boundOnScreenSettingsWindow");
  const topmost = functionBody(visualSource, "targetWindowIsTopmostAtPoint");
  const hitTest = functionBody(visualSource, "hitTestIsBoundSettingsWindow");

  assert.match(nodeSource, /import\s*\{\s*resolvePrepared2FAOcrHelperPath\s*\}\s*from\s*"\.\/mac-2fa-ocr\.js"/);
  assert.match(nodeSource, /resolvePrepared2FAOcrHelperPath\(\{\s*platform\s*\}\)/);
  assert.match(nodeSource, /if \(visualGetCodeHelperPath\)\s*\{\s*args\.push\("--visual-get-code-helper", visualGetCodeHelperPath\)/);
  assert.match(nodeSource, /preflightAccessibility\s*\?\s*null\s*:/);

  assert.match(settingsSource, /case getCodeRequestedVisually/);
  assert.match(press, /twoFactorNavigationVisualTarget:\s*inout\s+TrustedSettingsVisualTarget\?/);
  assert.match(press, /visualGetCodeHelperPath:\s*String\?/);
  assert.match(press, /var axUnavailableSince:\s*Date\?/);
  assert.match(press, /var visualGetCodeAttempted\s*=\s*false/);
  assert.match(press, /!visualGetCodeAttempted/);
  assert.match(
    press,
    /now\.timeIntervalSince\(unavailableSince\)\s*>=\s*[\s\S]{0,120}navigationAXRecoveryIntervalMs/,
    "visual recovery must wait through the AX-empty interval"
  );
  assert.match(press, /let helperPath = visualGetCodeHelperPath/);
  const postPressAxState = press.slice(
    press.indexOf("if hasVisibleAppleAccountNavigationEvidence("),
    press.indexOf("if let control = findGetCodeControl(")
  );
  assert.match(postPressAxState, /lastNavigationEvidenceAt\s*=\s*now/);
  assert.match(
    postPressAxState,
    /confirmedTwoFactorOwnerPid\s*==\s*navigationOwnerPid[\s\S]{0,240}twoFactorNavigationVisualTarget\s*!=\s*nil[\s\S]{0,180}axUnavailableSince\s*==\s*nil[\s\S]{0,120}axUnavailableSince\s*=\s*now/,
    "the visual timer must track a missing post-press Get Code control"
  );
  assert.doesNotMatch(
    postPressAxState,
    /axUnavailableSince\s*=\s*nil/,
    "generic Login & Security page evidence must not reset the Get Code AX timer"
  );
  assert.match(press, /confirmedOwnerPid == navigationOwnerPid/);
  assert.match(press, /retainsTrustedSettingsNavigationVisualTarget\(/);
  assert.match(press, /visualGetCodeAttempted\s*=\s*true/);
  assert.match(press, /verificationCodeRequested\s*=\s*true/);
  assert.match(press, /closeVerificationCodeAlert\(/);
  assert.match(press, /refreshTrustedSettingsNavigationVisualTarget\([\s\S]{0,180}originalTarget:\s*visualTarget/);
  assert.match(press, /twoFactorNavigationVisualTarget\s*=\s*refreshedVisualTarget/);
  assert.match(press, /requestVisualGetCodeButton\([\s\S]{0,200}appElement:\s*appElement[\s\S]{0,160}expectedPid:\s*expectedPid[\s\S]{0,180}navigationOwnerPid:\s*refreshedVisualTarget\.ownerPid[\s\S]{0,160}navigationWindowID:\s*refreshedVisualTarget\.windowID/);
  assert.match(press, /waitForVerificationCodeAlert\([\s\S]{0,260}return \.getCodeRequestedVisually/);
  assert.doesNotMatch(press, /true\s*\|\|\s*waitForVerificationCodeAlert\(/);
  assert.ok(
    press.indexOf("requestVisualGetCodeButton(") < press.indexOf("waitForVerificationCodeAlert("),
    "visual IPC success must still pass the normal alert gate"
  );
  assert.equal(
    (settingsSource.match(/requestVisualGetCodeButton\(/g) ?? []).length,
    2,
    "the visual helper may only be declared and invoked from the Two-Factor press loop"
  );

  assert.match(bindWindow, /trustedSettingsNavigationOwnerElement\(/);
  assert.match(bindWindow, /visualTargetForFocusedWindow\(navigationOwnerPid\)/);
  assert.match(bindWindow, /windowlessAppleIDSettingsStatus\(/);
  assert.match(bindWindow, /let settingsHost = uniqueTrustedSettingsApp\(\)/);
  assert.match(bindWindow, /visualTargetForFocusedWindow\(settingsHost\.processIdentifier\)/);
  const bindBeforePress = press.indexOf("let visualTarget = targetOwnerPid.flatMap");
  const clickAfterBind = press.indexOf("clickNamedInTrustedSettingsOwnerPid(", bindBeforePress);
  const retainBoundWindow = press.indexOf("twoFactorNavigationVisualTarget = visualTarget", clickAfterBind);
  assert.ok(
    bindBeforePress >= 0 && clickAfterBind > bindBeforePress && retainBoundWindow > clickAfterBind,
    "the exact focused window must be bound before the successful Two-Factor press"
  );
  assert.match(retainedWindow, /visualTarget\.windowID != 0/);
  assert.match(retainedWindow, /trustedSettingsNavigationOwnerElement\(/);
  assert.match(retainedWindow, /isTrustedAppleIDSettingsExtension\(navigationOwner\)/);
  assert.match(retainedWindow, /settingsHost\.processIdentifier == visualTarget\.ownerPid/);
  assert.match(refreshWindow, /retainsTrustedSettingsNavigationVisualTarget\(/);
  assert.match(refreshWindow, /visualTargetForFocusedWindow\(navigationOwnerPid\)/);
  assert.match(refreshWindow, /isTrustedAppleIDSettingsExtension\(navigationOwner\)/);
  assert.match(refreshWindow, /let settingsHost = uniqueTrustedSettingsApp\(\)/);
  assert.match(refreshWindow, /visualTargetForFocusedWindow\(settingsHost\.processIdentifier\)/);
  assert.match(refreshWindow, /refreshedTarget\.ownerPid == originalTarget\.ownerPid/);
  assert.doesNotMatch(
    refreshWindow,
    /bindTrustedSettingsNavigationVisualTarget|windowlessAppleIDSettingsStatus/,
    "a trusted rebind must not reread the AX-empty extension window list"
  );
  assert.match(
    press,
    /twoFactorNavigationOwnerPid\s*=\s*nil[\s\S]{0,180}confirmedTwoFactorOwnerPid\s*=\s*nil[\s\S]{0,180}twoFactorNavigationVisualTarget\s*=\s*nil/,
    "owner invalidation must discard the confirmed owner and its bound window"
  );
  assert.match(prepare, /case \.getCodeRequestedVisually:\s*return \.ready/);
  assert.match(invokeVisual, /--cancel-file/);
  assert.match(invokeVisual, /if let cancelFilePath[\s\S]{0,180}arguments\.append\(contentsOf:\s*\["--cancel-file", cancelFilePath\]\)/);
  assert.match(invokeVisual, /visualGetCodeCancellationRequested\(\)/);
  assert.match(invokeVisual, /terminateVisualGetCodeChild\(/);
  assert.match(invokeVisual, /while Date\(\) < childDeadline/);
  assert.match(invokeVisual, /stopIfCancelled\(appElement: appElement, expectedPid: expectedPid\)/);

  assert.match(visualSource, /--settings-visual-get-code/);
  assert.match(visualSource, /--settings-owner-pid/);
  assert.match(visualSource, /--settings-window-id/);
  assert.match(visualSource, /CGPreflightScreenCaptureAccess\(\)/);
  assert.match(visualClick, /AXIsProcessTrusted\(\)/);
  assert.match(visualClick, /visualGetCodeCancellationRequested\(\)/);
  assert.match(visualClick, /boundOnScreenSettingsWindow\(ownerPid: ownerPid, windowID: windowID\)/);
  assert.match(visualClick, /framesAreVisuallyStable\(initialWindow\.frame, currentWindow\.frame\)/);
  assert.match(visualClick, /framesAreVisuallyStable\(initialWindow\.frame, finalWindow\.frame\)/);
  assert.match(visualClick, /framesAreVisuallyStable\(initialWindow\.frame, postCaptureWindow\.frame\)/);
  assert.match(visualClick, /boxes\.count == 1/);
  assert.match(visualClick, /finalBoxes\.count == 1/);
  assert.match(visualClick, /visualSettingsGetCodeBoxIsStable\(boxes\[0\], finalBoxes\[0\]\)/);
  assert.equal(
    (visualClick.match(/captureWindowByID\(/g) ?? []).length,
    2,
    "the visual action must confirm the label in a fresh capture before clicking"
  );
  assert.match(visualClick, /targetWindowIsTopmostAtPoint\(postCaptureWindow, point: point\)/);
  assert.match(visualClick, /hitTestIsBoundSettingsWindow\(postCaptureWindow, point: point\)/);
  assert.match(visualClick, /mouseDown\.post/);
  assert.match(visualClick, /mouseUp\.post/);
  assert.match(visualClick, /Output\(ok: true, code: nil, source: "vision", message: "visual_get_code_clicked"\)/);
  assert.doesNotMatch(visualClick, /logStep\(|FileHandle\.standard(?:Output|Error)|raw\s*:/i);
  assert.match(exactBoxes, /visualSettingsGetCodeLabels\.contains\(normalizedVisualSettingsLabel\(text\)\)/);
  assert.doesNotMatch(exactBoxes, /range\(of:|contains\(text\)|hasPrefix\(/);
  assert.match(stableBox, /tolerance: CGFloat = 0\.005/);
  assert.match(visualSource, /let visualSettingsGetCodeLabels: Set<String> = \[/);
  assert.match(visualSource, /"get verification code"/);
  assert.match(visualSource, /"get a verification code"/);
  assert.match(boundWindow, /trustedSettingsVisualOwner\(ownerPid\)/);
  assert.match(boundWindow, /optionOnScreenOnly/);
  assert.match(topmost, /CGWindowListCopyWindowInfo/);
  assert.match(topmost, /return CGWindowID\(windowNumber\.uint32Value\) == target\.windowID/);
  assert.match(hitTest, /AXUIElementCopyElementAtPosition/);
  assert.match(hitTest, /elementWindowID\(node\) == target\.windowID/);
  assert.match(visualSource, /--cancel-file/);
  assert.match(visualSource, /func visualGetCodeCancellationRequested\(\)/);
}

function runSettingsVisualFallbackContractTest() {
  const settingsSource = readSettingsSwiftSource();
  const visualSource = readVisualHelperSwiftSource();
  const nodeSource = readNormalizedText(
    new URL("./lib/mac-settings-2fa.js", import.meta.url)
  );
  assertSettingsVisualFallbackContract(settingsSource, visualSource, nodeSource);
}

function runSettingsVisualFallbackMutationResistanceTest() {
  const settingsSource = readSettingsSwiftSource();
  const visualSource = readVisualHelperSwiftSource();
  const nodeSource = readNormalizedText(
    new URL("./lib/mac-settings-2fa.js", import.meta.url)
  );
  const missingUniqueBox = visualSource.replace("boxes.count == 1", "boxes.count >= 1");
  assert.notEqual(missingUniqueBox, visualSource, "unique-box mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(settingsSource, missingUniqueBox, nodeSource),
    assert.AssertionError
  );

  const missingTopmostCheck = visualSource.replace(
    "targetWindowIsTopmostAtPoint(postCaptureWindow, point: point)",
    "true"
  );
  assert.notEqual(missingTopmostCheck, visualSource, "topmost mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(settingsSource, missingTopmostCheck, nodeSource),
    assert.AssertionError
  );

  const repeatVisualAttempt = settingsSource.replace(
    "!visualGetCodeAttempted",
    "true"
  );

  const stalePrePressWindow = settingsSource.replace(
    "navigationOwnerPid: refreshedVisualTarget.ownerPid",
    "navigationOwnerPid: visualTarget.ownerPid"
  ).replace(
    "navigationWindowID: refreshedVisualTarget.windowID",
    "navigationWindowID: visualTarget.windowID"
  );

  const rebindRequiresEmptyExtensionAx = settingsSource.replace(
    "if originalTarget.ownerPid == navigationOwnerPid {",
    "if windowlessAppleIDSettingsStatus(appElement: appElement, expectedPid: navigationOwnerPid) == .eligible, originalTarget.ownerPid == navigationOwnerPid {"
  );
  assert.notEqual(
    rebindRequiresEmptyExtensionAx,
    settingsSource,
    "AX-empty rebind mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsVisualFallbackContract(
      rebindRequiresEmptyExtensionAx,
      visualSource,
      nodeSource
    ),
    assert.AssertionError
  );
  assert.notEqual(
    stalePrePressWindow,
    settingsSource,
    "pre-press window mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsVisualFallbackContract(
      stalePrePressWindow,
      visualSource,
      nodeSource
    ),
    assert.AssertionError
  );

  const staleNavigationEvidenceReset = settingsSource.replace(
    "lastNavigationEvidenceAt = now\n        } else {",
    "lastNavigationEvidenceAt = now\n            axUnavailableSince = nil\n        } else {"
  );
  assert.notEqual(
    staleNavigationEvidenceReset,
    settingsSource,
    "stale page-evidence reset mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsVisualFallbackContract(
      staleNavigationEvidenceReset,
      visualSource,
      nodeSource
    ),
    assert.AssertionError
  );
  assert.notEqual(repeatVisualAttempt, settingsSource, "one-shot mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(repeatVisualAttempt, visualSource, nodeSource),
    assert.AssertionError
  );

  const bypassAlertGate = settingsSource.replace(
    "if alertWaitMs > 0, waitForVerificationCodeAlert(",
    "if alertWaitMs > 0, true || waitForVerificationCodeAlert("
  );
  assert.notEqual(bypassAlertGate, settingsSource, "alert-gate mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(bypassAlertGate, visualSource, nodeSource),
    assert.AssertionError
  );

  const missingFrameStability = visualSource.replace(
    "framesAreVisuallyStable(initialWindow.frame, finalWindow.frame)",
    "true"
  );
  assert.notEqual(missingFrameStability, visualSource, "frame-stability mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(settingsSource, missingFrameStability, nodeSource),
    assert.AssertionError
  );

  const missingFreshVisualConfirmation = visualSource.replace(
    "visualSettingsGetCodeBoxIsStable(boxes[0], finalBoxes[0])",
    "true"
  );
  assert.notEqual(
    missingFreshVisualConfirmation,
    visualSource,
    "fresh visual confirmation mutation fixture must apply"
  );
  assert.throws(
    () => assertSettingsVisualFallbackContract(
      settingsSource,
      missingFreshVisualConfirmation,
      nodeSource
    ),
    assert.AssertionError
  );

  const missingCancelForwarding = settingsSource.replace(
    "arguments.append(contentsOf: [\"--cancel-file\", cancelFilePath])",
    "_ = cancelFilePath"
  );
  assert.notEqual(missingCancelForwarding, settingsSource, "cancel-forwarding mutation fixture must apply");
  assert.throws(
    () => assertSettingsVisualFallbackContract(missingCancelForwarding, visualSource, nodeSource),
    assert.AssertionError
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
await runVerificationAlertReadyEventTest();
await runMissingVerificationAlertReadyEventFailsClosedTest();
await runSettingsAccessibilityPreflightTest();
await runFixedSuccessStateTest();
await runSequentialSettingsCodeRequestsTest();
await runSensitiveOutputSanitizationTest();
await runHelperFailureSanitizationTest();
await runAccessibilityFailureClassificationTest();
await runFixedHelperReasonMappingTest();
await runCancellationCleanupFailureIsPreservedTest();
await runChildErrorSanitizationTest();
await runCancelTest();
runMissingSourceRejectsOldBinaryTest();
runPreparedOnlySettingsStartNeverCompilesTest();
runRuntimeSettingsStartNeverCompilesTest();
runStaleBinaryCompileFailureTest();
runNonExecutableCompilerOutputTest();
await runForceStopAllowsLatePopupCleanupTest();
await runInvalidCodeTest();
await runSixtySecondBudgetIncludesCleanupGraceTest();
await runTimeoutKeepsMarkerUntilChildClosesTest();
runSettingsOwnerMutationResistanceTest();
runSwiftCancellationContractTest();
runAccessibilityPromptSourceContractTest();
runVerificationCodeHardeningSourceContractTest();
runStrictVerificationCodeSourceContractTest();
runTraditionalChineseStateContractTest();
runSparseAxNavigationRecoveryStateTest();
runEvidenceDrivenSettingsNavigationContractTest();
runSettingsVisualFallbackContractTest();
runSettingsVisualFallbackMutationResistanceTest();
runManualSettingsPrivacyContractTest();

console.log("mac settings 2fa lifecycle: ok");
