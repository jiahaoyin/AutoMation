#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import {
  SUPERVISED_ACCEPTANCE_VALUE,
  SUPERVISED_COMMAND_ID,
  SUPERVISED_PRODUCTION_ENV_POLICY,
  SUPERVISED_SUCCESS_MARKER,
  createSupervisedProductionPermissionProfile,
  createSupervisedAttestation,
} from "./lib/supervised-attestation.js";
import {
  RUYIPAGE_LIFECYCLE_STATE_NAME,
  RUYIPAGE_SUPERVISOR_COMMAND_ID,
  validateRuyiPageLifecycleState,
} from "./lib/ruyipage-backend-runner.js";

const POLL_MS = 250;
const TERMINATE_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const TERMINAL_BRIDGE_COMMAND_ID = "supervised-terminal-bridge-v1";
const PRODUCTION_SUPERVISOR_COMMAND_ID = "supervised-production-v1";
const BROWSER_BROKER_COMMAND_ID = RUYIPAGE_SUPERVISOR_COMMAND_ID;
const MACOS_DEFAULT_FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const MAX_RAW_LOG_BYTES = 1024 * 1024;
const MANUAL_CODE_PROMPT =
  "[2FA] 自动取码仍未完成，请输入 Mac 上显示的 6 位验证码: ";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathIsWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function posixPathIsWithin(parentPath, candidatePath) {
  const relative = path.posix.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    !path.posix.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith("../")
  );
}

