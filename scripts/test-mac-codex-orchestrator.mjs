import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAgentPrompt,
  buildRemoteScript,
  buildScpArgs,
  buildSshArgs,
  hasSupervisedAcceptanceEvent,
  parseArgs,
  runProcess,
  summarizeRun,
  validateFinalReport,
} from "./mac-codex-orchestrator.mjs";
import {
  SUPERVISED_COMMAND_ID,
  SUPERVISED_COMMAND_SHA256,
  SUPERVISED_PRODUCTION_ENV_KEYS,
  SUPERVISED_PRODUCTION_ENV_POLICY,
  SUPERVISED_SUCCESS_MARKER,
  createMacVerificationPermissionProfile,
  createSupervisedAttestation,
  parseSupervisedAttestation,
} from "./lib/supervised-attestation.js";
import {
  DEFAULT_RUYIPAGE_BACKEND_TIMEOUT_MS,
  DEFAULT_SUPERVISED_HELPER_WAIT_MS,
  SUPERVISED_HELPER_CLEANUP_MARGIN_MS,
  runSupervisedMacAcceptance,
} from "./supervised-mac-acceptance.mjs";
import { validateSupervisedRequestArtifacts } from "./supervised-request-verifier.mjs";
import {
  readVerifiedRuyiPageLifecycleState,
  readVerifiedRuyiPageProcessState,
  validateRuyiPageProcessState,
} from "./supervised-process-state-verifier.mjs";
import {
  RUYIPAGE_SUPERVISOR_COMMAND_ID,
  buildRuyiPageProcessSupervisorScript,
  validateRuyiPageLifecycleState,
} from "./lib/ruyipage-backend-runner.js";
import {
  buildProductionProcessSupervisorScript,
  classifyProcessCleanup,
  classifySupervisorStatus,
  createProductionProtocolState,
  createSupervisorStatusProtocol,
  drainProductionStderr,
  productionStdinForSupervisedInput,
  readBoundedRegularFile,
  supervisedTtyCapability,
  supervisedTwoFaDetail,
} from "./supervised-terminal-bridge.mjs";

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_REMOTE_REPO = "/Users/admin/Desktop/Apple-AutoMation";
const EXPECTED_HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const SUPERVISED_TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_SUPERVISED_TOKEN = "fedcba9876543210fedcba9876543210";
const SUPERVISED_HELPER_COMMAND = "node scripts/supervised-mac-acceptance.mjs";
const RAW_SECRET_CANARY = "raw-secret-canary-must-not-leak";
const expectedBrowserBrokerEnvironment = [
  "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
];
assert.deepEqual(
  SUPERVISED_PRODUCTION_ENV_KEYS.filter((key) =>
    key.startsWith("APPLE_AUTOMATION_BROWSER_BROKER_")
  ),
  expectedBrowserBrokerEnvironment
);
assert.deepEqual(
  JSON.parse(SUPERVISED_PRODUCTION_ENV_POLICY).filter((key) =>
    key.startsWith("APPLE_AUTOMATION_BROWSER_BROKER_")
  ),
  expectedBrowserBrokerEnvironment
);

const interactiveTerminalInput = {
  isTTY: true,
  setRawMode() {},
};
const nonInteractiveInput = {
  isTTY: false,
  setRawMode() {},
};
const ttyWithoutRawMode = { isTTY: true };
assert.equal(supervisedTtyCapability(interactiveTerminalInput), "available");
assert.equal(
  productionStdinForSupervisedInput(
    interactiveTerminalInput,
    supervisedTtyCapability(interactiveTerminalInput)
  ),
  interactiveTerminalInput
);
assert.equal(supervisedTtyCapability(nonInteractiveInput), "unavailable");
assert.equal(
  productionStdinForSupervisedInput(
    nonInteractiveInput,
    supervisedTtyCapability(nonInteractiveInput)
  ),
  "ignore",
  "non-TTY stdin must never reach the production process"
);
assert.equal(supervisedTtyCapability(ttyWithoutRawMode), "unavailable");
assert.equal(
  productionStdinForSupervisedInput(
    ttyWithoutRawMode,
    supervisedTtyCapability(ttyWithoutRawMode)
  ),
  "ignore",
  "a terminal without raw-mode support must not claim manual input capability"
);
assert.equal(
  supervisedTwoFaDetail({
    failureClass: "TWO_FA_CODE_UNAVAILABLE",
    ttyCapability: "unavailable",
    manualPromptObserved: false,
  }),
  "manual_tty_unavailable"
);
assert.equal(
  supervisedTwoFaDetail({
    failureClass: "TWO_FA_CODE_UNAVAILABLE",
    ttyCapability: "available",
    manualPromptObserved: true,
  }),
  "manual_prompt_timeout"
);
assert.equal(
  supervisedTwoFaDetail({
    failureClass: "TWO_FA_CODE_UNAVAILABLE",
    ttyCapability: "available",
    manualPromptObserved: false,
  }),
  "automatic_code_unavailable"
);
assert.equal(
  supervisedTwoFaDetail({
    failureClass: "TWO_FA_LOGIN_FAILED",
    ttyCapability: "available",
    manualPromptObserved: true,
  }),
  "none"
);
const productionProtocol = createProductionProtocolState();
assert.equal(
  productionProtocol.processStdoutLine("[apple-automation] stage:flow_main_started"),
  true
);
assert.equal(productionProtocol.productionStage, "flow_main_started");
assert.equal(
  productionProtocol.processStdoutLine("[ruyipage] status:node-failure:backend_exit"),
  true
);
assert.equal(productionProtocol.nodeFailure, "backend_exit");
const stageBeforeStderr = productionProtocol.productionStage;
const nodeFailureBeforeStderr = productionProtocol.nodeFailure;
assert.equal(
  drainProductionStderr("[apple-automation] stage:credentials_ready\n"),
  Buffer.byteLength("[apple-automation] stage:credentials_ready\n")
);
assert.equal(productionProtocol.productionStage, stageBeforeStderr);
assert.equal(productionProtocol.nodeFailure, nodeFailureBeforeStderr);
assert.equal(
  productionProtocol.processStdoutLine("[apple-automation] stage:untrusted_stage"),
  false
);
assert.equal(
  productionProtocol.processStdoutLine("[ruyipage] status:node-failure:untrusted_failure"),
  false
);
assert.equal(productionProtocol.productionStage, stageBeforeStderr);
assert.equal(productionProtocol.nodeFailure, nodeFailureBeforeStderr);
const projectInstructions = fs.readFileSync(
  new URL("../AGENTS.md", import.meta.url),
  "utf8"
);
const operationsGuide = fs.readFileSync(
  new URL("../docs/WINDOWS_MAC_CODEX.md", import.meta.url),
  "utf8"
);
const macCodexSource = fs.readFileSync(
  new URL("./mac-codex-orchestrator.mjs", import.meta.url),
  "utf8"
);
assert.match(
  macCodexSource,
  /"@\{upstream\}"[\s\S]*upstreamHead !== expectedHead[\s\S]*must be pushed to its upstream/
);

for (const contract of [projectInstructions, operationsGuide]) {
  assert.match(contract, /npm\.cmd run -s mac:codex/);
  assert.match(contract, /ruyiPage/);
  assert.match(contract, /summary\.json/);
  assert.match(contract, /final\.json/);
  assert.match(contract, /events\.jsonl/);
}
assert.match(projectInstructions, /Windows is the development host/);
assert.match(projectInstructions, /Mac is the macOS verification host/);
assert.match(projectInstructions, /fast-forward/);
assert.match(projectInstructions, /-module-cache-path/);
assert.match(operationsGuide, /codex-exit\.txt/);
assert.match(operationsGuide, /git-before\.txt/);
assert.match(operationsGuide, /git-after\.txt/);
assert.match(operationsGuide, /test:2fa-allow/);
assert.match(operationsGuide, /真实 Apple ID/);
assert.match(operationsGuide, /-module-cache-path/);
assert.match(operationsGuide, /sandbox_mode = "read-only"/);
assert.match(operationsGuide, /umask 077/);
assert.match(operationsGuide, /30 天/);

function removeTreeOneFileAtATime(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) removeTreeOneFileAtATime(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(directory);
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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

function probeDarwinProcessEnumeration() {
  if (process.platform !== "darwin") return true;
  const outcome = spawnSync(
    "/bin/ps",
    ["-p", String(process.pid), "-o", "pid="],
    { encoding: "utf8" }
  );
  if (["EPERM", "EACCES"].includes(outcome.error?.code)) return false;
  assert.ifError(outcome.error);
  assert.equal(outcome.status, 0, "Darwin process enumeration probe failed");
  return readSpawnStdout(outcome).trim() === String(process.pid);
}

const DARWIN_PROCESS_ENUMERATION_AVAILABLE = probeDarwinProcessEnumeration();

async function runCleanupSignalDeferralTest(remoteScript) {
  if (
    process.platform !== "darwin" ||
    !fs.existsSync("/bin/zsh") ||
    !DARWIN_PROCESS_ENUMERATION_AVAILABLE
  ) {
    return;
  }
  const functionStart = remoteScript.indexOf("acquire_gate() {");
  const functionEnd = remoteScript.indexOf('/bin/mkdir -p "$READERS_DIR"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const cleanupFunctions = remoteScript.slice(functionStart, functionEnd);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-cleanup-signal-"));
  const controlDir = path.join(testDir, "supervised-control");
  const writerLock = path.join(testDir, "writer-lock");
  const readyPath = path.join(testDir, "ready");
  const scriptPath = path.join(testDir, "cleanup-signal.zsh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  fs.mkdirSync(controlDir, { mode: 0o700 });
  fs.mkdirSync(writerLock, { mode: 0o700 });
  const harness = [
    "#!/bin/zsh",
    "set -u",
    `REMOTE_ROUND_DIR=${quote(testDir)}`,
    `REMOTE_REPO=${quote(process.cwd())}`,
    `SUPERVISED_TOKEN=${quote(SUPERVISED_TOKEN)}`,
    `EXPECTED_HEAD=${quote(EXPECTED_HEAD)}`,
    "SUPERVISED_GUI=1",
    "BRIDGE_SETUP_OK=1",
    "SUPERVISED_CLEANUP_STATE=not_started",
    "SUPERVISED_CLEANUP_RESULT=1",
    "SUPERVISED_PENDING_SIGNAL=0",
    "GATE_HELD=0",
    "LOCK_ACQUIRED=1",
    "LOCK_MODE=writer",
    `LOCK_ROOT=${quote(testDir)}`,
    `GATE_LOCK=${quote(path.join(testDir, "gate"))}`,
    `WRITER_LOCK=${quote(writerLock)}`,
    `READERS_DIR=${quote(path.join(testDir, "readers"))}`,
    `RUN_READER=${quote(path.join(testDir, "reader"))}`,
    cleanupFunctions,
    `/bin/zsh -c "/bin/sleep 1; :" ${quote(
      path.join(process.cwd(), "scripts", "supervised-terminal-bridge.mjs")
    )} &`,
    "bridge_pid=$!",
    'bridge_pgid="$(/bin/ps -p "$bridge_pid" -o pgid= | /usr/bin/xargs)"',
    'bridge_started_at="$(/bin/ps -p "$bridge_pid" -o lstart= | /usr/bin/xargs)"',
    'printf \'{"version":1,"nonce":"%s","pid":%s,"pgid":%s,"startedAt":"%s"}\\n\' "$SUPERVISED_TOKEN" "$bridge_pid" "$bridge_pgid" "$bridge_started_at" > "$REMOTE_ROUND_DIR/supervised-control/supervised-terminal.json"',
    "trap cleanup_all EXIT",
    "trap 'handle_supervised_signal 130' INT",
    "trap 'handle_supervised_signal 143' TERM",
    "trap 'handle_supervised_signal 129' HUP",
    `print -r -- ready > ${quote(readyPath)}`,
    "cleanup_all",
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, harness, { encoding: "utf8", mode: 0o700 });

  const child = spawn("/bin/zsh", [scriptPath], { stdio: "ignore" });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  try {
    await waitUntil(() => fs.existsSync(readyPath), 2_000, "cleanup harness did not start");
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      fs.existsSync(writerLock),
      true,
      "a signal during process cleanup must not release the writer lock"
    );
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup harness did not finish")), 5_000)
      ),
    ]);
    assert.deepEqual(outcome, { exitCode: 143, signal: null });
    assert.equal(fs.existsSync(writerLock), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    removeTreeOneFileAtATime(testDir);
  }
}

async function runLockCleanupSignalDeferralTest(remoteScript) {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return;
  const functionStart = remoteScript.indexOf("acquire_gate() {");
  const functionEnd = remoteScript.indexOf('/bin/mkdir -p "$READERS_DIR"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const cleanupFunctions = remoteScript.slice(functionStart, functionEnd);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-lock-signal-"));
  const writerLock = path.join(testDir, "writer-lock");
  const gateLock = path.join(testDir, "gate");
  const readyPath = path.join(testDir, "ready");
  const scriptPath = path.join(testDir, "lock-signal.zsh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  fs.mkdirSync(writerLock, { mode: 0o700 });
  fs.mkdirSync(gateLock, { mode: 0o700 });
  const harness = [
    "#!/bin/zsh",
    "set -u",
    `REMOTE_ROUND_DIR=${quote(testDir)}`,
    `REMOTE_REPO=${quote(process.cwd())}`,
    `SUPERVISED_TOKEN=${quote(SUPERVISED_TOKEN)}`,
    `EXPECTED_HEAD=${quote(EXPECTED_HEAD)}`,
    "SUPERVISED_GUI=0",
    "BRIDGE_SETUP_OK=0",
    "SUPERVISED_CLEANUP_STATE=not_started",
    "SUPERVISED_CLEANUP_RESULT=1",
    "SUPERVISED_PENDING_SIGNAL=0",
    "LOCK_CLEANUP_STATE=not_started",
    "LOCK_CLEANUP_RESULT=1",
    "GATE_HELD=0",
    "LOCK_ACQUIRED=1",
    "LOCK_MODE=writer",
    `LOCK_ROOT=${quote(testDir)}`,
    `GATE_LOCK=${quote(gateLock)}`,
    `WRITER_LOCK=${quote(writerLock)}`,
    `READERS_DIR=${quote(path.join(testDir, "readers"))}`,
    `RUN_READER=${quote(path.join(testDir, "reader"))}`,
    cleanupFunctions,
    "trap cleanup_all EXIT",
    "trap 'handle_supervised_signal 130' INT",
    "trap 'handle_supervised_signal 143' TERM",
    "trap 'handle_supervised_signal 129' HUP",
    `( /bin/sleep 1; /bin/rmdir ${quote(gateLock)} ) &`,
    `print -r -- ready > ${quote(readyPath)}`,
    "cleanup_all",
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, harness, { encoding: "utf8", mode: 0o700 });

  const child = spawn("/bin/zsh", [scriptPath], { stdio: "ignore" });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  try {
    await waitUntil(() => fs.existsSync(readyPath), 2_000, "lock cleanup did not start");
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      fs.existsSync(writerLock),
      true,
      "a signal during gate acquisition must not bypass writer lock cleanup"
    );
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("lock cleanup did not finish")), 5_000)
      ),
    ]);
    assert.deepEqual(outcome, { exitCode: 143, signal: null });
    assert.equal(fs.existsSync(writerLock), false);
    assert.equal(fs.existsSync(gateLock), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    removeTreeOneFileAtATime(testDir);
  }
}

