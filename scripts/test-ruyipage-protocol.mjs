import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  buildRuyiPageProcessSupervisorScript,
  createBrowserBrokerChild,
  createChildStopper,
  createRuyiPageBackendRunner,
  resolveBackendTimeouts,
  shouldCleanUpRuyiPageProcessGroup,
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

if (process.argv.includes("--failed-result-exit-child")) {
  process.stdout.write(
    `${JSON.stringify({ event: "result", success: false, failureStage: "twofa_input" })}\n`,
    () => process.exit(1)
  );
  await new Promise(() => {});
}

if (process.argv.includes("--failed-result-after-failure-events-child")) {
  const events = [
    { event: "status", status: "browser_failure", failureStage: "password_input" },
    {
      event: "diagnostic",
      failureStage: "password_input",
      errorType: "RuntimeError",
      message: "password input verification failed",
    },
    { event: "result", success: false, failureStage: "password_input" },
  ];
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, () => {
    process.exit(1);
  });
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
    const command = await readCommand();
    if (command?.type === "2fa_code" && command.generation === generation) {
      await writeEvent({
        event: "status",
        status: "twofa_progress",
        phase: "code_received",
        generation,
      });
    }
    return command;
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

class ControlledBrokerSocket extends Duplex {
  constructor({ writeError = null, deferWrites = false, onWrite = null } = {}) {
    super({ allowHalfOpen: true });
    this.writeError = writeError;
    this.deferWrites = deferWrites;
    this.onWrite = onWrite;
    this.outbound = [];
    this.pendingWrites = [];
    this.destroyCalls = 0;
    this.unrefCalls = 0;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    const copy = Buffer.from(chunk);
    this.outbound.push(copy);
    try {
      this.onWrite?.(copy);
    } catch (error) {
      queueMicrotask(() => callback(error));
      return;
    }
    if (this.deferWrites) {
      this.pendingWrites.push(callback);
      return;
    }
    queueMicrotask(() => callback(this.writeError));
  }

  _destroy(error, callback) {
    this.destroyCalls += 1;
    callback(error);
  }

  receive(payload) {
    if (!this.destroyed) this.push(Buffer.from(payload));
  }

  endFromPeer(payload = "") {
    if (payload) this.receive(payload);
    if (!this.destroyed) this.push(null);
  }

  settlePendingWrites(error = this.writeError) {
    for (const callback of this.pendingWrites.splice(0)) callback(error);
  }

  outboundText() {
    return Buffer.concat(this.outbound).toString("utf8");
  }

  unref() {
    this.unrefCalls += 1;
  }
}

function createSocketBrokerChild({
  socket = new ControlledBrokerSocket(),
  connectTimeoutMs = 200,
  autoConnect = true,
  socketPath = "/broker/browser.sock",
  createConnectionError = null,
} = {}) {
  const connectionCalls = [];
  const child = createBrowserBrokerChild({
    socketPath,
    creds: FIXTURE_CREDS,
    connectTimeoutMs,
    createConnection(options) {
      connectionCalls.push(options);
      if (createConnectionError) throw createConnectionError;
      if (autoConnect) queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  return { child, socket, connectionCalls };
}

async function captureBrokerTerminal(child, action) {
  const errorOutcome = new Promise((resolve) => {
    child.once("error", resolve);
  });
  const closeOutcome = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  action();
  const error = await withRejectGuard(
    errorOutcome,
    500,
    "broker facade did not emit its fixed error"
  );
  const close = await withRejectGuard(
    closeOutcome,
    500,
    "broker facade did not close after its fixed error"
  );
  return { error, close };
}

function assertBrokerErrorIsPrivate(error, expectedMessage) {
  assert.equal(error?.message, expectedMessage);
  assert.equal(error?.cause, undefined);
  assert.equal(error?.stdout, undefined);
  assert.equal(error?.stderr, undefined);
  assert.equal(error?.raw, undefined);
  const exposed = [String(error), String(error?.stack ?? ""), JSON.stringify(error)].join("\n");
  for (const [label, secret] of Object.entries(SECRET_FIXTURES)) {
    assert.equal(exposed.includes(secret), false, `broker failure leaked ${label}`);
  }
}

function assertBrokerCredentialsFrame(frame) {
  assert.deepEqual(Object.keys(frame ?? {}).sort(), ["appleId", "password", "type"]);
  assert.equal(frame?.type, "credentials");
  assert.equal(frame?.appleId === FIXTURE_CREDS.appleId, true, "broker Apple ID mismatch");
  assert.equal(frame?.password === FIXTURE_CREDS.password, true, "broker password mismatch");
}

function parseOutboundFrames(socket) {
  return socket
    .outboundText()
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runBrowserBrokerSocketSelfTest() {
  const { child, socket, connectionCalls } = createSocketBrokerChild();
  let stdoutText = "";
  let stderrText = "";
  const terminalEvents = [];
  child.stdout.on("data", (chunk) => {
    stdoutText += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
  });
  child.once("exit", (code, signal) => terminalEvents.push(["exit", code, signal]));
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      terminalEvents.push(["close", code, signal]);
      resolve();
    });
  });

  assert.strictEqual(child.stdin, socket);
  assert.strictEqual(child.stdout, socket);
  await child.connected;
  assert.deepEqual(connectionCalls, [{ path: "/broker/browser.sock" }]);
  const initialFrames = parseOutboundFrames(socket);
  assert.equal(initialFrames.length, 1, "credentials must be the first socket frame");
  assertBrokerCredentialsFrame(initialFrames[0]);

  socket.receive(`${JSON.stringify({ event: "ready", mode: "socket-self-test" })}\n`);
  socket.endFromPeer(`${JSON.stringify({ event: "result", success: true })}\n`);
  await withRejectGuard(closed, 500, "broker facade did not close after socket EOF");

  assert.deepEqual(
    stdoutText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    [
      { event: "ready", mode: "socket-self-test" },
      { event: "result", success: true },
    ]
  );
  assert.equal(stderrText, "");
  assert.deepEqual(terminalEvents, [
    ["exit", 0, null],
    ["close", 0, null],
  ]);
  assert.equal(child.kill("SIGKILL"), false, "closed broker facade must not signal anything");
  await child.cleanup();
}