function requireAbsolutePosixPath(value, label) {
  if (!value || !path.posix.isAbsolute(value) || /[\\\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return path.posix.resolve(value);
}

function requireAbsolutePath(value, label) {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return path.resolve(value);
}

function lstatIfPresent(fileSystem, targetPath) {
  try {
    return fileSystem.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function permissionBits(stats) {
  return Number(stats?.mode ?? 0) & 0o777;
}

function assertPrivateDirectory(fileSystem, directory, label) {
  const stats = fileSystem.lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    permissionBits(stats) !== 0o700
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertPrivateFifo(fileSystem, fifoPath, label) {
  const stats = fileSystem.lstatSync(fifoPath);
  if (!stats.isFIFO() || stats.isSymbolicLink() || permissionBits(stats) !== 0o600) {
    throw new Error(`${label} is invalid`);
  }
}

function createPrivateDirectory(fileSystem, directory, label) {
  if (lstatIfPresent(fileSystem, directory)) throw new Error(`${label} already exists`);
  fileSystem.mkdirSync(directory, { recursive: false, mode: 0o700 });
  fileSystem.chmodSync(directory, 0o700);
  assertPrivateDirectory(fileSystem, directory, label);
}

function defaultCreateFifo(fifoPath) {
  const result = spawnSync("/usr/bin/mkfifo", ["-m", "600", fifoPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0) throw new Error("browser broker FIFO creation failed");
}

export function resolveBrowserBrokerPaths({ repo, productionDir }) {
  const resolvedRepo = requireAbsolutePosixPath(repo, "repository");
  const resolvedProductionDir = requireAbsolutePosixPath(
    productionDir,
    "production directory"
  );
  const brokerDir = path.posix.join(resolvedProductionDir, "browser-broker");
  const reportDir = path.posix.join(brokerDir, "report");
  const reportScreenshotsDir = path.posix.join(reportDir, "screenshots");
  const commandsFifo = path.posix.join(brokerDir, "commands.fifo");
  const eventsFifo = path.posix.join(brokerDir, "events.fifo");
  const launchGatePath = path.posix.join(brokerDir, "broker.ready");
  const reportRoot = path.posix.join(resolvedProductionDir, "reports");
  const values = {
    repo: resolvedRepo,
    productionDir: resolvedProductionDir,
    reportRoot,
    brokerDir,
    reportDir,
    reportScreenshotsDir,
    commandsFifo,
    eventsFifo,
    launchGatePath,
    statePath: path.posix.join(reportRoot, ".ruyipage-process.json"),
    lifecyclePath: path.posix.join(reportRoot, RUYIPAGE_LIFECYCLE_STATE_NAME),
    pythonPath: path.posix.join(
      resolvedRepo,
      ".runtime",
      "ruyipage-venv",
      "bin",
      "python"
    ),
    relayNodePath: path.posix.join(
      resolvedRepo,
      ".runtime",
      "node",
      "bin",
      "node"
    ),
    relayScriptPath: path.posix.join(
      resolvedRepo,
      "scripts",
      "ruyipage-fifo-relay.mjs"
    ),
    scriptPath: path.posix.join(
      resolvedRepo,
      "scripts",
      "ruyipage",
      "apple_account_flow.py"
    ),
    profileDir: path.posix.join(resolvedProductionDir, "firefox-profile"),
    firefoxPath: MACOS_DEFAULT_FIREFOX,
  };
  validateBrowserBrokerPathScope(values);
  return values;
}

export function validateBrowserBrokerPathScope(values) {
  for (const [candidate, parent, label] of [
    [values.brokerDir, values.productionDir, "browser broker directory"],
    [values.reportDir, values.brokerDir, "browser broker report directory"],
    [
      values.reportScreenshotsDir,
      values.reportDir,
      "browser broker screenshots directory",
    ],
    [values.commandsFifo, values.brokerDir, "browser broker commands FIFO"],
    [values.eventsFifo, values.brokerDir, "browser broker events FIFO"],
    [values.launchGatePath, values.brokerDir, "browser broker launch gate"],
    [values.statePath, values.reportRoot, "ruyipage process state"],
    [values.lifecyclePath, values.reportRoot, "ruyipage lifecycle state"],
    [values.pythonPath, values.repo, "ruyipage Python"],
    [values.relayNodePath, values.repo, "FIFO relay Node"],
    [values.relayScriptPath, values.repo, "FIFO relay script"],
    [values.scriptPath, values.repo, "ruyipage script"],
    [values.profileDir, values.productionDir, "Firefox profile"],
  ]) {
    if (!posixPathIsWithin(parent, candidate)) {
      throw new Error(`${label} is out of scope`);
    }
  }
  return true;
}

export function validateBrowserBrokerExecutable(paths, options = {}) {
  const fileSystem = options.fs ?? fs;
  if (!path.posix.isAbsolute(paths.pythonPath)) {
    throw new Error("ruyipage Python is invalid");
  }
  const pythonStats = fileSystem.lstatSync(paths.pythonPath);
  if (!pythonStats.isFile() && !pythonStats.isSymbolicLink()) {
    throw new Error("ruyipage Python is invalid");
  }
  fileSystem.accessSync(paths.pythonPath, fs.constants.X_OK);
  const relayNodeStats = fileSystem.lstatSync(paths.relayNodePath);
  if (!relayNodeStats.isFile() && !relayNodeStats.isSymbolicLink()) {
    throw new Error("FIFO relay Node is invalid");
  }
  fileSystem.accessSync(paths.relayNodePath, fs.constants.X_OK);
  const relayScriptStats = fileSystem.lstatSync(paths.relayScriptPath);
  if (!relayScriptStats.isFile() || relayScriptStats.isSymbolicLink()) {
    throw new Error("FIFO relay script is invalid");
  }
  if (!path.posix.isAbsolute(paths.firefoxPath)) {
    throw new Error("Firefox executable is invalid");
  }
  const firefoxStats = fileSystem.lstatSync(paths.firefoxPath);
  if (!firefoxStats.isFile() || firefoxStats.isSymbolicLink()) {
    throw new Error("Firefox executable is invalid");
  }
  fileSystem.accessSync(paths.firefoxPath, fs.constants.X_OK);
  const scriptStats = fileSystem.lstatSync(paths.scriptPath);
  if (!scriptStats.isFile() || scriptStats.isSymbolicLink()) {
    throw new Error("ruyipage script is invalid");
  }
}

export function prepareBrowserBrokerFilesystem(paths, options = {}) {
  const fileSystem = options.fs ?? fs;
  const createFifo = options.createFifo ?? defaultCreateFifo;
  validateBrowserBrokerPathScope(paths);
  assertPrivateDirectory(fileSystem, paths.profileDir, "Firefox profile directory");
  for (const [directory, label] of [
    [paths.brokerDir, "browser broker directory"],
    [paths.reportDir, "browser broker report directory"],
    [paths.reportScreenshotsDir, "browser broker screenshots directory"],
  ]) {
    createPrivateDirectory(fileSystem, directory, label);
  }
  for (const [fifoPath, label] of [
    [paths.commandsFifo, "browser broker commands FIFO"],
    [paths.eventsFifo, "browser broker events FIFO"],
  ]) {
    if (lstatIfPresent(fileSystem, fifoPath)) throw new Error(`${label} already exists`);
    createFifo(fifoPath);
    fileSystem.chmodSync(fifoPath, 0o600);
    assertPrivateFifo(fileSystem, fifoPath, label);
  }
  assertPrivateDirectory(fileSystem, paths.brokerDir, "browser broker directory");
  return paths;
}

export function readBoundedRegularFile(filePath, maxBytes = 4096) {
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    if (noFollow === 0) {
      const pathStats = fs.lstatSync(filePath);
      if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
        return { state: "invalid", text: null };
      }
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maxBytes) return { state: "invalid", text: null };
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(1024, maxBytes + 1 - total));
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { state: "invalid", text: null };
    return { state: "present", text: Buffer.concat(chunks, total).toString("utf8") };
  } catch (error) {
    return {
      state: error?.code === "ENOENT" ? "missing" : "invalid",
      text: null,
    };
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* descriptor cleanup must not change the fixed file state */
      }
    }
  }
}

function fixedGit(repo, args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function validateEnvironment(env) {
  const repo = requireAbsolutePath(env.APPLE_AUTOMATION_REPO, "repository");
  const controlDir = requireAbsolutePath(
    env.APPLE_AUTOMATION_SUPERVISED_CONTROL_DIR,
    "control directory"
  );
  const writableTmp = requireAbsolutePath(env.APPLE_AUTOMATION_SUPERVISED_WRITABLE_TMP, "writable tmp");
  const triggerPath = requireAbsolutePath(env.APPLE_AUTOMATION_SUPERVISED_TRIGGER, "trigger");
  const cancelPath = requireAbsolutePath(env.APPLE_AUTOMATION_SUPERVISED_CANCEL, "cancel marker");
  const outerCancelPath = requireAbsolutePath(
    env.APPLE_AUTOMATION_SUPERVISED_OUTER_CANCEL,
    "outer cancel marker"
  );
  const attestationPath = requireAbsolutePath(
    env.APPLE_AUTOMATION_SUPERVISED_ATTESTATION,
    "attestation"
  );
  const productionDir = requireAbsolutePath(
    env.APPLE_AUTOMATION_SUPERVISED_PRODUCTION_DIR,
    "production directory"
  );
  const helperDir = requireAbsolutePath(env.APPLE_AUTOMATION_HELPER_DIR, "helper directory");
  const nonce = env.APPLE_AUTOMATION_SUPERVISED_TOKEN ?? "";
  const expectedHead = env.APPLE_AUTOMATION_EXPECTED_HEAD ?? "";
  const deadlineMs = Number(env.APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS);
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("nonce is invalid");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHead)) {
    throw new Error("expected head is invalid");
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) {
    throw new Error("deadline is invalid");
  }
  for (const [candidate, parent, label] of [
    [triggerPath, writableTmp, "trigger"],
    [cancelPath, writableTmp, "cancel marker"],
    [outerCancelPath, controlDir, "outer cancel marker"],
    [attestationPath, controlDir, "attestation"],
    [productionDir, controlDir, "production directory"],
    [helperDir, controlDir, "helper directory"],
  ]) {
    if (!pathIsWithin(parent, candidate)) throw new Error(`${label} is out of scope`);
  }
  if (
    pathIsWithin(writableTmp, controlDir) ||
    pathIsWithin(writableTmp, attestationPath) ||
    pathIsWithin(writableTmp, productionDir) ||
    pathIsWithin(writableTmp, helperDir)
  ) {
    throw new Error("protected supervised path is writable by the model");
  }
  for (const [directory, label] of [
    [repo, "repository"],
    [controlDir, "control directory"],
    [writableTmp, "writable tmp"],
    [productionDir, "production directory"],
    [helperDir, "helper directory"],
  ]) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} is invalid`);
    }
  }
  const permissionProfile = env.APPLE_AUTOMATION_PRODUCTION_PERMISSION_PROFILE ?? "";
  if (permissionProfile !== createSupervisedProductionPermissionProfile(productionDir)) {
    throw new Error("production permission profile is invalid");
  }
  const shellEnvironmentPolicy = env.APPLE_AUTOMATION_PRODUCTION_ENV_POLICY ?? "";
  if (shellEnvironmentPolicy !== SUPERVISED_PRODUCTION_ENV_POLICY) {
    throw new Error("production environment policy is invalid");
  }
  return {
    repo,
    controlDir,
    writableTmp,
    triggerPath,
    cancelPath,
    outerCancelPath,
    attestationPath,
    productionDir,
    helperDir,
    nonce,
    expectedHead,
    deadlineMs,
    codexBin: requireAbsolutePath(env.APPLE_AUTOMATION_CODEX_BIN, "Codex binary"),
    permissionProfile,
    shellEnvironmentPolicy,
    home: requireAbsolutePath(env.HOME, "home directory"),
    user: env.USER ?? "",
  };
}

function atomicAttestation(context, values) {
  const attestation = createSupervisedAttestation({
    nonce: context.nonce,
    expectedHead: context.expectedHead,
    ...values,
  });
  const temporaryPath = path.join(
    context.controlDir,
    `.supervised-attestation-${process.pid}.tmp`
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(attestation)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, context.attestationPath);
}

function readTriggerState(context) {
  const file = readBoundedRegularFile(context.triggerPath, 256);
  if (file.state !== "present") return file.state;
  try {
    const value = JSON.parse(file.text);
    return (
      value?.version === 1 &&
      value?.nonce === context.nonce &&
      value?.commandId === SUPERVISED_COMMAND_ID &&
      Object.keys(value).sort().join(",") === "commandId,nonce,version"
    )
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
}

function readCancelState(context) {
  for (const cancelPath of [context.cancelPath, context.outerCancelPath]) {
    const file = readBoundedRegularFile(cancelPath, 256);
    if (file.state === "missing") continue;
    if (file.state !== "present") return "invalid";
    try {
      const value = JSON.parse(file.text);
      if (
        value?.version === 1 &&
        value?.nonce === context.nonce &&
        Object.keys(value).sort().join(",") === "nonce,version"
      ) {
        return "valid";
      }
      return "invalid";
    } catch {
      return "invalid";
    }
  }
  return "missing";
}

function cancellationIsPresent(context) {
  return readCancelState(context) !== "missing";
}

function processGroupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function fixedProcessIdentity(pid) {
  const readField = (args) => {
    const result = spawnSync("/bin/ps", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
  };
  const pgid = Number(readField(["-p", String(pid), "-o", "pgid="]));
  const startedAt = readField(["-p", String(pid), "-o", "lstart="]).replace(
    /\s+/g,
    " "
  );
  const command = readField(["-ww", "-p", String(pid), "-o", "command="]);
  if (
    !Number.isInteger(pgid) ||
    pgid <= 0 ||
    !startedAt ||
    startedAt.length > 64 ||
    /[\r\n\0]/.test(startedAt) ||
    !command ||
    command.length > 16 * 1024 ||
    /[\r\n\0]/.test(command)
  ) {
    return null;
  }
  return { pid, pgid, startedAt, command };
}

async function waitForFixedProcessIdentity(pid, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const identity = fixedProcessIdentity(pid);
    if (identity && predicate(identity)) return identity;
    await sleep(10);
  } while (Date.now() < deadline);
  return null;
}

function atomicProductionProcessState(context, filePath, identity, state) {
  if (
    !identity ||
    !Number.isInteger(identity.pid) ||
    !Number.isInteger(identity.pgid) ||
    identity.pid <= 0 ||
    identity.pgid !== identity.pid ||
    typeof identity.startedAt !== "string" ||
    !identity.startedAt ||
    identity.startedAt.length > 64 ||
    /[\r\n\0]/.test(identity.startedAt) ||
    typeof identity.command !== "string" ||
    !identity.command ||
    identity.command.length > 16 * 1024 ||
    /[\r\n\0]/.test(identity.command)
  ) {
    throw new Error("production process identity is invalid");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      nonce: context.nonce,
      pid: identity.pid,
      pgid: identity.pgid,
      startedAt: identity.startedAt,
      commandId: PRODUCTION_SUPERVISOR_COMMAND_ID,
      commandSha256: crypto
        .createHash("sha256")
        .update(identity.command, "utf8")
        .digest("hex"),
      state,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function atomicBrowserBrokerLifecycleState(context, filePath, state) {
  if (!["preparing", "active", "inactive", "cleanup_failed"].includes(state)) {
    throw new Error("browser broker lifecycle state is invalid");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, nonce: context.nonce, state })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function atomicBrowserBrokerProcessState(context, filePath, identity, state) {
  if (
    !identity ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pgid !== identity.pid ||
    typeof identity.startedAt !== "string" ||
    !identity.startedAt ||
    identity.startedAt.length > 64 ||
    /[\r\n\0]/.test(identity.startedAt) ||
    typeof identity.command !== "string" ||
    !identity.command ||
    identity.command.length > 16 * 1024 ||
    /[\r\n\0]/.test(identity.command) ||
    !["starting", "active", "inactive", "cleanup_failed"].includes(state)
  ) {
    throw new Error("browser broker process identity is invalid");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      pid: identity.pid,
      pgid: identity.pgid,
      startedAt: identity.startedAt,
      nonce: context.nonce,
      commandId: BROWSER_BROKER_COMMAND_ID,
      commandSha256: crypto
        .createHash("sha256")
        .update(identity.command, "utf8")
        .digest("hex"),
      state,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function writeProductionLaunchGate(filePath, pid, nonce) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, nonce, pid })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function removeSingleFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* The single-use launch gate may already be absent. */
  }
}

export function buildProductionProcessSupervisorScript() {
  return [
    "set -eu",
    "umask 077",
    "parent_pid=$1",
    "parent_pgid=$2",
    "parent_started_at=$3",
    "parent_command=$4",
    "launch_nonce=$5",
    "launch_gate=$6",
    "cancel_file=$7",
    "outer_cancel_file=$8",
    "deadline_ms=$9",
    "repo=${10}",
    "expected_head=${11}",
    "shift 11",
    "(( ${#launch_nonce} == 32 )) && [[ \"$launch_nonce\" != *[^0-9a-f]* ]] || exit 125",
    "parent_is_current() {",
    "  current_parent_pgid=$(/bin/ps -p \"$parent_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_started_at=$(/bin/ps -p \"$parent_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_command=$(/bin/ps -ww -p \"$parent_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_parent_pgid\" == \"$parent_pgid\" && -n \"$parent_started_at\" && \"$current_started_at\" == \"$parent_started_at\" && -n \"$parent_command\" && \"$current_command\" == \"$parent_command\" ]]",
    "}",
    "runtime_is_allowed() {",
    "  parent_is_current || return 125",
    "  [[ ! -e \"$cancel_file\" && ! -e \"$outer_cancel_file\" ]] || return 130",
    "  (( $(/bin/date +%s) * 1000 < deadline_ms )) || return 124",
    "  return 0",
    "}",
    "expected_gate=\"{\\\"version\\\":1,\\\"nonce\\\":\\\"$launch_nonce\\\",\\\"pid\\\":$$}\"",
    "while :; do",
    "  if runtime_is_allowed; then :; else exit $?; fi",
    "  gate_value=''",
    "  if [[ -f \"$launch_gate\" && ! -h \"$launch_gate\" ]]; then gate_value=$(< \"$launch_gate\") || true; fi",
    "  [[ \"$gate_value\" == \"$expected_gate\" ]] && break",
    "  /bin/sleep 0.05",
    "done",
    "if runtime_is_allowed; then :; else exit $?; fi",
    "[[ \"$(/usr/bin/git -C \"$repo\" rev-parse HEAD)\" == \"$expected_head\" ]] || exit 121",
    "[[ -z \"$(/usr/bin/git -C \"$repo\" status --porcelain=v1)\" ]] || exit 122",
    "[[ -n \"$launch_nonce\" ]] || exit 125",
    "if runtime_is_allowed; then :; else exit $?; fi",
    "group_snapshot=$(/usr/bin/mktemp \"${TMPDIR:-/tmp}/supervised-production-members.XXXXXX\") || exit 125",
    "snapshot_helper_pid=''",
    "group_snapshot_failed=0",
    "snapshot_group_members() {",
    "  : >| \"$group_snapshot\" || return 1",
    "  /bin/ps -ax -o pid= -o pgid= >| \"$group_snapshot\" 2>/dev/null &",
    "  snapshot_helper_pid=$!",
    "  wait \"$snapshot_helper_pid\"",
    "}",
    "group_has_members() {",
    "  group_snapshot_failed=0",
    "  if ! snapshot_group_members; then group_snapshot_failed=1; return 0; fi",
    "  while read -r member_pid member_pgid; do",
    "    [[ \"$member_pid\" == <-> && \"$member_pgid\" == \"$$\" ]] || continue",
    "    [[ \"$member_pid\" == \"$$\" || \"$member_pid\" == \"$snapshot_helper_pid\" ]] && continue",
    "    return 0",
    "  done < \"$group_snapshot\"",
    "  return 1",
    "}",
    "signal_group_members() {",
    "  signal_name=$1",
    "  signal_failed=0",
    "  snapshot_group_members || return 1",
    "  while read -r member_pid member_pgid; do",
    "    [[ \"$member_pid\" == <-> && \"$member_pgid\" == \"$$\" ]] || continue",
    "    [[ \"$member_pid\" == \"$$\" || \"$member_pid\" == \"$snapshot_helper_pid\" ]] && continue",
    "    current_pgid=$(/bin/ps -p \"$member_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "    if [[ \"$current_pgid\" == \"$$\" ]]; then",
    "      if [[ \"$member_pid\" == \"$production_pid\" ]] && ! target_identity_is_current; then signal_failed=1; continue; fi",
    "      /bin/kill -\"$signal_name\" \"$member_pid\" 2>/dev/null || signal_failed=1",
    "    elif /bin/kill -0 \"$member_pid\" 2>/dev/null; then",
    "      signal_failed=1",
    "    fi",
    "  done < \"$group_snapshot\"",
    "  (( signal_failed == 0 ))",
    "}",
    "cleanup_group_members() {",
    "  group_has_members || return 0",
    "  (( group_snapshot_failed == 0 )) || return 1",
    "  signal_group_members TERM || return 1",
    "  cleanup_attempt=0",
    "  while group_has_members && (( cleanup_attempt < 50 )); do /bin/sleep 0.1; cleanup_attempt=$((cleanup_attempt + 1)); done",
    "  group_has_members || return 0",
    "  (( group_snapshot_failed == 0 )) || return 1",
    "  signal_group_members KILL || return 1",
    "  cleanup_attempt=0",
    "  while group_has_members && (( cleanup_attempt < 20 )); do /bin/sleep 0.1; cleanup_attempt=$((cleanup_attempt + 1)); done",
    "  if group_has_members; then return 1; fi",
    "  (( group_snapshot_failed == 0 ))",
    "}",
    "interrupted_status=0",
    "trap 'interrupted_status=130' INT",
    "trap 'interrupted_status=143' TERM",
    "trap 'interrupted_status=129' HUP",
    "expected_production_command=\"$*\"",
    'supervisor_status() { print -r -- "$1" >&3; }',
    'supervisor_status "target-launch" || exit 125',
    "\"$@\" 3>&- <&0 >&1 2>&2 &",
    "production_pid=$!",
    "production_pgid=''",
    "production_started_at=''",
    "production_command=''",
    "capture_target_identity() {",
    "  identity_attempt=0",
    "  while /bin/kill -0 \"$production_pid\" 2>/dev/null && (( identity_attempt < 100 )); do",
    "    current_production_pgid=$(/bin/ps -p \"$production_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "    current_production_started_at=$(/bin/ps -p \"$production_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "    current_production_command=$(/bin/ps -ww -p \"$production_pid\" -o command= 2>/dev/null || true)",
    "    if [[ \"$current_production_pgid\" == \"$$\" && -n \"$current_production_started_at\" && \"$current_production_command\" == \"$expected_production_command\" ]]; then",
    "      production_pgid=$current_production_pgid",
    "      production_started_at=$current_production_started_at",
    "      production_command=$current_production_command",
    "      return 0",
    "    fi",
    "    /bin/sleep 0.01",
    "    identity_attempt=$((identity_attempt + 1))",
    "  done",
    "  return 1",
    "}",
    "target_identity_is_current() {",
    "  [[ -n \"$production_pgid\" && -n \"$production_started_at\" && -n \"$production_command\" ]] || return 1",
    "  current_production_pgid=$(/bin/ps -p \"$production_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_production_started_at=$(/bin/ps -p \"$production_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_production_command=$(/bin/ps -ww -p \"$production_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_production_pgid\" == \"$production_pgid\" && \"$current_production_pgid\" == \"$$\" && \"$current_production_started_at\" == \"$production_started_at\" && \"$current_production_command\" == \"$production_command\" && \"$current_production_command\" == \"$expected_production_command\" ]]",
    "}",
    "if ! capture_target_identity && /bin/kill -0 \"$production_pid\" 2>/dev/null; then",
    "  signal_group_members TERM || true",
    "  /usr/bin/unlink \"$group_snapshot\" 2>/dev/null || true",
    "  exit 125",
    "fi",
    'if [[ -n "$production_pgid" ]]; then supervisor_status "target-identity-ready" || exit 125; else supervisor_status "target-identity-unavailable" || exit 125; fi',
    "monitor_runtime() {",
    "  while target_identity_is_current; do",
    "    if runtime_is_allowed; then",
    "      /bin/sleep 0.25",
    "      continue",
    "    else",
    "      monitor_status=$?",
    "    fi",
    "    if target_identity_is_current; then",
    "      /bin/kill -TERM \"$production_pid\" 2>/dev/null || true",
    "    elif /bin/kill -0 \"$production_pid\" 2>/dev/null; then",
    "      return 125",
    "    else",
    "      return \"$monitor_status\"",
    "    fi",
    "    monitor_attempt=0",
    "    while /bin/kill -0 \"$production_pid\" 2>/dev/null && (( monitor_attempt < 50 )); do /bin/sleep 0.1; monitor_attempt=$((monitor_attempt + 1)); done",
    "    if /bin/kill -0 \"$production_pid\" 2>/dev/null; then",
    "      if target_identity_is_current; then",
    "        /bin/kill -KILL \"$production_pid\" 2>/dev/null || true",
    "      else",
    "        return 125",
    "      fi",
    "    fi",
    "    return \"$monitor_status\"",
    "  done",
    "  /bin/kill -0 \"$production_pid\" 2>/dev/null && return 125",
    "  return 0",
    "}",
    "monitor_runtime &",
    "monitor_pid=$!",
    "set +e",
    "wait \"$production_pid\"",
    "production_status=$?",
    'supervisor_status "target-exit:$production_status" || exit 125',
    "wait \"$monitor_pid\"",
    "monitor_status=$?",
    'supervisor_status "monitor-exit:$monitor_status" || exit 125',
    "set -e",
    "[[ \"$monitor_status\" == (124|125|130) ]] && production_status=$monitor_status",
    "(( interrupted_status == 0 )) || production_status=$interrupted_status",
    'supervisor_status "final-exit:$production_status" || exit 125',
    "cleanup_status=0",
    "cleanup_group_members || cleanup_status=125",
    "/usr/bin/unlink \"$group_snapshot\" 2>/dev/null || cleanup_status=125",
    'if (( cleanup_status != 0 )); then supervisor_status "cleanup-failed" || exit 125; fi',
    "exit \"$production_status\"",
  ].join("\n");
}

export function buildBrowserBrokerSupervisorScript() {
  return [
    "set -eu",
    "umask 077",
    "parent_pid=$1",
    "parent_pgid=$2",
    "parent_started_at=$3",
    "parent_command=$4",
    "launch_nonce=$5",
    "launch_gate=$6",
    "cancel_file=$7",
    "outer_cancel_file=$8",
    "deadline_ms=$9",
    "commands_fifo=${10}",
    "events_fifo=${11}",
    "relay_node=${12}",
    "relay_script=${13}",
    "shift 13",
    "interrupted_status=0",
    'broker_status() { print -r -- "$1" >&3; }',
    "(( ${#launch_nonce} == 32 )) && [[ \"$launch_nonce\" != *[^0-9a-f]* ]] || exit 125",
    "parent_is_current() {",
    "  current_parent_pgid=$(/bin/ps -p \"$parent_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_started_at=$(/bin/ps -p \"$parent_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_command=$(/bin/ps -ww -p \"$parent_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_parent_pgid\" == \"$parent_pgid\" && -n \"$parent_started_at\" && \"$current_started_at\" == \"$parent_started_at\" && -n \"$parent_command\" && \"$current_command\" == \"$parent_command\" ]]",
    "}",
    "runtime_is_allowed() {",
    "  parent_is_current || return 125",
    "  [[ ! -e \"$cancel_file\" && ! -e \"$outer_cancel_file\" ]] || return 130",
    "  (( $(/bin/date +%s) * 1000 < deadline_ms )) || return 124",
    "  (( interrupted_status == 0 )) || return \"$interrupted_status\"",
    "  return 0",
    "}",
    "[[ -p \"$commands_fifo\" && ! -h \"$commands_fifo\" ]] || exit 125",
    "[[ -p \"$events_fifo\" && ! -h \"$events_fifo\" ]] || exit 125",
    "[[ \"$(/usr/bin/stat -f %Lp \"$commands_fifo\" 2>/dev/null || true)\" == \"600\" ]] || exit 125",
    "[[ \"$(/usr/bin/stat -f %Lp \"$events_fifo\" 2>/dev/null || true)\" == \"600\" ]] || exit 125",
    "[[ -x \"$relay_node\" && -f \"$relay_script\" && ! -h \"$relay_script\" ]] || exit 125",
    'broker_status "supervisor-ready" || exit 125',
    "expected_gate=\"{\\\"version\\\":1,\\\"nonce\\\":\\\"$launch_nonce\\\",\\\"pid\\\":$$}\"",
    "while :; do",
    "  if runtime_is_allowed; then :; else exit $?; fi",
    "  gate_value=''",
    "  if [[ -f \"$launch_gate\" && ! -h \"$launch_gate\" ]]; then gate_value=$(< \"$launch_gate\") || true; fi",
    "  [[ \"$gate_value\" == \"$expected_gate\" ]] && break",
    "  /bin/sleep 0.05",
    "done",
    "if runtime_is_allowed; then :; else exit $?; fi",
    'broker_status "gate-open" || exit 125',
    "group_snapshot=$(/usr/bin/mktemp \"${TMPDIR:-/tmp}/ruyipage-broker-members.XXXXXX\") || exit 125",
    "snapshot_helper_pid=''",
    "group_snapshot_failed=0",
    "snapshot_group_members() {",
    "  : >| \"$group_snapshot\" || return 1",
    "  /bin/ps -ax -o pid= -o pgid= >| \"$group_snapshot\" 2>/dev/null &",
    "  snapshot_helper_pid=$!",
    "  wait \"$snapshot_helper_pid\"",
    "}",
    "group_has_members() {",
    "  group_snapshot_failed=0",
    "  if ! snapshot_group_members; then group_snapshot_failed=1; return 0; fi",
    "  while read -r member_pid member_pgid; do",
    "    [[ \"$member_pid\" == <-> && \"$member_pgid\" == \"$$\" ]] || continue",
    "    [[ \"$member_pid\" == \"$$\" || \"$member_pid\" == \"$snapshot_helper_pid\" ]] && continue",
    "    return 0",
    "  done < \"$group_snapshot\"",
    "  return 1",
    "}",
    "expected_backend_command=\"$*\"",
    "backend_pid=''",
    "backend_pgid=''",
    "backend_started_at=''",
    "backend_command=''",
    "backend_is_running() {",
    "  backend_state=$(/bin/ps -p \"$backend_pid\" -o state= 2>/dev/null | /usr/bin/xargs || true)",
    "  [[ -n \"$backend_state\" && \"$backend_state\" != Z* ]]",
    "}",
    "direct_backend_is_current() {",
    "  current_backend_ppid=$(/bin/ps -p \"$backend_pid\" -o ppid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_pgid=$(/bin/ps -p \"$backend_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  [[ \"$current_backend_ppid\" == \"$$\" && \"$current_backend_pgid\" == \"$$\" ]]",
    "}",
    "target_identity_is_current() {",
    "  [[ -n \"$backend_pid\" && -n \"$backend_pgid\" && -n \"$backend_started_at\" && -n \"$backend_command\" ]] || return 1",
    "  current_backend_pgid=$(/bin/ps -p \"$backend_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_started_at=$(/bin/ps -p \"$backend_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_command=$(/bin/ps -ww -p \"$backend_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_backend_pgid\" == \"$backend_pgid\" && \"$current_backend_pgid\" == \"$$\" && \"$current_backend_started_at\" == \"$backend_started_at\" && \"$current_backend_command\" == \"$backend_command\" && \"$current_backend_command\" == \"$expected_backend_command\" ]]",
    "}",
    "wait_backend_bounded() {",
    "  wait_attempt=0",
    "  wait_limit=$1",
    "  while backend_is_running && (( wait_attempt < wait_limit )); do /bin/sleep 0.1; wait_attempt=$((wait_attempt + 1)); done",
    "  ! backend_is_running",
    "}",
    "terminate_backend_bounded() {",
    "  backend_is_running || return 0",
    "  direct_backend_is_current || return 1",
    "  /bin/kill -TERM \"$backend_pid\" 2>/dev/null || true",
    "  wait_backend_bounded 50 && return 0",
    "  direct_backend_is_current || return 1",
    "  /bin/kill -KILL \"$backend_pid\" 2>/dev/null || true",
    "  wait_backend_bounded 20",
    "}",
    "signal_group_members() {",
    "  signal_name=$1",
    "  signal_failed=0",
    "  snapshot_group_members || return 1",
    "  while read -r member_pid member_pgid; do",
    "    [[ \"$member_pid\" == <-> && \"$member_pgid\" == \"$$\" ]] || continue",
    "    [[ \"$member_pid\" == \"$$\" || \"$member_pid\" == \"$snapshot_helper_pid\" ]] && continue",
    "    current_pgid=$(/bin/ps -p \"$member_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "    if [[ \"$current_pgid\" == \"$$\" ]]; then",
    "      /bin/kill -\"$signal_name\" \"$member_pid\" 2>/dev/null || signal_failed=1",
    "    elif /bin/kill -0 \"$member_pid\" 2>/dev/null; then",
    "      signal_failed=1",
    "    fi",
    "  done < \"$group_snapshot\"",
    "  (( signal_failed == 0 ))",
    "}",
    "cleanup_group_members() {",
    "  group_has_members || return 0",
    "  (( group_snapshot_failed == 0 )) || return 1",
    "  signal_group_members TERM || return 1",
    "  cleanup_attempt=0",
    "  while group_has_members && (( cleanup_attempt < 50 )); do /bin/sleep 0.1; cleanup_attempt=$((cleanup_attempt + 1)); done",
    "  group_has_members || return 0",
    "  (( group_snapshot_failed == 0 )) || return 1",
    "  signal_group_members KILL || return 1",
    "  cleanup_attempt=0",
    "  while group_has_members && (( cleanup_attempt < 20 )); do /bin/sleep 0.1; cleanup_attempt=$((cleanup_attempt + 1)); done",
    "  if group_has_members; then return 1; fi",
    "  (( group_snapshot_failed == 0 ))",
    "}",
    "shutdown_backend_and_descendants() {",
    "  if ! terminate_backend_bounded; then",
    "    signal_group_members TERM || true",
    "    if ! wait_backend_bounded 50; then",
    "      signal_group_members KILL || true",
    "      wait_backend_bounded 20 || return 1",
    "    fi",
    "  fi",
    "  if ! backend_is_running; then",
    "    set +e",
    "    wait \"$backend_pid\"",
    "    set -e",
    "  fi",
    "  cleanup_group_members",
    "}",
    "trap 'interrupted_status=130' INT",
    "trap 'interrupted_status=143' TERM",
    "trap 'interrupted_status=129' HUP",
    'broker_status "target-launch" || exit 125',
    "\"$@\" 3>&- < <(\"$relay_node\" \"$relay_script\" read \"$commands_fifo\" 3>&-) > >(\"$relay_node\" \"$relay_script\" write \"$events_fifo\" 3>&-) 2>/dev/null &",
    "backend_pid=$!",
    "identity_attempt=0",
    "while /bin/kill -0 \"$backend_pid\" 2>/dev/null && (( identity_attempt < 1000 )); do",
    "  current_backend_pgid=$(/bin/ps -p \"$backend_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_started_at=$(/bin/ps -p \"$backend_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_command=$(/bin/ps -ww -p \"$backend_pid\" -o command= 2>/dev/null || true)",
    "  if [[ \"$current_backend_pgid\" == \"$$\" && -n \"$current_backend_started_at\" && \"$current_backend_command\" == \"$expected_backend_command\" ]]; then backend_pgid=$current_backend_pgid; backend_started_at=$current_backend_started_at; backend_command=$current_backend_command; break; fi",
    "  /bin/sleep 0.01",
    "  identity_attempt=$((identity_attempt + 1))",
    "done",
    "if [[ -z \"$backend_pgid\" ]] && backend_is_running; then",
    '  broker_status "target-identity-failed" || true',
    "  shutdown_backend_and_descendants || true",
    "  /usr/bin/unlink \"$group_snapshot\" 2>/dev/null || true",
    "  exit 125",
    "fi",
    'broker_status "target-identity-ready" || exit 125',
    "runtime_status=0",
    "while target_identity_is_current; do",
    "  if runtime_is_allowed; then /bin/sleep 0.25; continue; else runtime_status=$?; fi",
    "  shutdown_backend_and_descendants || runtime_status=125",
    "  break",
    "done",
    "if backend_is_running; then runtime_status=125; shutdown_backend_and_descendants || runtime_status=125; fi",
    "backend_status=125",
    "if ! backend_is_running; then",
    "  set +e",
    "  wait \"$backend_pid\"",
    "  backend_status=$?",
    "  set -e",
    "fi",
    'broker_status "target-exit" || true',
    "[[ \"$runtime_status\" == (124|125|130) ]] && backend_status=$runtime_status",
    "(( interrupted_status == 0 )) || backend_status=$interrupted_status",
    "cleanup_status=0",
    "cleanup_group_members || cleanup_status=125",
    "/usr/bin/unlink \"$group_snapshot\" 2>/dev/null || cleanup_status=125",
    "(( cleanup_status == 0 )) || exit 125",
    "exit \"$backend_status\"",
  ].join("\n");
}

function processIdentityMatches(expectedIdentity, predicate) {
  if (!expectedIdentity) return false;
  const current = fixedProcessIdentity(expectedIdentity.pid);
  return Boolean(
    current &&
      current.pgid === expectedIdentity.pgid &&
      current.startedAt === expectedIdentity.startedAt &&
      predicate(current)
  );
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupExists(pid);
}

async function terminateRecordedProcessGroup(expectedIdentity, predicate) {
  const pid = expectedIdentity?.pid;
  if (!processGroupExists(pid)) return true;
  if (!processIdentityMatches(expectedIdentity, predicate)) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* process may already be gone */
  }
  if (await waitForProcessGroupExit(pid, TERMINATE_GRACE_MS)) return true;
  if (!processIdentityMatches(expectedIdentity, predicate)) return false;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* process may already be gone */
  }
  return waitForProcessGroupExit(pid, KILL_GRACE_MS);
}

async function cleanupRecordedRuyiPageProcess(
  filePath,
  expectedScriptPath,
  expectedNonce
) {
  const file = readBoundedRegularFile(filePath, 512);
  const lifecyclePath = path.join(
    path.dirname(filePath),
    RUYIPAGE_LIFECYCLE_STATE_NAME
  );
  const lifecycleFile = readBoundedRegularFile(lifecyclePath, 256);
  const lifecycle =
    lifecycleFile.state === "present"
      ? validateRuyiPageLifecycleState(lifecycleFile.text, expectedNonce)
      : null;
  if (file.state === "missing") {
    if (lifecycleFile.state === "missing") {
      return { ok: true, seen: false, cleanupEvidence: false };
    }
    return {
      ok: lifecycle?.state === "inactive",
      seen: false,
      cleanupEvidence: lifecycle?.state === "inactive",
    };
  }
  if (file.state !== "present") {
    return { ok: false, seen: true, cleanupEvidence: false };
  }
  let value;
  try {
    value = JSON.parse(file.text);
  } catch {
    return { ok: false, seen: true, cleanupEvidence: false };
  }
  if (
    value?.version !== 1 ||
    !Number.isInteger(value.pid) ||
    !Number.isInteger(value.pgid) ||
    value.pid <= 0 ||
    value.pgid !== value.pid ||
    typeof value.startedAt !== "string" ||
    !value.startedAt ||
    value.startedAt.length > 64 ||
    /[\r\n\0]/.test(value.startedAt) ||
    value.nonce !== expectedNonce ||
    value.commandId !== "ruyipage-supervisor-v1" ||
    typeof value.commandSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.commandSha256) ||
    !["starting", "active", "inactive", "cleanup_failed"].includes(value.state) ||
    Object.keys(value).sort().join(",") !==
      "commandId,commandSha256,nonce,pgid,pid,startedAt,state,version"
  ) {
    return { ok: false, seen: true, cleanupEvidence: false };
  }
  if (!processGroupExists(value.pid)) {
    return { ok: true, seen: true, cleanupEvidence: true };
  }
  const identity = fixedProcessIdentity(value.pid);
  const identityPredicate = (current) =>
    current.command.includes("ruyipage-supervisor") &&
    current.command.includes(expectedScriptPath) &&
    current.command.includes(expectedNonce) &&
    crypto.createHash("sha256").update(current.command, "utf8").digest("hex") ===
      value.commandSha256;
  if (
    !identity ||
    identity.pgid !== value.pgid ||
    identity.startedAt !== value.startedAt ||
    !identityPredicate(identity)
  ) {
    return { ok: false, seen: true, cleanupEvidence: false };
  }
  return {
    ok: await terminateRecordedProcessGroup(identity, identityPredicate),
    seen: true,
    cleanupEvidence: true,
  };
}

async function terminateGroup(child, expectedIdentity, predicate) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
  if (!processGroupExists(child.pid)) return true;
  if (!processIdentityMatches(expectedIdentity, predicate)) return false;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* process may already be gone */
  }
  if (await waitForProcessGroupExit(child.pid, TERMINATE_GRACE_MS)) return true;
  if (!processIdentityMatches(expectedIdentity, predicate)) return false;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* process may already be gone */
  }
  return waitForProcessGroupExit(child.pid, KILL_GRACE_MS);
}

function createOutcome(now = Date.now) {
  let resolve;
  const state = { settled: false, settledAt: null, value: null };
  const promise = new Promise((res) => {
    resolve = (value) => {
      if (state.settled) return;
      state.settled = true;
      state.settledAt = now();
      state.value = value;
      res(value);
    };
  });
  return {
    get settled() { return state.settled; },
    get settledAt() { return state.settledAt; },
    get value() { return state.value; },
    promise,
    resolve,
  };
}

export function createSupervisorStatusProtocol() {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let state = 0;
  let invalid = false;
  let targetExit = null;
  let monitorExit = null;
  let finalExit = null;
  let cleanupFailed = false;
  let finished = false;

  const accept = (line) => {
    if (invalid || finished || line.length === 0 || line.length > 64) {
      invalid = true;
      return;
    }
    if (state === 0 && line === "target-launch") {
      state = 1;
      return;
    }
    if (
      state === 1 &&
      ["target-identity-ready", "target-identity-unavailable"].includes(line)
    ) {
      state = 2;
      return;
    }
    const targetMatch = state === 2 ? line.match(/^target-exit:(\d{1,3})$/) : null;
    if (targetMatch && Number(targetMatch[1]) <= 255) {
      targetExit = Number(targetMatch[1]);
      state = 3;
      return;
    }
    const monitorMatch = state === 3 ? line.match(/^monitor-exit:(\d{1,3})$/) : null;
    if (monitorMatch && [0, 124, 125, 130, 143].includes(Number(monitorMatch[1]))) {
      monitorExit = Number(monitorMatch[1]);
      state = 4;
      return;
    }
    const finalMatch = state === 4 ? line.match(/^final-exit:(\d{1,3})$/) : null;
    if (finalMatch && Number(finalMatch[1]) <= 255) {
      finalExit = Number(finalMatch[1]);
      state = 5;
      return;
    }
    if (state === 5 && line === "cleanup-failed") {
      cleanupFailed = true;
      state = 6;
      return;
    }
    invalid = true;
  };

  const push = (chunk) => {
    if (finished || invalid) return;
    buffer += decoder.write(Buffer.from(chunk));
    if (Buffer.byteLength(buffer, "utf8") > 1024) {
      invalid = true;
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      accept(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
  };

  const finish = () => {
    if (!finished) {
      buffer += decoder.end();
      if (buffer.length !== 0) invalid = true;
      finished = true;
    }
    return {
      complete: !invalid && (state === 5 || state === 6),
      targetExit,
      monitorExit,
      finalExit,
      cleanupFailed,
    };
  };

  return { push, finish };
}

export function classifySupervisorStatus(
  status,
  productionExit,
  { externalTerminationAttempted = false } = {}
) {
  if (
    status?.complete !== true ||
    !Number.isInteger(productionExit) ||
    status.finalExit !== productionExit ||
    (status.monitorExit === 143 && externalTerminationAttempted !== true)
  ) {
    return "invalid";
  }
  return status.cleanupFailed === true ? "cleanup_failed" : "valid";
}

export function classifyProcessCleanup({
  productionGroupClean,
  ruyiPageGroupClean,
  supervisorStatusOutcome,
  markerConfirmed,
  ruyiPageCleanupEvidence,
}) {
  if (
    productionGroupClean !== true ||
    ruyiPageGroupClean !== true
  ) {
    return "failed";
  }
  if (markerConfirmed === true && ruyiPageCleanupEvidence !== true) return "failed";
  return supervisorStatusOutcome === "cleanup_failed" ? "recovered" : "clean";
}

export function buildBrowserBrokerEnvironment(context, paths) {
  return {
    HOME: context.home,
    USER: context.user,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: `${context.repo}/.runtime/ruyipage-venv/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.posix.join(context.productionDir, "tmp"),
    APPLE_AUTOMATION_REPORT_ROOT: paths.reportDir,
    APPLE_AUTOMATION_BROWSER_BROKER_MODE: "1",
    APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO: paths.commandsFifo,
    APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO: paths.eventsFifo,
    FIREFOX_PROFILE_DIR: paths.profileDir,
    BROWSER_PROFILE_MODE: "persistent",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