async function runLockCleanupFailureRetentionTest(remoteScript) {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return;
  const functionStart = remoteScript.indexOf("acquire_gate() {");
  const functionEnd = remoteScript.indexOf('/bin/mkdir -p "$READERS_DIR"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const cleanupFunctions = remoteScript.slice(functionStart, functionEnd);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-lock-failure-"));
  const writerLock = path.join(testDir, "writer-lock");
  const blockerPath = path.join(writerLock, "blocker");
  const resultPath = path.join(testDir, "result");
  const scriptPath = path.join(testDir, "lock-failure.zsh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  fs.mkdirSync(writerLock, { mode: 0o700 });
  fs.writeFileSync(blockerPath, "blocked\n", "utf8");
  const harness = [
    "#!/bin/zsh",
    "set -u",
    `REMOTE_ROUND_DIR=${quote(testDir)}`,
    `REMOTE_REPO=${quote(process.cwd())}`,
    `SUPERVISED_TOKEN=${quote(SUPERVISED_TOKEN)}`,
    `EXPECTED_HEAD=${quote(EXPECTED_HEAD)}`,
    "SUPERVISED_GUI=0",
    "BRIDGE_SETUP_OK=0",
    "SUPERVISED_CLEANUP_STATE=not_started",
    "SUPERVISED_CLEANUP_RESULT=1",
    "SUPERVISED_PENDING_SIGNAL=0",
    "LOCK_CLEANUP_STATE=not_started",
    "LOCK_CLEANUP_RESULT=1",
    "GATE_HELD=0",
    "LOCK_ACQUIRED=1",
    "LOCK_MODE=writer",
    `LOCK_ROOT=${quote(testDir)}`,
    `GATE_LOCK=${quote(path.join(testDir, "gate"))}`,
    `WRITER_LOCK=${quote(writerLock)}`,
    `READERS_DIR=${quote(path.join(testDir, "readers"))}`,
    `RUN_READER=${quote(path.join(testDir, "reader"))}`,
    cleanupFunctions,
    "set +e",
    "cleanup_all",
    "cleanup_status=$?",
    `print -r -- "$cleanup_status" > ${quote(resultPath)}`,
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, harness, { encoding: "utf8", mode: 0o700 });
  try {
    const outcome = spawnSync("/bin/zsh", [scriptPath], { encoding: "utf8" });
    assert.equal(outcome.status, 0);
    assert.equal(fs.readFileSync(resultPath, "utf8").trim(), "1");
    assert.equal(
      fs.existsSync(writerLock),
      true,
      "failed cleanup must retain the writer lock"
    );
  } finally {
    removeTreeOneFileAtATime(testDir);
  }
}

async function runLockAcquisitionSignalTest(remoteScript) {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return;
  const functionStart = remoteScript.indexOf("acquire_gate() {");
  const functionEnd = remoteScript.indexOf('/bin/mkdir -p "$READERS_DIR"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const lockFunctionsAndTraps = remoteScript.slice(functionStart, functionEnd);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-lock-acquire-signal-"));
  const writerLock = path.join(testDir, "writer-lock");
  const gateLock = path.join(testDir, "gate");
  const readyPath = path.join(testDir, "ready");
  const scriptPath = path.join(testDir, "lock-acquire-signal.zsh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  fs.mkdirSync(gateLock, { mode: 0o700 });
  const harness = [
    "#!/bin/zsh",
    "set -u",
    `REMOTE_ROUND_DIR=${quote(testDir)}`,
    `REMOTE_REPO=${quote(process.cwd())}`,
    `SUPERVISED_TOKEN=${quote(SUPERVISED_TOKEN)}`,
    `EXPECTED_HEAD=${quote(EXPECTED_HEAD)}`,
    "SUPERVISED_GUI=0",
    "BRIDGE_SETUP_OK=0",
    "SUPERVISED_CLEANUP_STATE=not_started",
    "SUPERVISED_CLEANUP_RESULT=1",
    "SUPERVISED_PENDING_SIGNAL=0",
    "LOCK_CLEANUP_STATE=not_started",
    "LOCK_CLEANUP_RESULT=1",
    "GATE_TRANSITION_IN_PROGRESS=0",
    "LOCK_ENTRY_TRANSITION_IN_PROGRESS=0",
    "GATE_HELD=0",
    "LOCK_ACQUIRED=0",
    "LOCK_MODE=writer",
    `LOCK_ROOT=${quote(testDir)}`,
    `GATE_LOCK=${quote(gateLock)}`,
    `WRITER_LOCK=${quote(writerLock)}`,
    `READERS_DIR=${quote(path.join(testDir, "readers"))}`,
    `RUN_READER=${quote(path.join(testDir, "reader"))}`,
    lockFunctionsAndTraps,
    `print -r -- ready > ${quote(readyPath)}`,
    "acquire_gate || exit 22",
    "exit 99",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, harness, { encoding: "utf8", mode: 0o700 });

  const child = spawn("/bin/zsh", [scriptPath], { stdio: "ignore" });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  try {
    await waitUntil(() => fs.existsSync(readyPath), 2_000, "gate acquisition did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("signal during gate acquisition was not handled")), 5_000)
      ),
    ]);
    assert.deepEqual(outcome, { exitCode: 143, signal: null });
    assert.equal(fs.existsSync(writerLock), false);
    assert.equal(
      fs.existsSync(gateLock),
      true,
      "a waiter must not remove a gate it never acquired"
    );
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    removeTreeOneFileAtATime(testDir);
  }
}

async function runPreStateCleanupFailureRetentionTest(remoteScript) {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return;
  const functionStart = remoteScript.indexOf("acquire_gate() {");
  const functionEnd = remoteScript.indexOf('/bin/mkdir -p "$READERS_DIR"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const cleanupFunctions = remoteScript.slice(functionStart, functionEnd);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-prestate-cleanup-"));
  const controlDir = path.join(testDir, "supervised-control");
  const writerLock = path.join(testDir, "writer-lock");
  const resultPath = path.join(testDir, "result");
  const scriptPath = path.join(testDir, "prestate-cleanup.zsh");
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  fs.mkdirSync(controlDir, { mode: 0o700 });
  fs.mkdirSync(writerLock, { mode: 0o700 });
  fs.writeFileSync(
    path.join(controlDir, "supervised-attestation.json"),
    `${JSON.stringify({ status: "failed", failureClass: "PROCESS_CLEANUP_FAILED" })}\n`,
    "utf8"
  );
  const harness = [
    "#!/bin/zsh",
    "set -u",
    `REMOTE_ROUND_DIR=${quote(testDir)}`,
    `REMOTE_REPO=${quote(process.cwd())}`,
    `SUPERVISED_TOKEN=${quote(SUPERVISED_TOKEN)}`,
    `EXPECTED_HEAD=${quote(EXPECTED_HEAD)}`,
    "SUPERVISED_GUI=1",
    "BRIDGE_SETUP_OK=0",
    "SUPERVISED_CLEANUP_STATE=not_started",
    "SUPERVISED_CLEANUP_RESULT=1",
    "SUPERVISED_PENDING_SIGNAL=0",
    "LOCK_CLEANUP_STATE=not_started",
    "LOCK_CLEANUP_RESULT=1",
    "GATE_TRANSITION_IN_PROGRESS=0",
    "LOCK_ENTRY_TRANSITION_IN_PROGRESS=0",
    "GATE_HELD=0",
    "LOCK_ACQUIRED=1",
    "LOCK_MODE=writer",
    `LOCK_ROOT=${quote(testDir)}`,
    `GATE_LOCK=${quote(path.join(testDir, "gate"))}`,
    `WRITER_LOCK=${quote(writerLock)}`,
    `READERS_DIR=${quote(path.join(testDir, "readers"))}`,
    `RUN_READER=${quote(path.join(testDir, "reader"))}`,
    cleanupFunctions,
    "trap - EXIT",
    "trap - INT",
    "trap - TERM",
    "trap - HUP",
    "set +e",
    "cleanup_all",
    "cleanup_status=$?",
    `print -r -- "$cleanup_status" > ${quote(resultPath)}`,
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, harness, { encoding: "utf8", mode: 0o700 });
  try {
    const outcome = spawnSync("/bin/zsh", [scriptPath], { encoding: "utf8" });
    assert.equal(outcome.status, 0);
    assert.equal(fs.readFileSync(resultPath, "utf8").trim(), "1");
    assert.equal(
      fs.existsSync(writerLock),
      true,
      "a pre-state PROCESS_CLEANUP_FAILED attestation must retain the writer lock"
    );
  } finally {
    removeTreeOneFileAtATime(testDir);
  }
}

async function runSupervisorGateTests() {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return;
  for (const [name, source] of [
    ["ruyipage", buildRuyiPageProcessSupervisorScript()],
    ["production", buildProductionProcessSupervisorScript()],
  ]) {
    const syntax = spawnSync("/bin/zsh", ["-n", "-c", source], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, `${name} supervisor zsh syntax failed`);
  }
  if (!DARWIN_PROCESS_ENUMERATION_AVAILABLE) return;

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "production-supervisor-gate-"));
  const gatePath = path.join(testDir, "ready");
  const cancelPath = path.join(testDir, "cancel.json");
  const outerCancelPath = path.join(testDir, "outer-cancel.json");
  const markerPath = path.join(testDir, "target-ran");
  const headOutcome = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(headOutcome.status, 0, "test HEAD is unavailable");
  const head = readSpawnStdout(headOutcome).trim();
  const parent = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => {}, 30000)",
      path.join(process.cwd(), "scripts", "supervised-terminal-bridge.mjs"),
    ],
    { stdio: "ignore" }
  );
  let parentPgid = "";
  let parentStartedAt = "";
  let parentCommand = "";
  await waitUntil(() => {
    parentPgid = readSpawnStdout(spawnSync(
      "/bin/ps",
      ["-p", String(parent.pid), "-o", "pgid="],
      { encoding: "utf8" }
    )).trim();
    parentStartedAt = readSpawnStdout(spawnSync(
      "/bin/ps",
      ["-p", String(parent.pid), "-o", "lstart="],
      { encoding: "utf8" }
    )).trim().replace(/\s+/g, " ");
    parentCommand = readSpawnStdout(spawnSync(
      "/bin/ps",
      ["-ww", "-p", String(parent.pid), "-o", "command="],
      { encoding: "utf8" }
    )).trim();
    return parentPgid !== "" && parentStartedAt !== "" && parentCommand !== "";
  }, 2_000, "production supervisor test parent identity is unavailable");
  let staleSupervisor = null;
  let supervisor = null;
  let helperOnlySupervisor = null;
  let residualSupervisor = null;
  let monitoredSupervisor = null;
  let supervisorClosed = null;
  const spawnProductionSupervisor = (args) => {
    const child = spawn("/bin/zsh", args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const protocol = createSupervisorStatusProtocol();
    child.stdio[3].on("data", (chunk) => protocol.push(chunk));
    child.supervisorStatus = () => protocol.finish();
    return child;
  };
  try {
    const staleMarkerPath = path.join(testDir, "stale-target-ran");
    staleSupervisor = spawnProductionSupervisor(
      [
        "-c",
        buildProductionProcessSupervisorScript(),
        "supervised-production",
        String(parent.pid),
        parentPgid,
        "Thu Jan  1 00:00:00 1970",
        parentCommand,
        SUPERVISED_TOKEN,
        gatePath,
        cancelPath,
        outerCancelPath,
        String(Date.now() + 30_000),
        process.cwd(),
        head,
        "/usr/bin/touch",
        staleMarkerPath,
      ]
    );
    const staleOutcome = await Promise.race([
      new Promise((resolve, reject) => {
        staleSupervisor.once("error", reject);
        staleSupervisor.once("close", (exitCode, signal) =>
          resolve({ exitCode, signal })
        );
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("stale parent identity was not rejected")), 3_000)
      ),
    ]);
    assert.deepEqual(staleOutcome, { exitCode: 125, signal: null });
    assert.equal(fs.existsSync(staleMarkerPath), false);

    supervisor = spawnProductionSupervisor(
      [
        "-c",
        buildProductionProcessSupervisorScript(),
        "supervised-production",
        String(parent.pid),
        parentPgid,
        parentStartedAt,
        parentCommand,
        SUPERVISED_TOKEN,
        gatePath,
        cancelPath,
        outerCancelPath,
        String(Date.now() + 30_000),
        process.cwd(),
        head,
        "/usr/bin/touch",
        markerPath,
      ]
    );
    supervisorClosed = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    fs.writeFileSync(cancelPath, `${JSON.stringify({ version: 1 })}\n`, "utf8");
    fs.writeFileSync(
      gatePath,
      `${JSON.stringify({ version: 1, nonce: SUPERVISED_TOKEN, pid: supervisor.pid })}\n`,
      "utf8"
    );
    const outcome = await Promise.race([
      supervisorClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("production supervisor ignored cancellation")), 3_000)
      ),
    ]);
    assert.deepEqual(outcome, { exitCode: 130, signal: null });
    assert.equal(fs.existsSync(markerPath), false);

    fs.unlinkSync(cancelPath);
    fs.unlinkSync(gatePath);
    const helperOnlyGatePath = path.join(testDir, "helper-only-ready");
    helperOnlySupervisor = spawnProductionSupervisor(
      [
        "-c",
        buildProductionProcessSupervisorScript(),
        "supervised-production",
        String(parent.pid),
        parentPgid,
        parentStartedAt,
        parentCommand,
        SUPERVISED_TOKEN,
        helperOnlyGatePath,
        cancelPath,
        outerCancelPath,
        String(Date.now() + 30_000),
        process.cwd(),
        head,
        "/usr/bin/true",
      ]
    );
    const helperOnlyClosed = new Promise((resolve, reject) => {
      helperOnlySupervisor.once("error", reject);
      helperOnlySupervisor.once("close", (exitCode, signal) =>
        resolve({ exitCode, signal })
      );
    });
    fs.writeFileSync(
      helperOnlyGatePath,
      `${JSON.stringify({
        version: 1,
        nonce: SUPERVISED_TOKEN,
        pid: helperOnlySupervisor.pid,
      })}\n`,
      "utf8"
    );
    const helperOnlyOutcome = await Promise.race([
      helperOnlyClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("snapshot helper counted itself as a member")), 5_000)
      ),
    ]);
    assert.deepEqual(helperOnlyOutcome, { exitCode: 0, signal: null });
    assert.deepEqual(helperOnlySupervisor.supervisorStatus(), {
      complete: true,
      targetExit: 0,
      monitorExit: 0,
      finalExit: 0,
      cleanupFailed: false,
    });

    const residualGatePath = path.join(testDir, "residual-ready");
    const residualPidPath = path.join(testDir, "residual-pid");
    const residualCommand = `/usr/bin/nohup /bin/sleep 30 >/dev/null 2>&1 & print -r -- $! > '${residualPidPath.replaceAll("'", `'"'"'`)}'`;
    residualSupervisor = spawnProductionSupervisor(
      [
        "-c",
        buildProductionProcessSupervisorScript(),
        "supervised-production",
        String(parent.pid),
        parentPgid,
        parentStartedAt,
        parentCommand,
        SUPERVISED_TOKEN,
        residualGatePath,
        cancelPath,
        outerCancelPath,
        String(Date.now() + 30_000),
        process.cwd(),
        head,
        "/bin/zsh",
        "-c",
        residualCommand,
      ]
    );
    const residualClosed = new Promise((resolve, reject) => {
      residualSupervisor.once("error", reject);
      residualSupervisor.once("close", (exitCode, signal) =>
        resolve({ exitCode, signal })
      );
    });
    fs.writeFileSync(
      residualGatePath,
      `${JSON.stringify({
        version: 1,
        nonce: SUPERVISED_TOKEN,
        pid: residualSupervisor.pid,
      })}\n`,
      "utf8"
    );
    await waitUntil(
      () => fs.existsSync(residualPidPath),
      3_000,
      "residual child was not launched"
    );
    const residualOutcome = await Promise.race([
      residualClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("residual process group was not cleaned")), 8_000)
      ),
    ]);
    assert.deepEqual(residualOutcome, { exitCode: 0, signal: null });
    assert.deepEqual(residualSupervisor.supervisorStatus(), {
      complete: true,
      targetExit: 0,
      monitorExit: 0,
      finalExit: 0,
      cleanupFailed: false,
    });
    const residualPid = Number(fs.readFileSync(residualPidPath, "utf8").trim());
    assert.equal(pidIsAlive(residualPid), false, "supervisor must clean residual descendants");

    const monitoredGatePath = path.join(testDir, "monitored-ready");
    const monitoredMarkerPath = path.join(testDir, "monitored-target-ran");
    monitoredSupervisor = spawnProductionSupervisor(
      [
        "-c",
        buildProductionProcessSupervisorScript(),
        "supervised-production",
        String(parent.pid),
        parentPgid,
        parentStartedAt,
        parentCommand,
        SUPERVISED_TOKEN,
        monitoredGatePath,
        cancelPath,
        outerCancelPath,
        String(Date.now() + 30_000),
        process.cwd(),
        head,
        "/bin/zsh",
        "-c",
        `trap 'exit 0' TERM; print -r -- started > '${monitoredMarkerPath.replaceAll("'", `'"'"'`)}'; while :; do /bin/sleep 1; done`,
      ]
    );
    const monitoredClosed = new Promise((resolve, reject) => {
      monitoredSupervisor.once("error", reject);
      monitoredSupervisor.once("close", (exitCode, signal) =>
        resolve({ exitCode, signal })
      );
    });
    fs.writeFileSync(
      monitoredGatePath,
      `${JSON.stringify({
        version: 1,
        nonce: SUPERVISED_TOKEN,
        pid: monitoredSupervisor.pid,
      })}\n`,
      "utf8"
    );
    await waitUntil(
      () => fs.existsSync(monitoredMarkerPath),
      3_000,
      "monitored target was not launched"
    );
    parent.kill("SIGKILL");
    const monitoredOutcome = await Promise.race([
      monitoredClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("supervisor ignored parent death after launch")), 8_000)
      ),
    ]);
    assert.deepEqual(monitoredOutcome, { exitCode: 125, signal: null });
    assert.deepEqual(monitoredSupervisor.supervisorStatus(), {
      complete: true,
      targetExit: 0,
      monitorExit: 125,
      finalExit: 125,
      cleanupFailed: false,
    });
  } finally {
    if (pidIsAlive(parent.pid)) parent.kill("SIGKILL");
    if (
      staleSupervisor &&
      staleSupervisor.exitCode == null &&
      staleSupervisor.signalCode == null
    ) {
      try {
        process.kill(-staleSupervisor.pid, "SIGKILL");
      } catch {
        /* process group may already be gone */
      }
    }
    if (supervisor && supervisor.exitCode == null && supervisor.signalCode == null) {
      try {
        process.kill(-supervisor.pid, "SIGKILL");
      } catch {
        /* process group may already be gone */
      }
    }
    for (const candidate of [helperOnlySupervisor, residualSupervisor, monitoredSupervisor]) {
      if (candidate && candidate.exitCode == null && candidate.signalCode == null) {
        try {
          process.kill(-candidate.pid, "SIGKILL");
        } catch {
          /* process group may already be gone */
        }
      }
    }
    removeTreeOneFileAtATime(testDir);
  }
}

const boundedReadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-supervised-bounded-read-"));
try {
  const regularPath = path.join(boundedReadDir, "regular.json");
  const oversizedPath = path.join(boundedReadDir, "oversized.json");
  fs.writeFileSync(regularPath, '{"ok":true}\n', "utf8");
  fs.writeFileSync(oversizedPath, "x".repeat(257), "utf8");
  assert.deepEqual(readBoundedRegularFile(regularPath, 256), {
    state: "present",
    text: '{"ok":true}\n',
  });
  assert.equal(readBoundedRegularFile(oversizedPath, 256).state, "invalid");
  assert.equal(
    readBoundedRegularFile(path.join(boundedReadDir, "missing.json"), 256).state,
    "missing"
  );
} finally {
  removeTreeOneFileAtATime(boundedReadDir);
}

const processStateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "mac-supervised-process-state-")
);
try {
  const statePath = path.join(processStateDir, ".ruyipage-process.json");
  const validState = {
    version: 1,
    pid: 123,
    pgid: 123,
    startedAt: "Mon Jul 14 12:34:56 2026",
    nonce: SUPERVISED_TOKEN,
    commandId: RUYIPAGE_SUPERVISOR_COMMAND_ID,
    commandSha256: "a".repeat(64),
    state: "active",
  };
  fs.writeFileSync(statePath, `${JSON.stringify(validState)}\n`, "utf8");
  assert.deepEqual(
    readVerifiedRuyiPageProcessState(statePath, { nonce: SUPERVISED_TOKEN }),
    validState
  );
  assert.equal(
    validateRuyiPageProcessState(JSON.stringify({ ...validState, pid: "123" })),
    null
  );
  assert.equal(
    validateRuyiPageProcessState(JSON.stringify({ ...validState, extra: true })),
    null
  );
  assert.equal(
    validateRuyiPageProcessState(JSON.stringify({ ...validState, version: 2 })),
    null
  );
  assert.equal(
    validateRuyiPageProcessState(JSON.stringify(validState), {
      nonce: "f".repeat(32),
    }),
    null
  );
  assert.equal(
    validateRuyiPageProcessState(
      JSON.stringify({ ...validState, commandSha256: "not-a-digest" })
    ),
    null
  );
  const lifecyclePath = path.join(processStateDir, ".ruyipage-lifecycle.json");
  const lifecycleState = {
    version: 1,
    nonce: SUPERVISED_TOKEN,
    state: "inactive",
  };
  fs.writeFileSync(lifecyclePath, `${JSON.stringify(lifecycleState)}\n`, "utf8");
  assert.deepEqual(
    readVerifiedRuyiPageLifecycleState(lifecyclePath, {
      nonce: SUPERVISED_TOKEN,
    }),
    lifecycleState
  );
  assert.equal(
    readVerifiedRuyiPageLifecycleState(lifecyclePath, {
      nonce: "f".repeat(32),
    }),
    null
  );
} finally {
  removeTreeOneFileAtATime(processStateDir);
}

const requestVerifierDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "mac-supervised-request-verifier-")
);
try {
  const triggerPath = path.join(requestVerifierDir, "supervised-trigger.json");
  const cancelPath = path.join(requestVerifierDir, "supervised-cancel.json");
  fs.writeFileSync(
    triggerPath,
    `${JSON.stringify({
      version: 1,
      nonce: SUPERVISED_TOKEN,
      commandId: SUPERVISED_COMMAND_ID,
    })}\n`,
    "utf8"
  );
  const validateRequests = (accepted) =>
    validateSupervisedRequestArtifacts({
      triggerPath,
      cancelPath,
      nonce: SUPERVISED_TOKEN,
      accepted,
    });
  assert.equal(validateRequests(true), true);
  fs.writeFileSync(
    cancelPath,
    `${JSON.stringify({ version: 1, nonce: SUPERVISED_TOKEN })}\n`,
    "utf8"
  );
  assert.equal(validateRequests(false), true);
  assert.equal(validateRequests(true), false, "accepted runs must not retain cancel");
  fs.unlinkSync(cancelPath);
  fs.writeFileSync(
    triggerPath,
    `${JSON.stringify({
      version: 1,
      nonce: SUPERVISED_TOKEN,
      commandId: SUPERVISED_COMMAND_ID,
      extra: true,
    })}\n`,
    "utf8"
  );
  assert.equal(validateRequests(false), false, "trigger keys must be exact");
} finally {
  removeTreeOneFileAtATime(requestVerifierDir);
}

assert.throws(() => parseArgs([]), /--task.*--task-file/);
assert.throws(() => parseArgs(["--task", "   "]), /task/i);
assert.throws(
  () => parseArgs(["--task", "one", "--task-file", "task.txt"]),
  /only one|不能同时|mutually/i
);

const defaults = parseArgs(["--task", "检查 macOS 测试"]);
assert.deepEqual(defaults, {
  task: "检查 macOS 测试",
  sync: true,
  sshAlias: "mac-codex",
  remoteRepo: DEFAULT_REMOTE_REPO,
  round: 1,
  roundName: "round-01",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  supervisedGui: false,
});

const taskFileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-codex-task-"));
try {
  const taskFile = path.join(taskFileDir, "task.txt");
  fs.writeFileSync(taskFile, "  运行中文回归测试\n", "utf8");
  const parsed = parseArgs([
    "--task-file",
    taskFile,
    "--round",
    "7",
    "--timeout-ms",
    "45000",
    "--ssh-alias",
    "mac-lab",
    "--remote-repo",
    "/Users/admin/Repo With Space",
    "--no-sync",
  ]);
  assert.deepEqual(parsed, {
    task: "运行中文回归测试",
    sync: false,
    sshAlias: "mac-lab",
    remoteRepo: "/Users/admin/Repo With Space",
    round: 7,
    roundName: "round-07",
    timeoutMs: 45_000,
    supervisedGui: false,
  });
} finally {
  removeTreeOneFileAtATime(taskFileDir);
}

for (const round of ["0", "-1", "1.5", "abc"]) {
  assert.throws(() => parseArgs(["--task", "x", "--round", round]), /round/i);
}
for (const timeout of ["0", "999", "1.5", "abc", "86400001"]) {
  assert.throws(
    () => parseArgs(["--task", "x", "--timeout-ms", timeout]),
    /timeout/i
  );
}
assert.throws(() => parseArgs(["--task", "x", "--unknown"]), /unknown|未知/i);
assert.throws(
  () => parseArgs(["--task", "x", "--ssh-alias", "-F"]),
  /SSH alias/i
);
assert.throws(
  () => parseArgs(["--task", "x", "--allow-supervised-gui", "--no-sync"]),
  /synchronized exclusive run/i
);

const supervisedArgs = parseArgs(["--task", "执行受监督 GUI 验收", "--allow-supervised-gui"]);
assert.equal(supervisedArgs.supervisedGui, true);
assert.throws(
  () =>
    parseArgs([
      "--task",
      "执行受监督 GUI 验收",
      "--allow-supervised-gui",
      "--timeout-ms",
      "119999",
    ]),
  /timeout of at least 120000ms/i
);