async function runBrowserBrokerCleanupSelfTest() {
  const { child, socket } = createSocketBrokerChild();
  await child.connected;
  const terminalEvents = [];
  child.once("exit", (code, signal) => terminalEvents.push(["exit", code, signal]));
  child.once("close", (code, signal) => terminalEvents.push(["close", code, signal]));

  await withRejectGuard(child.cleanup(), 100, "broker facade cleanup was not bounded");
  assert.equal(child.pid, undefined);
  assert.equal(child.killed, true);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  assert.ok(socket.destroyCalls > 0, "cleanup must destroy the socket");
  assert.deepEqual(terminalEvents, [
    ["exit", null, "SIGTERM"],
    ["close", null, "SIGTERM"],
  ]);
  assert.equal(child.kill("SIGKILL"), false);
}

async function runBrowserBrokerConnectionFailureSelfTest() {
  const child = createSocketBrokerChild({
    autoConnect: false,
    createConnectionError: new Error(SECRET_CHILD_OUTPUT),
  }).child;
  const { error, close } = await captureBrokerTerminal(child, () => {});
  assertBrokerErrorIsPrivate(
    error,
    "ruyipage browser broker socket connection failed"
  );
  assert.deepEqual(close, { code: 1, signal: null });
  await assert.rejects(child.connected, /socket connection failed/);
}

async function runBrowserBrokerSocketErrorSelfTest() {
  const { child, socket } = createSocketBrokerChild({ autoConnect: false });
  const { error, close } = await captureBrokerTerminal(child, () => {
    socket.destroy(new Error(SECRET_CHILD_OUTPUT));
  });
  assertBrokerErrorIsPrivate(
    error,
    "ruyipage browser broker socket connection failed"
  );
  assert.deepEqual(close, { code: 1, signal: null });
}

async function runBrowserBrokerConnectTimeoutSelfTest() {
  const { child, socket } = createSocketBrokerChild({
    autoConnect: false,
    connectTimeoutMs: 20,
  });
  const startedAt = Date.now();
  const { error } = await captureBrokerTerminal(child, () => {});
  assertBrokerErrorIsPrivate(
    error,
    "ruyipage browser broker socket connection timed out"
  );
  assert.ok(Date.now() - startedAt < 300, "socket connect timeout must remain bounded");
  assert.ok(socket.destroyCalls > 0, "connect timeout must cancel the socket");
}

async function runBrowserBrokerWriteFailureSelfTest() {
  const socket = new ControlledBrokerSocket({
    writeError: new Error(SECRET_CHILD_OUTPUT),
  });
  const { child } = createSocketBrokerChild({ socket });
  const { error } = await captureBrokerTerminal(child, () => {});
  assertBrokerErrorIsPrivate(error, "ruyipage browser broker socket I/O failed");
  assert.equal(parseOutboundFrames(socket).length, 1);
  assertBrokerCredentialsFrame(parseOutboundFrames(socket)[0]);
}

async function runBrowserBrokerEofSelfTest() {
  const { child, socket } = createSocketBrokerChild();
  child.stdout.resume();
  await child.connected;
  const close = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  socket.endFromPeer();
  assert.deepEqual(
    await withRejectGuard(close, 500, "broker facade did not close after EOF"),
    { code: 0, signal: null }
  );
}

async function withBrowserBrokerEnvironment(operation) {
  const overrides = {
    APPLE_AUTOMATION_BROWSER_BROKER_SOCKET: "/broker/browser.sock",
  };
  const previous = new Map();
  const priorMode = {
    present: Object.prototype.hasOwnProperty.call(
      process.env,
      "APPLE_AUTOMATION_BROWSER_BROKER_MODE"
    ),
    value: process.env.APPLE_AUTOMATION_BROWSER_BROKER_MODE,
  };
  delete process.env.APPLE_AUTOMATION_BROWSER_BROKER_MODE;
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, {
      present: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    });
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, prior] of previous) {
      if (prior.present) process.env[name] = prior.value;
      else delete process.env[name];
    }
    if (priorMode.present) {
      process.env.APPLE_AUTOMATION_BROWSER_BROKER_MODE = priorMode.value;
    } else {
      delete process.env.APPLE_AUTOMATION_BROWSER_BROKER_MODE;
    }
  }
}

