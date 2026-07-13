import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start2FASettingsCodeRequest } from "./lib/mac-settings-2fa.js";
import * as settingsModule from "./lib/mac-settings-2fa.js";

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
      Buffer.from(JSON.stringify({ ok: false, message: SECRET_TEXT }) + "\n")
    );
    harness.child.stderr.emit("data", Buffer.from(SECRET_TEXT));
    harness.child.emit("close", 7, null);

    const error = await rejectionOf(request.promise);
    assertSafeError(error);
    assert.match(error.message, /helper failed/i);
    assert.match(error.message, /exit 7/i);
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
    const rejected = assert.rejects(request.promise, /超时/);

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
    await rejected;
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

    const rejected = assert.rejects(request.promise, /超时/);
    harness.child.emit("close", null, "SIGKILL");
    await rejected;
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
  const source = fs.readFileSync(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url),
    "utf8"
  );
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
  assert.match(source, /func closeVerificationCodeAlert/);
  assert.match(source, /verificationCodeRequested/);
  assert.match(source, /waitForAlertMs/);
  assert.match(source, /func findExactButton\(/);
  assert.match(
    source,
    /let verificationAlertCloseButtons\s*=\s*\[\s*"好"\s*,\s*"OK"\s*\]/
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
    source.indexOf("guard stableHits >= 2, let finalCode = code else"),
    source.indexOf('logStep(7, "verification code detected")')
  );
  const timeoutClose = timeoutFailure.indexOf("closeVerificationCodeAlert");
  const timeoutEmit = timeoutFailure.indexOf("emit(Output");
  assert.ok(timeoutClose >= 0, "normal timeout must attempt alert cleanup");
  assert.ok(timeoutEmit > timeoutClose, "timeout cleanup must precede failure output");

  const finder = source.slice(
    source.indexOf("func findSettingsApp"),
    source.indexOf("func openAppleAccountSettings")
  );
  const findCall = source.indexOf("guard let app = findSettingsApp()");
  const axCreate = source.indexOf("AXUIElementCreateApplication(app.processIdentifier)");
  assert.match(source, /func isAppleSystemExecutable/);
  assert.match(source, /executableURL\.lastPathComponent/);
  assert.match(finder, /guard isTrustedSystemSettings\(app\) else/);
  assert.doesNotMatch(finder, /localizedName/);
  assert.ok(findCall >= 0 && axCreate > findCall, "trusted app lookup must precede AX enumeration");

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
  const source = fs.readFileSync(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url),
    "utf8"
  );
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
  assert.match(getCodeFinder, /elementBelongsToProcess\(root,\s*pid:\s*expectedPid\)/);
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
  assert.match(getCodeFinder, /focusedWindowForProcess\(expectedPid\)/);
  assert.match(getCodeFinder, /axWindowForElement\(button\)\s*==\s*focusedWindow/);
  const sheetRoots = functionBody("collectSheetRoots");
  assert.match(source, /let axSheetsAttribute\s*=\s*"AXSheets"/);
  assert.match(functionBody("axSheets"), /axCopy\(element,\s*axSheetsAttribute\)/);
  assert.match(sheetRoots, /kAXFocusedWindowAttribute/);
  assert.match(sheetRoots, /axSheets\(focusedWindow\)\s*\+\s*axChildren\(focusedWindow\)/);
  assert.match(sheetRoots, /queue\.append\(contentsOf:\s*axSheets\(node\)\)/);
  assert.match(sheetRoots, /seen\.contains/);
  assert.match(sheetRoots, /kAXHiddenAttribute/);
  assert.match(sheetRoots, /isDedicatedDialogWindow\(focusedWindow\)/);
  assert.match(sheetRoots, /kAXWindowRole[\s\S]*isDedicatedDialogWindow\(node\)/);
  assert.doesNotMatch(sheetRoots, /collectWindows\(/);

  const navigationClick = functionBody("clickNamed");
  assert.match(navigationClick, /expectedPid/);
  assert.match(navigationClick, /focusedWindowForProcess\(expectedPid\)/);
  assert.match(navigationClick, /kAXHiddenAttribute/);
  assert.match(navigationClick, /kAXEnabledAttribute[\s\S]{0,100}==\s*true/);
  assert.doesNotMatch(navigationClick, /kAXEnabledAttribute[\s\S]{0,100}!=\s*false/);
  assert.match(navigationClick, /supportsPressAction\(node\)/);
  assert.match(navigationClick, /axWindowForElement\(node\)\s*==\s*focusedWindow/);

  const navigationDiagnostics = functionBody("logNavigationState");
  assert.match(navigationDiagnostics, /visibleExactMatchCounts\(/);
  assert.match(navigationDiagnostics, /focused=/);
  assert.match(navigationDiagnostics, /sheets=/);
  assert.match(navigationDiagnostics, /signInVisible=/);
  assert.match(navigationDiagnostics, /twoFactorVisible=/);
  assert.match(navigationDiagnostics, /getCode=/);
  assert.doesNotMatch(navigationDiagnostics, /axDescription|axExactTexts|codeRaw|print\(/);

  const activation = functionBody("activateSystemSettings");
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
  assert.doesNotMatch(activation, /AXUIElementPerformAction\(window,\s*kAXRaiseAction/);
  assert.match(activation, /pid=/);
  assert.match(activation, /role=/);
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
  assert.match(request, /clickElementAtVerifiedFrame\(\s*button,\s*expectedPid:/);

  const alertRoot = functionBody("findVerificationCodeAlertRoot");
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

  const codeScan = functionBody("findSixDigitCodeInAlert");
  assert.match(codeScan, /kAXStaticTextRole/);
  assert.match(codeScan, /kAXGroupRole/);
  assert.match(codeScan, /sixDigitCodeCandidates\(/);
  assert.match(codeScan, /Set<String>\(\)/);
  assert.match(codeScan, /candidates\.(?:insert|formUnion)/);
  assert.match(codeScan, /candidates\.count\s*==\s*1/);
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

  assert.match(source, /let settingsPid\s*=\s*app\.processIdentifier/);
  const requestCall = source.slice(source.indexOf("guard requestVerificationCodeAlert("));
  assert.match(requestCall, /expectedPid:\s*settingsPid/);
  assert.doesNotMatch(source, /blobDeep|findFormattedCodeInTree|extractSixDigit|looksLikeFormattedCode/);
  assert.doesNotMatch(source, /screencapture|captureWindowScreenshot|captureSheetScreenshot|OCR/i);
}

function runVerificationCodeHardeningSourceContractTest() {
  const source = fs.readFileSync(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url),
    "utf8"
  );
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
  assert.match(closeAlert, /findVerificationCodeAlertRoot\(/);
  assert.match(closeAlert, /return\s+true/);
  assert.match(
    closeAlert,
    /return\s+findVerificationCodeAlertRoot\([\s\S]{0,240}==\s*nil/,
    "alert close timeout must return the verified disappearance result"
  );
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

  const successStart = source.lastIndexOf('logStep(7, "verification code detected")');
  const successEnd = source.lastIndexOf("emit(Output(ok: true");
  const successPath = source.slice(successStart, successEnd);
  assert.match(
    successPath,
    /(?:guard|if)[\s\S]{0,500}closeVerificationCodeAlert/,
    "the success path must require a true alert-close result"
  );

  const stabilityPath = source.slice(source.indexOf("var stableHits"), successStart);
  assert.match(
    stabilityPath,
    /guard\s+stableHits\s*>=\s*2/,
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
  const source = fs.readFileSync(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url),
    "utf8"
  );
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

  const scanAlert = functionBody("scanCodeFromAlertOnly");
  assert.match(
    scanAlert,
    /findVerificationCodeAlertRoot\([\s\S]*findSixDigitCodeInAlert\(alert\)/
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /findVerificationCodeAlertRoot\(/);
  assert.match(closeAlert, /findExactButton\(/);
  assert.match(closeAlert, /verificationAlertCloseButtons/);
  assert.match(source, /let verificationAlertCloseButtons\s*=\s*\[[^\]]*"好"/);

  assert.match(source, /let signInSecurity\s*=\s*\[[^\]]*"登入與安全性"/);
  assert.match(source, /let twoFactor\s*=\s*\[[^\]]*"雙重認證"/);
  assert.match(source, /let getCodeBtn\s*=\s*\[[^\]]*"取得驗證碼"/);

  const resumeProbe = source.indexOf("if findGetCodeButton(", source.indexOf("let getCodeBtn"));
  const signInClick = source.indexOf("clickNamed(in: appElement, names: signInSecurity,");
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
await runChildErrorSanitizationTest();
await runCancelTest();
runMissingSourceRejectsOldBinaryTest();
runStaleBinaryCompileFailureTest();
runNonExecutableCompilerOutputTest();
await runForceStopAllowsLatePopupCleanupTest();
await runInvalidCodeTest();
await runSixtySecondBudgetIncludesCleanupGraceTest();
await runTimeoutKeepsMarkerUntilChildClosesTest();
runSwiftCancellationContractTest();
runVerificationCodeHardeningSourceContractTest();
runStrictVerificationCodeSourceContractTest();
runTraditionalChineseStateContractTest();
runManualSettingsPrivacyContractTest();

console.log("mac settings 2fa lifecycle: ok");
