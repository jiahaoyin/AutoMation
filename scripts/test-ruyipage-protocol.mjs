import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createChildStopper,
  createRuyiPageBackendRunner,
  resolveBackendTimeouts,
} from "./lib/ruyipage-backend-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "ruyipage", "apple_account_flow.py");
const python = process.env.RUYIPAGE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const SECRET_FIXTURES = Object.freeze({
  appleId: ["person", "@example.com"].join(""),
  password: ["TOP-", "SECRET"].join(""),
  verificationCode: ["123", "456"].join(""),
  replacementCode: ["654", "321"].join(""),
  urlQuery: ["?token=", "SECRET"].join(""),
});
const FIXTURE_CREDS = Object.freeze({
  appleId: SECRET_FIXTURES.appleId,
  password: SECRET_FIXTURES.password,
});
const SECRET_CHILD_OUTPUT = Object.values(SECRET_FIXTURES).join(" ");
const SPLIT_UTF8_MESSAGE = "\u4e2d\u6587\u8de8\u5757";

if (process.argv.includes("--exit-with-live-descendant-child")) {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"],
    { detached: process.platform === "win32", stdio: "ignore", windowsHide: true }
  );
  descendant.unref();
  process.stdout.write(
    `${JSON.stringify({ event: "result", success: true, descendantPid: descendant.pid })}\n`,
    () => process.exit(0)
  );
  await new Promise(() => {});
}

if (process.argv.includes("--invalid-json-child")) {
  process.stdout.write(`{${SECRET_CHILD_OUTPUT}\n`, () => process.exit(0));
  await new Promise(() => {});
}

if (process.argv.includes("--stderr-exit-child")) {
  process.stderr.write(SECRET_CHILD_OUTPUT, () => process.exit(17));
  await new Promise(() => {});
}

if (process.argv.includes("--stderr-without-result-child")) {
  process.stderr.write(SECRET_CHILD_OUTPUT, () => process.exit(0));
  await new Promise(() => {});
}

if (process.argv.includes("--unsafe-result-error-child")) {
  process.stdout.write(
    `${JSON.stringify({ event: "result", success: false, error: SECRET_CHILD_OUTPUT })}\n`,
    () => process.exit(0)
  );
  await new Promise(() => {});
}

if (process.argv.includes("--exit-after-prepare-2fa-child")) {
  process.stdout.write(`${JSON.stringify({ event: "prepare_2fa" })}\n`, () => {
    process.exit(0);
  });
  await new Promise(() => {});
}

if (
  process.argv.includes("--exit-after-need-2fa-child") ||
  process.argv.includes("--hang-after-need-2fa-child")
) {
  process.stdout.write(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
  await new Promise((resolve) => {
    process.stdin.once("data", () => {
      process.stdout.write(`${JSON.stringify({ event: "need_2fa", generation: 1 })}\n`, resolve);
    });
  });
  if (process.argv.includes("--hang-after-need-2fa-child")) {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}

if (process.argv.includes("--exit-during-2fa-write-child")) {
  process.stdout.write(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
  await new Promise((resolve) => process.stdin.once("data", resolve));
  process.stdout.write(
    `${JSON.stringify({ event: "need_2fa", generation: 1 })}\n`,
    () => process.exit(0)
  );
  await new Promise(() => {});
}

const generationScenario = [
  "--node-runner-self-test-child",
  "--two-generation-child",
  "--missing-generation-child",
  "--repeated-generation-child",
  "--skipped-generation-child",
  "--third-generation-child",
].find((arg) => process.argv.includes(arg));

if (generationScenario) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const commands = input[Symbol.asyncIterator]();
  const readCommand = async () => {
    const next = await commands.next();
    if (next.done) return null;
    try {
      return JSON.parse(next.value);
    } catch {
      return null;
    }
  };
  const writeEvent = (event) =>
    new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(event)}\n`, resolve);
    });
  const requestCode = async (generation) => {
    await writeEvent({ event: "need_2fa", generation });
    return readCommand();
  };

  await writeEvent({ event: "ready", mode: "node-self-test" });
  await writeEvent({ event: "prepare_2fa" });
  const prepared = await readCommand();
  if (prepared?.type !== "2fa_prepared") process.exit(3);

  if (generationScenario === "--missing-generation-child") {
    await writeEvent({ event: "need_2fa", detail: SECRET_CHILD_OUTPUT });
    await new Promise(() => {});
  }
  if (generationScenario === "--skipped-generation-child") {
    await writeEvent({ event: "need_2fa", generation: 2, detail: SECRET_CHILD_OUTPUT });
    await new Promise(() => {});
  }

  const first = await requestCode(1);
  if (generationScenario === "--node-runner-self-test-child") {
    const argvText = process.argv.slice(2).join("\0");
    const credentialsInArgv = Object.values(FIXTURE_CREDS).some(
      (value) => value && argvText.includes(value)
    );
    const valid =
      first?.type === "2fa_code" &&
      first?.generation === 1 &&
      first?.code === SECRET_FIXTURES.verificationCode;
    await writeEvent({
      event: "result",
      success: valid,
      twoFaCodeLength: String(first?.code ?? "").length,
      receivedGeneration: first?.generation,
      credentialsInArgv,
    });
    process.exit(valid ? 0 : 4);
  }
  if (generationScenario === "--repeated-generation-child") {
    await writeEvent({ event: "need_2fa", generation: 1, detail: SECRET_CHILD_OUTPUT });
    await new Promise(() => {});
  }

  const second = await requestCode(2);
  if (generationScenario === "--third-generation-child") {
    await writeEvent({ event: "need_2fa", generation: 3, detail: SECRET_CHILD_OUTPUT });
    await new Promise(() => {});
  }

  const valid =
    first?.type === "2fa_code" &&
    first?.generation === 1 &&
    first?.code === SECRET_FIXTURES.verificationCode &&
    second?.type === "2fa_code" &&
    second?.generation === 2 &&
    second?.code === SECRET_FIXTURES.replacementCode;
  await writeEvent({
    event: "result",
    success: valid,
    receivedGenerations: [first?.generation, second?.generation],
  });
  process.exit(valid ? 0 : 4);
}

if (process.argv.includes("--exit-after-result-child")) {
  process.stdout.write(`${JSON.stringify({ event: "result", success: true })}\n`, () => {
    process.exit(0);
  });
  await new Promise(() => {});
}

if (process.argv.includes("--exit-after-ready-child")) {
  process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`, () => {
    process.exit(0);
  });
  await new Promise(() => {});
}