async function runNodeRunnerBrowserBrokerSelfTest() {
  const commands = [];
  const events = [];
  const connectionCalls = [];
  let commandBuffer = "";
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      commandBuffer += chunk.toString("utf8");
      const lines = commandBuffer.split(/\r?\n/);
      commandBuffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const command = JSON.parse(line);
        commands.push(command);
        if (commands.length === 1) {
          socket.receive(`${JSON.stringify({ event: "ready", mode: "broker" })}\n`);
          socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
        } else if (command.type === "2fa_prepared") {
          socket.receive(
            `${JSON.stringify({ event: "2fa_command_ack", command: "2fa_prepared" })}\n`
          );
          socket.receive(`${JSON.stringify({ event: "need_2fa", generation: 1 })}\n`);
        } else if (command.type === "2fa_code") {
          socket.endFromPeer(
            `${JSON.stringify({
              event: "2fa_command_ack",
              command: "2fa_code",
              generation: command.generation,
            })}\n${JSON.stringify({
              event: "result",
              success: command.code === SECRET_FIXTURES.verificationCode,
              receivedGeneration: command.generation,
            })}\n`
          );
        }
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      createConnection(options) {
        connectionCalls.push(options);
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  const result = await withBrowserBrokerEnvironment(() =>
    withRejectGuard(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
        onEvent(event) {
          events.push(event);
        },
        async prepare2FA() {},
        async get2FACode(request) {
          assert.deepEqual(request, { generation: 1, rejectPrevious: false });
          return SECRET_FIXTURES.verificationCode;
        },
      }),
      1_000,
      "runner hung on the browser broker socket"
    )
  );

  assert.deepEqual(connectionCalls, [{ path: "/broker/browser.sock" }]);
  assert.equal(commands.length, 3);
  assertBrokerCredentialsFrame(commands[0]);
  assert.deepEqual(commands[1], { type: "2fa_prepared" });
  assert.deepEqual(Object.keys(commands[2] ?? {}).sort(), ["code", "generation", "type"]);
  assert.equal(commands[2]?.type, "2fa_code");
  assert.equal(commands[2]?.generation, 1);
  assert.equal(
    commands[2]?.code === SECRET_FIXTURES.verificationCode,
    true,
    "broker verification code mismatch"
  );
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "ready",
      "prepare_2fa",
      "need_2fa",
      "runner_status",
      "runner_status",
      "runner_status",
      "result",
    ]
  );
  assert.deepEqual(
    events.filter((event) => event.event === "runner_status").map((event) => event.status),
    [
      "twofa_code_delivery_started",
      "twofa_code_delivery_sent",
      "twofa_code_delivery_acknowledged",
    ]
  );
  assert.equal(result.success, true);
  assert.equal(result.receivedGeneration, 1);
  const publicOutput = JSON.stringify({ events, result });
  for (const [label, secret] of Object.entries(SECRET_FIXTURES)) {
    assert.equal(publicOutput.includes(secret), false, `broker public events leaked ${label}`);
  }
}

