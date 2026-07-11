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
  assert.match(source, /clickNamed\(in: root, names:/);
  assert.match(
    source,
    /closeVerificationCodeAlert\(appElement: appElement, waitForAlertMs: 2_000\)/
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
    source.indexOf("guard let finalCode = code else"),
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

  const alertPredicate = functionBody("hasSettingsCodeAlert");
  assert.match(alertPredicate, /帳戶驗證碼/);

  const scanAlert = functionBody("scanCodeFromAlertOnly");
  assert.match(
    scanAlert,
    /guard hasSettingsCodeAlert\(blob\)[\s\S]*findFormattedCodeInTree\(root\)/
  );

  const closeAlert = functionBody("closeVerificationCodeAlert");
  assert.match(closeAlert, /hasSettingsCodeAlert\(blobDeep\(root\)\)/);
  assert.match(closeAlert, /"好"/);

  assert.match(source, /let signInSecurity\s*=\s*\[[^\]]*"登入與安全性"/);
  assert.match(source, /let twoFactor\s*=\s*\[[^\]]*"雙重認證"/);
  assert.match(source, /let getCodeBtn\s*=\s*\[[^\]]*"取得驗證碼"/);

  const getCodeClick = source.indexOf("clickNamed(in: appElement, names: getCodeBtn)");
  const requested = source.indexOf("verificationCodeRequested = true", getCodeClick);
  const scan = source.indexOf("scanCodeFromAlertOnly(appElement: appElement)", requested);
  assert.ok(
    getCodeClick >= 0 && requested > getCodeClick && scan > requested,
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
runTraditionalChineseStateContractTest();
runManualSettingsPrivacyContractTest();

console.log("mac settings 2fa lifecycle: ok");