if (process.argv.includes("--hang-after-ready-child")) {
  process.stdout.write(
    `${JSON.stringify({ event: "ready", verificationCode: SECRET_FIXTURES.verificationCode })}\n`
  );
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

if (process.argv.includes("--exit-after-result-without-newline-child")) {
  process.stdout.write(JSON.stringify({ event: "result", success: true }), () => {
    process.exit(0);
  });
  await new Promise(() => {});
}

function exitBeforeDelayedStdout(output) {
  const writer = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => process.stdout.write(process.argv[1]), 80)",
      output,
    ],
    { detached: true, stdio: ["ignore", 1, "ignore"], windowsHide: true }
  );
  writer.unref();
  process.exit(0);
}

if (process.argv.includes("--exit-before-delayed-result-child")) {
  exitBeforeDelayedStdout(JSON.stringify({ event: "result", success: true }));
}

if (process.argv.includes("--exit-before-delayed-invalid-tail-child")) {
  exitBeforeDelayedStdout("invalid-json-tail");
}

if (process.argv.includes("--result-success-missing-child")) {
  process.stdout.write(`${JSON.stringify({ event: "result" })}\n`, () => process.exit(0));
  await new Promise(() => {});
}

if (process.argv.includes("--result-success-null-child")) {
  process.stdout.write(
    `${JSON.stringify({ event: "result", success: null })}\n`,
    () => process.exit(0)
  );
  await new Promise(() => {});
}

if (process.argv.includes("--result-success-string-child")) {
  process.stdout.write(
    `${JSON.stringify({ event: "result", success: "true" })}\n`,
    () => process.exit(0)
  );
  await new Promise(() => {});
}

if (process.argv.includes("--split-utf8-chunks-child")) {
  const warningLine = Buffer.from(
    `${JSON.stringify({ event: "warning", message: SPLIT_UTF8_MESSAGE })}\n`,
    "utf8"
  );
  const firstCharacter = Buffer.from(SPLIT_UTF8_MESSAGE[0], "utf8");
  const splitAt = warningLine.indexOf(firstCharacter) + 1;
  process.stdout.write(warningLine.subarray(0, splitAt), () => {
    setTimeout(() => {
      process.stdout.write(warningLine.subarray(splitAt));
      process.stdout.write(
        `${JSON.stringify({ event: "result", success: true })}\n`,
        () => setTimeout(() => process.exit(0), 30)
      );
    }, 30);
  });
  await new Promise(() => {});
}