const prompt = buildAgentPrompt({ task: "检查中文任务与登录流程" });
for (const requiredText of [
  "检查中文任务与登录流程",
  "ruyiPage",
  ".env",
  "auth.json",
  "API Key",
  "GitHub PAT",
  "不读取",
  "不修改",
  "不提交",
  "不推送",
  "非交互",
  "2FA",
  "退出码",
  "JSON Schema",
  "noninteractive",
]) {
  assert.match(prompt, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(prompt, /不执行人工 2FA/);
assert.doesNotMatch(prompt, /用户明确监督并授权 GUI 验收/);

const supervisedPrompt = buildAgentPrompt({
  task: "执行真实 Apple Account 登录验收",
  supervisedGui: true,
});
for (const requiredText of [
  "用户明确监督并授权 GUI 验收",
  "真实 Apple 账号流程",
  "ruyiPage",
  "生产脚本在进程内部加载凭据",
  "完整 Apple ID",
  "raw AX/OCR",
  "固定成功标记",
  "supervised_gui",
  "REAL_ACCOUNT_HOME_CONFIRMED",
  SUPERVISED_HELPER_COMMAND,
  "不得自行调用 open、launchctl、AppleScript",
]) {
  assert.match(
    supervisedPrompt,
    new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
}
assert.doesNotMatch(supervisedPrompt, /不执行人工 2FA/);
assert.match(
  supervisedPrompt,
  /零参数入口 `node scripts\/supervised-mac-acceptance\.mjs`/
);
assert.doesNotMatch(
  supervisedPrompt,
  /node scripts\/supervised-mac-acceptance\.mjs\s+--|supervised-mac-acceptance\.mjs[^`\r\n]+/
);
assert.doesNotMatch(prompt, /supervised-mac-acceptance\.mjs/);

const remoteOptions = {
  task: "检查中文任务与登录流程",
  sync: true,
  remoteRepo: DEFAULT_REMOTE_REPO,
  remoteRoundDir: "/Users/admin/.codex-orchestrator/runs/run-test/mac/round-02",
  branch: "codex/ruyipage-risk-reduction",
  expectedHead: EXPECTED_HEAD,
};
const remoteScript = buildRemoteScript(remoteOptions);
const promptBase64 = remoteScript.match(/PROMPT_B64='([A-Za-z0-9+/=]+)'/)?.[1];
assert.ok(promptBase64, "remote script must contain a shell-quoted Base64 prompt");
assert.equal(
  Buffer.from(promptBase64, "base64").toString("utf8"),
  buildAgentPrompt(remoteOptions)
);
assert.doesNotMatch(remoteScript, /检查中文任务与登录流程/);
assert.match(remoteScript, /CODEX_BIN='\/Users\/admin\/\.local\/bin\/codex'/);
assert.match(
  remoteScript,
  /export PATH="\$REMOTE_REPO\/\.runtime\/node\/bin:\$HOME\/\.local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/
);
const expectedModelPermissionProfile = createMacVerificationPermissionProfile(
  remoteOptions.remoteRoundDir + "/tmp",
  remoteOptions.remoteRepo
);
assert.ok(
  remoteScript.includes("PERMISSION_PROFILE='" + expectedModelPermissionProfile + "'")
);
assert.match(remoteScript, /Apple-AutoMation\/\.env" = "deny"/);
assert.match(remoteScript, /~\/\.codex\/auth\.json" = "deny"/);
assert.match(remoteScript, /RUN_TMP_DIR="\$REMOTE_ROUND_DIR\/tmp"/);
assert.match(remoteScript, /export TMPDIR="\$RUN_TMP_DIR"/);
assert.match(
  remoteScript,
  /export APPLE_AUTOMATION_REPORT_ROOT="\$RUN_TMP_DIR\/reports"/
);
assert.match(
  remoteScript,
  /export APPLE_AUTOMATION_ACCEPTANCE_MARKER="\$ACCEPTANCE_MARKER"/
);
assert.match(remoteScript, /export FIREFOX_PROFILE_DIR="\$RUN_TMP_DIR\/firefox-profile"/);
assert.match(remoteScript, /export BROWSER_PROFILE_MODE="persistent"/);
for (const variable of [
  "APPLE_AUTOMATION_REPORT_ROOT",
  "APPLE_AUTOMATION_ACCEPTANCE_MARKER",
  "APPLE_AUTOMATION_SUPERVISED_GUI",
  "APPLE_AUTOMATION_SUPERVISED_TOKEN",
  "APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS",
  "APPLE_AUTOMATION_SUPERVISED_TRIGGER",
  "APPLE_AUTOMATION_SUPERVISED_CANCEL",
  "APPLE_AUTOMATION_SUPERVISED_ATTESTATION",
  "APPLE_AUTOMATION_EXPECTED_HEAD",
  "FIREFOX_PROFILE_DIR",
  "BROWSER_PROFILE_MODE",
  "APPLE_AUTOMATION_HELPER_DIR",
]) {
  assert.match(remoteScript, new RegExp(`SHELL_ENV_INCLUDE_ONLY=.*${variable}`));
}
assert.match(
  remoteScript,
  /export APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS="\$SUPERVISED_DEADLINE_EPOCH_MS"/
);
assert.doesNotMatch(
  remoteScript,
  /SUPERVISED_CONTROL_DIR=|SUPERVISED_PRODUCTION_DIR=|PRODUCTION_PERMISSION_PROFILE=|terminal-bridge\.command|open -b com\.apple\.Terminal/
);
assert.match(remoteScript, /"status":"not_requested"/);
assert.doesNotMatch(
  remoteScript,
  /supervised-terminal\.(?:status|trigger|cancel|exit|log)/
);
assert.equal((remoteScript.match(/PERMISSION_PROFILE=/g) ?? []).length, 1);
assert.equal((remoteScript.match(/permissions\.mac_verification=/g) ?? []).length, 2);
assert.equal((remoteScript.match(/default_permissions=/g) ?? []).length, 1);
assert.equal((remoteScript.match(/\n  -c /g) ?? []).length, 5);
const forbiddenSandboxOverride =
  /--add-dir|--sandbox(?:=|\s)|--dangerously-bypass-approvals-and-sandbox|(?:^|\s)-s(?:=|\s|read-only|workspace-write|danger-full-access)/;
for (const unsafeArgument of [
  "-s read-only",
  "-s=read-only",
  "-sread-only",
]) {
  assert.match(unsafeArgument, forbiddenSandboxOverride);
}
assert.doesNotMatch(remoteScript, forbiddenSandboxOverride);
assert.match(
  remoteScript,
  /"\$CODEX_BIN" sandbox -p automation \\\n  -c "permissions\.mac_verification=\$PERMISSION_PROFILE" \\\n  -c "shell_environment_policy\.include_only=\$SHELL_ENV_INCLUDE_ONLY" \\\n  -P mac_verification \\\n  --include-managed-config \\\n  -C "\$REMOTE_REPO" \\\n  \/usr\/bin\/true/
);
assert.match(
  remoteScript,
  /"\$CODEX_BIN" exec -p automation \\\n  -c "permissions\.mac_verification=\$PERMISSION_PROFILE" \\\n  -c "shell_environment_policy\.include_only=\$SHELL_ENV_INCLUDE_ONLY" \\\n  -c 'default_permissions="mac_verification"' \\\n  --json/
);
assert.ok(
  remoteScript.indexOf('"$CODEX_BIN" sandbox -p automation') <
    remoteScript.indexOf('"$CODEX_BIN" exec -p automation'),
  "managed permission preflight must pass before Codex exec starts"
);
for (const command of [
  '/bin/mkdir -p "$REMOTE_ROUND_DIR"',
  '/bin/chmod 700 "$REMOTE_ROUND_DIR"',
  '/bin/mkdir "$RUN_TMP_DIR"',
  '/bin/chmod 700 "$RUN_TMP_DIR"',
  'export TMPDIR="$RUN_TMP_DIR"',
  'export APPLE_AUTOMATION_REPORT_ROOT="$RUN_TMP_DIR/reports"',
  'export FIREFOX_PROFILE_DIR="$RUN_TMP_DIR/firefox-profile"',
  '"$CODEX_BIN" exec -p automation',
]) {
  assert.ok(remoteScript.includes(command), `remote script must include: ${command}`);
}
assert.ok(
  remoteScript.indexOf('/bin/mkdir -p "$REMOTE_ROUND_DIR"') <
    remoteScript.indexOf('/bin/chmod 700 "$REMOTE_ROUND_DIR"') &&
    remoteScript.indexOf('/bin/chmod 700 "$REMOTE_ROUND_DIR"') <
      remoteScript.indexOf('/bin/mkdir "$RUN_TMP_DIR"') &&
    remoteScript.indexOf('/bin/mkdir "$RUN_TMP_DIR"') <
      remoteScript.indexOf('/bin/chmod 700 "$RUN_TMP_DIR"') &&
    remoteScript.indexOf('/bin/chmod 700 "$RUN_TMP_DIR"') <
      remoteScript.indexOf('export TMPDIR="$RUN_TMP_DIR"') &&
    remoteScript.indexOf('export TMPDIR="$RUN_TMP_DIR"') <
      remoteScript.indexOf('"$CODEX_BIN" exec -p automation'),
  "private per-round TMPDIR must exist before Codex starts"
);
assert.match(remoteScript, /--json/);
assert.match(remoteScript, /--output-schema/);
assert.match(remoteScript, /-o "\$REMOTE_ROUND_DIR\/final\.json"/);
assert.match(
  remoteScript,
  /< \/dev\/null[\s\S]*> "\$REMOTE_ROUND_DIR\/events\.jsonl"/,
  "Codex must not consume the remaining SSH script as additional prompt input"
);
assert.match(remoteScript, /\/usr\/bin\/git fetch origin/);
assert.match(remoteScript, /\/usr\/bin\/git switch -- "\$BRANCH"/);
assert.match(remoteScript, /\/usr\/bin\/git merge --ff-only -- "origin\/\$BRANCH"/);
assert.match(remoteScript, /\/usr\/bin\/git rev-parse HEAD/);
const postSyncCleanCheck = 'Mac repository is not clean after synchronization';
assert.ok(
  remoteScript.indexOf(postSyncCleanCheck) >
    remoteScript.indexOf('Mac HEAD does not match the Windows HEAD') &&
    remoteScript.indexOf(postSyncCleanCheck) >
      remoteScript.indexOf('/usr/bin/git merge --ff-only -- "origin/$BRANCH"') &&
    remoteScript.indexOf(postSyncCleanCheck) <
      remoteScript.indexOf('"$CODEX_BIN" exec -p automation'),
  "Mac repository cleanliness must be rechecked after synchronization and HEAD verification, before Codex exec"
);
assert.doesNotMatch(remoteScript, /(^|\n)git\s/m);
assert.doesNotMatch(remoteScript, /git\s+(?:reset|clean)\b|rm\s+-[A-Za-z]*r[A-Za-z]*f/i);
assert.ok(
  remoteScript.indexOf('/usr/bin/git status') < remoteScript.indexOf('export PATH='),
  "control-plane Git checks must run before the project runtime enters PATH"
);
assert.ok(
  remoteScript.indexOf("umask 077") < remoteScript.indexOf('/bin/mkdir -p'),
  "run artifacts must be private from creation"
);
assert.match(remoteScript, /LOCK_MODE='writer'/);
assert.match(remoteScript, /acquire_gate\(\)/);
assert.match(remoteScript, /cleanup_lock\(\)/);
assert.match(remoteScript, /cleanup_supervised_bridge\(\)/);
assert.match(remoteScript, /cleanup_all\(\)/);
assert.match(remoteScript, /trap cleanup_all EXIT/);
assert.match(remoteScript, /SUPERVISED_CLEANUP_STATE=not_started/);
assert.match(remoteScript, /SUPERVISED_CLEANUP_STATE=in_progress/);
assert.match(remoteScript, /SUPERVISED_CLEANUP_STATE=complete/);
assert.match(remoteScript, /SUPERVISED_PENDING_SIGNAL/);
assert.match(remoteScript, /trap 'handle_supervised_signal 130' INT/);
assert.match(remoteScript, /trap 'handle_supervised_signal 143' TERM/);
assert.match(remoteScript, /trap 'handle_supervised_signal 129' HUP/);
assert.match(remoteScript, /READERS_DIR/);
assert.match(remoteScript, /WRITER_LOCK/);

assert.throws(
  () =>
    buildRemoteScript({
      ...remoteOptions,
      task: "执行真实 Apple Account 登录验收",
      supervisedGui: true,
    }),
  /random bridge token/i
);

const supervisedRemoteScript = buildRemoteScript({
  ...remoteOptions,
  task: "执行真实 Apple Account 登录验收",
  supervisedGui: true,
  supervisedToken: SUPERVISED_TOKEN,
});
for (const requiredText of [
  `SUPERVISED_TOKEN='${SUPERVISED_TOKEN}'`,
  'SUPERVISED_CONTROL_DIR="$REMOTE_ROUND_DIR/supervised-control"',
  'SUPERVISED_PRODUCTION_DIR="$SUPERVISED_CONTROL_DIR/production"',
  'SUPERVISED_HELPER_DIR="$SUPERVISED_CONTROL_DIR/helpers"',
  'SUPERVISED_TRIGGER="$RUN_TMP_DIR/supervised-trigger.json"',
  'SUPERVISED_CANCEL="$RUN_TMP_DIR/supervised-cancel.json"',
  'SUPERVISED_OUTER_CANCEL="$SUPERVISED_CONTROL_DIR/outer-cancel.json"',
  'SUPERVISED_ATTESTATION="$SUPERVISED_CONTROL_DIR/supervised-attestation.json"',
  'SUPERVISED_BRIDGE_SCRIPT="$SUPERVISED_CONTROL_DIR/terminal-bridge.command"',
  `PRODUCTION_PERMISSION_PROFILE='{ extends = ":read-only", filesystem = { "${remoteOptions.remoteRoundDir}/supervised-control/production" = "write", "/tmp/apple-automation-${SUPERVISED_TOKEN}.sock" = "write" }, network = { enabled = true, domains = {}, unix_sockets = { "/tmp/apple-automation-${SUPERVISED_TOKEN}.sock" = "allow" } } }'`,
  'APPLE_AUTOMATION_SUPERVISED_WRITABLE_TMP=${(q)RUN_TMP_DIR}',
  'APPLE_AUTOMATION_SUPERVISED_CONTROL_DIR=${(q)SUPERVISED_CONTROL_DIR}',
  'APPLE_AUTOMATION_SUPERVISED_TRIGGER=${(q)SUPERVISED_TRIGGER}',
  'APPLE_AUTOMATION_SUPERVISED_CANCEL=${(q)SUPERVISED_CANCEL}',
  'APPLE_AUTOMATION_SUPERVISED_ATTESTATION=${(q)SUPERVISED_ATTESTATION}',
  'APPLE_AUTOMATION_SUPERVISED_PRODUCTION_DIR=${(q)SUPERVISED_PRODUCTION_DIR}',
  "exec /usr/bin/env -i",
  'scripts/supervised-terminal-bridge.mjs',
  '/bin/chmod 500 "$SUPERVISED_BRIDGE_SCRIPT"',
  '/usr/bin/open -b com.apple.Terminal "$SUPERVISED_BRIDGE_SCRIPT"',
  'scripts/supervised-request-verifier.mjs',
  '/bin/cp -p "$SUPERVISED_ATTESTATION" "$SUPERVISED_ATTESTATION_ARTIFACT"',
]) {
  assert.ok(
    supervisedRemoteScript.includes(requiredText),
    `supervised remote script must include: ${requiredText}`
  );
}
const supervisedHelperFailureIndex = supervisedRemoteScript.indexOf(
  'write_supervised_attestation failed 1 false HELPER_COMPILE_FAILED "$EXPECTED_HEAD"'
);
assert.ok(supervisedHelperFailureIndex > 0, "supervised helper hard-failure marker is required");
for (const helper of ["mac-2fa-popup-read", "mac-2fa-click-allow"]) {
  const helperCompileIndex = supervisedRemoteScript.indexOf(
    `"$SUPERVISED_HELPER_DIR/${helper}" scripts/swift/${helper}.swift`
  );
  assert.ok(
    helperCompileIndex > 0 && helperCompileIndex < supervisedHelperFailureIndex,
    `${helper} must be compiled before the supervised hard-failure marker`
  );
}
for (const helper of ["mac-settings-2fa-code", "mac-2fa-popup-ocr"]) {
  const helperCompileIndex = supervisedRemoteScript.indexOf(
    `scripts/swift/${helper}.swift`
  );
  assert.ok(
    helperCompileIndex > supervisedHelperFailureIndex,
    `${helper} must be compiled only after the supervised hard-failure block`
  );
  assert.ok(
    supervisedRemoteScript.includes(`"$SUPERVISED_HELPER_DIR/${helper}" || true`),
    `${helper} must be best-effort in supervised setup`
  );
}
for (const forbiddenText of [
  "supervised-terminal.status",
  "supervised-terminal.trigger",
  "supervised-terminal.cancel",
  "supervised-terminal.exit",
  "supervised-terminal.log",
  'printf "\\n" | ./run.sh --skip-mac',
]) {
  assert.equal(
    supervisedRemoteScript.includes(forbiddenText),
    false,
    `supervised remote script must exclude obsolete protocol text: ${forbiddenText}`
  );
}
assert.doesNotMatch(
  supervisedRemoteScript,
  /SUPERVISED_(?:BRIDGE_SCRIPT|ATTESTATION|PRODUCTION_DIR|HELPER_DIR)="\$RUN_TMP_DIR/
);
assert.doesNotMatch(supervisedRemoteScript, /launchctl\s+asuser|osascript|open\s+-a/);
assert.equal(
  (supervisedRemoteScript.match(/open -b com\.apple\.Terminal/g) ?? []).length,
  1,
  "the outer wrapper must launch exactly one constrained Terminal bridge"
);
const gitVerificationIndex = supervisedRemoteScript.indexOf(
  "Mac repository is not clean after synchronization"
);
const productionPreflightIndex = supervisedRemoteScript.indexOf(
  'permissions.supervised_production=$PRODUCTION_PERMISSION_PROFILE'
);
const bridgeLaunchIndex = supervisedRemoteScript.indexOf(
  '/usr/bin/open -b com.apple.Terminal "$SUPERVISED_BRIDGE_SCRIPT"'
);
const modelDenyProbeIndex = supervisedRemoteScript.indexOf(
  'if (( BRIDGE_SETUP_OK == 1 )) && "$CODEX_BIN" sandbox -p automation -c "permissions.mac_verification=$PERMISSION_PROFILE"'
);
const supervisedSetupAbortIndex = supervisedRemoteScript.indexOf(
  "if (( BRIDGE_SETUP_OK != 1 )); then"
);
const codexExecIndex = supervisedRemoteScript.indexOf('"$CODEX_BIN" exec -p automation');
for (const [label, index] of [
  ["post-sync Git verification", gitVerificationIndex],
  ["production sandbox preflight", productionPreflightIndex],
  ["model secret deny probe", modelDenyProbeIndex],
  ["Terminal bridge launch", bridgeLaunchIndex],
  ["supervised setup abort", supervisedSetupAbortIndex],
  ["Codex exec", codexExecIndex],
]) {
  assert.notEqual(index, -1, `${label} must be present in the supervised script`);
}
assert.ok(
  gitVerificationIndex < productionPreflightIndex &&
    productionPreflightIndex < modelDenyProbeIndex &&
    modelDenyProbeIndex < supervisedSetupAbortIndex &&
    productionPreflightIndex < bridgeLaunchIndex &&
    bridgeLaunchIndex < supervisedSetupAbortIndex &&
    supervisedSetupAbortIndex < codexExecIndex,
  "the production sandbox must be preflighted before the bridge launches and Codex starts"
);
const supervisedSetupAbortSlice = supervisedRemoteScript.slice(
  supervisedSetupAbortIndex,
  codexExecIndex
);
for (const required of [
  "cleanup_supervised_bridge || true",
  '"$SUPERVISED_ATTESTATION_ARTIFACT"',
  '"$REMOTE_ROUND_DIR/final.json"',
  '"$REMOTE_ROUND_DIR/events.jsonl"',
  '"$REMOTE_ROUND_DIR/stderr.log"',
  "exit 125",
]) {
  assert.ok(supervisedSetupAbortSlice.includes(required));
}
assert.doesNotMatch(supervisedSetupAbortSlice, /"\$CODEX_BIN" exec/);
const supervisedSetupSlice = supervisedRemoteScript.slice(
  supervisedRemoteScript.indexOf('SUPERVISED_CONTROL_DIR='),
  supervisedSetupAbortIndex
);
assert.doesNotMatch(supervisedSetupSlice, /\brm\b|git\s|password|OTP/i);
assert.equal(
  (supervisedSetupSlice.match(/\/bin\/cat "\$REMOTE_REPO\/\.env"/g) ?? [])
    .length,
  2,
  "model deny and production read access must both be probed with output discarded"
);
assert.match(
  supervisedSetupSlice,
  /write_supervised_attestation pending[\s\S]*if ! "\$CODEX_BIN" sandbox[\s\S]*\/usr\/bin\/true >\/dev\/null 2>&1; then[\s\S]*BRIDGE_SETUP_OK=0[\s\S]*SANDBOX_PREFLIGHT_FAILED/
);
assert.doesNotMatch(supervisedSetupSlice, /\blocal status=/);
assert.match(
  supervisedSetupSlice,
  /local attestation_status="\$1"[\s\S]*"status":"'"\$attestation_status"'"/
);
assert.doesNotMatch(
  supervisedRemoteScript.slice(
    0,
    supervisedRemoteScript.indexOf("write_supervised_attestation pending")
  ),
  /"\$CODEX_BIN" sandbox/
);
assert.match(
  supervisedRemoteScript,
  /permissions\.supervised_production=\$PRODUCTION_PERMISSION_PROFILE[\s\S]*-P supervised_production[\s\S]*--include-managed-config[\s\S]*\/bin\/cat "\$REMOTE_REPO\/\.env"/
);
assert.match(
  supervisedRemoteScript,
  /permissions\.mac_verification=\$PERMISSION_PROFILE[\s\S]*-P mac_verification[\s\S]*\/bin\/cat "\$REMOTE_REPO\/\.env"[\s\S]*BRIDGE_SETUP_OK=0/
);
assert.match(
  supervisedRemoteScript,
  /\{"version":1,"nonce":"'\$SUPERVISED_TOKEN'"/
);
assert.match(
  supervisedRemoteScript,
  /temporary_attestation="\$SUPERVISED_ATTESTATION\.tmp\.\$\$"[\s\S]*\/bin\/mv -f "\$temporary_attestation" "\$SUPERVISED_ATTESTATION"/
);
assert.match(
  supervisedRemoteScript,
  /local bridge_state_file="\$control_dir\/supervised-terminal\.json"/
);

const supervisedTerminalBridgeSource = fs.readFileSync(
  new URL("./supervised-terminal-bridge.mjs", import.meta.url),
  "utf8"
);
const productionSupervisorScript = buildProductionProcessSupervisorScript();
assert.match(
  productionSupervisorScript,
  /if runtime_is_allowed; then\n\s+\/bin\/sleep 0\.25\n\s+continue\n\s+else\n\s+monitor_status=\$\?\n\s+fi/,
  "the runtime policy status must be captured in the failing else branch"
);
assert.match(
  productionSupervisorScript,
  /target_identity_is_current\(\)[\s\S]*current_production_pgid[\s\S]*current_production_started_at[\s\S]*current_production_command[\s\S]*expected_production_command/
);
assert.match(
  productionSupervisorScript,
  /if target_identity_is_current; then\n\s+\/bin\/kill -TERM "\$production_pid"/
);
assert.match(
  productionSupervisorScript,
  /if target_identity_is_current; then\n\s+\/bin\/kill -KILL "\$production_pid"/
);
assert.match(
  productionSupervisorScript,
  /group_snapshot=\$\(\/usr\/bin\/mktemp[\s\S]*\/bin\/ps -ax -o pid= -o pgid= >\| "\$group_snapshot"[\s\S]*snapshot_helper_pid=\$!/
);
assert.match(
  productionSupervisorScript,
  /"\$member_pid" == "\$\$" \|\| "\$member_pid" == "\$snapshot_helper_pid"/
);
assert.doesNotMatch(
  productionSupervisorScript,
  /group_member_pids|\/usr\/bin\/awk/,
  "group enumeration must not create untracked pipeline helpers"
);
assert.match(
  productionSupervisorScript,
  /target-exit:\$production_status[\s\S]*monitor-exit:\$monitor_status[\s\S]*final-exit:\$production_status[\s\S]*cleanup-failed[\s\S]*exit "\$production_status"/
);
assert.match(productionSupervisorScript, /"\$@" 3>&- <&0 >&1 2>&2 &/);
assert.doesNotMatch(
  productionSupervisorScript,
  /cleanup_status == 0 \)\) \|\| exit/
);

const validSupervisorProtocol = createSupervisorStatusProtocol();
for (const chunk of [
  "target-la",
  "unch\ntarget-identity-ready\ntarget-exit:",
  "1\nmonitor-exit:0\nfinal-exit:1\ncleanup-failed\n",
]) {
  validSupervisorProtocol.push(Buffer.from(chunk));
}
assert.deepEqual(validSupervisorProtocol.finish(), {
  complete: true,
  targetExit: 1,
  monitorExit: 0,
  finalExit: 1,
  cleanupFailed: true,
});
assert.equal(
  classifySupervisorStatus(
    { complete: true, targetExit: 1, monitorExit: 0, finalExit: 1, cleanupFailed: false },
    1
  ),
  "valid"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: true,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "cleanup_failed",
    markerConfirmed: false,
    ruyiPageCleanupEvidence: true,
  }),
  "recovered"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: false,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "cleanup_failed",
    markerConfirmed: false,
    ruyiPageCleanupEvidence: true,
  }),
  "failed"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: true,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "cleanup_failed",
    markerConfirmed: false,
    ruyiPageCleanupEvidence: true,
  }),
  "recovered"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: true,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "valid",
    markerConfirmed: false,
    ruyiPageCleanupEvidence: false,
  }),
  "clean"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: true,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "invalid",
    markerConfirmed: false,
    ruyiPageCleanupEvidence: false,
  }),
  "clean"
);
assert.equal(
  classifyProcessCleanup({
    productionGroupClean: true,
    ruyiPageGroupClean: true,
    supervisorStatusOutcome: "valid",
    markerConfirmed: true,
    ruyiPageCleanupEvidence: false,
  }),
  "failed"
);
assert.equal(
  classifySupervisorStatus(
    { complete: true, targetExit: 1, monitorExit: 0, finalExit: 1, cleanupFailed: true },
    1
  ),
  "cleanup_failed"
);
assert.equal(
  classifySupervisorStatus(
    { complete: true, targetExit: 1, monitorExit: 0, finalExit: 1, cleanupFailed: false },
    0
  ),
  "invalid"
);
assert.equal(
  classifySupervisorStatus(
    { complete: true, targetExit: 143, monitorExit: 143, finalExit: 143, cleanupFailed: false },
    143
  ),
  "invalid"
);
assert.equal(
  classifySupervisorStatus(
    { complete: true, targetExit: 143, monitorExit: 143, finalExit: 143, cleanupFailed: false },
    143,
    { externalTerminationAttempted: true }
  ),
  "valid"
);
for (const lines of [
  ["target-launch", "target-identity-ready", "monitor-exit:0"],
  ["target-launch", "target-launch", "target-identity-ready", "target-exit:0", "monitor-exit:0"],
  ["target-launch", "target-identity-ready", "target-exit:999", "monitor-exit:0"],
  ["target-launch", "target-identity-ready", "target-exit:0", "monitor-exit:142", "final-exit:0"],
  ["target-launch", "target-identity-ready", "target-exit:0", "monitor-exit:0", "final-exit:0", "extra"],
]) {
  const protocol = createSupervisorStatusProtocol();
  protocol.push(Buffer.from(`${lines.join("\n")}\n`));
  assert.equal(protocol.finish().complete, false);
}
const unterminatedSupervisorProtocol = createSupervisorStatusProtocol();
unterminatedSupervisorProtocol.push(
  Buffer.from("target-launch\ntarget-identity-ready\ntarget-exit:0\nmonitor-exit:0")
);
assert.equal(unterminatedSupervisorProtocol.finish().complete, false);
assert.match(
  supervisedTerminalBridgeSource,
  /const productionArgs = \[\s*"sandbox",[\s\S]*?"-P",\s*"supervised_production",[\s\S]*?"--include-managed-config",[\s\S]*?"-C",\s*context\.repo,\s*"\.\/run\.sh",\s*"--skip-mac",\s*\]/
);
const browserBrokerStartIndex = supervisedTerminalBridgeSource.indexOf(
  "await startBroker(browserBroker, bridgeIdentity)"
);
const productionSpawnIndex = supervisedTerminalBridgeSource.indexOf(
  "child = spawnProcess(",
  browserBrokerStartIndex
);
assert.ok(
  browserBrokerStartIndex >= 0 &&
    productionSpawnIndex > browserBrokerStartIndex,
  "the trusted browser broker socket must be ready before production starts"
);
assert.match(supervisedTerminalBridgeSource, /runtime_resolving/);
assert.match(supervisedTerminalBridgeSource, /backend_starting/);
assert.match(supervisedTerminalBridgeSource, /BROWSER_RUNTIME_UNAVAILABLE/);
for (const failureClass of [
  "BROWSER_BROKER_LAUNCH_FAILED",
  "BROWSER_BROKER_TRANSPORT_FAILED",
  "BROWSER_PROCESS_UNRESPONSIVE",
  "BROWSER_LAUNCH_FAILED",
]) {
  assert.match(supervisedTerminalBridgeSource, new RegExp(failureClass));
}
assert.match(
  supervisedTerminalBridgeSource,
  /child = spawnProcess\(\s*"\/bin\/zsh",\s*\[\s*"-c",\s*supervisorScript,[\s\S]*?productionLaunchGatePath,[\s\S]*?context\.codexBin,[\s\S]*?\.\.\.productionArgs/
);
assert.match(
  supervisedTerminalBridgeSource,
  /buildProductionProcessSupervisorScript[\s\S]*"parent_pid=\$1"[\s\S]*"parent_pgid=\$2"[\s\S]*"parent_started_at=\$3"[\s\S]*"parent_command=\$4"[\s\S]*"launch_nonce=\$5"[\s\S]*"launch_gate=\$6"[\s\S]*"\\\"\$@\\\" 3>&- <&0 >&1 2>&2 &"[\s\S]*monitor_runtime[\s\S]*cleanup_group_members/
);
assert.match(
  supervisedTerminalBridgeSource,
  /combined\.includes\(manualPromptBytes\)[\s\S]*manualPromptObserved = true/
);
assert.match(
  supervisedTerminalBridgeSource,
  /"manual_code",\s*"manual_unavailable",\s*"ocr_permission_missing"[\s\S]*productionStage = "two_fa_code_pending"/
);
assert.match(
  supervisedTerminalBridgeSource,
  /supervisedTwoFaDetail\(\{[\s\S]*failureClass,[\s\S]*ttyCapability,[\s\S]*manualPromptObserved/
);
assert.match(
  supervisedTerminalBridgeSource,
  /createProductionProtocolState[\s\S]*SUPERVISED_STDOUT_STAGE_TOKENS\.has\(stage\)[\s\S]*SUPERVISED_NODE_FAILURES\.has\(failure\)/
);
assert.match(
  supervisedTerminalBridgeSource,
  /const onStderrChunk = \(chunk\) => \{[\s\S]*drainProductionStderr\(chunk\)[\s\S]*\};/
);
assert.doesNotMatch(
  supervisedTerminalBridgeSource,
  /const onStderrChunk[\s\S]*processSafeLine\(/
);
assert.match(
  supervisedTerminalBridgeSource,
  /TERMINAL_BRIDGE_COMMAND_ID[\s\S]*PRODUCTION_SUPERVISOR_COMMAND_ID[\s\S]*commandSha256/
);
assert.match(
  supervisedTerminalBridgeSource,
  /productionStateConfirmed\s*=[\s\S]*state\?\.commandId === PRODUCTION_SUPERVISOR_COMMAND_ID[\s\S]*state\?\.commandSha256 ===[\s\S]*productionIdentity\.command[\s\S]*commandId,commandSha256,nonce,pgid,pid,startedAt,state,version/
);
assert.match(
  supervisedTerminalBridgeSource,
  /writeProductionLaunchGate\(productionLaunchGatePath, child\.pid, context\.nonce\)/
);
assert.match(
  supervisedTerminalBridgeSource,
  /cleanupBrowserBroker\([\s\S]*cleanupRecorded\s*=\s*[\s\S]*cleanupRecordedRuyiPageProcess[\s\S]*broker\.paths\.statePath[\s\S]*broker\.paths\.scriptPath[\s\S]*broker\.context\.nonce/
);
assert.equal(
  (supervisedTerminalBridgeSource.match(/"\.\/run\.sh"/g) ?? []).length,
  1,
  "the bridge must contain one fixed production entrypoint"
);
assert.doesNotMatch(supervisedTerminalBridgeSource, /shell:\s*true|["']-lc["']/);
assert.match(
  supervisedTerminalBridgeSource,
  /path\.join\(context\.controlDir, "supervised-terminal\.json"\)/
);
assert.match(
  supervisedTerminalBridgeSource,
  /path\.join\(context\.controlDir, "supervised-production\.json"\)/
);
assert.match(supervisedTerminalBridgeSource, /O_NOFOLLOW/);
assert.match(supervisedTerminalBridgeSource, /fs\.fstatSync\(descriptor\)/);
assert.doesNotMatch(
  supervisedTerminalBridgeSource,
  /output\.write\((?:buffer|chunk|.*subarray)/
);
assert.match(supervisedTerminalBridgeSource, /2FA 自动取码处理中/);
for (const token of [
  'const twoFaPrefix = "[2FA] status:"',
  'status === "permission_preflight_missing"',
  'productionStage = "two_fa_code_acquired"',
  'productionStage = "two_fa_code_unavailable"',
  "TWO_FA_LOGIN_FAILED",
  "TWO_FA_CODE_UNAVAILABLE",
  "TWO_FA_PAGE_FAILED",
  "ACCESSIBILITY_PERMISSION_REQUIRED",
]) {
  assert.ok(
    supervisedTerminalBridgeSource.includes(token),
    `strict supervised protocol must retain ${token}`
  );
}
assert.match(
  supervisedTerminalBridgeSource,
  /APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE/
);
assert.match(supervisedTerminalBridgeSource, /cleanupRecordedRuyiPageProcess/);
assert.match(
  supervisedTerminalBridgeSource,
  /fixedProcessIdentity[\s\S]*"-ww", "-p", String\(pid\), "-o", "command="/
);
assert.match(
  supervisedTerminalBridgeSource,
  /if \(cancellationRequested \|\| cancellationIsPresent\(context\)\)[\s\S]*if \(now\(\) >= context\.deadlineMs\)[\s\S]*const finalHead = git/
);
assert.match(supervisedRemoteScript, /PROCESS_CLEANUP_FAILED/);
assert.match(
  supervisedRemoteScript,
  /plutil -extract failureClass raw[\s\S]*lifecycle_failure_class" != "PROCESS_CLEANUP_FAILED"[\s\S]*cleanup_failed=1/
);
assert.match(supervisedRemoteScript, /LOCK_CLEANUP_STATE=not_started/);
assert.match(
  supervisedRemoteScript,
  /SUPERVISED_CLEANUP_STATE" == "in_progress" \|\| "\$LOCK_CLEANUP_STATE" == "in_progress"/
);
assert.doesNotMatch(supervisedRemoteScript, /acquire_gate \|\| return 0/);
assert.match(
  supervisedRemoteScript,
  /lifecycle_status" == \(running\|accepted\)[\s\S]*cleanup_failed=1/
);
assert.match(
  supervisedRemoteScript,
  /ruyi_state_file[\s\S]*elif \[\[ "\$lifecycle_status" == \(running\|accepted\) \|\| "\$ruyi_lifecycle_state" == \(preparing\|active\|cleanup_failed\) \]\][\s\S]*cleanup_failed=1/,
  "an unfinished broker lifecycle without process identity must fail closed"
);
assert.match(
  supervisedRemoteScript,
  /SUPERVISED_CLEANUP_RESULT="\$cleanup_failed"[\s\S]*SUPERVISED_CLEANUP_STATE=complete/
);
assert.match(
  supervisedRemoteScript,
  /production\/reports\/\.ruyipage-process\.json[\s\S]*apple_account_flow\.py/
);
assert.ok(
  (supervisedRemoteScript.match(/\/bin\/ps -ww -p/g) ?? []).length >= 6,
  "supervised cleanup must revalidate untruncated commands before escalation"
);
assert.match(
  supervisedRemoteScript,
  /supervised-process-state-verifier\.mjs" ruyipage/
);
assert.match(
  supervisedRemoteScript,
  /supervised-process-state-verifier\.mjs" ruyipage-lifecycle[\s\S]*ruyi_lifecycle_state" != \(preparing\|active\|inactive\|cleanup_failed\)[\s\S]*ruyi_cleanup_identity_ok=0/
);
assert.match(
  supervisedRemoteScript,
  /browser_broker_socket="\/tmp\/apple-automation-\$SUPERVISED_TOKEN\.sock" browser_broker_gate="\$control_dir\/production\/browser-broker\/broker\.ready"[\s\S]*if \(\( ruyi_cleanup_identity_ok == 1 \)\); then[\s\S]*! -e "\$browser_broker_socket"[\s\S]*cleanup_failed=1[\s\S]*! -e "\$browser_broker_gate"[\s\S]*cleanup_failed=1/,
  "outer cleanup must fail closed when broker transport artifacts remain"
);
assert.doesNotMatch(
  supervisedRemoteScript,
  /commands\.fifo|events\.fifo|broker_fifo/,
  "outer cleanup must not retain FIFO cleanup paths"
);
assert.doesNotMatch(supervisedRemoteScript, /-z "\$(?:\/bin\/)?ps .*command=/);
assert.match(supervisedRemoteScript, /MODEL_TMP_OK=1/);
assert.ok(
  supervisedRemoteScript.indexOf("SUPERVISED_DEADLINE_EPOCH_MS=") <
    supervisedRemoteScript.indexOf('acquire_gate || exit 22'),
  "the supervised deadline must include lock acquisition, sync, and setup"
);
const exitTrapIndex = supervisedRemoteScript.indexOf("trap cleanup_all EXIT");
assert.ok(exitTrapIndex >= 0);
for (const lockOperation of [
  '/bin/mkdir -p "$READERS_DIR"',
  'acquire_gate || exit 22',
  '/bin/mkdir "$WRITER_LOCK"',
  '/usr/bin/touch "$RUN_READER"',
]) {
  assert.ok(
    exitTrapIndex < supervisedRemoteScript.indexOf(lockOperation),
    `cleanup traps must be installed before ${lockOperation}`
  );
}
assert.match(
  supervisedRemoteScript,
  /GATE_TRANSITION_IN_PROGRESS=1[\s\S]*\/bin\/mkdir "\$GATE_LOCK"[\s\S]*GATE_HELD=1[\s\S]*GATE_TRANSITION_IN_PROGRESS=0/
);
assert.match(
  supervisedRemoteScript,
  /LOCK_ENTRY_TRANSITION_IN_PROGRESS=1[\s\S]*\/bin\/mkdir "\$WRITER_LOCK"[\s\S]*LOCK_ACQUIRED=1[\s\S]*LOCK_ENTRY_TRANSITION_IN_PROGRESS=0/
);
assert.match(macCodexSource, /SUPERVISED_OUTER_CLEANUP_RESERVE_MS/);
await runSupervisorGateTests();
await runCleanupSignalDeferralTest(supervisedRemoteScript);
await runLockCleanupSignalDeferralTest(supervisedRemoteScript);
await runLockCleanupFailureRetentionTest(supervisedRemoteScript);
await runLockAcquisitionSignalTest(supervisedRemoteScript);
await runPreStateCleanupFailureRetentionTest(supervisedRemoteScript);

const ruyiPageRunnerSource = fs.readFileSync(
  new URL("./lib/ruyipage-backend-runner.js", import.meta.url),
  "utf8"
);
const ruyiPageSupervisorScript = buildRuyiPageProcessSupervisorScript();
assert.match(
  ruyiPageRunnerSource,
  /buildRuyiPageProcessSupervisorScript[\s\S]*"parent_pgid=\$2"[\s\S]*"parent_started_at=\$3"[\s\S]*"parent_command=\$4"[\s\S]*"launch_nonce=\$5"[\s\S]*"deadline_ms=\$6"[\s\S]*"launch_gate=\$7"[\s\S]*"launch_cancel=\$8"[\s\S]*monitor_runtime[\s\S]*cleanup_group_members[\s\S]*\.join\("\\n"\)/
);
assert.match(
  ruyiPageRunnerSource,
  /writeRuyiPageLifecycleState\(lifecycleStatePath, "preparing", processNonce\)[\s\S]*const child = usesBrowserBroker[\s\S]*createBrowserBrokerChild[\s\S]*:\s*spawn\(/
);
assert.match(
  ruyiPageRunnerSource,
  /writeRuyiPageLifecycleState\(lifecycleStatePath, "active", processNonce\)/
);
assert.match(
  ruyiPageRunnerSource,
  /cleanupConfirmed \? "inactive" : "cleanup_failed"/
);
assert.deepEqual(
  validateRuyiPageLifecycleState(
    JSON.stringify({ version: 1, nonce: SUPERVISED_TOKEN, state: "inactive" }),
    SUPERVISED_TOKEN
  ),
  { version: 1, nonce: SUPERVISED_TOKEN, state: "inactive" }
);
assert.equal(
  validateRuyiPageLifecycleState(
    JSON.stringify({ version: 1, nonce: SUPERVISED_TOKEN, state: "unknown" }),
    SUPERVISED_TOKEN
  ),
  null
);
assert.match(
  supervisedTerminalBridgeSource,
  /path\.dirname\(filePath\),[\s\S]*RUYIPAGE_LIFECYCLE_STATE_NAME[\s\S]*validateRuyiPageLifecycleState/
);
assert.match(
  ruyiPageRunnerSource,
  /usesProcessStateSupervisor[\s\S]*buildRuyiPageProcessSupervisorScript\(\)/
);
assert.match(
  ruyiPageRunnerSource,
  /usesProcessStateSupervisor[\s\S]*APPLE_AUTOMATION_SUPERVISED_GUI !== "1"/
);
assert.match(
  ruyiPageRunnerSource,
  /usesOuterProcessSupervisor[\s\S]*APPLE_AUTOMATION_SUPERVISED_GUI === "1"/
);
assert.match(
  ruyiPageRunnerSource,
  /detached: process\.platform !== "win32" && !usesOuterProcessSupervisor/
);
assert.match(
  ruyiPageRunnerSource,
  /useProcessGroup: !usesBrowserBroker && !usesOuterProcessSupervisor/
);
assert.match(
  ruyiPageRunnerSource,
  /if \(usesOuterProcessSupervisor\) \{[\s\S]*try \{[\s\S]*"active"[\s\S]*catch \{[\s\S]*stopper\.stop\(\)[\s\S]*await stopper\.waitForCleanup\(\)[\s\S]*"inactive"/
);
assert.match(ruyiPageRunnerSource, /"active"[\s\S]*"inactive"[\s\S]*"cleanup_failed"/);
assert.match(
  ruyiPageRunnerSource,
  /"parent_pid=\$1"[\s\S]*"parent_pgid=\$2"[\s\S]*"parent_started_at=\$3"[\s\S]*"parent_command=\$4"[\s\S]*"launch_nonce=\$5"/
);
assert.match(ruyiPageRunnerSource, /parent_is_current/);
assert.match(
  ruyiPageRunnerSource,
  /writeRuyiPageProcessState\([\s\S]*processStatePath,[\s\S]*processIdentity,[\s\S]*"starting",[\s\S]*processNonce/
);
assert.match(ruyiPageRunnerSource, /pgid[\s\S]*startedAt[\s\S]*commandSha256/);
assert.match(
  ruyiPageSupervisorScript,
  /if launch_is_allowed; then[\s\S]*continue[\s\S]*else[\s\S]*monitor_status=\$\?/
);
assert.match(
  ruyiPageSupervisorScript,
  /group_snapshot=\$\(\/usr\/bin\/mktemp[\s\S]*snapshot_helper_pid=\$![\s\S]*"\$member_pid" == "\$snapshot_helper_pid"/
);
assert.doesNotMatch(ruyiPageSupervisorScript, /group_member_pids|\/usr\/bin\/awk/);
assert.match(
  ruyiPageSupervisorScript,
  /target_identity_is_current[\s\S]*current_backend_started_at[\s\S]*current_backend_command[\s\S]*\/bin\/kill -TERM[\s\S]*target_identity_is_current[\s\S]*\/bin\/kill -KILL/
);
assert.match(
  supervisedTerminalBridgeSource,
  /"starting", "active", "inactive", "cleanup_failed"/
);
assert.match(supervisedRemoteScript, /ruyi_state=""/);
assert.match(
  supervisedRemoteScript,
  /ruyi_state_fields[\s\S]*supervised-process-state-verifier\.mjs" ruyipage "\$ruyi_state_file" "\$SUPERVISED_TOKEN"[\s\S]*ruyi_state="\$\{ruyi_state_fields\[4\]\}"[\s\S]*ruyi_command_sha256="\$\{ruyi_state_fields\[5\]\}"/
);
assert.match(
  supervisedRemoteScript,
  /current_ruyi_pgid[\s\S]*current_ruyi_started_at[\s\S]*current_ruyi_command_sha256[\s\S]*"\$SUPERVISED_TOKEN"[\s\S]*apple_account_flow\.py/
);
assert.match(
  supervisedTerminalBridgeSource,
  /path\.join\(context\.controlDir, "supervised-production\.json"\)/
);
assert.doesNotMatch(
  supervisedTerminalBridgeSource,
  /supervised-terminal\.(?:status|trigger|cancel|exit|log)/
);

const multilineTask = "第一行\r\n第二行 '$(touch nope)' & 结束";
const multilineScript = buildRemoteScript({ ...remoteOptions, task: multilineTask });
const multilineBase64 = multilineScript.match(/PROMPT_B64='([A-Za-z0-9+/=]+)'/)?.[1];
assert.ok(multilineBase64);
assert.equal(
  Buffer.from(multilineBase64, "base64").toString("utf8"),
  buildAgentPrompt({ task: multilineTask })
);

const noSyncScript = buildRemoteScript({ ...remoteOptions, sync: false });
assert.doesNotMatch(noSyncScript, /git fetch origin|git switch|git merge/);
assert.match(noSyncScript, /git rev-parse HEAD/);
assert.match(noSyncScript, /LOCK_MODE='reader'/);
assert.throws(
  () =>
    buildRemoteScript({
      ...remoteOptions,
      sync: false,
      supervisedGui: true,
    }),
  /synchronized exclusive run/i
);

assert.deepEqual(buildSshArgs({ sshAlias: "mac-codex" }), [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "mac-codex",
  "/bin/zsh",
  "-s",
]);
const scpArgs = buildScpArgs({
  sshAlias: "mac-codex",
  remoteRoundDir: remoteOptions.remoteRoundDir,
  roundDir: "C:\\runs\\round-02",
});
const requiredArtifacts = [
  "events.jsonl",
  "stderr.log",
  "final.json",
  "git-before.txt",
  "git-after.txt",
  "head-before.txt",
  "head-after.txt",
  "codex-exit.txt",
  "supervised-acceptance.txt",
  "supervised-attestation.json",
];
assert.deepEqual(scpArgs.slice(0, 4), [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
]);
assert.deepEqual(
  scpArgs.slice(4, -1),
  requiredArtifacts.map(
    (artifact) => `mac-codex:${remoteOptions.remoteRoundDir}/${artifact}`
  )
);
assert.equal(scpArgs.at(-1), "C:\\runs\\round-02");
assert.doesNotMatch(scpArgs.join("\n"), /(?:^|\n)-r(?:\n|$)|\/\.?(?:\n|$)|\/tmp(?:\/|\n|$)/);

const schema = JSON.parse(
  fs.readFileSync(new URL("./mac-codex-report.schema.json", import.meta.url), "utf8")
);
assert.equal(schema.type, "object");
assert.equal(schema.additionalProperties, false);
assert.deepEqual(
  new Set(schema.required),
  new Set([
    "taskUnderstanding",
    "environmentObservations",
    "commands",
    "tests",
    "findings",
    "recommendedWindowsActions",
    "executionMode",
    "supervisedGuiStatus",
    "status",
  ])
);
for (const property of ["commands", "tests", "findings"]) {
  assert.equal(schema.properties[property].items.additionalProperties, false);
}
assert.deepEqual(schema.properties.status.enum, ["passed", "failed"]);
assert.deepEqual(schema.properties.executionMode.enum, ["noninteractive", "supervised_gui"]);
assert.deepEqual(schema.properties.supervisedGuiStatus.enum, [
  "not_requested",
  "passed",
  "failed",
  "skipped",
]);

function validReport(status = "passed", options = {}) {
  const executionMode = options.executionMode ?? "noninteractive";
  return {
    taskUnderstanding: "检查相关 macOS 合同并运行非交互测试",
    environmentObservations: ["macOS Intel x86_64", "Node.js 22.14.0"],
    commands: [
      {
        purpose: "运行目标测试",
        command: "npm run test:python-bootstrap",
        exitCode: 0,
        summary: "测试通过",
      },
    ],
    tests: [
      {
        name: "python bootstrap contract",
        command: "npm run test:python-bootstrap",
        status: "passed",
        exitCode: 0,
        summary: "ok",
      },
    ],
    findings: [],
    recommendedWindowsActions: [],
    executionMode,
    supervisedGuiStatus:
      options.supervisedGuiStatus ??
      (executionMode === "supervised_gui" ? "passed" : "not_requested"),
    status,
  };
}

function supervisedAcceptanceEventStream(overrides = {}) {
  const item = {
    id: "item-acceptance",
    type: "command_execution",
    command: SUPERVISED_HELPER_COMMAND,
    aggregated_output: `${SUPERVISED_SUCCESS_MARKER}\n`,
    exit_code: 0,
    status: "completed",
    ...overrides.item,
  };
  return [
    { type: "thread.started" },
    { type: overrides.eventType ?? "item.completed", item },
    { type: "turn.completed" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";
}

const supervisedAcceptanceEvents = supervisedAcceptanceEventStream();
assert.equal(hasSupervisedAcceptanceEvent(supervisedAcceptanceEvents), true);
assert.equal(
  hasSupervisedAcceptanceEvent(
    supervisedAcceptanceEvents.replace(
      SUPERVISED_HELPER_COMMAND,
      `/bin/zsh -lc '${SUPERVISED_HELPER_COMMAND}'`
    )
  ),
  true
);
const extraCommandEvent = `${JSON.stringify({
  type: "item.completed",
  item: {
    id: "item-extra",
    type: "command_execution",
    command: "/bin/zsh -lc 'pwd'",
    aggregated_output: "",
    exit_code: 0,
    status: "completed",
  },
})}\n`;
assert.equal(
  hasSupervisedAcceptanceEvent(`${supervisedAcceptanceEvents}${extraCommandEvent}`),
  false
);
assert.equal(
  hasSupervisedAcceptanceEvent(
    `${supervisedAcceptanceEvents}${JSON.stringify({
      type: "item.completed",
      item: { id: "item-tool", type: "mcp_tool_call", status: "completed" },
    })}\n`
  ),
  false
);

for (const command of [
  `echo ${SUPERVISED_HELPER_COMMAND}`,
  `${SUPERVISED_HELPER_COMMAND} # claimed success`,
  `${SUPERVISED_HELPER_COMMAND} -- ./run.sh --skip-mac`,
  `${SUPERVISED_HELPER_COMMAND} --unexpected`,
  `/bin/zsh -lc '${SUPERVISED_HELPER_COMMAND}; echo marker'`,
]) {
  assert.equal(
    hasSupervisedAcceptanceEvent(
      supervisedAcceptanceEventStream({ item: { command } })
    ),
    false,
    `acceptance events must reject non-exact helper command: ${command}`
  );
}
for (const aggregatedOutput of [
  "REAL_ACCOUNT_HOME_CONFIRMED\n",
  `fake ${SUPERVISED_SUCCESS_MARKER}\n`,
  `${SUPERVISED_SUCCESS_MARKER} forged\n`,
  `before\n${SUPERVISED_SUCCESS_MARKER}\nafter\n`,
  `[验收] ACCOUNT_FLOW_FAILED\n`,
]) {
  assert.equal(
    hasSupervisedAcceptanceEvent(
      supervisedAcceptanceEventStream({ item: { aggregated_output: aggregatedOutput } })
    ),
    false,
    `acceptance events must reject forged marker output: ${aggregatedOutput.trim()}`
  );
}
for (const overrides of [
  { eventType: "item.started" },
  { item: { type: "reasoning" } },
  { item: { status: "failed" } },
  { item: { exit_code: 1 } },
]) {
  assert.equal(
    hasSupervisedAcceptanceEvent(supervisedAcceptanceEventStream(overrides)),
    false
  );
}

assert.deepEqual(validateFinalReport(validReport()), []);
assert.deepEqual(
  validateFinalReport(validReport("passed", { executionMode: "supervised_gui" })),
  []
);
const skippedSupervisedReport = validReport("passed", {
  executionMode: "supervised_gui",
  supervisedGuiStatus: "skipped",
});
assert.ok(
  validateFinalReport(skippedSupervisedReport).some((error) =>
    /without supervised GUI acceptance/i.test(error)
  )
);
const criticalPassedReport = validReport();
criticalPassedReport.findings.push({
  severity: "critical",
  title: "critical review finding",
  details: "must fail the report",
});
assert.ok(
  validateFinalReport(criticalPassedReport).some((error) => /critical|important/i.test(error))
);
const failedTestPassedReport = validReport();
failedTestPassedReport.tests[0].status = "failed";
failedTestPassedReport.tests[0].exitCode = 1;
assert.ok(
  validateFinalReport(failedTestPassedReport).some((error) => /failed test/i.test(error))
);

function nonSupervisedAttestation(overrides = {}) {
  return {
    ...createSupervisedAttestation({
      expectedHead: EXPECTED_HEAD,
      observedHeadBefore: EXPECTED_HEAD,
      observedHeadAfter: EXPECTED_HEAD,
      status: "not_requested",
    }),
    ...overrides,
  };
}

function acceptedSupervisedAttestation(overrides = {}) {
  return {
    ...createSupervisedAttestation({
      nonce: SUPERVISED_TOKEN,
      expectedHead: EXPECTED_HEAD,
      observedHeadBefore: EXPECTED_HEAD,
      observedHeadAfter: EXPECTED_HEAD,
      status: "accepted",
      exitCode: 0,
      markerConfirmed: true,
      failureClass: "NONE",
    }),
    ...overrides,
  };
}

function attestationArtifact(value) {
  return `${JSON.stringify(value)}\n`;
}

const acceptedAttestation = acceptedSupervisedAttestation();
assert.equal(acceptedAttestation.commandId, SUPERVISED_COMMAND_ID);
assert.equal(acceptedAttestation.commandSha256, SUPERVISED_COMMAND_SHA256);
assert.equal(acceptedAttestation.ttyCapability, "unknown");
assert.equal(acceptedAttestation.twoFaDetail, "none");
assert.equal(acceptedAttestation.productionStage, "not_started");
assert.equal(acceptedAttestation.nodeFailure, "none");
assert.match(SUPERVISED_COMMAND_SHA256, /^[0-9a-f]{64}$/);
assert.deepEqual(
  parseSupervisedAttestation(attestationArtifact(acceptedAttestation), {
    nonce: SUPERVISED_TOKEN,
    expectedHead: EXPECTED_HEAD,
  }).errors,
  []
);

const detailedTwoFaAttestation = createSupervisedAttestation({
  nonce: SUPERVISED_TOKEN,
  expectedHead: EXPECTED_HEAD,
  observedHeadBefore: EXPECTED_HEAD,
  observedHeadAfter: EXPECTED_HEAD,
  status: "failed",
  exitCode: 1,
  failureClass: "TWO_FA_CODE_UNAVAILABLE",
  ttyCapability: "unavailable",
  twoFaDetail: "manual_tty_unavailable",
});
assert.deepEqual(
  parseSupervisedAttestation(attestationArtifact(detailedTwoFaAttestation), {
    nonce: SUPERVISED_TOKEN,
    expectedHead: EXPECTED_HEAD,
  }).errors,
  []
);
const legacyFailedAttestation = { ...detailedTwoFaAttestation };
delete legacyFailedAttestation.ttyCapability;
delete legacyFailedAttestation.twoFaDetail;
delete legacyFailedAttestation.productionStage;
delete legacyFailedAttestation.nodeFailure;
assert.deepEqual(
  parseSupervisedAttestation(attestationArtifact(legacyFailedAttestation), {
    nonce: SUPERVISED_TOKEN,
    expectedHead: EXPECTED_HEAD,
  }).errors,
  [],
  "legacy failed attestations without TTY/detail fields must remain valid"
);
const invalidTwoFaDetailAttestation = {
  ...detailedTwoFaAttestation,
  twoFaDetail: "untrusted-detail",
};
assert.ok(
  parseSupervisedAttestation(
    attestationArtifact(invalidTwoFaDetailAttestation),
    { nonce: SUPERVISED_TOKEN, expectedHead: EXPECTED_HEAD }
  ).errors.some((error) => /2FA detail is invalid/i.test(error))
);
const inconsistentTwoFaDetailAttestation = {
  ...detailedTwoFaAttestation,
  failureClass: "PRODUCTION_EXIT_NONZERO",
};
assert.ok(
  parseSupervisedAttestation(
    attestationArtifact(inconsistentTwoFaDetailAttestation),
    { nonce: SUPERVISED_TOKEN, expectedHead: EXPECTED_HEAD }
  ).errors.some((error) => /2FA detail is inconsistent/i.test(error))
);
const invalidTtyCapabilityAttestation = {
  ...detailedTwoFaAttestation,
  ttyCapability: "untrusted-capability",
};
assert.ok(
  parseSupervisedAttestation(
    attestationArtifact(invalidTtyCapabilityAttestation),
    { nonce: SUPERVISED_TOKEN, expectedHead: EXPECTED_HEAD }
  ).errors.some((error) => /TTY capability is invalid/i.test(error))
);
const invalidProductionStageAttestation = {
  ...detailedTwoFaAttestation,
  productionStage: "untrusted-stage",
};
assert.ok(
  parseSupervisedAttestation(
    attestationArtifact(invalidProductionStageAttestation),
    { nonce: SUPERVISED_TOKEN, expectedHead: EXPECTED_HEAD }
  ).errors.some((error) => /production stage is invalid/i.test(error))
);
const invalidNodeFailureAttestation = {
  ...detailedTwoFaAttestation,
  nodeFailure: "untrusted-node-failure",
};
assert.ok(
  parseSupervisedAttestation(
    attestationArtifact(invalidNodeFailureAttestation),
    { nonce: SUPERVISED_TOKEN, expectedHead: EXPECTED_HEAD }
  ).errors.some((error) => /node failure is invalid/i.test(error))
);

function writeArtifacts(roundDir, overrides = {}) {
  fs.mkdirSync(roundDir, { recursive: true });
  const artifacts = {
    "events.jsonl":
      '{"type":"thread.started"}\n{"type":"item.completed"}\n{"type":"turn.completed"}\n',
    "stderr.log": "",
    "final.json": `${JSON.stringify(validReport())}\n`,
    "git-before.txt": "",
    "git-after.txt": "",
    "head-before.txt": `${EXPECTED_HEAD}\n`,
    "head-after.txt": `${EXPECTED_HEAD}\n`,
    "codex-exit.txt": "0\n",
    "supervised-acceptance.txt": "not_requested\n",
    "supervised-attestation.json": attestationArtifact(nonSupervisedAttestation()),
    ...overrides,
  };
  for (const [name, content] of Object.entries(artifacts)) {
    if (content !== null) fs.writeFileSync(path.join(roundDir, name), content, "utf8");
  }
}

const processResults = {
  ssh: { exitCode: 0, timedOut: false },
  scp: { exitCode: 0, timedOut: false },
};
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-codex-summary-"));
try {
  const passedDir = path.join(artifactRoot, "passed");
  writeArtifacts(passedDir);
  const passed = summarizeRun(passedDir, processResults, EXPECTED_HEAD);
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.errors, []);
  assert.deepEqual(passed.events, {
    total: 3,
    valid: 3,
    invalid: 0,
    byType: { "thread.started": 1, "item.completed": 1, "turn.completed": 1 },
  });
  assert.equal(passed.git.changed, false);
  assert.equal(passed.codex.exitCode, 0);
  assert.equal(passed.expectedExecutionMode, "noninteractive");
  assert.deepEqual(passed.report, validReport());
  assert.equal(passed.artifacts.finalReport, path.join(passedDir, "final.json"));

  const supervisedDir = path.join(artifactRoot, "supervised-passed");
  writeArtifacts(supervisedDir, {
    "events.jsonl": supervisedAcceptanceEvents,
    "supervised-acceptance.txt": "accepted\n",
    "supervised-attestation.json": attestationArtifact(acceptedAttestation),
    "final.json": `${JSON.stringify(
      validReport("passed", { executionMode: "supervised_gui" })
    )}\n`,
  });
  const supervised = summarizeRun(
    supervisedDir,
    processResults,
    EXPECTED_HEAD,
    "supervised_gui",
    SUPERVISED_TOKEN
  );
  assert.equal(supervised.status, "passed");
  assert.deepEqual(supervised.errors, []);
  assert.equal(supervised.expectedExecutionMode, "supervised_gui");
  assert.equal(supervised.supervisedAcceptance, "accepted");
  assert.deepEqual(supervised.supervisedAttestation, acceptedAttestation);

  const invalidAttestationCases = [
    {
      name: "nonce",
      overrides: { nonce: OTHER_SUPERVISED_TOKEN },
      message: /nonce does not match/i,
    },
    {
      name: "expected-head",
      overrides: {
        expectedHead: OTHER_HEAD,
        observedHeadBefore: OTHER_HEAD,
        observedHeadAfter: OTHER_HEAD,
      },
      message: /expected head does not match/i,
    },
    {
      name: "observed-head-before",
      overrides: { observedHeadBefore: OTHER_HEAD },
      message: /evidence is inconsistent/i,
    },
    {
      name: "observed-head-after",
      overrides: { observedHeadAfter: OTHER_HEAD },
      message: /evidence is inconsistent/i,
    },
    {
      name: "command-id",
      overrides: { commandId: "not-the-fixed-command" },
      message: /command id is invalid/i,
    },
    {
      name: "command-hash",
      overrides: { commandSha256: "0".repeat(64) },
      message: /command digest is invalid/i,
    },
    {
      name: "exit-code",
      overrides: { exitCode: 17 },
      message: /evidence is inconsistent/i,
    },
    {
      name: "marker",
      overrides: { markerConfirmed: false },
      message: /evidence is inconsistent/i,
    },
    {
      name: "failure-class",
      overrides: { failureClass: "PRODUCTION_EXIT_NONZERO" },
      message: /evidence is inconsistent/i,
    },
    {
      name: "extra-key",
      overrides: { extraEvidence: "must-not-be-trusted" },
      message: /keys are invalid/i,
    },
  ];
  for (const { name, overrides, message } of invalidAttestationCases) {
    const invalidDir = path.join(artifactRoot, `supervised-invalid-${name}`);
    writeArtifacts(invalidDir, {
      "events.jsonl": supervisedAcceptanceEvents,
      "supervised-acceptance.txt": "accepted\n",
      "supervised-attestation.json": attestationArtifact(
        acceptedSupervisedAttestation(overrides)
      ),
      "final.json": `${JSON.stringify(
        validReport("passed", { executionMode: "supervised_gui" })
      )}\n`,
    });
    const invalidSummary = summarizeRun(
      invalidDir,
      processResults,
      EXPECTED_HEAD,
      "supervised_gui",
      SUPERVISED_TOKEN
    );
    assert.equal(invalidSummary.status, "failed", name);
    const invalidError = invalidSummary.errors.find(
      (error) => error.code === "invalid_supervised_attestation"
    );
    assert.ok(invalidError, name);
    assert.match(invalidError.message, message, name);
  }

  const missingSupervisedToken = summarizeRun(
    supervisedDir,
    processResults,
    EXPECTED_HEAD,
    "supervised_gui"
  );
  assert.equal(missingSupervisedToken.status, "failed");
  assert.ok(
    missingSupervisedToken.errors.some(
      (error) => error.code === "invalid_supervised_token"
    )
  );

  const wrongSupervisedToken = summarizeRun(
    supervisedDir,
    processResults,
    EXPECTED_HEAD,
    "supervised_gui",
    OTHER_SUPERVISED_TOKEN
  );
  assert.equal(wrongSupervisedToken.status, "failed");
  assert.ok(
    wrongSupervisedToken.errors.some(
      (error) => error.code === "invalid_supervised_attestation"
    )
  );

  const missingAcceptanceDir = path.join(artifactRoot, "supervised-missing-acceptance");
  writeArtifacts(missingAcceptanceDir, {
    "supervised-acceptance.txt": "missing\n",
    "supervised-attestation.json": attestationArtifact(acceptedAttestation),
    "final.json": `${JSON.stringify(
      validReport("passed", { executionMode: "supervised_gui" })
    )}\n`,
  });
  const missingAcceptance = summarizeRun(
    missingAcceptanceDir,
    processResults,
    EXPECTED_HEAD,
    "supervised_gui",
    SUPERVISED_TOKEN
  );
  assert.equal(missingAcceptance.status, "failed");
  assert.ok(
    missingAcceptance.errors.some((error) => error.code === "supervised_acceptance_missing")
  );

  const modeMismatch = summarizeRun(
    supervisedDir,
    processResults,
    EXPECTED_HEAD,
    "noninteractive"
  );
  assert.equal(modeMismatch.status, "failed");
  assert.ok(modeMismatch.errors.some((error) => error.code === "execution_mode_mismatch"));

  const changedDir = path.join(artifactRoot, "changed");
  writeArtifacts(changedDir, { "git-after.txt": " M scripts/file.mjs\n" });
  const changed = summarizeRun(changedDir, processResults, EXPECTED_HEAD);
  assert.equal(changed.status, "failed");
  assert.equal(changed.git.changed, true);
  assert.ok(changed.errors.some((error) => error.code === "git_changed"));

  const dirtyBothDir = path.join(artifactRoot, "dirty-both");
  writeArtifacts(dirtyBothDir, {
    "git-before.txt": " M scripts/file.mjs\n",
    "git-after.txt": " M scripts/file.mjs\n",
  });
  const dirtyBoth = summarizeRun(dirtyBothDir, processResults, EXPECTED_HEAD);
  assert.equal(dirtyBoth.status, "failed");
  assert.equal(dirtyBoth.git.changed, false);
  assert.ok(dirtyBoth.errors.some((error) => error.code === "git_dirty"));

  const wrongHeadDir = path.join(artifactRoot, "wrong-head");
  writeArtifacts(wrongHeadDir, {
    "head-before.txt": `${OTHER_HEAD}\n`,
    "head-after.txt": `${OTHER_HEAD}\n`,
  });
  const wrongHeadSummary = summarizeRun(wrongHeadDir, processResults, EXPECTED_HEAD);
  assert.equal(wrongHeadSummary.status, "failed");
  assert.equal(wrongHeadSummary.git.changed, false);
  assert.ok(wrongHeadSummary.errors.some((error) => error.code === "head_mismatch"));

  const missingExpectedHead = summarizeRun(passedDir, processResults);
  assert.equal(missingExpectedHead.status, "failed");
  assert.ok(
    missingExpectedHead.errors.some((error) => error.code === "invalid_expected_head")
  );

  const invalidExpectedHead = summarizeRun(passedDir, processResults, "not-a-git-head");
  assert.equal(invalidExpectedHead.status, "failed");
  assert.ok(
    invalidExpectedHead.errors.some((error) => error.code === "invalid_expected_head")
  );

  const codexFailedDir = path.join(artifactRoot, "codex-failed");
  writeArtifacts(codexFailedDir, { "codex-exit.txt": "17\n" });
  const codexFailed = summarizeRun(codexFailedDir, processResults, EXPECTED_HEAD);
  assert.equal(codexFailed.status, "failed");
  assert.ok(codexFailed.errors.some((error) => error.code === "codex_failed"));

  const missingDir = path.join(artifactRoot, "missing");
  writeArtifacts(missingDir, { "final.json": null });
  const missing = summarizeRun(missingDir, processResults, EXPECTED_HEAD);
  assert.equal(missing.status, "failed");
  assert.ok(missing.errors.some((error) => error.code === "missing_artifact"));

  const failedReportDir = path.join(artifactRoot, "failed-report");
  writeArtifacts(failedReportDir, {
    "final.json": `${JSON.stringify(validReport("failed"))}\n`,
  });
  const failedReport = summarizeRun(failedReportDir, processResults, EXPECTED_HEAD);
  assert.equal(failedReport.status, "failed");
  assert.ok(failedReport.errors.some((error) => error.code === "report_failed"));

  const invalidReportDir = path.join(artifactRoot, "invalid-report");
  writeArtifacts(invalidReportDir, {
    "final.json": '{"status":"passed"}\n',
  });
  const invalidReport = summarizeRun(invalidReportDir, processResults, EXPECTED_HEAD);
  assert.equal(invalidReport.status, "failed");
  assert.ok(
    invalidReport.errors.some((error) => error.code === "invalid_final_report")
  );

  const emptyEventsDir = path.join(artifactRoot, "empty-events");
  writeArtifacts(emptyEventsDir, { "events.jsonl": "" });
  const emptyEvents = summarizeRun(emptyEventsDir, processResults, EXPECTED_HEAD);
  assert.equal(emptyEvents.status, "failed");
  assert.ok(emptyEvents.errors.some((error) => error.code === "missing_events"));

  const primitiveEventsDir = path.join(artifactRoot, "primitive-events");
  writeArtifacts(primitiveEventsDir, { "events.jsonl": "42\n" });
  const primitiveEvents = summarizeRun(primitiveEventsDir, processResults, EXPECTED_HEAD);
  assert.equal(primitiveEvents.status, "failed");
  assert.ok(primitiveEvents.errors.some((error) => error.code === "invalid_events"));

  const processFailedDir = path.join(artifactRoot, "process-failed");
  writeArtifacts(processFailedDir);
  const processFailed = summarizeRun(
    processFailedDir,
    {
      ssh: { exitCode: 255, timedOut: false },
      scp: { exitCode: 1, timedOut: true },
    },
    EXPECTED_HEAD
  );
  assert.equal(processFailed.status, "failed");
  assert.ok(processFailed.errors.some((error) => error.code === "ssh_failed"));
  assert.ok(processFailed.errors.some((error) => error.code === "scp_failed"));
} finally {
  removeTreeOneFileAtATime(artifactRoot);
}

async function runSupervisedHelperHarness({
  args = [],
  attestationFactory = () => acceptedSupervisedAttestation(),
  timeoutMs = 1_000,
  useDefaultTimeout = false,
  outerDeadlineMs = 10_000,
  includeOuterDeadline = true,
} = {}) {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "apple-automation-supervised-helper-")
  );
  const tmpDir = path.join(rootDir, "tmp");
  const controlDir = path.join(rootDir, "control");
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(controlDir);
  const triggerPath = path.join(tmpDir, "supervised-trigger.json");
  const cancelPath = path.join(tmpDir, "supervised-cancel.json");
  const attestationPath = path.join(controlDir, "supervised-attestation.json");
  let time = 0;
  let attestationWritten = false;
  let exitCode = null;
  let error = null;
  const output = [];

  try {
    try {
      const helperOptions = {
        args,
        env: {
          TMPDIR: tmpDir,
          APPLE_AUTOMATION_SUPERVISED_GUI: "1",
          APPLE_AUTOMATION_SUPERVISED_TOKEN: SUPERVISED_TOKEN,
          APPLE_AUTOMATION_EXPECTED_HEAD: EXPECTED_HEAD,
          APPLE_AUTOMATION_SUPERVISED_TRIGGER: triggerPath,
          APPLE_AUTOMATION_SUPERVISED_CANCEL: cancelPath,
          APPLE_AUTOMATION_SUPERVISED_ATTESTATION: attestationPath,
          APPLE_AUTOMATION_RAW_SECRET_CANARY: RAW_SECRET_CANARY,
          ...(includeOuterDeadline
            ? {
                APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS:
                  String(outerDeadlineMs),
              }
            : {}),
        },
        now: () => time,
        stdout: { write: (value) => output.push(String(value)) },
        async sleep(ms) {
          time += ms;
          if (
            !attestationWritten &&
            attestationFactory &&
            fs.existsSync(triggerPath)
          ) {
            const trigger = JSON.parse(fs.readFileSync(triggerPath, "utf8"));
            const attestation = attestationFactory(trigger);
            if (attestation !== null) {
              const source =
                typeof attestation === "string"
                  ? attestation
                  : attestationArtifact(attestation);
              fs.writeFileSync(attestationPath, source, {
                encoding: "utf8",
                mode: 0o600,
              });
            }
            attestationWritten = true;
          }
        },
      };
      if (!useDefaultTimeout) helperOptions.timeoutMs = timeoutMs;
      exitCode = await runSupervisedMacAcceptance(helperOptions);
    } catch (caught) {
      error = caught;
    }

    const triggerStats = fs.existsSync(triggerPath)
      ? fs.lstatSync(triggerPath)
      : null;
    return {
      exitCode,
      error,
      output: output.join(""),
      elapsedMs: time,
      trigger: fs.existsSync(triggerPath)
        ? JSON.parse(fs.readFileSync(triggerPath, "utf8"))
        : null,
      triggerIsRegularFile:
        triggerStats?.isFile() === true && triggerStats?.isSymbolicLink() === false,
      cancel: fs.existsSync(cancelPath)
        ? JSON.parse(fs.readFileSync(cancelPath, "utf8"))
        : null,
      tmpEntries: fs.readdirSync(tmpDir).sort(),
      controlEntries: fs.readdirSync(controlDir).sort(),
    };
  } finally {
    removeTreeOneFileAtATime(rootDir);
  }
}

