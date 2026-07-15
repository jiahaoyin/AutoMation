import { strict as assert } from "node:assert";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  SUPERVISED_PRODUCTION_ENV_KEYS,
  SUPERVISED_PRODUCTION_ENV_POLICY,
} from "./lib/supervised-attestation.js";
import { buildRemoteScript } from "./mac-codex-orchestrator.mjs";
import {
  browserBrokerIdentityMatches,
  buildBrowserBrokerEnvironment,
  buildBrowserBrokerSupervisorScript,
  cleanupBrowserBroker,
  createBrowserBroker,
  prepareBrowserBrokerFilesystem,
  productionEnvironment,
  resolveBrowserBrokerPaths,
  startBrowserBroker,
  validateBrowserBrokerExecutable,
  validateBrowserBrokerPathScope,
} from "./supervised-terminal-bridge.mjs";

const REPO = "/Users/admin/Desktop/Apple-AutoMation";
const PRODUCTION_DIR =
  "/Users/admin/.codex-orchestrator/runs/test/mac/round-01/supervised-control/production";
const NONCE = "0123456789abcdef0123456789abcdef";
const EXPECTED_HEAD = "0123456789abcdef0123456789abcdef01234567";

function fakeStats(type, mode) {
  return {
    mode,
    isDirectory: () => type === "directory",
    isFIFO: () => type === "fifo",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function createFakeFileSystem(initial = new Map()) {
  const entries = new Map(initial);
  const calls = [];
  const missing = (targetPath) => {
    const error = new Error(`missing: ${targetPath}`);
    error.code = "ENOENT";
    return error;
  };
  return {
    calls,
    entries,
    lstatSync(targetPath) {
      calls.push(["lstat", targetPath]);
      if (!entries.has(targetPath)) throw missing(targetPath);
      const entry = entries.get(targetPath);
      return fakeStats(entry.type, entry.mode);
    },
    mkdirSync(targetPath, options) {
      calls.push(["mkdir", targetPath, options]);
      if (entries.has(targetPath)) throw new Error(`exists: ${targetPath}`);
      entries.set(targetPath, { type: "directory", mode: options.mode });
    },
    chmodSync(targetPath, mode) {
      calls.push(["chmod", targetPath, mode]);
      const entry = entries.get(targetPath);
      if (!entry) throw missing(targetPath);
      entry.mode = mode;
    },
    accessSync(targetPath, mode) {
      calls.push(["access", targetPath, mode]);
      if (!entries.has(targetPath)) throw missing(targetPath);
    },
    unlinkSync(targetPath) {
      calls.push(["unlink", targetPath]);
      if (!entries.delete(targetPath)) throw missing(targetPath);
    },
  };
}

const context = {
  repo: REPO,
  productionDir: PRODUCTION_DIR,
  home: "/Users/admin",
  user: "admin",
  nonce: NONCE,
  cancelPath: "/private/round/tmp/supervised-cancel.json",
  outerCancelPath: "/private/round/control/outer-cancel.json",
  deadlineMs: Date.now() + 60_000,
};
const paths = resolveBrowserBrokerPaths(context);

assert.equal(paths.brokerDir, path.posix.join(PRODUCTION_DIR, "browser-broker"));
assert.equal(paths.reportDir, path.posix.join(paths.brokerDir, "report"));
assert.equal(
  paths.reportScreenshotsDir,
  path.posix.join(PRODUCTION_DIR, "browser-broker", "report", "screenshots")
);
assert.equal(paths.commandsFifo, path.posix.join(paths.brokerDir, "commands.fifo"));
assert.equal(paths.eventsFifo, path.posix.join(paths.brokerDir, "events.fifo"));
assert.equal(paths.profileDir, path.posix.join(PRODUCTION_DIR, "firefox-profile"));
assert.equal(
  paths.firefoxPath,
  "/Applications/Firefox.app/Contents/MacOS/firefox"
);
assert.equal(validateBrowserBrokerPathScope(paths), true);
assert.throws(
  () =>
    validateBrowserBrokerPathScope({
      ...paths,
      commandsFifo: "/private/outside/commands.fifo",
    }),
  /out of scope/i
);

const executableFs = createFakeFileSystem(
  new Map([
    [paths.pythonPath, { type: "symlink", mode: 0o777 }],
    [paths.firefoxPath, { type: "file", mode: 0o755 }],
    [paths.scriptPath, { type: "file", mode: 0o644 }],
  ])
);
validateBrowserBrokerExecutable(paths, { fs: executableFs });
assert.deepEqual(
  executableFs.calls.filter(([operation]) => operation === "access").map((call) => call[1]),
  [paths.pythonPath, paths.firefoxPath]
);
const symlinkFirefoxFs = createFakeFileSystem(
  new Map([
    [paths.pythonPath, { type: "file", mode: 0o755 }],
    [paths.firefoxPath, { type: "symlink", mode: 0o777 }],
    [paths.scriptPath, { type: "file", mode: 0o644 }],
  ])
);
assert.throws(
  () => validateBrowserBrokerExecutable(paths, { fs: symlinkFirefoxFs }),
  /Firefox executable is invalid/
);

const fifoFs = createFakeFileSystem(
  new Map([[paths.profileDir, { type: "directory", mode: 0o700 }]])
);
const fifoCreationOrder = [];
prepareBrowserBrokerFilesystem(paths, {
  fs: fifoFs,
  createFifo(fifoPath) {
    fifoCreationOrder.push(fifoPath);
    fifoFs.entries.set(fifoPath, { type: "fifo", mode: 0 });
  },
});
assert.deepEqual(fifoCreationOrder, [paths.commandsFifo, paths.eventsFifo]);
for (const directory of [paths.brokerDir, paths.reportDir, paths.reportScreenshotsDir]) {
  assert.deepEqual(fifoFs.entries.get(directory), {
    type: "directory",
    mode: 0o700,
  });
}
for (const fifoPath of [paths.commandsFifo, paths.eventsFifo]) {
  assert.deepEqual(fifoFs.entries.get(fifoPath), { type: "fifo", mode: 0o600 });
}

const nonFifoFs = createFakeFileSystem(
  new Map([[paths.profileDir, { type: "directory", mode: 0o700 }]])
);
assert.throws(
  () =>
    prepareBrowserBrokerFilesystem(paths, {
      fs: nonFifoFs,
      createFifo(fifoPath) {
        nonFifoFs.entries.set(fifoPath, { type: "file", mode: 0o600 });
      },
    }),
  /FIFO is invalid/i
);
const symlinkFifoFs = createFakeFileSystem(
  new Map([[paths.profileDir, { type: "directory", mode: 0o700 }]])
);
assert.throws(
  () =>
    prepareBrowserBrokerFilesystem(paths, {
      fs: symlinkFifoFs,
      createFifo(fifoPath) {
        symlinkFifoFs.entries.set(fifoPath, { type: "symlink", mode: 0o600 });
      },
    }),
  /FIFO is invalid/i
);

for (const key of [
  "APPLE_AUTOMATION_BROWSER_BROKER_MODE",
  "APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO",
  "APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO",
]) {
  assert.equal(SUPERVISED_PRODUCTION_ENV_KEYS.filter((item) => item === key).length, 1);
  assert.ok(JSON.parse(SUPERVISED_PRODUCTION_ENV_POLICY).includes(key));
}
const brokerEnv = buildBrowserBrokerEnvironment(context, paths);
assert.deepEqual(Object.keys(brokerEnv).sort(), [
  "APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO",
  "APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO",
  "APPLE_AUTOMATION_BROWSER_BROKER_MODE",
  "APPLE_AUTOMATION_REPORT_ROOT",
  "BROWSER_PROFILE_MODE",
  "FIREFOX_PROFILE_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PYTHONDONTWRITEBYTECODE",
  "SHELL",
  "TMPDIR",
  "USER",
].sort());
assert.equal(brokerEnv.APPLE_AUTOMATION_REPORT_ROOT, paths.reportDir);
assert.equal(brokerEnv.FIREFOX_PROFILE_DIR, paths.profileDir);
assert.equal(brokerEnv.APPLE_AUTOMATION_BROWSER_BROKER_MODE, "1");
assert.equal("APPLE_ID" in brokerEnv, false);
assert.equal("APPLE_PASSWORD" in brokerEnv, false);

const productionEnv = productionEnvironment(
  { ...context, helperDir: "/private/round/control/helpers" },
  paths
);
assert.equal(productionEnv.APPLE_AUTOMATION_BROWSER_BROKER_MODE, "1");
assert.equal(
  productionEnv.APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO,
  paths.commandsFifo
);
assert.equal(
  productionEnv.APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO,
  paths.eventsFifo
);

const wrapper = buildBrowserBrokerSupervisorScript();
assert.match(wrapper, /^set -eu\numask 077/m);
assert.match(wrapper, /ruyipage-broker-members/);
assert.match(
  wrapper,
  /"\$@" 3>&- < "\$commands_fifo" > "\$events_fifo" 2>\/dev\/null &/
);
assert.match(wrapper, /target_identity_is_current[\s\S]*\/bin\/kill -TERM/);
assert.match(
  wrapper,
  /terminate_backend_bounded[\s\S]*wait_backend_bounded 50[\s\S]*\/bin\/kill -KILL[\s\S]*wait_backend_bounded 20/,
  "broker termination must have bounded TERM and KILL phases"
);
assert.match(
  wrapper,
  /if \[\[ -z "\$backend_pgid" \]\] && backend_is_running; then[\s\S]*shutdown_backend_and_descendants[\s\S]*exit 125/,
  "identity capture failure must not wait forever"
);
assert.match(
  wrapper,
  /if backend_is_running; then runtime_status=125; shutdown_backend_and_descendants/,
  "identity loss must terminate the direct backend before wait"
);
assert.match(
  wrapper,
  /backend_status=125[\s\S]*if ! backend_is_running; then[\s\S]*wait "\$backend_pid"/,
  "the supervisor must never wait on a backend that is still running"
);
assert.match(
  wrapper,
  /target_identity_is_current[\s\S]*\/bin\/kill -"\$signal_name"[\s\S]*signal_group_members KILL/
);
assert.doesNotMatch(wrapper, /\bexec\b/);

const broker = createBrowserBroker(context);
const startOrder = [];
let spawnCall = null;
const brokerStatusStream = new PassThrough();
const expectedIdentity = {
  pid: 4321,
  pgid: 4321,
  startedAt: "Wed Jul 15 12:00:00 2026",
  command: `zsh ruyipage-supervisor ${NONCE} ${paths.scriptPath}`,
};
await startBrowserBroker(
  broker,
  {
    pid: 100,
    pgid: 100,
    startedAt: "Wed Jul 15 11:59:00 2026",
    command: `${REPO}/scripts/supervised-terminal-bridge.mjs`,
  },
  {
    validateExecutable() {
      startOrder.push("validate-executable");
    },
    prepareFilesystem() {
      startOrder.push("prepare-fifos");
    },
    spawn(command, args, options) {
      startOrder.push("spawn-broker");
      spawnCall = { command, args, options };
      return {
        pid: 4321,
        stdio: [null, null, null, brokerStatusStream],
        unref: () => startOrder.push("unref"),
      };
    },
    async waitForIdentity(pid, predicate) {
      startOrder.push("wait-identity");
      assert.equal(pid, 4321);
      assert.equal(predicate(expectedIdentity), true);
      return expectedIdentity;
    },
    writeLifecycle(_context, _filePath, state) {
      startOrder.push(`lifecycle:${state}`);
    },
    writeProcessState(_context, _filePath, _identity, state) {
      startOrder.push(`process:${state}`);
    },
    writeLaunchGate(_filePath, pid, nonce) {
      startOrder.push("launch-gate");
      assert.equal(pid, 4321);
      assert.equal(nonce, NONCE);
    },
  }
);
assert.deepEqual(startOrder, [
  "validate-executable",
  "prepare-fifos",
  "lifecycle:preparing",
  "spawn-broker",
  "wait-identity",
  "process:starting",
  "launch-gate",
  "process:active",
  "lifecycle:active",
  "unref",
]);
assert.equal(spawnCall.command, "/bin/zsh");
assert.equal(spawnCall.options.detached, true);
assert.deepEqual(spawnCall.options.stdio, ["ignore", "ignore", "ignore", "pipe"]);
assert.equal(spawnCall.options.env.APPLE_ID, undefined);
assert.equal(spawnCall.options.env.APPLE_PASSWORD, undefined);
for (const value of [
  "ruyipage-supervisor",
  NONCE,
  paths.scriptPath,
  "--report-dir",
  paths.reportDir,
  "--profile-dir",
  paths.profileDir,
  "--firefox",
  paths.firefoxPath,
]) {
  assert.ok(spawnCall.args.includes(value), `broker launch must include ${value}`);
}
assert.equal(browserBrokerIdentityMatches(expectedIdentity, broker), true);
brokerStatusStream.write("supervisor-ready\ngate-open\ntarget-launch\n");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(broker.stage, "target-launch");
assert.equal(
  browserBrokerIdentityMatches(
    { ...expectedIdentity, command: expectedIdentity.command.replace(NONCE, "f".repeat(32)) },
    broker
  ),
  false
);

const cleanupFs = createFakeFileSystem(
  new Map([
    [paths.commandsFifo, { type: "fifo", mode: 0o600 }],
    [paths.eventsFifo, { type: "fifo", mode: 0o600 }],
    [paths.launchGatePath, { type: "file", mode: 0o600 }],
  ])
);
const cleanupStates = [];
const cleanResult = await cleanupBrowserBroker(broker, {
  fs: cleanupFs,
  async cleanupRecorded() {
    return { ok: true, seen: true, cleanupEvidence: true };
  },
  writeProcessState(_context, _filePath, _identity, state) {
    cleanupStates.push(`process:${state}`);
  },
  writeLifecycle(_context, _filePath, state) {
    cleanupStates.push(`lifecycle:${state}`);
  },
});
assert.deepEqual(cleanResult, { ok: true, seen: true, cleanupEvidence: true });
assert.deepEqual(cleanupStates, ["process:inactive", "lifecycle:inactive"]);
assert.deepEqual(
  cleanupFs.calls.filter(([operation]) => operation === "unlink").map((call) => call[1]),
  [paths.commandsFifo, paths.eventsFifo, paths.launchGatePath]
);

const failedCleanupFs = createFakeFileSystem(
  new Map([
    [paths.commandsFifo, { type: "fifo", mode: 0o600 }],
    [paths.eventsFifo, { type: "fifo", mode: 0o600 }],
  ])
);
const failedCleanupStates = [];
const failedCleanup = await cleanupBrowserBroker(broker, {
  fs: failedCleanupFs,
  async cleanupRecorded() {
    return { ok: false, seen: true, cleanupEvidence: false };
  },
  writeProcessState(_context, _filePath, _identity, state) {
    failedCleanupStates.push(`process:${state}`);
  },
  writeLifecycle(_context, _filePath, state) {
    failedCleanupStates.push(`lifecycle:${state}`);
  },
});
assert.deepEqual(failedCleanup, { ok: false, seen: true, cleanupEvidence: false });
assert.deepEqual(failedCleanupStates, [
  "process:cleanup_failed",
  "lifecycle:cleanup_failed",
]);
assert.equal(
  failedCleanupFs.calls.some(([operation]) => operation === "unlink"),
  false,
  "identity or cleanup failure must retain both FIFOs"
);

const unlinkFailureFs = createFakeFileSystem(
  new Map([
    [paths.commandsFifo, { type: "fifo", mode: 0o600 }],
    [paths.eventsFifo, { type: "file", mode: 0o600 }],
  ])
);
const unlinkFailureStates = [];
const unlinkFailure = await cleanupBrowserBroker(broker, {
  fs: unlinkFailureFs,
  async cleanupRecorded() {
    return { ok: true, seen: true, cleanupEvidence: true };
  },
  writeProcessState(_context, _filePath, _identity, state) {
    unlinkFailureStates.push(`process:${state}`);
  },
  writeLifecycle(_context, _filePath, state) {
    unlinkFailureStates.push(`lifecycle:${state}`);
  },
});
assert.equal(unlinkFailure.ok, false);
assert.deepEqual(unlinkFailureStates, [
  "process:inactive",
  "lifecycle:inactive",
  "process:cleanup_failed",
  "lifecycle:cleanup_failed",
]);

const remoteScript = buildRemoteScript({
  task: "Run supervised acceptance",
  sync: true,
  remoteRepo: REPO,
  remoteRoundDir: "/Users/admin/.codex-orchestrator/runs/test/mac/round-01",
  branch: "codex/ruyipage-risk-reduction",
  expectedHead: EXPECTED_HEAD,
  supervisedGui: true,
  supervisedToken: NONCE,
});
for (const key of [
  "APPLE_AUTOMATION_BROWSER_BROKER_MODE",
  "APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO",
  "APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO",
]) {
  assert.match(remoteScript, new RegExp(`PRODUCTION_ENV_POLICY=.*${key}`));
}
assert.match(
  remoteScript,
  /supervised-process-state-verifier\.mjs" ruyipage[\s\S]*\/usr\/bin\/unlink "\$broker_fifo"/
);
assert.doesNotMatch(remoteScript, /(?:\/bin\/rm|\brm\b).*commands\.fifo/);

console.log("supervised browser broker contract: ok");