async function withRejectGuard(promise, timeoutMs, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureRunnerFailure(promise, expectedMessage) {
  try {
    await promise;
    return { rejected: false, fixedContract: false, leaked: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      rejected: true,
      fixedContract: message === expectedMessage,
      leaked: Object.values(SECRET_FIXTURES).some((value) => message.includes(value)),
    };
  }
}

function createSecretCallbackError(label) {
  const error = new Error(`${label}: ${SECRET_CHILD_OUTPUT}`);
  error.cause = new Error(`cause: ${SECRET_CHILD_OUTPUT}`);
  error.stdout = `stdout: ${SECRET_CHILD_OUTPUT}`;
  error.stderr = `stderr: ${SECRET_CHILD_OUTPUT}`;
  error.raw = { detail: SECRET_CHILD_OUTPUT };
  return error;
}

async function assertSanitizedCallbackFailure(promise, expectedMessage) {
  try {
    await promise;
    assert.fail(`runner resolved instead of rejecting with ${expectedMessage}`);
  } catch (error) {
    assert.equal(error?.message, expectedMessage);
    assert.equal(error?.cause, undefined);
    assert.equal(error?.stdout, undefined);
    assert.equal(error?.stderr, undefined);
    assert.equal(error?.raw, undefined);
    const exposed = [
      String(error),
      String(error?.stack ?? ""),
      JSON.stringify(error),
    ].join("\n");
    for (const secret of Object.values(SECRET_FIXTURES)) {
      assert.equal(exposed.includes(secret), false, `callback failure leaked ${secret}`);
    }
  }
}

function runBackendTimeoutConfigTest() {
  assert.deepEqual(resolveBackendTimeouts({}), {
    timeoutMs: 720_000,
    killGraceMs: 5_000,
    eventHandlerTimeoutMs: 30_000,
  });
  assert.deepEqual(
    resolveBackendTimeouts({
      RUYIPAGE_BACKEND_TIMEOUT_MS: "900000",
      RUYIPAGE_KILL_GRACE_MS: "7500",
      RUYIPAGE_EVENT_HANDLER_TIMEOUT_MS: "45000",
    }),
    {
      timeoutMs: 900_000,
      killGraceMs: 5_000,
      eventHandlerTimeoutMs: 45_000,
    }
  );
  assert.equal(
    resolveBackendTimeouts({ RUYIPAGE_KILL_GRACE_MS: "999999999" }).killGraceMs,
    5_000
  );
  assert.deepEqual(
    resolveBackendTimeouts({
      RUYIPAGE_BACKEND_TIMEOUT_MS: "0",
      RUYIPAGE_KILL_GRACE_MS: "not-a-number",
      RUYIPAGE_EVENT_HANDLER_TIMEOUT_MS: "-1",
    }),
    {
      timeoutMs: 720_000,
      killGraceMs: 5_000,
      eventHandlerTimeoutMs: 30_000,
    }
  );
}

function runChildStopperSelfTest() {
  const signals = [];
  const timers = [];
  const child = {
    pid: 1234,
    stdin: { end() {} },
    kill(signal) {
      signals.push(["child", signal]);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    graceMs: 250,
    signalProcessGroup(pid, signal) {
      signals.push([pid, signal]);
    },
    schedule(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    cancel() {},
  });

  stopper.stop();
  assert.deepEqual(signals, [[-1234, "SIGINT"]]);
  assert.equal(timers[0].delay, 250);
  timers[0].callback();
  assert.ok(
    signals.some(([pid, signal]) => pid === -1234 && signal === "SIGKILL"),
    "the force timer must send SIGKILL"
  );
}

async function runChildStopperLiveDescendantSelfTest() {
  const signals = [];
  const postKillAliveMs = 35;
  let killAt = null;
  let esrchAt = null;
  const child = {
    pid: 4321,
    stdin: { end() {} },
    kill(signal) {
      signals.push(["child", signal]);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    graceMs: 40,
    cleanupPollIntervalMs: 5,
    forceCleanupTimeoutMs: 200,
    signalProcessGroup(pid, signal) {
      const observedAt = Date.now();
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        killAt = observedAt;
        return;
      }
      if (signal === 0 && killAt != null && observedAt - killAt >= postKillAliveMs) {
        esrchAt = observedAt;
        const error = new Error("process group not found");
        error.code = "ESRCH";
        throw error;
      }
    },
  });

  stopper.stop();
  const startedAt = Date.now();
  await stopper.waitForCleanup();
  const settledAt = Date.now();

  assert.ok(killAt != null, "cleanup must send SIGKILL after the real grace timer");
  assert.ok(esrchAt != null, "cleanup must poll until the process group reports ESRCH");
  assert.ok(killAt - startedAt >= 30, "cleanup must wait for the real force timer");
  assert.ok(esrchAt - killAt >= 25, "SIGKILL must not synchronously mark the group gone");
  assert.ok(settledAt >= esrchAt, "cleanup must settle only after ESRCH is observed");
  assert.deepEqual(signals[0], [-4321, "SIGINT"]);
  assert.ok(signals.some(([, signal]) => signal === "SIGKILL"));
  assert.deepEqual(signals.at(-1), [-4321, 0]);
}

async function runChildStopperCleanupDeadlineSelfTest() {
  const signals = [];
  const child = {
    pid: 5432,
    stdin: { end() {} },
    kill(signal) {
      signals.push(["child", signal]);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    graceMs: 20,
    cleanupPollIntervalMs: 5,
    forceCleanupTimeoutMs: 35,
    signalProcessGroup(pid, signal) {
      signals.push([pid, signal]);
    },
  });

  stopper.stop();
  const startedAt = Date.now();
  const failure = await stopper.waitForCleanup().then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.message, "ruyipage backend cleanup failed");
  assert.ok(Date.now() - startedAt >= 45, "cleanup failure must use the post-kill deadline");
  assert.ok(signals.some(([, signal]) => signal === "SIGKILL"));
  assert.ok(
    signals.filter(([, signal]) => signal === 0).length >= 2,
    "cleanup must poll the process group before failing"
  );
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopTestProcess(pid) {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function runNodeRunnerProcessGroupSettlementSelfTest() {
  const signals = [];
  const postKillAliveMs = 35;
  let backendPid = null;
  let killAt = null;
  let esrchAt = null;
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-ready-child"],
    timeoutMs: 40,
    killGraceMs: 40,
    eventHandlerTimeoutMs: 1_000,
    childStopperOptions: {
      platform: "darwin",
      cleanupPollIntervalMs: 5,
      forceCleanupTimeoutMs: 200,
      signalProcessGroup(pid, signal) {
        const observedAt = Date.now();
        signals.push([pid, signal]);
        if (signal === "SIGINT") {
          backendPid = Math.abs(pid);
          return;
        }
        if (signal === "SIGKILL") {
          killAt = observedAt;
          return;
        }
        if (signal === 0 && killAt != null && observedAt - killAt >= postKillAliveMs) {
          esrchAt = observedAt;
          const error = new Error("simulated process group detail must stay private");
          error.code = "ESRCH";
          throw error;
        }
      },
    },
  });

  const startedAt = Date.now();
  const runOutcome = runner
    .run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
    })
    .then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    );
  try {
    const outcome = await withRejectGuard(
      runOutcome,
      800,
      "runner hung while waiting for process-group cleanup"
    ).then(
      (value) => value,
      (error) => ({ value: null, error })
    );
    const settledAt = Date.now();

    assert.equal(outcome.error?.message, "ruyipage backend timed out after 40ms");
    assert.ok(killAt != null, "runner cleanup must send the scheduled SIGKILL");
    assert.ok(esrchAt != null, "runner cleanup must observe ESRCH after SIGKILL");
    assert.ok(killAt - startedAt >= 65, "runner must use the real timeout and force-grace timers");
    assert.ok(esrchAt - killAt >= 25, "the integration must keep the group alive after SIGKILL");
    assert.ok(settledAt >= esrchAt, "runner must not settle before process-group cleanup completes");
    assert.equal(
      processIsAlive(backendPid),
      true,
      "runner must settle without relying on child exit/error/close"
    );
    assert.deepEqual(
      signals
        .filter(([, signal]) => signal === "SIGINT" || signal === "SIGKILL")
        .map(([, signal]) => signal),
      ["SIGINT", "SIGKILL"]
    );
  } finally {
    await stopTestProcess(backendPid);
    await withRejectGuard(runOutcome, 500, "runner stayed pending after test child cleanup");
  }
}