const expectedTrigger = {
  version: 1,
  nonce: SUPERVISED_TOKEN,
  commandId: SUPERVISED_COMMAND_ID,
};
const expectedCancel = { version: 1, nonce: SUPERVISED_TOKEN };

assert.equal(DEFAULT_RUYIPAGE_BACKEND_TIMEOUT_MS, 720_000);
assert.equal(
  DEFAULT_SUPERVISED_HELPER_WAIT_MS,
  DEFAULT_RUYIPAGE_BACKEND_TIMEOUT_MS + SUPERVISED_HELPER_CLEANUP_MARGIN_MS
);
assert.ok(
  SUPERVISED_HELPER_CLEANUP_MARGIN_MS >= 60_000,
  "the helper must leave bridge and process cleanup margin after the backend budget"
);

const supervisedHelper = await runSupervisedHelperHarness();
assert.equal(supervisedHelper.error, null);
assert.equal(supervisedHelper.exitCode, 0);
assert.equal(supervisedHelper.output, `${SUPERVISED_SUCCESS_MARKER}\n`);
assert.deepEqual(supervisedHelper.trigger, expectedTrigger);
assert.equal(supervisedHelper.triggerIsRegularFile, true);
assert.equal(supervisedHelper.cancel, null);
assert.deepEqual(supervisedHelper.tmpEntries, ["supervised-trigger.json"]);
assert.deepEqual(supervisedHelper.controlEntries, ["supervised-attestation.json"]);

