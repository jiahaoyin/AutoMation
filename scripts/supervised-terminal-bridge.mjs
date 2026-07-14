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
  validateRuyiPageLifecycleState,
} from "./lib/ruyipage-backend-runner.js";

const POLL_MS = 250;
const TERMINATE_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const TERMINAL_BRIDGE_COMMAND_ID = "supervised-terminal-bridge-v1";
const PRODUCTION_SUPERVISOR_COMMAND_ID = "supervised-production-v1";
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

function requireAbsolutePath(value, label) {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return path.resolve(value);
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
      return { ok: true, seen: false, lifecycleSeen: false };
    }
    return {
      ok: lifecycle?.state === "inactive",
      seen: false,
      lifecycleSeen: lifecycle !== null,
    };
  }
  if (file.state !== "present") return { ok: false, seen: true };
  let value;
  try {
    value = JSON.parse(file.text);
  } catch {
    return { ok: false, seen: true };
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
    return { ok: false, seen: true };
  }
  if (!processGroupExists(value.pid)) return { ok: true, seen: true };
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
    return { ok: false, seen: true };
  }
  return {
    ok: await terminateRecordedProcessGroup(identity, identityPredicate),
    seen: true,
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
  ruyiPageStateSeen,
}) {
  if (
    productionGroupClean !== true ||
    ruyiPageGroupClean !== true
  ) {
    return "failed";
  }
  if (markerConfirmed === true && ruyiPageStateSeen !== true) return "failed";
  return supervisorStatusOutcome === "cleanup_failed" ? "recovered" : "clean";
}

function productionEnvironment(context) {
  const runtimeTmp = path.join(context.productionDir, "tmp");
  const reportRoot = path.join(context.productionDir, "reports");
  const profileDir = path.join(context.productionDir, "firefox-profile");
  return {
    HOME: context.home,
    USER: context.user,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: `${context.repo}/.runtime/node/bin:${context.home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: runtimeTmp,
    APPLE_AUTOMATION_REPORT_ROOT: reportRoot,
    APPLE_AUTOMATION_ACCEPTANCE_MARKER: path.join(reportRoot, ".account-home-confirmed"),
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: context.nonce,
    APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE: path.join(
      reportRoot,
      ".ruyipage-process.json"
    ),
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
  const output = options.stdout ?? process.stdout;
  const input = options.stdin ?? process.stdin;
  const maxRawLogBytes = options.maxRawLogBytes ?? MAX_RAW_LOG_BYTES;
  let headBefore = null;
  let child = null;
  let outcome = null;
  let productionIdentity = null;
  let productionStatePath = null;
  let productionLaunchGatePath = null;
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

    const env = productionEnvironment(context);
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

    atomicAttestation(context, {
      status: "running",
      observedHeadBefore: headBefore,
    });
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
    const ruyiPageCleanup = await cleanupRecordedRuyiPageProcess(
      env.APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE,
      path.join(context.repo, "scripts", "ruyipage", "apple_account_flow.py"),
      context.nonce
    );

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
      ruyiPageStateSeen: ruyiPageCleanup.seen,
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
    const ruyiPageCleanup = await cleanupRecordedRuyiPageProcess(
      path.join(context.productionDir, "reports", ".ruyipage-process.json"),
      path.join(context.repo, "scripts", "ruyipage", "apple_account_flow.py"),
      context.nonce
    );
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