export function browserBrokerIdentityMatches(identity, broker) {
  return Boolean(
    identity &&
      Number.isInteger(identity.pid) &&
      identity.pid > 0 &&
      identity.pgid === identity.pid &&
      typeof identity.command === "string" &&
      identity.command.includes("ruyipage-supervisor") &&
      identity.command.includes(broker.context.nonce) &&
      identity.command.includes(broker.paths.scriptPath) &&
      (!broker.identity || identity.command === broker.identity.command)
  );
}

export function attachBrowserBrokerStatusStream(broker, stream) {
  if (!stream || typeof stream.on !== "function") {
    throw new Error("browser broker status stream is unavailable");
  }
  const allowed = new Set([
    "supervisor-ready",
    "gate-open",
    "target-launch",
    "target-identity-ready",
    "target-identity-failed",
    "target-exit",
  ]);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let bytes = 0;
  const accept = (line) => {
    if (!allowed.has(line)) {
      broker.stage = "status-invalid";
      return;
    }
    broker.stage = line;
  };
  stream.on("data", (chunk) => {
    if (broker.stage === "status-invalid") return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 512) {
      broker.stage = "status-invalid";
      return;
    }
    buffer += decoder.write(Buffer.from(chunk));
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) accept(line);
  });
  stream.once("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) accept(buffer);
    buffer = "";
  });
  return broker;
}