async function runNodeRunnerCleanupFailureWithoutChildExitSelfTest() {
  const signals = [];
  let backendPid = null;
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-ready-child"],
    timeoutMs: 30,
    killGraceMs: 30,
    eventHandlerTimeoutMs: 1_000,
    childStopperOptions: {
      platform: "darwin",
      cleanupPollIntervalMs: 5,
      forceCleanupTimeoutMs: 60,
      signalProcessGroup(pid, signal) {
        signals.push([pid, signal]);
        backendPid = Math.abs(pid);
      },
    },
  });

  const startedAt = Date.now();
  const runOutcome = runner
    .run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
    })
    .then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    );
  try {
    const outcome = await withRejectGuard(
      runOutcome,
      600,
      "runner ignored the fixed cleanup deadline"
    ).then(
      (value) => value,
      (error) => ({ value: null, error })
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(outcome.error?.message, "ruyipage backend cleanup failed");
    assert.ok(elapsedMs >= 95, "runner must include timeout, kill grace, and cleanup polling");
    assert.ok(elapsedMs < 400, "runner cleanup failure must remain bounded");
    assert.equal(processIsAlive(backendPid), true);
    assert.ok(signals.some(([, signal]) => signal === "SIGKILL"));
  } finally {
    await stopTestProcess(backendPid);
    await withRejectGuard(runOutcome, 500, "runner stayed pending after failed-cleanup child release");
  }
}

async function runNodeRunnerNormalCloseDescendantCleanupSelfTest() {
  const signals = [];
  let descendantPid = null;
  let killAt = null;
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-with-live-descendant-child"],
    timeoutMs: 2_000,
    killGraceMs: 35,
    childStopperOptions: {
      platform: "darwin",
      cleanupPollIntervalMs: 5,
      forceCleanupTimeoutMs: 250,
      signalProcessGroup(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          killAt = Date.now();
          if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
          return;
        }
        if (signal === 0 && !processIsAlive(descendantPid)) {
          const error = new Error("controlled process group is gone");
          error.code = "ESRCH";
          throw error;
        }
      },
    },
  });

  const startedAt = Date.now();
  try {
    const result = await withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent(event) {
          if (event.event === "result") descendantPid = event.descendantPid;
        },
      }),
      1_500,
      "runner hung cleaning a descendant after normal backend close"
    );
    const settledAt = Date.now();

    assert.equal(result.success, true);
    assert.ok(descendantPid, "the real backend fixture must create a descendant");
    assert.ok(killAt != null, "normal close cleanup must reach the real force timer");
    assert.ok(killAt - startedAt >= 25, "normal close cleanup must honor kill grace");
    assert.ok(settledAt >= killAt, "runner must settle after force cleanup");
    assert.equal(processIsAlive(descendantPid), false, "runner returned with a live descendant");
    assert.deepEqual(
      signals
        .filter(([, signal]) => signal === "SIGINT" || signal === "SIGKILL")
        .map(([, signal]) => signal),
      ["SIGINT", "SIGKILL"]
    );
  } finally {
    await stopTestProcess(descendantPid);
  }
}

