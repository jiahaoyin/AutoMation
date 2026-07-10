import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start2FASettingsCodeRequest } from "./lib/mac-settings-2fa.js";

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
  const runtime = {
    platform: "darwin",
    helperPath: "/tmp/fake-mac-settings-2fa-code",
    spawn(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
  };

  return {
    child,
    reportDir,
    runtime,
    get spawnCall() {
      return spawnCall;
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

async function runSuccessTest() {
  const harness = createHarness();
  try {
    const request = start2FASettingsCodeRequest({
      reportDir: harness.reportDir,
      runtime: harness.runtime,
      verbose: false,
    });
    assert.equal(fs.existsSync(harness.cancelFile()), false);

    harness.child.stdout.emit(
      "data",
      Buffer.from('{"ok":true,"code":"123 456","raw":"123 456","screenshot":null}\n')
    );
    harness.child.emit("close", 0, null);

    assert.deepEqual(await request.promise, {
      code: "123456",
      raw: "123 456",
      screenshot: null,
    });
    assert.equal(fs.existsSync(harness.cancelFile()), false);
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

async function runForceStopTest() {
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

    request.forceStop();
    assert.equal(fs.existsSync(harness.cancelFile()), true);
    assert.deepEqual(harness.child.killSignals, ["SIGKILL"]);

    harness.child.emit("close", null, "SIGKILL");
    await rejected;
    assert.equal(fs.existsSync(harness.cancelFile()), false);
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
    const rejected = assert.rejects(request.promise, /验证码格式异常/);
    harness.child.stdout.emit(
      "data",
      Buffer.from('{"ok":true,"code":"1234567","raw":"1234567"}\n')
    );
    harness.child.emit("close", 0, null);
    await rejected;
    assert.equal(fs.existsSync(harness.cancelFile()), false);
  } finally {
    harness.cleanup();
  }
}

function runSwiftCancellationContractTest() {
  const source = fs.readFileSync(
    new URL("./swift/mac-settings-2fa-code.swift", import.meta.url),
    "utf8"
  );
  assert.match(source, /--cancel-file/);
  assert.match(source, /func stopIfCancelled/);
  assert.match(source, /func closeVerificationCodeAlert/);
  assert.ok(
    source.match(/stopIfCancelled\(/g)?.length >= 6,
    "Swift helper must check cancellation throughout navigation and polling"
  );
}

await runSuccessTest();
await runCancelTest();
await runForceStopTest();
await runInvalidCodeTest();
runSwiftCancellationContractTest();

console.log("mac settings 2fa lifecycle: ok");