export function createBrowserBroker(context) {
  return {
    context,
    paths: resolveBrowserBrokerPaths(context),
    child: null,
    identity: null,
    filesystemTouched: false,
    lifecycleStarted: false,
    stage: "created",
  };
}

export async function startBrowserBroker(
  broker,
  bridgeIdentity,
  options = {}
) {
  const validateExecutable =
    options.validateExecutable ?? validateBrowserBrokerExecutable;
  const prepareFilesystem =
    options.prepareFilesystem ?? prepareBrowserBrokerFilesystem;
  const spawnProcess = options.spawn ?? spawn;
  const waitForIdentity = options.waitForIdentity ?? waitForFixedProcessIdentity;
  const writeLifecycle =
    options.writeLifecycle ?? atomicBrowserBrokerLifecycleState;
  const writeProcessState =
    options.writeProcessState ?? atomicBrowserBrokerProcessState;
  const writeLaunchGate = options.writeLaunchGate ?? writeProductionLaunchGate;
  validateExecutable(broker.paths);
  broker.filesystemTouched = true;
  prepareFilesystem(broker.paths);
  writeLifecycle(
    broker.context,
    broker.paths.lifecyclePath,
    "preparing"
  );
  broker.lifecycleStarted = true;
  const supervisorScript = buildBrowserBrokerSupervisorScript();
  const backendArgs = [
    broker.paths.pythonPath,
    broker.paths.scriptPath,
    "--report-dir",
    broker.paths.reportDir,
    "--profile-dir",
    broker.paths.profileDir,
    "--firefox",
    broker.paths.firefoxPath,
  ];
  broker.child = spawnProcess(
    "/bin/zsh",
    [
      "-c",
      supervisorScript,
      "ruyipage-supervisor",
      String(process.pid),
      String(bridgeIdentity.pgid),
      bridgeIdentity.startedAt,
      bridgeIdentity.command,
      broker.context.nonce,
      broker.paths.launchGatePath,
      broker.context.cancelPath,
      broker.context.outerCancelPath,
      String(broker.context.deadlineMs),
      broker.paths.commandsFifo,
      broker.paths.eventsFifo,
      broker.paths.relayNodePath,
      broker.paths.relayScriptPath,
      ...backendArgs,
    ],
    {
      cwd: broker.context.repo,
      detached: true,
      env: buildBrowserBrokerEnvironment(broker.context, broker.paths),
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    }
  );
  if (!Number.isInteger(broker.child?.pid) || broker.child.pid <= 0) {
    throw new Error("browser broker process did not start");
  }
  broker.stage = "spawned";
  attachBrowserBrokerStatusStream(broker, broker.child.stdio?.[3]);
  broker.identity = await waitForIdentity(
    broker.child.pid,
    (identity) => browserBrokerIdentityMatches(identity, broker)
  );
  if (!broker.identity) throw new Error("browser broker identity is unavailable");
  writeProcessState(
    broker.context,
    broker.paths.statePath,
    broker.identity,
    "starting"
  );
  writeLaunchGate(
    broker.paths.launchGatePath,
    broker.child.pid,
    broker.context.nonce
  );
  writeProcessState(
    broker.context,
    broker.paths.statePath,
    broker.identity,
    "active"
  );
  writeLifecycle(broker.context, broker.paths.lifecyclePath, "active");
  broker.child.unref?.();
  return broker;
}