async function runNodeRunnerNormalCloseDescendantCleanupFailureSelfTest() {
  const signals = [];
  let descendantPid = null;
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-with-live-descendant-child"],
    timeoutMs: 2_000,
    killGraceMs: 30,
    childStopperOptions: {
      platform: "darwin",
      cleanupPollIntervalMs: 5,
      forceCleanupTimeoutMs: 55,
      signalProcessGroup(pid, signal) {
        signals.push([pid, signal]);
      },
    },
  });

  const startedAt = Date.now();
  try {
    const outcome = await withRejectGuard(
      runner
        .run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          onEvent(event) {
            if (event.event === "result") descendantPid = event.descendantPid;
          },
        })
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error })
        ),
      1_000,
      "runner ignored the normal-close cleanup deadline"
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(outcome.value, null, "live process group produced a false success");
    assert.equal(outcome.error?.message, "ruyipage backend cleanup failed");
    assert.ok(elapsedMs >= 75, "cleanup failure skipped grace or post-kill polling");
    assert.ok(elapsedMs < 500, "normal-close cleanup failure was not bounded");
    assert.ok(signals.some(([, signal]) => signal === "SIGKILL"));
    assert.ok(signals.filter(([, signal]) => signal === 0).length >= 2);
  } finally {
    await stopTestProcess(descendantPid);
  }
}

async function runNodeRunnerGenerationProtocolSelfTest() {
  const requests = [];
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--two-generation-child"],
    timeoutMs: 2_000,
    killGraceMs: 100,
  });

  const result = await runner.run({
    creds: FIXTURE_CREDS,
    reportDir: "data/reports/protocol-test",
    async prepare2FA() {},
    async get2FACode(request) {
      requests.push(request);
      return request?.generation === 2
        ? SECRET_FIXTURES.replacementCode
        : SECRET_FIXTURES.verificationCode;
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.receivedGenerations, [1, 2]);
  assert.deepEqual(requests, [
    { generation: 1, rejectPrevious: false },
    { generation: 2, rejectPrevious: true },
  ]);
}

async function runNodeRunnerInvalidGenerationSelfTest() {
  const cases = [
    { arg: "--missing-generation-child", expectedRequests: [] },
    { arg: "--repeated-generation-child", expectedRequests: [1] },
    { arg: "--skipped-generation-child", expectedRequests: [] },
    { arg: "--third-generation-child", expectedRequests: [1, 2] },
  ];
  const outcomes = [];

  for (const { arg, expectedRequests } of cases) {
    const requests = [];
    const runner = createRuyiPageBackendRunner({
      python: process.execPath,
      script: fileURLToPath(import.meta.url),
      cwd: root,
      args: [arg],
      timeoutMs: 300,
      killGraceMs: 50,
    });
    const outcome = await captureRunnerFailure(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
          async get2FACode(request) {
            requests.push(request?.generation);
            return request?.generation === 2
              ? SECRET_FIXTURES.replacementCode
              : SECRET_FIXTURES.verificationCode;
          },
        }),
        1_000,
        `runner hung for ${arg}`
      ),
      "ruyipage backend sent invalid 2FA generation"
    );
    outcomes.push({ arg, ...outcome });
    assert.deepEqual(requests, expectedRequests, `${arg} called the provider incorrectly`);
  }

  assert.deepEqual(
    outcomes,
    cases.map(({ arg }) => ({
      arg,
      rejected: true,
      fixedContract: true,
      leaked: false,
    }))
  );
}

async function runNodeRunnerStdinEofSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-during-2fa-write-child"],
    timeoutMs: 2_000,
    killGraceMs: 100,
  });
  const asynchronousFailures = [];
  const onUncaughtException = (error) => asynchronousFailures.push(error);
  const onUnhandledRejection = (error) => asynchronousFailures.push(error);
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const failure = await withRejectGuard(
      runner
        .run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
          async get2FACode() {
            return "0".repeat(4 * 1024 * 1024);
          },
        })
        .then(
          () => null,
          (error) => error
        ),
      1_000,
      "runner hung after stdin closed during a write"
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(failure?.message, "ruyipage backend stdin failed");
    assert.deepEqual(
      asynchronousFailures,
      [],
      "stdin stream errors must not escape as uncaught or unhandled failures"
    );
  } finally {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

async function runProtocolSelfTest() {
  const child = spawn(python, [script, "--protocol-self-test"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (buf) => {
    stdout += buf.toString();
  });
  child.stderr.on("data", (buf) => {
    stderr += buf.toString();
  });

  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  const events = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(events[0].event, "ready");
  assert.equal(events.at(-1).event, "result");
  assert.equal(events.at(-1).success, true);
}

async function runNodeRunnerSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--node-runner-self-test-child"],
  });

  const events = [];
  let prepared = false;
  const result = await runner.run({
    creds: FIXTURE_CREDS,
    reportDir: "data/reports/protocol-test",
    onEvent(event) {
      events.push(event.event);
    },
    async prepare2FA() {
      prepared = true;
    },
    async get2FACode(request) {
      assert.equal(prepared, true, "2FA code must not be requested before preparation");
      assert.deepEqual(request, { generation: 1, rejectPrevious: false });
      return SECRET_FIXTURES.verificationCode;
    },
  });

  assert.deepEqual(events, ["ready", "prepare_2fa", "need_2fa", "result"]);
  assert.equal(result.success, true);
  assert.equal(result.twoFaCodeLength, 6);
  assert.equal(result.receivedGeneration, 1);
  assert.equal(result.credentialsInArgv, false);
}

async function runNodeRunnerDelayedResultOnEventSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-after-result-child"],
    timeoutMs: 10_000,
    eventHandlerTimeoutMs: 500,
  });

  let sawResultEvent = false;
  let releaseResultEvent;
  const resultEventPending = new Promise((resolve) => {
    releaseResultEvent = resolve;
  });
  const runOutcome = runner.run({
    creds: FIXTURE_CREDS,
    reportDir: "data/reports/protocol-test",
    onEvent(event) {
      if (event.event === "result") {
        sawResultEvent = true;
        return resultEventPending;
      }
    },
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseResultEvent();

  const outcome = await runOutcome;
  assert.equal(outcome.ok, true, String(outcome.error));
  assert.equal(sawResultEvent, true);
  assert.equal(outcome.value.success, true);
}

async function runNodeRunnerPendingEventChildExitSelfTest() {
  const before = process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-after-ready-child"],
    timeoutMs: 10_000,
    eventHandlerTimeoutMs: 60_000,
  });

  let rejectHandler;
  const handlerPending = new Promise((_, reject) => {
    rejectHandler = reject;
  });
  const asynchronousFailures = [];
  const onUncaughtException = (error) => asynchronousFailures.push(error);
  const onUnhandledRejection = (error) => asynchronousFailures.push(error);
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const startedAt = Date.now();
    await assert.rejects(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          onEvent() {
            return handlerPending;
          },
        }),
        1_000,
        "runner hung after child exited with a pending onEvent handler"
      ),
      /ruyipage backend exited 0/
    );
    assert.ok(Date.now() - startedAt < 1_000, "child exit rejection must be prompt");

    rejectHandler(new Error("late onEvent rejection"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(asynchronousFailures, [], "late onEvent rejection must remain observed");
    await new Promise((resolve) => setImmediate(resolve));
    const after = process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
    assert.equal(after, before, "child exit must clear the onEvent handler timeout");
  } finally {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

async function runNodeRunnerPendingEventHandlerTimeoutSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-ready-child"],
    timeoutMs: 10_000,
    killGraceMs: 100,
    eventHandlerTimeoutMs: 80,
  });

  await assert.rejects(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent() {
          return new Promise(() => {});
        },
      }),
      1_000,
      "runner hung after the onEvent handler timeout"
    ),
    (error) => {
      assert.equal(error.message, "ruyipage onEvent handler timed out for ready after 80ms");
      return true;
    }
  );
}

async function runNodeRunnerPendingResultHandlerTimeoutSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-after-result-without-newline-child"],
    timeoutMs: 10_000,
    eventHandlerTimeoutMs: 80,
  });

  await assert.rejects(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent() {
          return new Promise(() => {});
        },
      }),
      1_000,
      "runner hung after the result onEvent handler timeout"
    ),
    (error) => {
      assert.equal(error.message, "ruyipage onEvent handler timed out for result after 80ms");
      return true;
    }
  );
}

async function runNodeRunnerPendingEventBackendTimeoutPrioritySelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-ready-child"],
    timeoutMs: 120,
    killGraceMs: 100,
    eventHandlerTimeoutMs: 5_000,
  });
  let handlerCalled = false;

  await assert.rejects(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent() {
          handlerCalled = true;
          return new Promise(() => {});
        },
      }),
      1_500,
      "runner hung after backend timeout with a pending onEvent handler"
    ),
    (error) => {
      assert.equal(error.message, "ruyipage backend timed out after 120ms");
      return true;
    }
  );
  assert.equal(handlerCalled, true, "the backend timeout must race a pending onEvent handler");
}

async function runNodeRunnerSanitizedChildFailureSelfTest() {
  const cases = [
    {
      scenario: "invalid_jsonl",
      arg: "--invalid-json-child",
      expectedMessage: "Invalid JSONL from ruyipage backend",
    },
    {
      scenario: "nonzero_stderr",
      arg: "--stderr-exit-child",
      expectedMessage: "ruyipage backend exited 17",
    },
    {
      scenario: "missing_result_stderr",
      arg: "--stderr-without-result-child",
      expectedMessage: "ruyipage backend exited without result",
    },
    {
      scenario: "failed_result_error",
      arg: "--unsafe-result-error-child",
      expectedMessage: "ruyipage backend failed",
    },
  ];
  const outcomes = [];

  for (const { scenario, arg, expectedMessage } of cases) {
    const runner = createRuyiPageBackendRunner({
      python: process.execPath,
      script: fileURLToPath(import.meta.url),
      cwd: root,
      args: [arg],
      timeoutMs: 2_000,
      killGraceMs: 100,
    });

    const outcome = await captureRunnerFailure(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
          async get2FACode() {
            return SECRET_FIXTURES.verificationCode;
          },
        }),
        1_000,
        `runner hung for ${arg}`
      ),
      expectedMessage
    );
    outcomes.push({ scenario, ...outcome });
  }

  assert.deepEqual(
    outcomes,
    cases.map(({ scenario }) => ({
      scenario,
      rejected: true,
      fixedContract: true,
      leaked: false,
    })),
    "runner child failures must use fixed sanitized contracts"
  );
}

async function runNodeRunnerOnEventFailureSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-ready-child"],
    timeoutMs: 2_000,
    killGraceMs: 50,
  });

  await assertSanitizedCallbackFailure(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent() {
          throw createSecretCallbackError("event handler raw stderr URL");
        },
      }),
      1_000,
      "runner hung after an onEvent callback failure"
    ),
    "ruyipage event handler failed"
  );
}