const failedSupervisedHelper = await runSupervisedHelperHarness({
  attestationFactory: () =>
    createSupervisedAttestation({
      nonce: SUPERVISED_TOKEN,
      expectedHead: EXPECTED_HEAD,
      observedHeadBefore: EXPECTED_HEAD,
      observedHeadAfter: EXPECTED_HEAD,
      status: "failed",
      exitCode: 17,
      markerConfirmed: false,
      failureClass: "PRODUCTION_EXIT_NONZERO",
    }),
});
assert.equal(failedSupervisedHelper.error, null);
assert.equal(failedSupervisedHelper.exitCode, 17);
assert.equal(
  failedSupervisedHelper.output,
  "[mac:supervised] PRODUCTION_EXIT_NONZERO\n"
);
assert.deepEqual(failedSupervisedHelper.trigger, expectedTrigger);
assert.equal(failedSupervisedHelper.cancel, null);

const cancelledSupervisedHelper = await runSupervisedHelperHarness({
  attestationFactory: () =>
    createSupervisedAttestation({
      nonce: SUPERVISED_TOKEN,
      expectedHead: EXPECTED_HEAD,
      observedHeadBefore: EXPECTED_HEAD,
      observedHeadAfter: EXPECTED_HEAD,
      status: "cancelled",
      exitCode: 130,
      markerConfirmed: false,
      failureClass: "CANCELLED",
    }),
});
assert.equal(cancelledSupervisedHelper.error, null);
assert.equal(cancelledSupervisedHelper.exitCode, 130);
assert.equal(cancelledSupervisedHelper.output, "[mac:supervised] CANCELLED\n");
assert.deepEqual(cancelledSupervisedHelper.trigger, expectedTrigger);