function removeValidatedBrowserBrokerFifo(fileSystem, fifoPath, label) {
  const stats = lstatIfPresent(fileSystem, fifoPath);
  if (!stats) return true;
  if (!stats.isFIFO() || stats.isSymbolicLink() || permissionBits(stats) !== 0o600) {
    return false;
  }
  try {
    fileSystem.unlinkSync(fifoPath);
    return lstatIfPresent(fileSystem, fifoPath) === null;
  } catch {
    return false;
  }
}

function removeValidatedBrowserBrokerGate(fileSystem, gatePath) {
  const stats = lstatIfPresent(fileSystem, gatePath);
  if (!stats) return true;
  if (!stats.isFile() || stats.isSymbolicLink() || permissionBits(stats) !== 0o600) {
    return false;
  }
  try {
    fileSystem.unlinkSync(gatePath);
    return lstatIfPresent(fileSystem, gatePath) === null;
  } catch {
    return false;
  }
}

export async function cleanupBrowserBroker(broker, options = {}) {
  if (!broker) return { ok: true, seen: false, cleanupEvidence: false };
  const fileSystem = options.fs ?? fs;
  const cleanupRecorded =
    options.cleanupRecorded ?? cleanupRecordedRuyiPageProcess;
  const groupExists = options.processGroupExists ?? processGroupExists;
  const writeLifecycle =
    options.writeLifecycle ?? atomicBrowserBrokerLifecycleState;
  const writeProcessState =
    options.writeProcessState ?? atomicBrowserBrokerProcessState;
  let processCleanup = { ok: true, seen: false, cleanupEvidence: false };
  if (broker.identity) {
    processCleanup = await cleanupRecorded(
      broker.paths.statePath,
      broker.paths.scriptPath,
      broker.context.nonce
    );
  } else if (Number.isInteger(broker.child?.pid) && groupExists(broker.child.pid)) {
    processCleanup = { ok: false, seen: true, cleanupEvidence: false };
  }

  let stateOk = processCleanup.ok;
  const finalState = stateOk ? "inactive" : "cleanup_failed";
  if (broker.identity) {
    try {
      writeProcessState(
        broker.context,
        broker.paths.statePath,
        broker.identity,
        finalState
      );
    } catch {
      stateOk = false;
    }
  }
  if (broker.lifecycleStarted) {
    try {
      writeLifecycle(
        broker.context,
        broker.paths.lifecyclePath,
        stateOk ? "inactive" : "cleanup_failed"
      );
    } catch {
      stateOk = false;
    }
  }
  if (!stateOk) {
    return {
      ok: false,
      seen: processCleanup.seen || Boolean(broker.child),
      cleanupEvidence: false,
    };
  }

  let filesOk = true;
  if (broker.filesystemTouched) {
    for (const [fifoPath, label] of [
      [broker.paths.commandsFifo, "browser broker commands FIFO"],
      [broker.paths.eventsFifo, "browser broker events FIFO"],
    ]) {
      if (!removeValidatedBrowserBrokerFifo(fileSystem, fifoPath, label)) {
        filesOk = false;
      }
    }
    if (!removeValidatedBrowserBrokerGate(fileSystem, broker.paths.launchGatePath)) {
      filesOk = false;
    }
  }
  if (!filesOk) {
    if (broker.identity) {
      try {
        writeProcessState(
          broker.context,
          broker.paths.statePath,
          broker.identity,
          "cleanup_failed"
        );
      } catch {
        /* the failed cleanup result remains authoritative */
      }
    }
    if (broker.lifecycleStarted) {
      try {
        writeLifecycle(
          broker.context,
          broker.paths.lifecyclePath,
          "cleanup_failed"
        );
      } catch {
        /* the failed cleanup result remains authoritative */
      }
    }
  }
  return {
    ok: filesOk,
    seen: processCleanup.seen || Boolean(broker.child),
    cleanupEvidence: processCleanup.cleanupEvidence,
  };
}