async function runNodeRunnerBrowserBrokerEofSelfTest() {
  const socket = new ControlledBrokerSocket({
    onWrite() {
      socket.endFromPeer();
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  await withBrowserBrokerEnvironment(() =>
    assert.rejects(
      runner.run({
        creds: FIXTURE_CREDS,
        reportDir: "data/reports/protocol-test",
      }),
      (error) => {
        assert.equal(error.message, "ruyipage browser broker socket closed");
        return true;
      }
    )
  );
}

async function runNodeRunnerBrowserBrokerEofDuringPreparationTest() {
  let preparedCommandSeen;
  const preparedCommand = new Promise((resolve) => {
    preparedCommandSeen = resolve;
  });
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      const frame = JSON.parse(chunk.toString("utf8"));
      if (frame.type === "credentials") {
        socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
      } else if (frame.type === "2fa_prepared") {
        preparedCommandSeen();
        setTimeout(() => socket.endFromPeer(), 0);
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  const outcome = withBrowserBrokerEnvironment(() =>
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {},
      async get2FACode() {
        return SECRET_FIXTURES.verificationCode;
      },
    })
  );
  await withRejectGuard(
    preparedCommand,
    500,
    "browser broker did not receive the preparation command"
  );

  await assert.rejects(
    withRejectGuard(outcome, 1_000, "runner hung awaiting preparation acknowledgement"),
    (error) => {
      assert.equal(error.message, "ruyipage browser broker socket closed");
      return true;
    }
  );
  assert.equal(
    parseOutboundFrames(socket).some((frame) => frame.type === "2fa_prepared"),
    true,
    "the test must exercise a post-write EOF rather than callback cancellation"
  );
}

async function runNodeRunnerBrowserBrokerEofDuringCodeDeliveryTest() {
  let codeRequested;
  const requestedCode = new Promise((resolve) => {
    codeRequested = resolve;
  });
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      const frame = JSON.parse(chunk.toString("utf8"));
      if (frame.type === "credentials") {
        socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
      } else if (frame.type === "2fa_prepared") {
        socket.receive(
          `${JSON.stringify({ event: "2fa_command_ack", command: "2fa_prepared" })}\n`
        );
        socket.receive(`${JSON.stringify({ event: "need_2fa", generation: 1 })}\n`);
      } else if (frame.type === "2fa_code") {
        setTimeout(() => socket.endFromPeer(), 0);
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  const outcome = withBrowserBrokerEnvironment(() =>
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {},
      async get2FACode() {
        codeRequested();
        return SECRET_FIXTURES.verificationCode;
      },
    })
  );
  await withRejectGuard(requestedCode, 500, "browser broker did not request a 2FA code");

  await assert.rejects(
    withRejectGuard(outcome, 1_000, "runner hung awaiting verification-code acknowledgement"),
    (error) => {
      assert.equal(error.message, "ruyipage browser broker socket closed");
      return true;
    }
  );
  assert.equal(
    parseOutboundFrames(socket).some((frame) => frame.type === "2fa_code"),
    true,
    "the test must exercise a post-write EOF rather than provider cancellation"
  );
}

async function runNodeRunnerBrowserBrokerCommandAckTimeoutTest() {
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      const frame = JSON.parse(chunk.toString("utf8"));
      if (frame.type === "credentials") {
        socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      commandAckTimeoutMs: 20,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  await withBrowserBrokerEnvironment(() =>
    assert.rejects(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
        }),
        1_000,
        "runner hung awaiting a missing broker acknowledgement"
      ),
      (error) => {
        assert.equal(
          error.message,
          "ruyipage browser broker command acknowledgement timed out"
        );
        return true;
      }
    )
  );
}

async function runNodeRunnerBrowserBrokerCommandAckTimeoutIsCappedTest() {
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      const frame = JSON.parse(chunk.toString("utf8"));
      if (frame.type === "credentials") {
        socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 20_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      commandAckTimeoutMs: 60_000,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  await withBrowserBrokerEnvironment(() =>
    assert.rejects(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
        }),
        6_500,
        "broker acknowledgement timeout exceeded its five-second ceiling"
      ),
      (error) => {
        assert.equal(
          error.message,
          "ruyipage browser broker command acknowledgement timed out"
        );
        return true;
      }
    )
  );
}

async function runNodeRunnerBrowserBrokerInvalidCommandAckTest() {
  const socket = new ControlledBrokerSocket({
    onWrite(chunk) {
      const frame = JSON.parse(chunk.toString("utf8"));
      if (frame.type === "credentials") {
        socket.receive(`${JSON.stringify({ event: "prepare_2fa" })}\n`);
      } else if (frame.type === "2fa_prepared") {
        socket.receive(
          `${JSON.stringify({
            event: "2fa_command_ack",
            command: "2fa_code",
            generation: 1,
          })}\n`
        );
      }
    },
  });
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "broker-mode-must-not-spawn-python"),
    timeoutMs: 2_000,
    killGraceMs: 50,
    browserBrokerTransportOptions: {
      connectTimeoutMs: 200,
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });

  await withBrowserBrokerEnvironment(() =>
    assert.rejects(
      withRejectGuard(
        runner.run({
          creds: FIXTURE_CREDS,
          reportDir: "data/reports/protocol-test",
          async prepare2FA() {},
        }),
        1_000,
        "runner hung after an invalid broker acknowledgement"
      ),
      (error) => {
        assert.equal(
          error.message,
          "ruyipage browser broker command acknowledgement invalid"
        );
        return true;
      }
    )
  );
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

async function runChildStopperIdentityChangeSelfTest() {
  const signals = [];
  let identityMatches = true;
  const child = {
    pid: 6543,
    stdin: { end() {} },
    kill(signal) {
      signals.push(["child", signal]);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    graceMs: 20,
    cleanupPollIntervalMs: 5,
    forceCleanupTimeoutMs: 30,
    verifyProcessGroupIdentity: () => identityMatches,
    signalProcessGroup(pid, signal) {
      signals.push([pid, signal]);
    },
  });

  stopper.stop();
  identityMatches = false;
  const failure = await stopper.waitForCleanup().then(
    () => null,
    (error) => error
  );
  assert.equal(failure?.message, "ruyipage backend cleanup failed");
  assert.ok(signals.some(([, signal]) => signal === "SIGINT"));
  assert.equal(
    signals.some(([, signal]) => signal === "SIGKILL"),
    false,
    "identity changes must block force signals"
  );
}

