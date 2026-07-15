import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER } from "./lib/supervised-attestation.js";
import {
  SETTINGS_SMOKE_FAILURE_CODE,
  runSupervisedSettings2FASmoke,
} from "./supervised-settings-2fa-smoke.mjs";

function removeTreeOneFileAtATime(target) {
  if (!fs.existsSync(target)) return;
  const stats = fs.lstatSync(target);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      removeTreeOneFileAtATime(path.join(target, entry));
    }
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected settings smoke to fail");
}

function smokeEnvironment(reportRoot, markerPath, overrides = {}) {
  return {
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SETTINGS_SMOKE: "1",
    APPLE_AUTOMATION_SUPERVISED_MODE: "settings_smoke",
    APPLE_AUTOMATION_REPORT_ROOT: reportRoot,
    APPLE_AUTOMATION_ACCEPTANCE_MARKER: markerPath,
    ...overrides,
  };
}

function assertSanitizedFailure(error, output, secrets = []) {
  assert.equal(error.code, SETTINGS_SMOKE_FAILURE_CODE);
  assert.equal(error.cause, undefined);
  assert.deepEqual(output, []);
  const visibleText = [error.message, error.stack ?? "", output.join("")].join("\n");
  for (const secret of secrets) {
    assert.equal(visibleText.includes(secret), false, `secret leaked: ${secret}`);
  }
}

function providerThatMustNotRun(calls) {
  return async () => {
    calls.push("called");
    throw new Error("provider should not run");
  };
}