export function productionEnvironment(context, brokerPaths) {
  const runtimeTmp = path.posix.join(context.productionDir, "tmp");
  const reportRoot = path.posix.join(context.productionDir, "reports");
  const profileDir = path.posix.join(context.productionDir, "firefox-profile");
  return {
    HOME: context.home,
    USER: context.user,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: `${context.repo}/.runtime/node/bin:${context.home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: runtimeTmp,
    APPLE_AUTOMATION_REPORT_ROOT: reportRoot,
    APPLE_AUTOMATION_ACCEPTANCE_MARKER: path.posix.join(
      reportRoot,
      ".account-home-confirmed"
    ),
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: context.nonce,
    APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE: path.posix.join(
      reportRoot,
      ".ruyipage-process.json"
    ),
    APPLE_AUTOMATION_BROWSER_BROKER_MODE: "1",
    APPLE_AUTOMATION_BROWSER_BROKER_COMMANDS_FIFO: brokerPaths.commandsFifo,
    APPLE_AUTOMATION_BROWSER_BROKER_EVENTS_FIFO: brokerPaths.eventsFifo,
    APPLE_AUTOMATION_HELPER_DIR: context.helperDir,
    FIREFOX_PROFILE_DIR: profileDir,
    BROWSER_PROFILE_MODE: "persistent",
    SKIP_ENV_SETUP: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    TERM_PROGRAM: "Apple_Terminal",
  };
}

export async function runSupervisedTerminalBridge(options = {}) {
  const context = validateEnvironment(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const git = options.fixedGit ?? fixedGit;
  const spawnProcess = options.spawn ?? spawn;
  const startBroker = options.startBrowserBroker ?? startBrowserBroker;
  const cleanupBroker = options.cleanupBrowserBroker ?? cleanupBrowserBroker;
  const output = options.stdout ?? process.stdout;
  const input = options.stdin ?? process.stdin;
  const maxRawLogBytes = options.maxRawLogBytes ?? MAX_RAW_LOG_BYTES;
  let headBefore = null;
  let child = null;
  let outcome = null;
  let productionIdentity = null;
  let productionStatePath = null;
  let productionLaunchGatePath = null;
  let browserBroker = null;
  let cancellationRequested = false;
  const productionCommandMatches = (identity) =>
    identity.command.includes("supervised-production") &&
    identity.command.includes(context.nonce) &&
    identity.command.includes(context.repo);
  const productionIdentityMatches = (identity) =>
    Boolean(productionIdentity && identity.command === productionIdentity.command);
  const requestCancellation = () => {
    cancellationRequested = true;
  };
  const registeredSignals = [];

  try {
    headBefore = git(context.repo, ["rev-parse", "HEAD"]);
    const initialStatus = git(context.repo, ["status", "--porcelain=v1"]);
    if (headBefore !== context.expectedHead || initialStatus !== "") {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 1,
        failureClass: headBefore === context.expectedHead ? "GIT_DIRTY" : "HEAD_MISMATCH",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 1;
    }

    const bridgeIdentity = await waitForFixedProcessIdentity(
      process.pid,
      (identity) =>
        identity.command.includes(
          path.join(context.repo, "scripts", "supervised-terminal-bridge.mjs")
        )
    );
    if (!bridgeIdentity) throw new Error("terminal bridge identity is unavailable");
    fs.writeFileSync(
      path.join(context.controlDir, "supervised-terminal.json"),
      `${JSON.stringify({
        version: 1,
        nonce: context.nonce,
        pid: bridgeIdentity.pid,
        pgid: bridgeIdentity.pgid,
        startedAt: bridgeIdentity.startedAt,
        commandId: TERMINAL_BRIDGE_COMMAND_ID,
        commandSha256: crypto
          .createHash("sha256")
          .update(bridgeIdentity.command, "utf8")
          .digest("hex"),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    atomicAttestation(context, {
      status: "ready",
      observedHeadBefore: headBefore,
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, requestCancellation);
      registeredSignals.push(signal);
    }

    let triggerState = "missing";
    while (now() < context.deadlineMs && triggerState !== "valid") {
      triggerState = readTriggerState(context);
      if (triggerState === "invalid") {
        atomicAttestation(context, {
          status: "failed",
          exitCode: 1,
          failureClass: "TRIGGER_INVALID",
          observedHeadBefore: headBefore,
          observedHeadAfter: headBefore,
        });
        return 1;
      }
      if (cancellationRequested || cancellationIsPresent(context)) {
        atomicAttestation(context, {
          status: "cancelled",
          exitCode: 130,
          failureClass: "CANCELLED",
          observedHeadBefore: headBefore,
          observedHeadAfter: headBefore,
        });
        return 130;
      }
      await wait(POLL_MS);
    }
    if (triggerState !== "valid") {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 124,
        failureClass: "TRIGGER_TIMEOUT",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 124;
    }
    if (cancellationRequested || cancellationIsPresent(context)) {
      atomicAttestation(context, {
        status: "cancelled",
        exitCode: 130,
        failureClass: "CANCELLED",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 130;
    }
    if (now() >= context.deadlineMs) {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 124,
        failureClass: "TRIGGER_TIMEOUT",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 124;
    }
    const preSpawnHead = git(context.repo, ["rev-parse", "HEAD"]);
    const preSpawnStatus = git(context.repo, ["status", "--porcelain=v1"]);
    if (preSpawnHead !== context.expectedHead || preSpawnStatus !== "") {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 1,
        failureClass:
          preSpawnHead === context.expectedHead ? "GIT_DIRTY" : "HEAD_MISMATCH",
        observedHeadBefore: headBefore,
        observedHeadAfter: preSpawnHead,
      });
      return 1;
    }

    let rawBytes = 0;
    let logLimitExceeded = false;
    let outputForwardingFailed = false;
    let markerTail = Buffer.alloc(0);
    let promptTail = Buffer.alloc(0);
    let markerConfirmedInOutput = false;
    let manualPromptVisible = false;
    let manualPromptCount = 0;
    let productionStage = "starting";
    const supervisorStatusProtocol = createSupervisorStatusProtocol();
    const emittedStatuses = new Set();
    const successMarkerBytes = Buffer.from(SUPERVISED_SUCCESS_MARKER, "utf8");
    const manualPromptBytes = Buffer.from(MANUAL_CODE_PROMPT, "utf8");
    const safeWrite = (value) => {
      if (outputForwardingFailed) return;
      try {
        output.write(value);
      } catch {
        outputForwardingFailed = true;
      }
    };
    const emitStatus = (key, value) => {
      if (emittedStatuses.has(key)) return;
      emittedStatuses.add(key);
      safeWrite(`${value}\n`);
    };
    const processSafeLine = (line) => {
      if (line.startsWith("[2FA] status:")) {
        const status = line.slice("[2FA] status:".length);
        if (status === "permission_preflight_start") {
          productionStage = "accessibility_preflight";
        } else if (status === "permission_preflight_ready") {
          productionStage = "accessibility_ready";
        } else if (status === "permission_preflight_missing") {
          productionStage = "accessibility_missing";
          emitStatus(
            "accessibility-missing",
            "[mac:supervised] 原生 2FA helper 未获辅助功能授权；Terminal 已勾选时请同时允许系统新显示的 Codex/helper 项，流程将继续并保留手动验证码兜底"
          );
        } else if (["winner:popup", "winner:settings", "winner:manual"].includes(status)) {
          productionStage = "two_fa_code_acquired";
        } else if (status === "timeout") {
          productionStage = "two_fa_code_unavailable";
        } else if (
          [
            "settings_start",
            "settings_retry",
            "settings_accessibility",
            "manual_allow",
            "manual_code",
            "ocr_permission_missing",
          ].includes(status) &&
          productionStage !== "two_fa_code_acquired"
        ) {
          productionStage = "two_fa_code_pending";
        }
        return;
      }
      if (line.includes(MANUAL_CODE_PROMPT)) {
        if (manualPromptVisible) {
          safeWrite("\n");
          manualPromptVisible = false;
        }
        return;
      }
      if (line === "[ruyipage] status:runtime_resolving") {
        productionStage = "browser_runtime_resolving";
        emitStatus("runtime-resolving", "[mac:supervised] ruyiPage runtime resolving");
        return;
      }
      if (line === "[ruyipage] status:backend_starting") {
        productionStage = "browser_backend_starting";
        emitStatus("backend-starting", "[mac:supervised] ruyiPage backend starting");
        return;
      }
      if (line === "[ruyipage] status:broker_credentials_received") {
        productionStage = "browser_credentials_received";
        emitStatus("broker-connected", "[mac:supervised] ruyiPage broker connected");
        return;
      }
      if (line === "[ruyipage] status:browser_url_validated") {
        productionStage = "browser_url_validated";
        return;
      }
      if (line === "[ruyipage] status:browser_runtime_imported") {
        productionStage = "browser_runtime_imported";
        emitStatus("runtime-imported", "[mac:supervised] ruyiPage runtime imported");
        return;
      }
      if (line === "[ruyipage] status:browser_constructing") {
        productionStage = "browser_constructing";
        emitStatus("browser-constructing", "[mac:supervised] Firefox launch requested by ruyiPage");
        return;
      }
      if (line.startsWith("[ruyipage] status:failure:")) {
        const failureStage = line.slice("[ruyipage] status:failure:".length);
        if (
          [
            "not_started",
            "credentials_received",
            "url_validated",
            "runtime_importing",
            "runtime_imported",
            "browser_constructing",
            "browser_ready",
            "login_navigation",
            "login_page_loaded",
            "login_state_detected",
            "email_wait",
            "email_input",
            "email_submit",
            "password_wait",
            "password_input",
            "remember_account",
            "twofa_prepare",
            "password_submit",
            "twofa_page_wait",
            "twofa_code_wait",
            "twofa_input",
            "signed_in",
            "account_information",
          ].includes(failureStage)
        ) {
          productionStage = `browser_failure:${failureStage}`;
        }
        return;
      }
      if (line === SUPERVISED_SUCCESS_MARKER) {
        emitStatus("success", SUPERVISED_SUCCESS_MARKER);
      } else if (line.startsWith("[Firefox]")) {
        productionStage = "browser_started";
        emitStatus("browser", "[mac:supervised] ruyiPage 浏览器流程已启动");
      } else if (line.startsWith("[ruyipage] 浏览器已就绪")) {
        productionStage = "browser_ready";
        emitStatus("browser-ready", "[mac:supervised] ruyiPage 浏览器已就绪");
      } else if (line.startsWith("[ruyipage] 密码提交前")) {
        productionStage = "two_fa_page_pending";
        emitStatus("2fa-prepare", "[mac:supervised] 正在准备 2FA 自动取码");
      } else if (line.startsWith("[ruyipage] 页面已确认进入 2FA")) {
        productionStage = "two_fa_code_pending";
        emitStatus("2fa-page", "[mac:supervised] 网页已进入 2FA 验证");
      } else if (line.startsWith("[2FA]")) {
        emitStatus("2fa-progress", "[mac:supervised] 2FA 自动取码处理中");
      } else if (line.includes("Apple ID flow failed")) {
        emitStatus("production-failed", "[mac:supervised] Apple Account 登录流程失败");
      }
    };
    const createChunkHandler = ({ inspectPrompt = false, inspectMarker = false } = {}) => {
      const decoder = new StringDecoder("utf8");
      let lineBuffer = "";
      return (chunk) => {
        const buffer = Buffer.from(chunk);
        rawBytes += buffer.length;
        if (rawBytes > maxRawLogBytes) {
          logLimitExceeded = true;
          return;
        }
        if (inspectMarker && !markerConfirmedInOutput) {
          const combined = Buffer.concat([markerTail, buffer]);
          markerConfirmedInOutput = combined.includes(successMarkerBytes);
          markerTail = combined.subarray(
            Math.max(0, combined.length - successMarkerBytes.length + 1)
          );
        }
        if (inspectPrompt && manualPromptCount < 2 && !manualPromptVisible) {
          const combined = Buffer.concat([promptTail, buffer]);
          if (combined.includes(manualPromptBytes)) {
            manualPromptVisible = true;
            manualPromptCount += 1;
            promptTail = Buffer.alloc(0);
            safeWrite(MANUAL_CODE_PROMPT);
          } else {
            promptTail = combined.subarray(
              Math.max(0, combined.length - manualPromptBytes.length + 1)
            );
          }
        }
        lineBuffer += decoder.write(buffer);
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processSafeLine(line);
      };
    };
    const onStdoutChunk = createChunkHandler({ inspectPrompt: true, inspectMarker: true });
    const onStderrChunk = createChunkHandler();
    emitStatus("starting", "[mac:supervised] 受监督 Apple Account 登录已启动");

    browserBroker = createBrowserBroker(context);
    const env = productionEnvironment(context, browserBroker.paths);
    for (const directory of [
      env.TMPDIR,
      env.APPLE_AUTOMATION_REPORT_ROOT,
      env.FIREFOX_PROFILE_DIR,
    ]) {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    }
    if (cancellationRequested || cancellationIsPresent(context)) {
      atomicAttestation(context, {
        status: "cancelled",
        exitCode: 130,
        failureClass: "CANCELLED",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 130;
    }
    if (now() >= context.deadlineMs) {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 124,
        failureClass: "PRODUCTION_TIMEOUT",
        observedHeadBefore: headBefore,
        observedHeadAfter: headBefore,
      });
      return 124;
    }
    const finalHead = git(context.repo, ["rev-parse", "HEAD"]);
    const finalGitStatus = git(context.repo, ["status", "--porcelain=v1"]);
    if (finalHead !== context.expectedHead || finalGitStatus !== "") {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 1,
        failureClass: finalHead === context.expectedHead ? "GIT_DIRTY" : "HEAD_MISMATCH",
        observedHeadBefore: headBefore,
        observedHeadAfter: finalHead,
      });
      return 1;
    }

    productionStatePath = path.join(context.controlDir, "supervised-production.json");
    productionLaunchGatePath = path.join(
      context.controlDir,
      "supervised-production.ready"
    );
    const productionArgs = [
      "sandbox",
      "-p",
      "automation",
      "-c",
      `permissions.supervised_production=${context.permissionProfile}`,
      "-c",
      `shell_environment_policy.include_only=${context.shellEnvironmentPolicy}`,
      "-P",
      "supervised_production",
      "--include-managed-config",
      "-C",
      context.repo,
      "./run.sh",
      "--skip-mac",
    ];
    const supervisorScript = buildProductionProcessSupervisorScript();
    const launchHead = git(context.repo, ["rev-parse", "HEAD"]);
    const launchGitStatus = git(context.repo, ["status", "--porcelain=v1"]);
    if (launchHead !== context.expectedHead || launchGitStatus !== "") {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 1,
        failureClass: launchHead === context.expectedHead ? "GIT_DIRTY" : "HEAD_MISMATCH",
        observedHeadBefore: headBefore,
        observedHeadAfter: launchHead,
      });
      return 1;
    }
    if (cancellationRequested || cancellationIsPresent(context)) {
      atomicAttestation(context, {
        status: "cancelled",
        exitCode: 130,
        failureClass: "CANCELLED",
        observedHeadBefore: headBefore,
        observedHeadAfter: launchHead,
      });
      return 130;
    }
    if (now() >= context.deadlineMs) {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 124,
        failureClass: "PRODUCTION_TIMEOUT",
        observedHeadBefore: headBefore,
        observedHeadAfter: launchHead,
      });
      return 124;
    }
    await startBroker(browserBroker, bridgeIdentity);
    if (
      cancellationRequested ||
      cancellationIsPresent(context) ||
      now() >= context.deadlineMs ||
      git(context.repo, ["rev-parse", "HEAD"]) !== context.expectedHead ||
      git(context.repo, ["status", "--porcelain=v1"]) !== ""
    ) {
      throw new Error("browser broker launch gate was cancelled");
    }
    atomicAttestation(context, {
      status: "running",
      observedHeadBefore: headBefore,
    });
    child = spawnProcess(
      "/bin/zsh",
      [
        "-c",
        supervisorScript,
        "supervised-production",
        String(process.pid),
        String(bridgeIdentity.pgid),
        bridgeIdentity.startedAt,
        bridgeIdentity.command,
        context.nonce,
        productionLaunchGatePath,
        context.cancelPath,
        context.outerCancelPath,
        String(context.deadlineMs),
        context.repo,
        context.expectedHead,
        context.codexBin,
        ...productionArgs,
      ],
      {
        cwd: context.repo,
        detached: true,
        env,
        stdio: [input?.isTTY === true ? input : "ignore", "pipe", "pipe", "pipe"],
      }
    );
    outcome = createOutcome(now);
    const supervisorStatusStream = child.stdio?.[3];
    if (!supervisorStatusStream) {
      throw new Error("production supervisor status stream is unavailable");
    }
    supervisorStatusStream.on("data", (chunk) => supervisorStatusProtocol.push(chunk));
    child.once("error", () => outcome.resolve({ exitCode: 1, signal: null }));
    child.once("close", (exitCode, signal) => outcome.resolve({ exitCode, signal }));
    if (!Number.isInteger(child?.pid) || child.pid <= 0) {
      throw new Error("production process did not start");
    }
    productionIdentity = await waitForFixedProcessIdentity(
      child.pid,
      (identity) =>
        identity.pgid === child.pid &&
        productionCommandMatches(identity)
    );
    if (!productionIdentity) {
      throw new Error("production process identity is unavailable");
    }
    if (
      cancellationRequested ||
      cancellationIsPresent(context) ||
      now() >= context.deadlineMs ||
      git(context.repo, ["rev-parse", "HEAD"]) !== context.expectedHead ||
      git(context.repo, ["status", "--porcelain=v1"]) !== ""
    ) {
      throw new Error("production launch gate was cancelled");
    }
    atomicProductionProcessState(
      context,
      productionStatePath,
      productionIdentity,
      "starting"
    );
    writeProductionLaunchGate(productionLaunchGatePath, child.pid, context.nonce);
    atomicProductionProcessState(
      context,
      productionStatePath,
      productionIdentity,
      "active"
    );
    child.stdout.on("data", onStdoutChunk);
    child.stderr.on("data", onStderrChunk);

    while (
      !outcome.settled &&
      now() < context.deadlineMs &&
      !cancellationRequested &&
      !logLimitExceeded &&
      !outputForwardingFailed
    ) {
      if (cancellationIsPresent(context)) cancellationRequested = true;
      if (!cancellationRequested) {
        await Promise.race([outcome.promise, wait(POLL_MS)]);
      }
    }
    const timedOut =
      now() >= context.deadlineMs &&
      (!outcome.settled || outcome.settledAt >= context.deadlineMs);
    const externalTerminationAttempted =
      !outcome.settled &&
      processGroupExists(child.pid) &&
      processIdentityMatches(productionIdentity, productionIdentityMatches);
    let cleanupSucceeded = await terminateGroup(
      child,
      productionIdentity,
      productionIdentityMatches
    );
    try {
      atomicProductionProcessState(
        context,
        productionStatePath,
        productionIdentity,
        cleanupSucceeded ? "inactive" : "cleanup_failed"
      );
    } catch {
      cleanupSucceeded = false;
    } finally {
      removeSingleFile(productionLaunchGatePath);
    }
    const ruyiPageCleanup = await cleanupBroker(browserBroker);

    const productionExit = Number.isInteger(outcome.value?.exitCode)
      ? outcome.value.exitCode
      : 1;
    const supervisorStatus = supervisorStatusProtocol.finish();
    const supervisorStatusOutcome = classifySupervisorStatus(
      supervisorStatus,
      productionExit,
      { externalTerminationAttempted }
    );
    if (supervisorStatusOutcome === "invalid") {
      outputForwardingFailed = true;
    }
    const headAfter = git(context.repo, ["rev-parse", "HEAD"]);
    const finalStatus = git(context.repo, ["status", "--porcelain=v1"]);
    const markerFile = readBoundedRegularFile(env.APPLE_AUTOMATION_ACCEPTANCE_MARKER, 64);
    const markerValue = markerFile.state === "present" ? markerFile.text.trim() : "";
    const markerConfirmed =
      markerConfirmedInOutput && markerValue === SUPERVISED_ACCEPTANCE_VALUE;
    const processCleanupOutcome = classifyProcessCleanup({
      productionGroupClean: cleanupSucceeded,
      ruyiPageGroupClean: ruyiPageCleanup.ok,
      supervisorStatusOutcome,
      markerConfirmed,
      ruyiPageCleanupEvidence: ruyiPageCleanup.cleanupEvidence,
    });
    const productionStateFile = readBoundedRegularFile(productionStatePath, 512);
    let productionStateConfirmed = false;
    if (productionStateFile.state === "present") {
      try {
        const state = JSON.parse(productionStateFile.text);
        productionStateConfirmed =
          state?.version === 1 &&
          state?.nonce === context.nonce &&
          state?.pid === child.pid &&
          state?.pgid === child.pid &&
          state?.startedAt === productionIdentity?.startedAt &&
          state?.commandId === PRODUCTION_SUPERVISOR_COMMAND_ID &&
          state?.commandSha256 ===
            crypto
              .createHash("sha256")
              .update(productionIdentity.command, "utf8")
              .digest("hex") &&
          ["inactive", "cleanup_failed"].includes(state?.state) &&
          Object.keys(state).sort().join(",") ===
            "commandId,commandSha256,nonce,pgid,pid,startedAt,state,version";
      } catch {
        productionStateConfirmed = false;
      }
    }
    if (manualPromptVisible) {
      safeWrite("\n");
      manualPromptVisible = false;
    }

    let failureClass = "NONE";
    if (processCleanupOutcome === "failed") {
      failureClass = "PROCESS_CLEANUP_FAILED";
    }
    else if (!productionStateConfirmed) failureClass = "INTERNAL_ERROR";
    else if (logLimitExceeded) failureClass = "LOG_LIMIT_EXCEEDED";
    else if (outputForwardingFailed) failureClass = "INTERNAL_ERROR";
    else if (cancellationRequested) failureClass = "CANCELLED";
    else if (timedOut) failureClass = "PRODUCTION_TIMEOUT";
    else if (headAfter !== context.expectedHead) failureClass = "HEAD_MISMATCH";
    else if (finalStatus !== "") failureClass = "GIT_DIRTY";
    else if (productionExit !== 0) {
      if (productionStage === "two_fa_code_acquired") {
        failureClass = "TWO_FA_LOGIN_FAILED";
      } else if (
        ["two_fa_code_pending", "two_fa_code_unavailable"].includes(productionStage)
      ) {
        failureClass = "TWO_FA_CODE_UNAVAILABLE";
      } else if (productionStage === "two_fa_page_pending") {
        failureClass = "TWO_FA_PAGE_FAILED";
      } else if (
        ["accessibility_preflight", "accessibility_missing"].includes(productionStage)
      ) {
        failureClass = "ACCESSIBILITY_PERMISSION_REQUIRED";
      } else if (productionStage === "browser_runtime_resolving") {
        failureClass = "BROWSER_RUNTIME_UNAVAILABLE";
      } else if (productionStage === "browser_failure:credentials_received") {
        failureClass = "BROWSER_URL_VALIDATION_FAILED";
      } else if (
        [
          "browser_failure:url_validated",
          "browser_failure:runtime_importing",
        ].includes(productionStage)
      ) {
        failureClass = "BROWSER_RUNTIME_UNAVAILABLE";
      } else if (
        [
          "browser_failure:runtime_imported",
          "browser_failure:browser_constructing",
          "browser_failure:browser_ready",
        ].includes(productionStage)
      ) {
        failureClass = "BROWSER_LAUNCH_FAILED";
      } else if (productionStage === "browser_failure:login_navigation") {
        failureClass = "BROWSER_PAGE_LOAD_FAILED";
      } else if (
        [
          "browser_failure:login_page_loaded",
          "browser_failure:login_state_detected",
          "browser_failure:email_wait",
          "browser_failure:email_input",
          "browser_failure:email_submit",
          "browser_failure:password_wait",
        ].includes(productionStage)
      ) {
        failureClass = "BROWSER_EMAIL_STEP_FAILED";
      } else if (
        [
          "browser_failure:password_input",
          "browser_failure:remember_account",
          "browser_failure:twofa_prepare",
          "browser_failure:password_submit",
        ].includes(productionStage)
      ) {
        failureClass = "BROWSER_PASSWORD_STEP_FAILED";
      } else if (productionStage === "browser_failure:twofa_page_wait") {
        failureClass = "TWO_FA_PAGE_FAILED";
      } else if (productionStage === "browser_failure:twofa_code_wait") {
        failureClass = "TWO_FA_CODE_UNAVAILABLE";
      } else if (productionStage === "browser_failure:twofa_input") {
        failureClass = "TWO_FA_LOGIN_FAILED";
      } else if (
        [
          "browser_failure:signed_in",
          "browser_failure:account_information",
        ].includes(productionStage)
      ) {
        failureClass = "ACCOUNT_INFORMATION_FAILED";
      } else if (productionStage === "browser_failure:not_started") {
        failureClass = "BROWSER_BROKER_TRANSPORT_FAILED";
      } else if (productionStage === "browser_credentials_received") {
        failureClass = "BROWSER_RUNTIME_UNAVAILABLE";
      } else if (
        ["browser_runtime_imported", "browser_constructing"].includes(
          productionStage
        )
      ) {
        failureClass = "BROWSER_LAUNCH_FAILED";
      } else if (productionStage === "browser_backend_starting") {
        if (
          ["target-identity-ready", "target-exit"].includes(
            browserBroker?.stage
          )
        ) {
          failureClass = "BROWSER_PROCESS_UNRESPONSIVE";
        } else if (browserBroker?.stage === "target-launch") {
          failureClass = "BROWSER_BROKER_TRANSPORT_FAILED";
        } else {
          failureClass = "BROWSER_BROKER_LAUNCH_FAILED";
        }
      } else {
        failureClass = "PRODUCTION_EXIT_NONZERO";
      }
    }
    else if (!markerConfirmed) failureClass = "ACCEPTANCE_EVIDENCE_MISSING";

    const accepted = failureClass === "NONE";
    const cancelled = failureClass === "CANCELLED";
    const attestedExitCode = accepted
      ? 0
      : timedOut
        ? 124
        : cancelled
          ? 130
          : productionExit || 1;
    atomicAttestation(context, {
      status: accepted ? "accepted" : cancelled ? "cancelled" : "failed",
      exitCode: attestedExitCode,
      markerConfirmed,
      failureClass,
      observedHeadBefore: headBefore,
      observedHeadAfter: headAfter,
    });
    if (accepted) {
      emitStatus("accepted", "[mac:supervised] Apple Account 首页验收通过");
    } else {
      if (processCleanupOutcome === "recovered") {
        emitStatus(
          "cleanup-recovered",
          "[mac:supervised] inner cleanup recovered by trusted outer cleanup"
        );
      }
      emitStatus("failed-class", `[mac:supervised] ${failureClass}`);
    }
    return attestedExitCode;
  } catch {
    let cleanupSucceeded = true;
    if (child) {
      cleanupSucceeded = await terminateGroup(
        child,
        productionIdentity,
        productionIdentityMatches
      );
    }
    if (productionStatePath && productionIdentity) {
      try {
        atomicProductionProcessState(
          context,
          productionStatePath,
          productionIdentity,
          cleanupSucceeded ? "inactive" : "cleanup_failed"
        );
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (productionLaunchGatePath) removeSingleFile(productionLaunchGatePath);
    const ruyiPageCleanup = await cleanupBroker(browserBroker);
    cleanupSucceeded = cleanupSucceeded && ruyiPageCleanup.ok;
    const headAfter = git(context.repo, ["rev-parse", "HEAD"]);
    try {
      atomicAttestation(context, {
        status: "failed",
        exitCode: 1,
        markerConfirmed: false,
        failureClass: cleanupSucceeded ? "INTERNAL_ERROR" : "PROCESS_CLEANUP_FAILED",
        observedHeadBefore: headBefore,
        observedHeadAfter: headAfter,
      });
    } catch {
      /* the outer orchestrator will reject missing trusted evidence */
    }
    try {
      output.write(
        `[mac:supervised] ${cleanupSucceeded ? "INTERNAL_ERROR" : "PROCESS_CLEANUP_FAILED"}\n`
      );
    } catch {
      /* Terminal may already be detached */
    }
    return 1;
  } finally {
    for (const signal of registeredSignals) {
      process.removeListener(signal, requestCancellation);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runSupervisedTerminalBridge()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