async function runChildStopperFallbackIdentityChangeSelfTest() {
  const childSignals = [];
  let identityMatches = true;
  const child = {
    pid: 7654,
    stdin: { end() {} },
    kill(signal) {
      childSignals.push(signal);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    graceMs: 20,
    cleanupPollIntervalMs: 5,
    forceCleanupTimeoutMs: 30,
    verifyProcessGroupIdentity: () => identityMatches,
    signalProcessGroup(_pid, signal) {
      if (signal === "SIGINT") {
        identityMatches = false;
        throw Object.assign(new Error("group signal failed"), { code: "EPERM" });
      }
      throw Object.assign(new Error("group is gone"), { code: "ESRCH" });
    },
  });

  stopper.stop();
  await stopper.waitForCleanup();
  assert.deepEqual(
    childSignals,
    [],
    "a failed non-Windows group signal must never fall back to a single-PID signal"
  );
}

async function runChildStopperDirectChildSelfTest() {
  const childSignals = [];
  const child = {
    pid: 8765,
    exitCode: null,
    signalCode: null,
    stdin: { end() {} },
    kill(signal) {
      childSignals.push(signal);
    },
  };
  const stopper = createChildStopper(child, {
    platform: "darwin",
    useProcessGroup: false,
    graceMs: 100,
    signalProcessGroup() {
      throw new Error("direct child mode must not signal a process group");
    },
  });
  stopper.stop();
  assert.deepEqual(childSignals, ["SIGINT"]);
  child.exitCode = 0;
  stopper.cancelForce();
  await stopper.waitForCleanup();
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

function readSpawnStdout(outcome) {
  return typeof outcome?.stdout === "string" ? outcome.stdout : "";
}

function probeProcessEnumeration() {
  if (process.platform === "win32" || !fs.existsSync("/bin/ps")) return false;
  const outcome = spawnSync(
    "/bin/ps",
    ["-p", String(process.pid), "-o", "pid="],
    { encoding: "utf8" }
  );
  if (["EPERM", "EACCES"].includes(outcome.error?.code)) return false;
  assert.ifError(outcome.error);
  assert.equal(outcome.status, 0, "process enumeration probe failed");
  return readSpawnStdout(outcome).trim() === String(process.pid);
}

const PROCESS_ENUMERATION_AVAILABLE = probeProcessEnumeration();

function readDarwinProcessField(pid, field) {
  const args =
    field === "command"
      ? ["-ww", "-p", String(pid), "-o", `${field}=`]
      : ["-p", String(pid), "-o", `${field}=`];
  const outcome = spawnSync("/bin/ps", args, { encoding: "utf8" });
  if (outcome.error || outcome.status !== 0) return "";
  return readSpawnStdout(outcome).trim();
}

function readDarwinProcessIdentity(pid) {
  const pgid = Number(readDarwinProcessField(pid, "pgid"));
  const startedAt = readDarwinProcessField(pid, "lstart").replace(/\s+/g, " ");
  const command = readDarwinProcessField(pid, "command");
  return Number.isInteger(pgid) && pgid > 0 && startedAt && command
    ? { pgid, startedAt, command }
    : null;
}

async function runSupervisorParentExitBeforeGateSelfTest() {
  if (
    process.platform === "win32" ||
    !fs.existsSync("/bin/zsh") ||
    !PROCESS_ENUMERATION_AVAILABLE
  ) {
    return;
  }

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyipage-supervisor-gate-"));
  const statePath = path.join(testDir, ".ruyipage-process.json");
  const gatePath = path.join(testDir, ".ruyipage-launch.ready");
  const cancelPath = path.join(testDir, ".ruyipage-launch.cancel");
  const markerPath = path.join(testDir, "target-ran");
  const parent = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  let parentIdentity = null;
  for (let attempt = 0; attempt < 100 && !parentIdentity; attempt += 1) {
    parentIdentity = readDarwinProcessIdentity(parent.pid);
    if (!parentIdentity) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(parentIdentity, "test parent identity is unavailable");
  const nonce = "a".repeat(32);
  let supervisor = null;
  let supervisorClosed = null;
  try {
    supervisor = spawn(
      "/bin/zsh",
      [
        "-c",
        buildRuyiPageProcessSupervisorScript(),
        "ruyipage-supervisor",
        String(parent.pid),
        String(parentIdentity.pgid),
        parentIdentity.startedAt,
        parentIdentity.command,
        nonce,
        String(Date.now() + 30_000),
        gatePath,
        cancelPath,
        "/usr/bin/touch",
        markerPath,
      ],
      { detached: true, stdio: "ignore" }
    );
    supervisorClosed = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", resolve);
    });
    let supervisorStartedAt = "";
    for (let attempt = 0; attempt < 100 && !supervisorStartedAt; attempt += 1) {
      supervisorStartedAt = readDarwinProcessField(
        supervisor.pid,
        "lstart"
      ).replace(/\s+/g, " ");
      if (!supervisorStartedAt) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(supervisorStartedAt, "test supervisor identity is unavailable");
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        pid: supervisor.pid,
        pgid: supervisor.pid,
        startedAt: supervisorStartedAt,
        nonce,
        commandId: "ruyipage-supervisor-v1",
        commandSha256: "a".repeat(64),
        state: "starting",
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );

    const parentClosed = new Promise((resolve) => parent.once("close", resolve));
    parent.kill("SIGKILL");
    await withRejectGuard(
      parentClosed,
      2_000,
      "test parent did not terminate"
    );
    const exitCode = await withRejectGuard(
      supervisorClosed,
      2_000,
      "ruyipage supervisor survived a dead parent before launch gate"
    );
    assert.equal(exitCode, 125);
    assert.equal(fs.existsSync(markerPath), false, "supervisor must not execute before the gate");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.state, "starting");
  } finally {
    if (processIsAlive(parent.pid)) parent.kill("SIGKILL");
    if (supervisor && processIsAlive(supervisor.pid)) {
      try {
        process.kill(-supervisor.pid, "SIGKILL");
      } catch {
        /* process group may already be gone */
      }
    }
    for (const file of [markerPath, gatePath, cancelPath, statePath]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* each test artifact is removed individually when present */
      }
    }
    fs.rmdirSync(testDir);
  }
}