async function runNodeRunner2FAFailureSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--node-runner-self-test-child"],
  });

  const guarded = Promise.race([
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {},
      async get2FACode() {
        throw createSecretCallbackError("2FA provider raw stderr URL");
      },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("runner hung after 2fa failure")), 2000);
    }),
  ]);

  await assertSanitizedCallbackFailure(guarded, "ruyipage 2FA code provider failed");
}

async function runNodeRunnerImmediateExitDuring2FASelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-after-need-2fa-child"],
    timeoutMs: 10_000,
  });

  let resolveCode;
  const codePending = new Promise((resolve) => {
    resolveCode = resolve;
  });
  const asynchronousFailures = [];
  const onUncaughtException = (error) => {
    asynchronousFailures.push(error);
  };
  const onUnhandledRejection = (error) => {
    asynchronousFailures.push(error);
  };
  let codeRequested = false;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const startedAt = Date.now();
    await assert.rejects(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
          async get2FACode() {
            codeRequested = true;
            return codePending;
          },
        }),
        1_000,
        "runner hung after child exited during 2FA"
      ),
      /backend exited/i
    );
    assert.ok(Date.now() - startedAt < 1_000, "child exit rejection must be prompt");
    assert.equal(codeRequested, true, "the regression must cover a pending 2FA provider");

    resolveCode(SECRET_FIXTURES.verificationCode);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      asynchronousFailures,
      [],
      "late 2FA completion must not write to closed child stdin"
    );
  } finally {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

async function runNodeRunnerImmediateExitDuringPreparationSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--exit-after-prepare-2fa-child"],
    timeoutMs: 10_000,
  });

  let prepareRequested = false;
  await assert.rejects(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        async prepare2FA() {
          prepareRequested = true;
          return new Promise(() => {});
        },
        async get2FACode() {
          return SECRET_FIXTURES.verificationCode;
        },
      }),
      1_000,
      "runner hung after child exited during 2FA preparation"
    ),
    /backend exited/i
  );
  assert.equal(
    prepareRequested,
    true,
    "the regression must cover a pending 2FA preparation handler"
  );
}

async function runNodeRunnerPreparationFailureSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--node-runner-self-test-child"],
  });

  let codeRequested = false;
  const guarded = Promise.race([
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {
        throw createSecretCallbackError("2FA preparation raw stderr URL");
      },
      async get2FACode() {
        codeRequested = true;
        return SECRET_FIXTURES.verificationCode;
      },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("runner hung after preparation failure")), 2000);
    }),
  ]);

  await assertSanitizedCallbackFailure(guarded, "ruyipage 2FA preparation failed");
  assert.equal(codeRequested, false);
}

async function runNodeRunnerTimeoutSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python,
    script,
    cwd: root,
    args: ["--hang-self-test"],
    timeoutMs: 500,
  });

  await assert.rejects(
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async get2FACode() {
        return SECRET_FIXTURES.verificationCode;
      },
    }),
    /timed out/i
  );
}

async function runNodeRunnerPending2FATimeoutPrioritySelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--hang-after-need-2fa-child"],
    timeoutMs: 150,
    killGraceMs: 100,
  });

  await assert.rejects(
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        async prepare2FA() {},
        async get2FACode() {
          return new Promise(() => {});
        },
      }),
      1_500,
      "runner hung after timeout while 2FA provider was pending"
    ),
    /timed out after 150ms/i
  );
}

async function runNodeRunnerForcedTimeoutSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python,
    script,
    cwd: root,
    args: ["--ignore-signals-self-test"],
    timeoutMs: 200,
    killGraceMs: 200,
  });

  await assert.rejects(
    Promise.race([
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        async get2FACode() {
          return SECRET_FIXTURES.verificationCode;
        },
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("forced backend timeout did not terminate")), 2000);
      }),
    ]),
    /timed out/i
  );
}

async function runNodeRunnerSpawnFailureSelfTest() {
  const before = process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
  const missingExecutable = path.join(root, "definitely-missing-python");
  const runner = createRuyiPageBackendRunner({
    python: missingExecutable,
    timeoutMs: 60_000,
  });

  await assert.rejects(
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async get2FACode() {
        return SECRET_FIXTURES.verificationCode;
      },
    }),
    /ENOENT|spawn/i
  );
  await new Promise((resolve) => setImmediate(resolve));
  const after = process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
  assert.equal(after, before, "spawn failure must not leave the backend timeout active");
}

async function runNodeRunnerCloseBoundarySelfTest() {
  const createRunner = (arg) =>
    createRuyiPageBackendRunner({
      python: process.execPath,
      script: fileURLToPath(import.meta.url),
      cwd: root,
      args: [arg],
      timeoutMs: 2_000,
      killGraceMs: 100,
    });
  const run = (arg) =>
    createRunner(arg).run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
    });

  const delayedResult = await withRejectGuard(
    run("--exit-before-delayed-result-child").then(
      (result) => ({ resolved: true, success: result.success === true }),
      () => ({ resolved: false, success: false })
    ),
    1_000,
    "runner did not finish after delayed stdout closed"
  );
  const delayedInvalid = await captureRunnerFailure(
    withRejectGuard(
      run("--exit-before-delayed-invalid-tail-child"),
      1_000,
      "runner did not process delayed invalid stdout"
    ),
    "Invalid JSONL from ruyipage backend"
  );

  assert.deepEqual(
    {
      delayedResult,
      delayedInvalid: {
        rejected: delayedInvalid.rejected,
        fixedContract: delayedInvalid.fixedContract,
      },
    },
    {
      delayedResult: { resolved: true, success: true },
      delayedInvalid: { rejected: true, fixedContract: true },
    }
  );
}

