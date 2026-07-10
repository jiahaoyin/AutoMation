import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
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

function runBackendTimeoutConfigTest() {
  assert.deepEqual(resolveBackendTimeouts({}), {
    timeoutMs: 720_000,
    killGraceMs: 5_000,
  });
  assert.deepEqual(
    resolveBackendTimeouts({
      RUYIPAGE_BACKEND_TIMEOUT_MS: "900000",
      RUYIPAGE_KILL_GRACE_MS: "7500",
    }),
    {
      timeoutMs: 900_000,
      killGraceMs: 7_500,
    }
  );
  assert.deepEqual(
    resolveBackendTimeouts({
      RUYIPAGE_BACKEND_TIMEOUT_MS: "0",
      RUYIPAGE_KILL_GRACE_MS: "not-a-number",
    }),
    {
      timeoutMs: 720_000,
      killGraceMs: 5_000,
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
  assert.deepEqual(signals.at(-1), [-1234, "SIGKILL"]);
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
    python,
    script,
    cwd: root,
    args: ["--node-self-test"],
  });

  const events = [];
  let prepared = false;
  const result = await runner.run({
    creds: { appleId: "person@example.com", password: "secret" },
    reportDir: "data/reports/protocol-test",
    onEvent(event) {
      events.push(event.event);
    },
    async prepare2FA() {
      prepared = true;
    },
    async get2FACode() {
      assert.equal(prepared, true, "2FA code must not be requested before preparation");
      return "123456";
    },
  });

  assert.deepEqual(events, ["ready", "prepare_2fa", "need_2fa", "result"]);
  assert.equal(result.success, true);
  assert.equal(result.twoFaCodeLength, 6);
  assert.equal(result.credentialsInArgv, false);
}

async function runNodeRunner2FAFailureSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python,
    script,
    cwd: root,
    args: ["--node-self-test"],
  });

  const guarded = Promise.race([
    runner.run({
      creds: { appleId: "person@example.com", password: "secret" },
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {},
      async get2FACode() {
        throw new Error("2fa failed");
      },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("runner hung after 2fa failure")), 2000);
    }),
  ]);

  await assert.rejects(guarded, /2fa failed/);
}

async function runNodeRunnerPreparationFailureSelfTest() {
  const runner = createRuyiPageBackendRunner({
    python,
    script,
    cwd: root,
    args: ["--node-self-test"],
  });

  let codeRequested = false;
  const guarded = Promise.race([
    runner.run({
      creds: { appleId: "person@example.com", password: "secret" },
      reportDir: "data/reports/protocol-test",
      async prepare2FA() {
        throw new Error("preparation failed");
      },
      async get2FACode() {
        codeRequested = true;
        return "123456";
      },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("runner hung after preparation failure")), 2000);
    }),
  ]);

  await assert.rejects(guarded, /preparation failed/);
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
      creds: { appleId: "person@example.com", password: "secret" },
      reportDir: "data/reports/protocol-test",
      async get2FACode() {
        return "123456";
      },
    }),
    /timed out/i
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
        creds: { appleId: "person@example.com", password: "secret" },
        reportDir: "data/reports/protocol-test",
        async get2FACode() {
          return "123456";
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
  const runner = createRuyiPageBackendRunner({
    python: path.join(root, "definitely-missing-python"),
    timeoutMs: 60_000,
  });

  await assert.rejects(
    runner.run({
      creds: { appleId: "person@example.com", password: "secret" },
      reportDir: "data/reports/protocol-test",
      async get2FACode() {
        return "123456";
      },
    }),
    /ENOENT|spawn/i
  );
  await new Promise((resolve) => setImmediate(resolve));
  const after = process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
  assert.equal(after, before, "spawn failure must not leave the backend timeout active");
}

runBackendTimeoutConfigTest();
runChildStopperSelfTest();
await runProtocolSelfTest();
await runNodeRunnerSelfTest();
await runNodeRunnerPreparationFailureSelfTest();
await runNodeRunner2FAFailureSelfTest();
await runNodeRunnerTimeoutSelfTest();
await runNodeRunnerForcedTimeoutSelfTest();
await runNodeRunnerSpawnFailureSelfTest();

console.log("ruyipage protocol: ok");