const timeoutSupervisedHelper = await runSupervisedHelperHarness({
  timeoutMs: 500,
  attestationFactory: null,
});
assert.equal(timeoutSupervisedHelper.exitCode, null);
assert.equal(timeoutSupervisedHelper.error?.exitCode, 124);
assert.match(timeoutSupervisedHelper.error?.message ?? "", /production timed out/i);
assert.equal(timeoutSupervisedHelper.output, "");
assert.deepEqual(timeoutSupervisedHelper.trigger, expectedTrigger);
assert.deepEqual(timeoutSupervisedHelper.cancel, expectedCancel);
assert.deepEqual(timeoutSupervisedHelper.tmpEntries, [
  "supervised-cancel.json",
  "supervised-trigger.json",
]);
assert.equal(timeoutSupervisedHelper.elapsedMs, 500);

const defaultBudgetSupervisedHelper = await runSupervisedHelperHarness({
  useDefaultTimeout: true,
  outerDeadlineMs: DEFAULT_SUPERVISED_HELPER_WAIT_MS + 10_000,
  attestationFactory: null,
});
assert.equal(defaultBudgetSupervisedHelper.error?.exitCode, 124);
assert.equal(
  defaultBudgetSupervisedHelper.elapsedMs,
  DEFAULT_SUPERVISED_HELPER_WAIT_MS
);
assert.deepEqual(defaultBudgetSupervisedHelper.cancel, expectedCancel);