async function runSupervisorRuntimePolicySelfTest() {
  if (
    process.platform !== "darwin" ||
    !fs.existsSync("/bin/zsh") ||
    !PROCESS_ENUMERATION_AVAILABLE
  ) {
    return;
  }

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyipage-supervisor-runtime-"));
  const cancelPath = path.join(testDir, "cancel");
  const markerPath = path.join(testDir, "target-ran");
  const nonce = "b".repeat(32);
  const parent = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  let parentIdentity = null;
  let helperSupervisor = null;
  let monitoredSupervisor = null;
  try {
    for (let attempt = 0; attempt < 100 && !parentIdentity; attempt += 1) {
      parentIdentity = readDarwinProcessIdentity(parent.pid);
      if (!parentIdentity) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(parentIdentity, "runtime test parent identity is unavailable");
    const spawnSupervisor = (gatePath, targetArgs) =>
      spawn(
        "/bin/zsh",
        [
          "-c",
          buildRuyiPageProcessSupervisorScript(),
          "ruyipage-supervisor",
          String(parent.pid),
          String(parentIdentity.pgid),
          parentIdentity.startedAt,
          parentIdentity.command,
          nonce,
          String(Date.now() + 30_000),
          gatePath,
          cancelPath,
          ...targetArgs,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, TMPDIR: testDir },
        }
      );
    const waitForClose = (child, label, timeoutMs = 8_000) =>
      withRejectGuard(
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
        timeoutMs,
        label
      );
    const openGate = (gatePath, pid) =>
      fs.writeFileSync(
        gatePath,
        `${JSON.stringify({ version: 1, nonce, pid })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );

    const helperGatePath = path.join(testDir, "helper-ready");
    helperSupervisor = spawnSupervisor(helperGatePath, ["/usr/bin/true"]);
    const helperClosed = waitForClose(
      helperSupervisor,
      "snapshot helper was counted as a residual group member",
      5_000
    );
    openGate(helperGatePath, helperSupervisor.pid);
    assert.equal(await helperClosed, 0);

    const monitoredGatePath = path.join(testDir, "monitored-ready");
    monitoredSupervisor = spawnSupervisor(monitoredGatePath, [
      "/bin/zsh",
      "-c",
      `trap 'exit 0' TERM; print -r -- started > '${markerPath.replaceAll("'", `'"'"'`)}'; while :; do /bin/sleep 1; done`,
    ]);
    const monitoredClosed = waitForClose(
      monitoredSupervisor,
      "runtime cancellation did not stop the supervisor"
    );
    openGate(monitoredGatePath, monitoredSupervisor.pid);
    for (let attempt = 0; attempt < 300 && !fs.existsSync(markerPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(markerPath), true, "monitored target did not start");
    fs.writeFileSync(cancelPath, "cancel\n", { encoding: "utf8", flag: "wx" });
    assert.equal(
      await monitoredClosed,
      130,
      "a target that exits zero on TERM must not erase the cancellation status"
    );
  } finally {
    if (processIsAlive(parent.pid)) parent.kill("SIGKILL");
    for (const child of [helperSupervisor, monitoredSupervisor]) {
      if (child && processIsAlive(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* process group may already be gone */
        }
      }
    }
    for (const entry of fs.readdirSync(testDir)) {
      const artifact = path.join(testDir, entry);
      try {
        fs.unlinkSync(artifact);
      } catch {
        /* each test artifact is removed individually when present */
      }
    }
    fs.rmdirSync(testDir);
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
    assert.equal(outcome.error?.ruyiPageFailureCode, "backend_timeout");
    assert.equal(outcome.error?.ruyiPageFailureContext?.cleanupFailed, false);
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

    assert.equal(outcome.error?.message, "ruyipage backend timed out after 30ms");
    assert.equal(outcome.error?.ruyiPageFailureCode, "backend_timeout");
    assert.equal(outcome.error?.ruyiPageFailureContext?.cleanupFailed, true);
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

async function runNodeRunnerSecondGenerationStateResetTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--two-generation-child"],
    timeoutMs: 2_000,
    killGraceMs: 100,
  });
  let failure = null;
  await assert.rejects(
    runner.run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {},
      async get2FACode(request) {
        if (request?.generation === 2) {
          throw createSecretCallbackError("second generation provider failure");
        }
        return SECRET_FIXTURES.verificationCode;
      },
    }),
    (error) => {
      failure = error;
      return error?.ruyiPageFailureCode === "two_fa_provider";
    }
  );
  assert.deepEqual(failure?.ruyiPageFailureContext, {
    stage: "not_started",
    twoFaPhase: "unknown",
    generation: 2,
    codeDeliveryAttempted: false,
    codeDeliverySent: false,
    codeDeliveryAcknowledged: false,
    browserPreserved: false,
    browserErrorClass: "unknown",
    cleanupFailed: false,
  });
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

  assert.deepEqual(events, [
    "ready",
    "prepare_2fa",
    "need_2fa",
    "runner_status",
    "runner_status",
    "status",
    "runner_status",
    "result",
  ]);
  assert.equal(result.success, true);
  assert.equal(result.twoFaCodeLength, 6);
  assert.equal(result.receivedGeneration, 1);
  assert.equal(result.credentialsInArgv, false);
}

