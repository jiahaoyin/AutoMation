#!/usr/bin/env node
/**
 * 浏览器 2FA 权限探测：只依赖辅助功能。
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";

import {
  ensureAccessibility,
  isAccessibilityGranted,
  getAccessibilityHostApp,
  run2FAPermissionPreflight,
} from "./lib/accessibility.js";
import {
  checkNativeAccessibilityCapability,
  promptNativeAccessibilityPermission,
} from "./lib/mac-2fa-popup.js";

const accessibilitySource = fs.readFileSync(
  new URL("./lib/accessibility.js", import.meta.url),
  "utf8"
);
const popupSource = fs.readFileSync(
  new URL("./lib/mac-2fa-popup.js", import.meta.url),
  "utf8"
);
const popupSwiftSource = fs.readFileSync(
  new URL("./swift/mac-2fa-popup-read.swift", import.meta.url),
  "utf8"
);
const preflightEntrySource = fs.readFileSync(
  new URL("./preflight-2fa-permissions.mjs", import.meta.url),
  "utf8"
);

assert.match(
  preflightEntrySource,
  /APPLE_AUTOMATION_SUPERVISED_GUI[\s\S]*permission_preflight_start[\s\S]*permission_preflight_prompted[\s\S]*triggerAccessibilityPrompt\(\)[\s\S]*permission_preflight_ready[\s\S]*permission_preflight_missing[\s\S]*return;[\s\S]*run2FAPermissionPreflight/
);
assert.match(accessibilitySource, /error\.code = "2FA_ACCESSIBILITY_DENIED"/);

function exportedFunctionSource(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing exported function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

for (const name of [
  "isAccessibilityGranted",
  "triggerAccessibilityPrompt",
  "ensureAccessibility",
  "run2FAPermissionPreflight",
]) {
  assert.doesNotMatch(
    exportedFunctionSource(accessibilitySource, name),
    /osascript|System Events|openAccessibilitySettings|openAutomationSettings|ensureAutomation/,
    `${name} must stay on the native Accessibility capability path`
  );
}
assert.doesNotMatch(
  accessibilitySource,
  /accessibility-check\.applescript|^const CHECK_SCPT\b/m,
  "the removed AppleScript Accessibility probe must not remain"
);
assert.match(
  accessibilitySource,
  /checkCapability:\s*[\s\S]*checkNativeAccessibilityCapability/
);
assert.match(
  accessibilitySource,
  /promptPermission:\s*[\s\S]*promptNativeAccessibilityPermission/
);
assert.match(
  exportedFunctionSource(accessibilitySource, "isAccessibilityGranted"),
  /runtime\.checkCapability\(\{\s*signal:\s*options\.signal\s*\}\)/
);
assert.match(
  exportedFunctionSource(accessibilitySource, "triggerAccessibilityPrompt"),
  /runtime\.promptPermission\(\{\s*signal:\s*options\.signal\s*\}\)/
);
assert.doesNotMatch(
  accessibilitySource,
  /check2FAAutomationGranted|ensure2FAAutomation/,
  "legacy 2FA Automation helpers must be removed"
);

const preflightStart = accessibilitySource.indexOf(
  "export async function run2FAPermissionPreflight"
);
assert.notEqual(preflightStart, -1, "browser 2FA preflight must exist");
const preflightSource = accessibilitySource.slice(preflightStart);
assert.match(
  preflightSource,
  /ensureAccessibility\s*\(/,
  "browser 2FA preflight must require Accessibility"
);
assert.doesNotMatch(
  preflightSource,
  /ensureAutomation\s*\(/,
  "browser 2FA preflight must not require System Settings Automation"
);

const nativeCalls = [];
const nativeOptions = [];
const nativeController = new AbortController();
const available = await checkNativeAccessibilityCapability({
  platform: "darwin",
  signal: nativeController.signal,
  ensureHelper: () => true,
  async execFile(_binary, args, options) {
    nativeCalls.push([...args]);
    nativeOptions.push(options);
    return {
      stdout: JSON.stringify({ capability: "available", raw: "must-not-escape" }),
    };
  },
});
assert.deepEqual(available, { capability: "available" });
assert.deepEqual(nativeCalls.shift(), ["--preflight-accessibility"]);
assert.equal(nativeOptions.shift().signal, nativeController.signal);

const prompted = await promptNativeAccessibilityPermission({
  platform: "darwin",
  ensureHelper: () => true,
  async execFile(_binary, args) {
    nativeCalls.push([...args]);
    const error = new Error("native details must not escape");
    error.stdout = JSON.stringify({ capability: "permission_missing" });
    throw error;
  },
});
assert.deepEqual(prompted, { capability: "permission_missing" });
assert.deepEqual(nativeCalls.shift(), ["--prompt-accessibility"]);

const malformed = await checkNativeAccessibilityCapability({
  platform: "darwin",
  ensureHelper: () => true,
  async execFile() {
    return { stdout: '{"capability":"unexpected","raw":"secret"}' };
  },
});
assert.deepEqual(malformed, { capability: "unavailable" });

const failedAvailable = await checkNativeAccessibilityCapability({
  platform: "darwin",
  ensureHelper: () => true,
  async execFile() {
    const error = new Error("must not escape");
    error.stdout = JSON.stringify({ capability: "available" });
    throw error;
  },
});
assert.deepEqual(failedAvailable, { capability: "unavailable" });

const prepareFailure = await checkNativeAccessibilityCapability({
  platform: "darwin",
  ensureHelper() {
    throw new Error("compiler details must not escape");
  },
});
assert.deepEqual(prepareFailure, { capability: "unavailable" });
assert.deepEqual(nativeCalls, []);
assert.doesNotMatch(popupSource, /osascript|System Events/);

await assert.rejects(
  isAccessibilityGranted({
    runtime: {
      platform: "darwin",
      async checkCapability() {
        return { capability: "unavailable" };
      },
    },
  }),
  (error) => error?.code === "2FA_ACCESSIBILITY_UNAVAILABLE"
);

const preflightCalls = [];
const capabilitySequence = ["permission_missing", "available"];
const preflightLogs = [];
const originalConsoleLog = console.log;
let runtimePreflight;
try {
  console.log = (...args) => preflightLogs.push(args.map(String).join(" "));
  runtimePreflight = await run2FAPermissionPreflight({
    quiet: true,
    timeoutMs: 100,
    pollMs: 1,
    runtime: {
      platform: "darwin",
      async checkCapability() {
        preflightCalls.push("check");
        return { capability: capabilitySequence.shift() ?? "available" };
      },
      async promptPermission() {
        preflightCalls.push("prompt");
        return { capability: "permission_missing" };
      },
      async sleep() {
        preflightCalls.push("sleep");
        assert.ok(
          preflightLogs.some((line) =>
            line.includes("系统设置 → 隐私与安全性 → 辅助功能")
          ),
          "the fixed Accessibility path must be shown before waiting"
        );
      },
    },
  });
} finally {
  console.log = originalConsoleLog;
}
assert.equal(runtimePreflight.ok, true);
assert.deepEqual(preflightCalls, ["check", "prompt", "sleep", "check"]);

const cancellationController = new AbortController();
const cancellationCalls = [];
await assert.rejects(
  ensureAccessibility({
    quiet: true,
    timeoutMs: 100,
    pollMs: 1,
    signal: cancellationController.signal,
    runtime: {
      platform: "darwin",
      async checkCapability({ signal }) {
        assert.equal(signal, cancellationController.signal);
        cancellationCalls.push("check");
        return { capability: "permission_missing" };
      },
      async promptPermission({ signal }) {
        assert.equal(signal, cancellationController.signal);
        cancellationCalls.push("prompt");
        cancellationController.abort();
        return { capability: "permission_missing" };
      },
      async sleep() {
        cancellationCalls.push("sleep");
      },
    },
  }),
  (error) => error?.code === "2FA_ACCESSIBILITY_CANCELLED"
);
assert.deepEqual(cancellationCalls, ["check", "prompt"]);

const preflightFlag = popupSwiftSource.indexOf('args.contains("--preflight-accessibility")');
const promptFlag = popupSwiftSource.indexOf('args.contains("--prompt-accessibility")');
const firstWindowEnumeration = popupSwiftSource.indexOf("let windows = collectPriorityWindows()");
assert.ok(preflightFlag >= 0, "Swift helper must expose Accessibility preflight");
assert.ok(promptFlag >= 0, "Swift helper must expose the native Accessibility prompt");
assert.ok(
  firstWindowEnumeration >= 0 &&
    preflightFlag < firstWindowEnumeration &&
    promptFlag < firstWindowEnumeration,
  "Accessibility flags must return before any window enumeration"
);
assert.match(popupSwiftSource, /AXIsProcessTrusted\(\)/);
assert.match(popupSwiftSource, /AXIsProcessTrustedWithOptions/);
assert.match(popupSwiftSource, /kAXTrustedCheckOptionPrompt/);
const popupCodeDisplayMatcher = popupSwiftSource.match(
  /func looksLikeCodeDisplay\(_ text: String\) -> Bool \{([\s\S]*?)\n\}/
)?.[1] ?? "";
assert.match(
  popupCodeDisplayMatcher,
  /\\d\(\?:\[\\s\\u00A0\\u2009\]\+\\d\)\{5\}/,
  "the popup reader must accept a complete six-cell AX code display"
);
assert.match(
  popupSwiftSource,
  /struct AccessibilityCapabilityOutput:\s*Codable\s*\{[\s\S]*let capability:\s*String[\s\S]*\}/
);
const capabilityStruct = popupSwiftSource.match(
  /struct AccessibilityCapabilityOutput:\s*Codable\s*\{([^}]*)\}/
)?.[1] ?? "";
assert.ok(capabilityStruct, "missing fixed Accessibility capability payload");
assert.doesNotMatch(
  capabilityStruct,
  /\b(?:raw|message|source|code)\b/
);

const host = getAccessibilityHostApp();
const ax = await isAccessibilityGranted();

console.log("浏览器 2FA 权限探测:");
console.log(`  宿主: ${host.name}`);
console.log(`  辅助功能: ${ax ? "ok" : "未授权"}`);

process.exitCode = ax ? 0 : 1;