const absoluteDeadlineSupervisedHelper = await runSupervisedHelperHarness({
  timeoutMs: 5_000,
  outerDeadlineMs: 600,
  attestationFactory: null,
});
assert.equal(absoluteDeadlineSupervisedHelper.error?.exitCode, 124);
assert.equal(absoluteDeadlineSupervisedHelper.elapsedMs, 600);
assert.deepEqual(absoluteDeadlineSupervisedHelper.cancel, expectedCancel);

for (const deadlineCase of [
  { name: "missing", includeOuterDeadline: false },
  { name: "invalid", outerDeadlineMs: "invalid" },
  { name: "expired", outerDeadlineMs: 0 },
]) {
  const invalidDeadlineHelper = await runSupervisedHelperHarness({
    timeoutMs: 5_000,
    attestationFactory: null,
    ...deadlineCase,
  });
  assert.equal(invalidDeadlineHelper.exitCode, null, deadlineCase.name);
  assert.equal(invalidDeadlineHelper.error?.exitCode, 77, deadlineCase.name);
  assert.match(
    invalidDeadlineHelper.error?.message ?? "",
    /absolute deadline is unavailable/i,
    deadlineCase.name
  );
  assert.equal(invalidDeadlineHelper.trigger, null, deadlineCase.name);
  assert.equal(invalidDeadlineHelper.cancel, null, deadlineCase.name);
  assert.deepEqual(invalidDeadlineHelper.tmpEntries, [], deadlineCase.name);
}

const secretCanarySupervisedHelper = await runSupervisedHelperHarness({
  attestationFactory: () => ({
    ...acceptedSupervisedAttestation(),
    rawSecretCanary: RAW_SECRET_CANARY,
  }),
});
assert.equal(secretCanarySupervisedHelper.exitCode, null);
assert.equal(secretCanarySupervisedHelper.error?.exitCode, 78);
assert.match(
  secretCanarySupervisedHelper.error?.message ?? "",
  /attestation is invalid/i
);
assert.equal(secretCanarySupervisedHelper.output, "");
assert.deepEqual(secretCanarySupervisedHelper.trigger, expectedTrigger);
assert.equal(secretCanarySupervisedHelper.cancel, null);

const helperWithArguments = await runSupervisedHelperHarness({
  args: ["--", "./run.sh", "--skip-mac"],
  attestationFactory: null,
});
assert.equal(helperWithArguments.exitCode, null);
assert.equal(helperWithArguments.error?.exitCode, 64);
assert.match(helperWithArguments.error?.message ?? "", /takes no arguments/i);
assert.equal(helperWithArguments.trigger, null);
assert.deepEqual(helperWithArguments.tmpEntries, []);

for (const helperResult of [
  supervisedHelper,
  failedSupervisedHelper,
  cancelledSupervisedHelper,
  timeoutSupervisedHelper,
  defaultBudgetSupervisedHelper,
  absoluteDeadlineSupervisedHelper,
  secretCanarySupervisedHelper,
  helperWithArguments,
]) {
  assert.doesNotMatch(helperResult.output, new RegExp(RAW_SECRET_CANARY));
}

const timeoutResult = await runProcess(
  process.execPath,
  ["-e", "setTimeout(() => {}, 10000)"],
  { timeoutMs: 100 }
);
assert.equal(timeoutResult.timedOut, true);

const inheritedPipeStartedAt = Date.now();
const inheritedPipePidPath = path.join(
  os.tmpdir(),
  `mac-codex-inherited-pipe-${process.pid}.pid`
);
assert.equal(fs.existsSync(inheritedPipePidPath), false);
let inheritedPipePid = null;
try {
  const inheritedPipeResult = await runProcess(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(inheritedPipePidPath)},String(child.pid));setTimeout(()=>{},10000);`,
    ],
    { timeoutMs: 500, terminateGraceMs: 50, cleanupDeadlineMs: 100 }
  );
  assert.equal(inheritedPipeResult.timedOut, true);
  assert.ok(
    Date.now() - inheritedPipeStartedAt < 1_000,
    "runProcess must finish after its bounded cleanup deadline even when a descendant holds pipes"
  );
  inheritedPipePid = Number(fs.readFileSync(inheritedPipePidPath, "utf8").trim());
  assert.ok(Number.isInteger(inheritedPipePid) && inheritedPipePid > 0);
} finally {
  if (Number.isInteger(inheritedPipePid) && inheritedPipePid > 0) {
    try {
      process.kill(inheritedPipePid, "SIGKILL");
    } catch {
      /* descendant may already be gone */
    }
  }
  try {
    fs.unlinkSync(inheritedPipePidPath);
  } catch {
    /* a failed launch may not have created the single-use pid file */
  }
}

console.log("mac codex orchestrator contract: ok");