function runPreservedBrowserCleanupPolicyTest() {
  assert.equal(
    shouldCleanUpRuyiPageProcessGroup({
      timedOut: false,
      terminationSignal: null,
      usesBrowserBroker: false,
      browserPreserved: true,
    }),
    false,
    "a direct run that explicitly preserved Firefox must not kill its process group"
  );
  assert.equal(
    shouldCleanUpRuyiPageProcessGroup({
      timedOut: false,
      terminationSignal: null,
      usesBrowserBroker: true,
      browserPreserved: true,
    }),
    true,
    "broker/supervised runs keep their strict cleanup contract"
  );
  assert.equal(
    shouldCleanUpRuyiPageProcessGroup({
      timedOut: true,
      terminationSignal: null,
      usesBrowserBroker: false,
      browserPreserved: true,
    }),
    true,
    "a timed-out run must still wait for the timeout cleanup path"
  );
  assert.equal(
    shouldCleanUpRuyiPageProcessGroup({
      timedOut: false,
      terminationSignal: "SIGTERM",
      usesBrowserBroker: false,
      browserPreserved: true,
    }),
    true,
    "an externally interrupted run must still clean up its process group"
  );
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

async function runNodeRunnerTerminalFailureEventsAfterExitSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python: process.execPath,
    script: fileURLToPath(import.meta.url),
    cwd: root,
    args: ["--failed-result-after-failure-events-child"],
    timeoutMs: 10_000,
    eventHandlerTimeoutMs: 500,
  });
  const events = [];
  const releases = [];
  const waitForHandlers = async (count) => {
    const startedAt = Date.now();
    while (releases.length < count) {
      if (Date.now() - startedAt > 500) {
        throw new Error(`terminal failure handler ${count} did not start`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  let settled = false;

  const runOutcome = runner
    .run({
      creds: FIXTURE_CREDS,
      reportDir: "data/reports/protocol-test",
      onEvent(event) {
        events.push({
          event: event.event,
          status: event.status ?? null,
          failureStage: event.failureStage ?? null,
        });
        return new Promise((resolve) => releases.push(resolve));
      },
    })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
  runOutcome.then(() => {
    settled = true;
  });

  await waitForHandlers(1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(
    settled,
    false,
    "terminal failure events must remain drainable after child exit"
  );
  releases.shift()();
  await waitForHandlers(1);
  releases.shift()();
  await waitForHandlers(1);
  releases.shift()();

  const outcome = await withRejectGuard(
    runOutcome,
    1_000,
    "terminal failure events did not finish draining"
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.message, "ruyipage backend failed");
  assert.deepEqual(events, [
    { event: "status", status: "browser_failure", failureStage: "password_input" },
    { event: "diagnostic", status: null, failureStage: "password_input" },
    { event: "result", status: null, failureStage: "password_input" },
  ]);
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
    {
      scenario: "failed_result_nonzero",
      arg: "--failed-result-exit-child",
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

const supervisorContract = buildRuyiPageProcessSupervisorScript();
if (process.platform !== "win32" && fs.existsSync("/bin/zsh")) {
  const syntax = spawnSync("/bin/zsh", ["-n", "-c", supervisorContract], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, "ruyipage supervisor zsh syntax failed");
}
assert.match(
  supervisorContract,
  /parent_pgid=\$2[\s\S]*parent_command=\$4[\s\S]*launch_nonce=\$5[\s\S]*expected_gate=/
);
assert.match(
  supervisorContract,
  /if launch_is_allowed; then[\s\S]*continue[\s\S]*else[\s\S]*monitor_status=\$\?/
);
assert.match(
  supervisorContract,
  /group_snapshot=\$\(\/usr\/bin\/mktemp[\s\S]*snapshot_helper_pid=\$![\s\S]*"\$member_pid" == "\$snapshot_helper_pid"/
);
assert.doesNotMatch(supervisorContract, /group_member_pids|\/usr\/bin\/awk/);
assert.match(
  supervisorContract,
  /target_identity_is_current[\s\S]*current_backend_started_at[\s\S]*current_backend_command[\s\S]*\/bin\/kill -TERM[\s\S]*target_identity_is_current[\s\S]*\/bin\/kill -KILL/
);

const focusedTests = {
  "broker-socket": runBrowserBrokerSocketSelfTest,
  "broker-cleanup": runBrowserBrokerCleanupSelfTest,
  "broker-connect-failure": runBrowserBrokerConnectionFailureSelfTest,
  "broker-socket-error": runBrowserBrokerSocketErrorSelfTest,
  "broker-connect-timeout": runBrowserBrokerConnectTimeoutSelfTest,
  "broker-write-failure": runBrowserBrokerWriteFailureSelfTest,
  "broker-facade-eof": runBrowserBrokerEofSelfTest,
  "broker-runner": runNodeRunnerBrowserBrokerSelfTest,
  "broker-eof": runNodeRunnerBrowserBrokerEofSelfTest,
  "broker-eof-prepare": runNodeRunnerBrowserBrokerEofDuringPreparationTest,
  "broker-eof-code": runNodeRunnerBrowserBrokerEofDuringCodeDeliveryTest,
  "broker-ack-timeout": runNodeRunnerBrowserBrokerCommandAckTimeoutTest,
  "broker-ack-timeout-cap": runNodeRunnerBrowserBrokerCommandAckTimeoutIsCappedTest,
  "broker-ack-invalid": runNodeRunnerBrowserBrokerInvalidCommandAckTest,
  "live-descendant": runChildStopperLiveDescendantSelfTest,
  "cleanup-timeout": runChildStopperCleanupDeadlineSelfTest,
  "identity-change": runChildStopperIdentityChangeSelfTest,
  "fallback-identity-change": runChildStopperFallbackIdentityChangeSelfTest,
  "direct-child": runChildStopperDirectChildSelfTest,
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
  "generation-state-reset": runNodeRunnerSecondGenerationStateResetTest,
  "close-boundary": runNodeRunnerCloseBoundarySelfTest,
  "strict-result": runNodeRunnerStrictResultContractSelfTest,
  "utf8-chunks": runNodeRunnerSplitUtf8ChunkSelfTest,
  "supervisor-parent-exit": runSupervisorParentExitBeforeGateSelfTest,
  "supervisor-runtime-policy": runSupervisorRuntimePolicySelfTest,
  "preserved-browser-cleanup": runPreservedBrowserCleanupPolicyTest,
};

const focusedTest = process.env.RUYIPAGE_PROTOCOL_FOCUSED_TEST;
if (focusedTest) {
  const test = focusedTests[focusedTest];
  assert.ok(test, `unknown focused test: ${focusedTest}`);
  await test();
  console.log(`ruyipage protocol focused test: ${focusedTest} ok`);
  process.exit(0);
}

await runBrowserBrokerSocketSelfTest();
await runBrowserBrokerCleanupSelfTest();
await runBrowserBrokerConnectionFailureSelfTest();
await runBrowserBrokerSocketErrorSelfTest();
await runBrowserBrokerConnectTimeoutSelfTest();
await runBrowserBrokerWriteFailureSelfTest();
await runBrowserBrokerEofSelfTest();
await runNodeRunnerBrowserBrokerSelfTest();
await runNodeRunnerBrowserBrokerEofSelfTest();
await runNodeRunnerBrowserBrokerEofDuringPreparationTest();
await runNodeRunnerBrowserBrokerEofDuringCodeDeliveryTest();
await runNodeRunnerBrowserBrokerCommandAckTimeoutTest();
await runNodeRunnerBrowserBrokerCommandAckTimeoutIsCappedTest();
await runNodeRunnerBrowserBrokerInvalidCommandAckTest();
runPreservedBrowserCleanupPolicyTest();
runChildStopperSelfTest();
await runChildStopperLiveDescendantSelfTest();
await runChildStopperCleanupDeadlineSelfTest();
await runChildStopperIdentityChangeSelfTest();
await runChildStopperFallbackIdentityChangeSelfTest();
await runChildStopperDirectChildSelfTest();
await runNodeRunnerProcessGroupSettlementSelfTest();
await runNodeRunnerCleanupFailureWithoutChildExitSelfTest();
await runNodeRunnerNormalCloseDescendantCleanupSelfTest();
await runNodeRunnerNormalCloseDescendantCleanupFailureSelfTest();
await runNodeRunnerGenerationProtocolSelfTest();
await runNodeRunnerSecondGenerationStateResetTest();
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
await runNodeRunnerTerminalFailureEventsAfterExitSelfTest();
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
await runSupervisorParentExitBeforeGateSelfTest();
await runSupervisorRuntimePolicySelfTest();

console.log("ruyipage protocol: ok");