function createMarkerSymlink(root, markerPath) {
  const fileTarget = path.join(root, "marker-symlink-target");
  fs.writeFileSync(fileTarget, "symlink target must remain unchanged\n", "utf8");
  try {
    fs.symlinkSync(fileTarget, markerPath, "file");
    return { targetPath: fileTarget, targetIsDirectory: false };
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    const directoryTarget = path.join(root, "marker-junction-target");
    fs.mkdirSync(directoryTarget, { mode: 0o700 });
    fs.symlinkSync(directoryTarget, markerPath, "junction");
    return { targetPath: directoryTarget, targetIsDirectory: true };
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "apple-settings-smoke-"));
try {
  const reportRoot = path.join(root, "reports");
  fs.mkdirSync(reportRoot, { mode: 0o700 });
  const markerPath = path.join(reportRoot, ".settings-2fa-twice-confirmed");
  const env = smokeEnvironment(reportRoot, markerPath);

  const calls = [];
  const output = [];
  const result = await runSupervisedSettings2FASmoke({
    env,
    stdout: { write: (value) => output.push(String(value)) },
    fetchCode: async (options) => {
      calls.push(options);
      return { code: calls.length === 1 ? "123456" : "654321" };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [
    {
      timeoutMs: 90_000,
      verbose: false,
      runtime: { compileIfNeeded: false },
    },
    {
      timeoutMs: 90_000,
      verbose: false,
      runtime: { compileIfNeeded: false },
    },
  ]);
  assert.equal(
    fs.readFileSync(markerPath, "utf8"),
    "SETTINGS_2FA_TWICE_CONFIRMED\n"
  );
  assert.deepEqual(output, [`${SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER}\n`]);
  assert.doesNotMatch(output.join(""), /123456|654321/);
  assert.doesNotMatch(fs.readFileSync(markerPath, "utf8"), /123456|654321/);

  fs.unlinkSync(markerPath);
  const repeatedOutput = [];
  const repeated = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => repeatedOutput.push(String(value)) },
      fetchCode: async () => ({ code: "123456" }),
    })
  );
  assert.equal(repeated.message, "settings smoke did not receive two fresh codes");
  assertSanitizedFailure(repeated, repeatedOutput, ["123456"]);
  assert.equal(fs.existsSync(markerPath), false);

  const invalidOutput = [];
  const invalid = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => invalidOutput.push(String(value)) },
      fetchCode: async () => ({ code: "not-a-code-123456" }),
    })
  );
  assert.equal(invalid.message, "settings smoke did not receive two fresh codes");
  assertSanitizedFailure(invalid, invalidOutput, ["not-a-code-123456", "123456"]);
  assert.equal(fs.existsSync(markerPath), false);

  const providerSecret = "provider-secret-654321";
  const providerOutput = [];
  const providerFailure = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => providerOutput.push(String(value)) },
      fetchCode: async () => {
        throw new Error(`provider exploded with ${providerSecret}`);
      },
    })
  );
  assert.equal(providerFailure.message, "settings smoke did not receive two fresh codes");
  assertSanitizedFailure(providerFailure, providerOutput, [providerSecret, "provider exploded"]);
  assert.equal(fs.existsSync(markerPath), false);

  const racedMarkerOutput = [];
  let racedMarkerCalls = 0;
  const racedMarker = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => racedMarkerOutput.push(String(value)) },
      fetchCode: async () => {
        racedMarkerCalls += 1;
        if (racedMarkerCalls === 2) {
          fs.writeFileSync(markerPath, "raced marker must not be overwritten\n", "utf8");
        }
        return { code: racedMarkerCalls === 1 ? "123456" : "654321" };
      },
    })
  );
  assert.equal(racedMarker.message, "settings smoke did not receive two fresh codes");
  assertSanitizedFailure(racedMarker, racedMarkerOutput);
  assert.equal(
    fs.readFileSync(markerPath, "utf8"),
    "raced marker must not be overwritten\n"
  );
  fs.unlinkSync(markerPath);

  for (const [key, value] of [
    ["APPLE_AUTOMATION_SUPERVISED_GUI", "0"],
    ["APPLE_AUTOMATION_SETTINGS_SMOKE", "0"],
    ["APPLE_AUTOMATION_SUPERVISED_MODE", "account"],
  ]) {
    const invalidEnvironmentCalls = [];
    const invalidEnvironmentOutput = [];
    const invalidEnvironment = await rejectionOf(
      runSupervisedSettings2FASmoke({
        env: smokeEnvironment(reportRoot, markerPath, { [key]: value }),
        stdout: { write: (written) => invalidEnvironmentOutput.push(String(written)) },
        fetchCode: providerThatMustNotRun(invalidEnvironmentCalls),
      })
    );
    assert.equal(invalidEnvironment.message, "settings smoke environment is invalid");
    assertSanitizedFailure(invalidEnvironment, invalidEnvironmentOutput);
    assert.deepEqual(invalidEnvironmentCalls, []);
    assert.equal(fs.existsSync(markerPath), false);
  }

  for (const key of [
    "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
    "APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE",
    "FIREFOX_PROFILE_DIR",
    "BROWSER_PROFILE_MODE",
  ]) {
    const pollutedCalls = [];
    const pollutedOutput = [];
    const polluted = await rejectionOf(
      runSupervisedSettings2FASmoke({
        env: smokeEnvironment(reportRoot, markerPath, { [key]: "" }),
        stdout: { write: (value) => pollutedOutput.push(String(value)) },
        fetchCode: providerThatMustNotRun(pollutedCalls),
      })
    );
    assert.equal(polluted.message, "settings smoke environment is invalid");
    assertSanitizedFailure(polluted, pollutedOutput);
    assert.deepEqual(pollutedCalls, []);
    assert.equal(fs.existsSync(markerPath), false);
  }

  const outsideMarkerPath = path.join(root, ".outside-settings-marker");
  const outsideCalls = [];
  const outside = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env: smokeEnvironment(reportRoot, outsideMarkerPath),
      fetchCode: providerThatMustNotRun(outsideCalls),
    })
  );
  assert.equal(outside.message, "settings smoke environment is invalid");
  assertSanitizedFailure(outside, []);
  assert.deepEqual(outsideCalls, []);
  assert.equal(fs.existsSync(outsideMarkerPath), false);

  fs.writeFileSync(markerPath, "existing marker must not be overwritten\n", "utf8");
  const existingCalls = [];
  const existingOutput = [];
  const existing = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => existingOutput.push(String(value)) },
      fetchCode: providerThatMustNotRun(existingCalls),
    })
  );
  assert.equal(existing.message, "settings smoke environment is invalid");
  assertSanitizedFailure(existing, existingOutput);
  assert.deepEqual(existingCalls, []);
  assert.equal(
    fs.readFileSync(markerPath, "utf8"),
    "existing marker must not be overwritten\n"
  );
  fs.unlinkSync(markerPath);

  const symlink = createMarkerSymlink(root, markerPath);
  assert.equal(fs.lstatSync(markerPath).isSymbolicLink(), true);
  const symlinkCalls = [];
  const symlinkOutput = [];
  const symlinkFailure = await rejectionOf(
    runSupervisedSettings2FASmoke({
      env,
      stdout: { write: (value) => symlinkOutput.push(String(value)) },
      fetchCode: providerThatMustNotRun(symlinkCalls),
    })
  );
  assert.equal(symlinkFailure.message, "settings smoke environment is invalid");
  assertSanitizedFailure(symlinkFailure, symlinkOutput);
  assert.deepEqual(symlinkCalls, []);
  assert.equal(fs.lstatSync(markerPath).isSymbolicLink(), true);
  if (!symlink.targetIsDirectory) {
    assert.equal(
      fs.readFileSync(symlink.targetPath, "utf8"),
      "symlink target must remain unchanged\n"
    );
  }
  fs.unlinkSync(markerPath);
} finally {
  removeTreeOneFileAtATime(root);
}

console.log("supervised settings 2FA smoke contract: ok");
