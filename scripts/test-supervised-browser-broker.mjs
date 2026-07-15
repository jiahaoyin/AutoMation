import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";

import {
  SUPERVISED_PRODUCTION_ENV_KEYS,
  SUPERVISED_PRODUCTION_ENV_POLICY,
} from "./lib/supervised-attestation.js";
import { buildRemoteScript } from "./mac-codex-orchestrator.mjs";
import {
  browserBrokerIdentityMatches,
  closeBrowserBrokerTransport,
  buildBrowserBrokerEnvironment,
  buildBrowserBrokerSupervisorScript,
  cleanupBrowserBroker,
  createBrowserBroker,
  listenBrowserBrokerSocket,
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

function fakeStats(type, mode, dev = 1, ino = 1) {
  return {
    dev,
    ino,
    mode,
    isDirectory: () => type === "directory",
    isFIFO: () => type === "fifo",
    isFile: () => type === "file",
    isSocket: () => type === "socket",
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
      return fakeStats(entry.type, entry.mode, entry.dev, entry.ino);
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

class FakeSocket extends Duplex {
  constructor() {
    super();
    this.outbound = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.outbound.push(Buffer.from(chunk));
    callback();
  }

  sendInbound(value) {
    this.push(Buffer.from(value));
  }

  outboundText() {
    return Buffer.concat(this.outbound).toString("utf8");
  }
}

function createFakeSocketServer(fileSystem, socketPath, calls = []) {
  let connectionHandler = null;
  const server = new EventEmitter();
  server.listening = false;
  server.listen = (options, callback) => {
    calls.push(["listen", options]);
    assert.deepEqual(options, { path: socketPath, backlog: 1 });
    fileSystem.entries.set(socketPath, { type: "socket", mode: 0o777 });
    server.listening = true;
    queueMicrotask(callback);
    return server;
  };
  server.close = (callback) => {
    calls.push(["close"]);
    if (!server.listening) {
      const error = new Error("server is not running");
      error.code = "ERR_SERVER_NOT_RUNNING";
      queueMicrotask(() => callback?.(error));
      return server;
    }
    server.listening = false;
    queueMicrotask(() => callback?.());
    return server;
  };
  return {
    server,
    createServer(options, handler) {
      calls.push(["create-server", options]);
      connectionHandler = handler;
      return server;
    },
    connect(socket) {
      connectionHandler(socket);
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
assert.equal(paths.socketPath, `/tmp/apple-automation-${NONCE}.sock`);
assert.ok(
  Buffer.byteLength(paths.socketPath, "utf8") < 104,
  "browser broker socket path must fit macOS sockaddr_un.sun_path"
);
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
      socketPath: `/tmp/apple-automation-${"f".repeat(32)}.sock`,
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

const socketFs = createFakeFileSystem(
  new Map([[paths.profileDir, { type: "directory", mode: 0o700 }]])
);
prepareBrowserBrokerFilesystem(paths, { fs: socketFs });
for (const directory of [paths.brokerDir, paths.reportDir, paths.reportScreenshotsDir]) {
  assert.deepEqual(socketFs.entries.get(directory), {
    type: "directory",
    mode: 0o700,
  });
}
assert.equal(socketFs.entries.has(paths.socketPath), false);

const symlinkSocketFs = createFakeFileSystem(
  new Map([
    [paths.profileDir, { type: "directory", mode: 0o700 }],
    [paths.socketPath, { type: "symlink", mode: 0o777 }],
  ])
);
assert.throws(
  () => prepareBrowserBrokerFilesystem(paths, { fs: symlinkSocketFs }),
  /socket already exists/i
);

for (const key of ["APPLE_AUTOMATION_BROWSER_BROKER_SOCKET"]) {
  assert.equal(SUPERVISED_PRODUCTION_ENV_KEYS.filter((item) => item === key).length, 1);
  assert.ok(JSON.parse(SUPERVISED_PRODUCTION_ENV_POLICY).includes(key));
}
const brokerEnv = buildBrowserBrokerEnvironment(context, paths);
assert.deepEqual(Object.keys(brokerEnv).sort(), [
  "APPLE_AUTOMATION_BROWSER_BROKER_MODE",
  "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
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
assert.equal(productionEnv.APPLE_AUTOMATION_BROWSER_BROKER_MODE, undefined);
assert.equal(
  productionEnv.APPLE_AUTOMATION_BROWSER_BROKER_SOCKET,
  paths.socketPath
);

const wrapper = buildBrowserBrokerSupervisorScript();
assert.match(wrapper, /^set -eu\numask 077/m);
assert.match(wrapper, /ruyipage-broker-members/);
assert.match(
  wrapper,
  /"\$@" 3>&- <&0 >&1 2>\/dev\/null &/
);
assert.doesNotMatch(
  wrapper,
  /(?:commands_fifo|events_fifo|relay_node|relay_script|control\.sock|< <\(|> >\()/,
  "the supervisor must only use the bridge-provided stdio pipes"
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

const socketTransportBroker = createBrowserBroker(context);
const backendInput = new PassThrough();
const backendOutput = new PassThrough();
const backendInputChunks = [];
backendInput.on("data", (chunk) => backendInputChunks.push(Buffer.from(chunk)));
socketTransportBroker.child = { stdin: backendInput, stdout: backendOutput };
const socketListenFs = createFakeFileSystem();
const socketServerCalls = [];
const socketServer = createFakeSocketServer(
  socketListenFs,
  paths.socketPath,
  socketServerCalls
);
await listenBrowserBrokerSocket(socketTransportBroker, {
  fs: socketListenFs,
  createServer: socketServer.createServer,
  connectTimeoutMs: 1_000,
});
assert.deepEqual(socketServerCalls[0], [
  "create-server",
  { allowHalfOpen: false, pauseOnConnect: true },
]);
assert.equal(socketListenFs.entries.get(paths.socketPath).mode, 0o600);
assert.deepEqual(socketTransportBroker.socketIdentity, { dev: 1, ino: 1 });

const firstClient = new FakeSocket();
socketServer.connect(firstClient);
assert.equal(socketTransportBroker.clientAccepted, true);
assert.equal(socketTransportBroker.transportWired, true);
firstClient.sendInbound('{"type":"credentials"}\n');
backendOutput.write('{"type":"event"}\n');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  Buffer.concat(backendInputChunks).toString("utf8"),
  '{"type":"credentials"}\n'
);
assert.equal(firstClient.outboundText(), '{"type":"event"}\n');

const secondClient = new FakeSocket();
socketServer.connect(secondClient);
assert.equal(secondClient.destroyed, true);
assert.equal(socketTransportBroker.client, firstClient);
const firstClose = closeBrowserBrokerTransport(socketTransportBroker, {
  closeTimeoutMs: 100,
});
assert.equal(
  closeBrowserBrokerTransport(socketTransportBroker, { closeTimeoutMs: 100 }),
  firstClose,
  "transport cleanup must be idempotent"
);
assert.equal(await firstClose, true);
assert.equal(socketServer.server.listening, false);

const timeoutBroker = createBrowserBroker({
  ...context,
  deadlineMs: Date.now() + 1_000,
});
timeoutBroker.child = {
  stdin: new PassThrough(),
  stdout: new PassThrough(),
};
const timeoutFs = createFakeFileSystem();
const timeoutServer = createFakeSocketServer(timeoutFs, paths.socketPath);
await listenBrowserBrokerSocket(timeoutBroker, {
  fs: timeoutFs,
  createServer: timeoutServer.createServer,
  connectTimeoutMs: 5,
});
await new Promise((resolve) => setTimeout(resolve, 15));
assert.match(timeoutBroker.transportError?.message ?? "", /connection timed out/);
assert.equal(timeoutBroker.child.stdin.writableEnded, true);
assert.equal(
  await closeBrowserBrokerTransport(timeoutBroker, { closeTimeoutMs: 100 }),
  true
);

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
      startOrder.push("prepare-socket-directory");
    },
    async listenSocket() {
      startOrder.push("listen-socket");
    },
    spawn(command, args, options) {
      startOrder.push("spawn-broker");
      spawnCall = { command, args, options };
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      return {
        pid: 4321,
        stdin,
        stdout,
        stdio: [stdin, stdout, null, brokerStatusStream],
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
  "prepare-socket-directory",
  "lifecycle:preparing",
  "listen-socket",
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
assert.deepEqual(spawnCall.options.stdio, ["pipe", "pipe", "ignore", "pipe"]);
assert.equal(
  spawnCall.options.env.APPLE_AUTOMATION_BROWSER_BROKER_SOCKET,
  paths.socketPath
);
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
assert.equal(spawnCall.args.includes(paths.socketPath), false);
assert.equal(browserBrokerIdentityMatches(expectedIdentity, broker), true);
broker.socketIdentity = { dev: 1, ino: 1 };
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
    [paths.socketPath, { type: "socket", mode: 0o600 }],
    [paths.launchGatePath, { type: "file", mode: 0o600 }],
  ])
);
const cleanupStates = [];
const cleanResult = await cleanupBrowserBroker(broker, {
  fs: cleanupFs,
  async cleanupRecorded() {
    return { ok: true, seen: true, cleanupEvidence: true };
  },
  async closeTransport() {
    return true;
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
  [paths.socketPath, paths.launchGatePath]
);

const failedCleanupFs = createFakeFileSystem(
  new Map([[paths.socketPath, { type: "socket", mode: 0o600 }]])
);
const failedCleanupStates = [];
const failedCleanup = await cleanupBrowserBroker(broker, {
  fs: failedCleanupFs,
  async cleanupRecorded() {
    return { ok: false, seen: true, cleanupEvidence: false };
  },
  async closeTransport() {
    return true;
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
  "identity or cleanup failure must retain the socket path"
);

const unlinkFailureFs = createFakeFileSystem(
  new Map([[paths.socketPath, { type: "file", mode: 0o600 }]])
);
const unlinkFailureStates = [];
const unlinkFailure = await cleanupBrowserBroker(broker, {
  fs: unlinkFailureFs,
  async cleanupRecorded() {
    return { ok: true, seen: true, cleanupEvidence: true };
  },
  async closeTransport() {
    return true;
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
for (const key of ["APPLE_AUTOMATION_BROWSER_BROKER_SOCKET"]) {
  assert.match(remoteScript, new RegExp(`PRODUCTION_ENV_POLICY=.*${key}`));
}
assert.match(
  remoteScript,
  /supervised-process-state-verifier\.mjs" ruyipage[\s\S]*browser_broker_socket[\s\S]*browser_broker_gate[\s\S]*cleanup_failed=1/
);
assert.match(
  remoteScript,
  /network = \{ enabled = true, domains = \{\}, unix_sockets = \{ "\/tmp\/apple-automation-[0-9a-f]{32}\.sock" = "allow" \} \}/,
  "production sandbox must allow only the per-run browser broker Unix socket"
);
assert.doesNotMatch(
  remoteScript,
  /(?:\/bin\/rm|\brm\b|\/usr\/bin\/unlink).*browser_broker_(?:socket|gate)/
);

console.log("supervised browser broker contract: ok");