async function runNodeRunnerStrictResultContractSelfTest() {
  const args = [
    "--result-success-missing-child",
    "--result-success-null-child",
    "--result-success-string-child",
  ];
  const outcomes = [];
  for (const arg of args) {
    const runner = createRuyiPageBackendRunner({
      python: process.execPath,
      script: fileURLToPath(import.meta.url),
      cwd: root,
      args: [arg],
      timeoutMs: 2_000,
      killGraceMs: 100,
    });
    const outcome = await captureRunnerFailure(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
      }),
      "ruyipage backend failed"
    );
    outcomes.push({ rejected: outcome.rejected, fixedContract: outcome.fixedContract });
  }
  assert.deepEqual(
    outcomes,
    args.map(() => ({ rejected: true, fixedContract: true }))
  );
}

async function runNodeRunnerSplitUtf8ChunkSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--split-utf8-chunks-child"],
    timeoutMs: 2_000,
    killGraceMs: 100,
  });
  const warningMessages = [];
  const result = await runner.run({
    creds: FIXTURE_CREDS,
    reportDir: "data/reports/protocol-test",
    onEvent(event) {
      if (event.event === "warning") warningMessages.push(event.message);
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(warningMessages, [SPLIT_UTF8_MESSAGE]);
}

const focusedTests = {
  "live-descendant": runChildStopperLiveDescendantSelfTest,
  "cleanup-timeout": runChildStopperCleanupDeadlineSelfTest,
  "runner-cleanup": runNodeRunnerProcessGroupSettlementSelfTest,
  "runner-cleanup-failure": runNodeRunnerCleanupFailureWithoutChildExitSelfTest,
  "normal-close-descendant": runNodeRunnerNormalCloseDescendantCleanupSelfTest,
  "normal-close-cleanup-failure": runNodeRunnerNormalCloseDescendantCleanupFailureSelfTest,
  "timeout-config": runBackendTimeoutConfigTest,
  "callback-on-event-secret": runNodeRunnerOnEventFailureSelfTest,
  "callback-prepare-secret": runNodeRunnerPreparationFailureSelfTest,
  "callback-code-secret": runNodeRunner2FAFailureSelfTest,
  generations: runNodeRunnerGenerationProtocolSelfTest,
  "invalid-generations": runNodeRunnerInvalidGenerationSelfTest,
  "stdin-eof": runNodeRunnerStdinEofSelfTest,
  "close-boundary": runNodeRunnerCloseBoundarySelfTest,
  "strict-result": runNodeRunnerStrictResultContractSelfTest,
  "utf8-chunks": runNodeRunnerSplitUtf8ChunkSelfTest,
};

const focusedTest = process.env.RUYIPAGE_PROTOCOL_FOCUSED_TEST;
if (focusedTest) {
  const test = focusedTests[focusedTest];
  assert.ok(test, `unknown focused test: ${focusedTest}`);
  await test();
  console.log(`ruyipage protocol focused test: ${focusedTest} ok`);
  process.exit(0);
}

runChildStopperSelfTest();
await runChildStopperLiveDescendantSelfTest();
await runChildStopperCleanupDeadlineSelfTest();
await runNodeRunnerProcessGroupSettlementSelfTest();
await runNodeRunnerCleanupFailureWithoutChildExitSelfTest();
await runNodeRunnerNormalCloseDescendantCleanupSelfTest();
await runNodeRunnerNormalCloseDescendantCleanupFailureSelfTest();
await runNodeRunnerGenerationProtocolSelfTest();
await runNodeRunnerInvalidGenerationSelfTest();
await runNodeRunnerPendingEventChildExitSelfTest();
await runNodeRunnerPendingEventHandlerTimeoutSelfTest();
await runNodeRunnerPendingResultHandlerTimeoutSelfTest();
await runNodeRunnerPendingEventBackendTimeoutPrioritySelfTest();
await runNodeRunnerSanitizedChildFailureSelfTest();
await runNodeRunnerOnEventFailureSelfTest();
runBackendTimeoutConfigTest();
await runProtocolSelfTest();
await runNodeRunnerSelfTest();
await runNodeRunnerDelayedResultOnEventSelfTest();
await runNodeRunnerPreparationFailureSelfTest();
await runNodeRunner2FAFailureSelfTest();
await runNodeRunnerImmediateExitDuring2FASelfTest();
await runNodeRunnerImmediateExitDuringPreparationSelfTest();
await runNodeRunnerStdinEofSelfTest();
await runNodeRunnerTimeoutSelfTest();
await runNodeRunnerPending2FATimeoutPrioritySelfTest();
await runNodeRunnerForcedTimeoutSelfTest();
await runNodeRunnerSpawnFailureSelfTest();
await runNodeRunnerCloseBoundarySelfTest();
await runNodeRunnerStrictResultContractSelfTest();
await runNodeRunnerSplitUtf8ChunkSelfTest();

console.log("ruyipage protocol: ok");
