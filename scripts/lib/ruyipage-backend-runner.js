import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createConnection as connectToBrowserBroker } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import {
  resolveFirefoxExecutable,
  resolveFirefoxProfileOptions,
} from "./firefox-runtime.js";
import { resolvePythonCommand } from "./ruyipage-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_SCRIPT = path.join(ROOT, "scripts", "ruyipage", "apple_account_flow.py");
const MAX_KILL_GRACE_MS = 5_000;
const RUYIPAGE_PROCESS_STATE_NAME = ".ruyipage-process.json";
export const RUYIPAGE_LIFECYCLE_STATE_NAME = ".ruyipage-lifecycle.json";
const RUYIPAGE_LAUNCH_GATE_NAME = ".ruyipage-launch.ready";
const RUYIPAGE_LAUNCH_CANCEL_NAME = ".ruyipage-launch.cancel";
export const RUYIPAGE_SUPERVISOR_COMMAND_ID = "ruyipage-supervisor-v1";
const DEFAULT_BROWSER_BROKER_CONNECT_TIMEOUT_MS = 60_000;
const BROWSER_BROKER_ERRORS = Object.freeze({
  eof: "ruyipage browser broker socket closed",
  connect: "ruyipage browser broker socket connection failed",
  connectTimeout: "ruyipage browser broker socket connection timed out",
  io: "ruyipage browser broker socket I/O failed",
});
const RUYIPAGE_LIFECYCLE_STATES = new Set([
  "preparing",
  "active",
  "inactive",
  "cleanup_failed",
]);

export function validateRuyiPageLifecycleState(source, expectedNonce) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.nonce !== expectedNonce ||
    !/^[0-9a-f]{32}$/.test(String(value.nonce ?? "")) ||
    !RUYIPAGE_LIFECYCLE_STATES.has(value.state) ||
    Object.keys(value).sort().join(",") !== "nonce,state,version"
  ) {
    return null;
  }
  return value;
}

function resolveRuyiPageProcessStatePath(reportDir, env = process.env) {
  const configured = env.APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE?.trim();
  if (!configured) return null;
  const reportRoot = path.resolve(env.APPLE_AUTOMATION_REPORT_ROOT ?? "");
  const resolvedReportDir = path.resolve(reportDir);
  const relativeReportDir = path.relative(reportRoot, resolvedReportDir);
  const expected = path.join(reportRoot, RUYIPAGE_PROCESS_STATE_NAME);
  if (
    !path.isAbsolute(configured) ||
    path.resolve(configured) !== expected ||
    !relativeReportDir ||
    path.isAbsolute(relativeReportDir) ||
    relativeReportDir === ".." ||
    relativeReportDir.startsWith(`..${path.sep}`)
  ) {
    throw new Error("ruyipage process state path is invalid");
  }
  return expected;
}

function readProcessIdentity(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const readField = (args, maxBuffer = 16 * 1024) => {
    const result = run("/bin/ps", args, { encoding: "utf8", maxBuffer });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
  };
  const pgidText = readField(["-p", String(pid), "-o", "pgid="]);
  const startedAt = readField(["-p", String(pid), "-o", "lstart="]).replace(
    /\s+/g,
    " "
  );
  const command = readField(["-ww", "-p", String(pid), "-o", "command="]);
  const pgid = Number(pgidText);
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

async function waitForProcessIdentity(pid, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const identity = readProcessIdentity(pid);
    if (identity && predicate(identity)) return identity;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}

function writeRuyiPageProcessState(filePath, identity, state, nonce) {
  if (!filePath) return;
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
    /[\r\n\0]/.test(identity.command) ||
    !/^[0-9a-f]{32}$/.test(nonce)
  ) {
    throw new Error("ruyipage process identity is invalid");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      pid: identity.pid,
      pgid: identity.pgid,
      startedAt: identity.startedAt,
      nonce,
      commandId: RUYIPAGE_SUPERVISOR_COMMAND_ID,
      commandSha256: crypto.createHash("sha256").update(identity.command, "utf8").digest("hex"),
      state,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function writeRuyiPageLifecycleState(filePath, state, nonce) {
  if (!filePath) return;
  if (!RUYIPAGE_LIFECYCLE_STATES.has(state) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new Error("ruyipage lifecycle state is invalid");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, nonce, state })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function writeRuyiPageLaunchGate(filePath, pid, nonce) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, nonce, pid })}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }
  );
  fs.renameSync(temporaryPath, filePath);
}

function writeRuyiPageLaunchCancel(filePath) {
  if (!filePath) return;
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* A prior cancellation marker is sufficient. */
    }
  }
}

function removeRuyiPageLaunchGate(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* The gate is single-use and may already be absent after cleanup. */
  }
}

export function buildRuyiPageProcessSupervisorScript() {
  return [
    "set -eu",
    "umask 077",
    "parent_pid=$1",
    "parent_pgid=$2",
    "parent_started_at=$3",
    "parent_command=$4",
    "launch_nonce=$5",
    "deadline_ms=$6",
    "launch_gate=$7",
    "launch_cancel=$8",
    "shift 8",
    "(( ${#launch_nonce} == 32 )) && [[ \"$launch_nonce\" != *[^0-9a-f]* ]] || exit 125",
    "parent_is_current() {",
    "  current_parent_pgid=$(/bin/ps -p \"$parent_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_started_at=$(/bin/ps -p \"$parent_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_parent_command=$(/bin/ps -ww -p \"$parent_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_parent_pgid\" == \"$parent_pgid\" && -n \"$parent_started_at\" && \"$current_started_at\" == \"$parent_started_at\" && -n \"$parent_command\" && \"$current_parent_command\" == \"$parent_command\" ]]",
    "}",
    "launch_is_allowed() {",
    "  parent_is_current || return 125",
    "  [[ ! -e \"$launch_cancel\" ]] || return 130",
    "  (( $(/bin/date +%s) * 1000 < deadline_ms )) || return 124",
    "  return 0",
    "}",
    "expected_gate=\"{\\\"version\\\":1,\\\"nonce\\\":\\\"$launch_nonce\\\",\\\"pid\\\":$$}\"",
    "while :; do",
    "  if launch_is_allowed; then :; else exit $?; fi",
    "  gate_value=''",
    "  if [[ -f \"$launch_gate\" && ! -h \"$launch_gate\" ]]; then gate_value=$(< \"$launch_gate\") || true; fi",
    "  [[ \"$gate_value\" == \"$expected_gate\" ]] && break",
    "  /bin/sleep 0.05",
    "done",
    "if launch_is_allowed; then :; else exit $?; fi",
    "group_snapshot=$(/usr/bin/mktemp \"${TMPDIR:-/tmp}/ruyipage-members.XXXXXX\") || exit 125",
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
    "      if [[ \"$member_pid\" == \"$backend_pid\" ]] && ! target_identity_is_current; then signal_failed=1; continue; fi",
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
    "expected_backend_command=\"$*\"",
    "\"$@\" <&0 >&1 2>&2 &",
    "backend_pid=$!",
    "backend_pgid=''",
    "backend_started_at=''",
    "backend_command=''",
    "capture_target_identity() {",
    "  identity_attempt=0",
    "  while /bin/kill -0 \"$backend_pid\" 2>/dev/null && (( identity_attempt < 100 )); do",
    "    current_backend_pgid=$(/bin/ps -p \"$backend_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "    current_backend_started_at=$(/bin/ps -p \"$backend_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "    current_backend_command=$(/bin/ps -ww -p \"$backend_pid\" -o command= 2>/dev/null || true)",
    "    if [[ \"$current_backend_pgid\" == \"$$\" && -n \"$current_backend_started_at\" && \"$current_backend_command\" == \"$expected_backend_command\" ]]; then",
    "      backend_pgid=$current_backend_pgid",
    "      backend_started_at=$current_backend_started_at",
    "      backend_command=$current_backend_command",
    "      return 0",
    "    fi",
    "    /bin/sleep 0.01",
    "    identity_attempt=$((identity_attempt + 1))",
    "  done",
    "  return 1",
    "}",
    "target_identity_is_current() {",
    "  [[ -n \"$backend_pgid\" && -n \"$backend_started_at\" && -n \"$backend_command\" ]] || return 1",
    "  current_backend_pgid=$(/bin/ps -p \"$backend_pid\" -o pgid= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_started_at=$(/bin/ps -p \"$backend_pid\" -o lstart= 2>/dev/null | /usr/bin/xargs || true)",
    "  current_backend_command=$(/bin/ps -ww -p \"$backend_pid\" -o command= 2>/dev/null || true)",
    "  [[ \"$current_backend_pgid\" == \"$backend_pgid\" && \"$current_backend_pgid\" == \"$$\" && \"$current_backend_started_at\" == \"$backend_started_at\" && \"$current_backend_command\" == \"$backend_command\" && \"$current_backend_command\" == \"$expected_backend_command\" ]]",
    "}",
    "target_identity_ready=0",
    "if capture_target_identity; then",
    "  target_identity_ready=1",
    "elif /bin/kill -0 \"$backend_pid\" 2>/dev/null; then",
    "  /usr/bin/unlink \"$group_snapshot\" 2>/dev/null || true",
    "  exit 125",
    "fi",
    "monitor_runtime() {",
    "  while target_identity_is_current; do",
    "    if launch_is_allowed; then",
    "      /bin/sleep 0.25",
    "      continue",
    "    else",
    "      monitor_status=$?",
    "    fi",
    "    if target_identity_is_current; then",
    "      /bin/kill -TERM \"$backend_pid\" 2>/dev/null || true",
    "    elif /bin/kill -0 \"$backend_pid\" 2>/dev/null; then",
    "      return 125",
    "    else",
    "      return \"$monitor_status\"",
    "    fi",
    "    monitor_attempt=0",
    "    while /bin/kill -0 \"$backend_pid\" 2>/dev/null && (( monitor_attempt < 50 )); do /bin/sleep 0.1; monitor_attempt=$((monitor_attempt + 1)); done",
    "    if /bin/kill -0 \"$backend_pid\" 2>/dev/null; then",
    "      if target_identity_is_current; then",
    "        /bin/kill -KILL \"$backend_pid\" 2>/dev/null || true",
    "      else",
    "        return 125",
    "      fi",
    "    fi",
    "    return \"$monitor_status\"",
    "  done",
    "  /bin/kill -0 \"$backend_pid\" 2>/dev/null && return 125",
    "  return 0",
    "}",
    "monitor_pid=''",
    "if (( target_identity_ready == 1 )); then monitor_runtime & monitor_pid=$!; fi",
    "set +e",
    "wait \"$backend_pid\"",
    "backend_status=$?",
    "monitor_status=0",
    "if [[ \"$monitor_pid\" == <-> ]]; then",
    "  wait \"$monitor_pid\"",
    "  monitor_status=$?",
    "fi",
    "set -e",
    "[[ \"$monitor_status\" == (124|125|130) ]] && backend_status=$monitor_status",
    "(( interrupted_status == 0 )) || backend_status=$interrupted_status",
    "cleanup_status=0",
    "cleanup_group_members || cleanup_status=125",
    "/usr/bin/unlink \"$group_snapshot\" 2>/dev/null || cleanup_status=125",
    "(( cleanup_status == 0 )) || exit \"$cleanup_status\"",
    "exit \"$backend_status\"",
  ].join("\n");
}

/**
 * Create the child-process-shaped transport used by the supervised browser broker.
 * One connected Unix-domain socket carries commands and events as JSONL.
 *
 * @param {{
 *   socketPath: string,
 *   creds: {appleId: string, password: string},
 *   connectTimeoutMs?: number,
 *   createConnection?: typeof connectToBrowserBroker,
 * }} options
 */
export function createBrowserBrokerChild(options) {
  const createConnection = options?.createConnection ?? connectToBrowserBroker;
  const connectTimeoutMs =
    Number.isFinite(options?.connectTimeoutMs) && options.connectTimeoutMs > 0
      ? options.connectTimeoutMs
      : DEFAULT_BROWSER_BROKER_CONNECT_TIMEOUT_MS;
  const child = new EventEmitter();
  const stderr = new PassThrough();
  let socket = null;
  let socketConnected = false;
  let credentialsWritten = false;
  let terminalRequested = false;
  let terminal = false;
  let connectTimer = null;
  let resolveConnected;
  let rejectConnected;
  let resolveClosed;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  void connected.catch(() => {});

  const destroySocket = () => {
    try {
      socket?.destroy();
    } catch {
      /* Socket cleanup remains best-effort and bounded. */
    }
  };
  const finishTerminal = ({ error = null, exitCode = null, signal = null } = {}) => {
    if (terminal) return;
    terminal = true;
    if (connectTimer !== null) clearTimeout(connectTimer);
    connectTimer = null;
    destroySocket();
    if (!stderr.destroyed && !stderr.writableEnded) stderr.end();
    const finalExitCode = error && exitCode == null ? 1 : exitCode;
    child.exitCode = finalExitCode;
    child.signalCode = signal;
    if (!credentialsWritten) {
      rejectConnected(error ?? new Error(BROWSER_BROKER_ERRORS.eof));
    }
    if (error) child.emit("error", error);
    child.emit("exit", finalExitCode, signal);
    child.emit("close", finalExitCode, signal);
    resolveClosed();
  };
  const requestTerminal = (outcome = {}) => {
    if (terminalRequested || terminal) return;
    terminalRequested = true;
    queueMicrotask(() => finishTerminal(outcome));
  };
  const fail = (message) => requestTerminal({ error: new Error(message) });

  Object.assign(child, {
    stdin: null,
    stdout: null,
    stderr,
    pid: undefined,
    exitCode: null,
    signalCode: null,
    killed: false,
    connected,
    cleanup() {
      child.kill("SIGTERM");
      return closed;
    },
    kill(signal = "SIGTERM") {
      if (terminalRequested || terminal) return false;
      child.killed = true;
      destroySocket();
      requestTerminal({ signal: typeof signal === "string" ? signal : "SIGTERM" });
      return true;
    },
    unref() {
      socket?.unref?.();
    },
  });
  child.on("error", () => {});

  try {
    const socketPath = String(options?.socketPath ?? "");
    if (!socketPath || !path.isAbsolute(socketPath) || /[\0\r\n]/.test(socketPath)) {
      throw new Error(BROWSER_BROKER_ERRORS.connect);
    }
    socket = createConnection({ path: socketPath });
    if (
      !socket ||
      typeof socket.once !== "function" ||
      typeof socket.write !== "function" ||
      typeof socket.destroy !== "function"
    ) {
      throw new Error(BROWSER_BROKER_ERRORS.connect);
    }
    child.stdin = socket;
    child.stdout = socket;

    connectTimer = setTimeout(() => {
      destroySocket();
      fail(BROWSER_BROKER_ERRORS.connectTimeout);
    }, connectTimeoutMs);

    socket.once("connect", () => {
      if (terminalRequested || terminal) return;
      socketConnected = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = null;
      const credentialsFrame = {
        type: "credentials",
        appleId: options.creds.appleId,
        password: options.creds.password,
      };
      try {
        socket.write(`${JSON.stringify(credentialsFrame)}\n`, (error) => {
          if (terminalRequested || terminal) return;
          if (error) {
            fail(BROWSER_BROKER_ERRORS.io);
            return;
          }
          credentialsWritten = true;
          resolveConnected();
        });
      } catch {
        fail(BROWSER_BROKER_ERRORS.io);
      }
    });
    socket.once("error", () => {
      fail(
        socketConnected
          ? BROWSER_BROKER_ERRORS.io
          : BROWSER_BROKER_ERRORS.connect
      );
    });
    socket.once("end", () => requestTerminal({ exitCode: 0 }));
    socket.once("close", (hadError) => {
      if (terminalRequested || terminal) return;
      if (hadError) {
        fail(
          socketConnected
            ? BROWSER_BROKER_ERRORS.io
            : BROWSER_BROKER_ERRORS.connect
        );
      } else {
        requestTerminal({ exitCode: 0 });
      }
    });
  } catch {
    fail(BROWSER_BROKER_ERRORS.connect);
  }

  return child;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Invalid JSONL from ruyipage backend");
  }
}

export function resolveBackendTimeouts(env = process.env) {
  const positiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs: positiveNumber(env.RUYIPAGE_BACKEND_TIMEOUT_MS, 720_000),
    killGraceMs: Math.min(
      positiveNumber(env.RUYIPAGE_KILL_GRACE_MS, MAX_KILL_GRACE_MS),
      MAX_KILL_GRACE_MS
    ),
    eventHandlerTimeoutMs: positiveNumber(
      env.RUYIPAGE_EVENT_HANDLER_TIMEOUT_MS,
      30_000
    ),
  };
}

/**
 * @param {{
 *   python?: string|null,
 *   script?: string,
 *   cwd?: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   killGraceMs?: number,
 *   eventHandlerTimeoutMs?: number,
 *   childStopperOptions?: object,
 *   browserBrokerTransportOptions?: object
 * }} [options]
 */
export function createRuyiPageBackendRunner(options = {}) {
  const python = options.python || resolvePythonCommand();
  if (!python) {
    throw new Error("Python 3.10+ with ruyiPage is required. Run ./install.sh first.");
  }
  const script = options.script || DEFAULT_SCRIPT;
  const cwd = options.cwd || ROOT;
  const extraArgs = options.args || [];
  const configuredTimeouts = resolveBackendTimeouts();
  const timeoutMs = options.timeoutMs ?? configuredTimeouts.timeoutMs;
  const requestedKillGraceMs = options.killGraceMs ?? configuredTimeouts.killGraceMs;
  const killGraceMs =
    Number.isFinite(requestedKillGraceMs) && requestedKillGraceMs > 0
      ? Math.min(requestedKillGraceMs, MAX_KILL_GRACE_MS)
      : configuredTimeouts.killGraceMs;
  const eventHandlerTimeoutMs =
    Number.isFinite(options.eventHandlerTimeoutMs) && options.eventHandlerTimeoutMs > 0
      ? options.eventHandlerTimeoutMs
      : configuredTimeouts.eventHandlerTimeoutMs;
  const childStopperOptions = options.childStopperOptions ?? {};
  const browserBrokerTransportOptions = options.browserBrokerTransportOptions ?? {};

  return {
    /**
     * @param {object} params
     * @param {{ appleId: string, password: string }} params.creds
     * @param {string} params.reportDir
     * @param {(event: object) => void|Promise<void>} [params.onEvent]
     * @param {() => Promise<void>} params.prepare2FA
     * @param {(request: {generation: 1|2, rejectPrevious: boolean}) => Promise<string>} params.get2FACode
     */
    run(params) {
      return runRuyiPageBackend({
        python,
        script,
        cwd,
        args: extraArgs,
        timeoutMs,
        killGraceMs,
        eventHandlerTimeoutMs,
        childStopperOptions,
        browserBrokerTransportOptions,
        ...params,
      });
    },
  };
}

export function createChildStopper(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const useProcessGroup = options.useProcessGroup ?? platform !== "win32";
  const graceMs = options.graceMs ?? 5_000;
  const signalProcessGroup = options.signalProcessGroup ?? process.kill;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const now = options.now ?? Date.now;
  const verifyProcessGroupIdentity =
    typeof options.verifyProcessGroupIdentity === "function"
      ? options.verifyProcessGroupIdentity
      : null;
  const processGroupIdentityMatches = () => {
    try {
      return verifyProcessGroupIdentity?.() !== false;
    } catch {
      return false;
    }
  };
  const forceCleanupTimeoutMs =
    Number.isFinite(options.forceCleanupTimeoutMs) && options.forceCleanupTimeoutMs > 0
      ? options.forceCleanupTimeoutMs
      : 2_000;
  const cleanupPollIntervalMs =
    Number.isFinite(options.cleanupPollIntervalMs) && options.cleanupPollIntervalMs > 0
      ? options.cleanupPollIntervalMs
      : 25;
  let forceTimer = null;
  let cleanupPollTimer = null;
  let forceCleanupDeadline = null;
  let stopRequested = false;
  let cleanupPending = false;
  let resolveCleanup = () => {};
  let rejectCleanup = () => {};
  let cleanup = Promise.resolve();

  const settleCleanup = (error = null) => {
    if (!cleanupPending) return;
    cleanupPending = false;
    if (forceTimer != null) cancel(forceTimer);
    if (cleanupPollTimer != null) cancel(cleanupPollTimer);
    forceTimer = null;
    cleanupPollTimer = null;
    if (error) rejectCleanup(error);
    else resolveCleanup();
  };

  const signal = (signalName) => {
    if (useProcessGroup && platform !== "win32" && child.pid) {
      if (!processGroupIdentityMatches()) return;
      try {
        signalProcessGroup(-child.pid, signalName);
        return;
      } catch {
        return;
      }
    }
    try {
      child.kill(signalName);
    } catch {
      /* ignore */
    }
  };

  const processGroupIsAlive = () => {
    if (!useProcessGroup) {
      return child.exitCode == null && child.signalCode == null;
    }
    if (platform === "win32" || !child.pid) return false;
    try {
      signalProcessGroup(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };

  const pollProcessGroupAfterForce = () => {
    if (!cleanupPending) return;
    if (!processGroupIsAlive()) {
      settleCleanup();
      return;
    }
    const remainingMs = forceCleanupDeadline - now();
    if (remainingMs <= 0) {
      settleCleanup(new Error("ruyipage backend cleanup failed"));
      return;
    }
    try {
      cleanupPollTimer = schedule(() => {
        cleanupPollTimer = null;
        pollProcessGroupAfterForce();
      }, Math.min(cleanupPollIntervalMs, remainingMs));
    } catch {
      settleCleanup(new Error("ruyipage backend cleanup failed"));
    }
  };

  return {
    stop() {
      if (stopRequested) return;
      stopRequested = true;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      cleanupPending = true;
      cleanup = new Promise((resolve, reject) => {
        resolveCleanup = resolve;
        rejectCleanup = reject;
      });
      void cleanup.catch(() => {});
      signal(platform === "win32" ? "SIGTERM" : "SIGINT");
      try {
        forceTimer = schedule(() => {
          forceTimer = null;
          signal("SIGKILL");
          if (platform === "win32" || !child.pid) {
            settleCleanup();
            return;
          }
          forceCleanupDeadline = now() + forceCleanupTimeoutMs;
          pollProcessGroupAfterForce();
        }, graceMs);
      } catch {
        settleCleanup(new Error("ruyipage backend cleanup failed"));
      }
    },
    cancelForce() {
      if (cleanupPending && !processGroupIsAlive()) {
        settleCleanup();
      }
    },
    stopIfProcessGroupAlive() {
      if (processGroupIsAlive()) {
        this.stop();
        return true;
      }
      return false;
    },
    waitForCleanup() {
      if (cleanupPending && !processGroupIsAlive()) {
        settleCleanup();
      }
      return cleanup;
    },
  };
}

async function runRuyiPageBackend({
  python,
  script,
  cwd,
  args,
  timeoutMs,
  killGraceMs,
  eventHandlerTimeoutMs,
  childStopperOptions,
  browserBrokerTransportOptions,
  creds,
  reportDir,
  onEvent,
  prepare2FA,
  get2FACode,
}) {
  const processStatePath = resolveRuyiPageProcessStatePath(reportDir);
  const launchGatePath = processStatePath
    ? path.join(path.dirname(processStatePath), RUYIPAGE_LAUNCH_GATE_NAME)
    : null;
  const launchCancelPath = processStatePath
    ? path.join(path.dirname(processStatePath), RUYIPAGE_LAUNCH_CANCEL_NAME)
    : null;
  const lifecycleStatePath = processStatePath
    ? path.join(path.dirname(processStatePath), RUYIPAGE_LIFECYCLE_STATE_NAME)
    : null;
  const backendDeadlineMs = Date.now() + timeoutMs;
  const backendArgs = [
    script,
    "--report-dir",
    reportDir,
    "--profile-dir",
    resolveFirefoxProfileOptions(process.env, path.basename(reportDir || "ruyipage-run"))
      .profileDir,
    "--firefox",
    resolveFirefoxExecutable(),
    ...args,
  ];
  const brokerSocketPath =
    process.env.APPLE_AUTOMATION_BROWSER_BROKER_SOCKET?.trim();
  const usesBrowserBroker = Boolean(brokerSocketPath);
  const usesProcessStateSupervisor =
    !usesBrowserBroker &&
    process.platform !== "win32" &&
    processStatePath !== null &&
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI !== "1";
  const usesOuterProcessSupervisor =
    process.platform !== "win32" &&
    processStatePath !== null &&
    process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const usesLifecycleState = usesProcessStateSupervisor || usesOuterProcessSupervisor;
  const processNonce = usesLifecycleState
    ? String(process.env.APPLE_AUTOMATION_SUPERVISED_TOKEN ?? "")
    : null;
  if (usesLifecycleState && !/^[0-9a-f]{32}$/.test(processNonce)) {
    throw new Error("ruyipage process nonce is unavailable");
  }
  const supervisorScript = buildRuyiPageProcessSupervisorScript();
  const parentProcessIdentity = usesProcessStateSupervisor
    ? readProcessIdentity(process.pid)
    : null;
  if (usesProcessStateSupervisor && !parentProcessIdentity) {
    throw new Error("ruyipage parent process identity is unavailable");
  }
  if (usesLifecycleState) {
    writeRuyiPageLifecycleState(lifecycleStatePath, "preparing", processNonce);
  }
  const child = usesBrowserBroker
    ? createBrowserBrokerChild({
        ...browserBrokerTransportOptions,
        socketPath: brokerSocketPath,
        creds,
        connectTimeoutMs:
          browserBrokerTransportOptions.connectTimeoutMs ??
          Math.min(DEFAULT_BROWSER_BROKER_CONNECT_TIMEOUT_MS, timeoutMs),
      })
    : spawn(
        usesProcessStateSupervisor ? "/bin/zsh" : python,
        usesProcessStateSupervisor
          ? [
              "-c",
              supervisorScript,
              "ruyipage-supervisor",
              String(process.pid),
              String(parentProcessIdentity.pgid),
              parentProcessIdentity.startedAt,
              parentProcessIdentity.command,
              processNonce,
              String(backendDeadlineMs),
              launchGatePath,
              launchCancelPath,
              python,
              ...backendArgs,
            ]
          : backendArgs,
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32" && !usesOuterProcessSupervisor,
          env: {
            ...process.env,
            APPLE_ID: creds.appleId,
            APPLE_PASSWORD: creds.password,
          },
        }
      );

  const stdoutDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stdoutDecoderEnded = false;
  const finishStdoutDecoding = () => {
    if (stdoutDecoderEnded) return;
    stdoutDecoderEnded = true;
    stdoutBuffer += stdoutDecoder.end();
  };
  let finalResult = null;
  let exitCode = null;
  let processingError = null;
  let timedOut = false;
  let acceptingStdout = true;
  let twoFaPrepared = false;
  let twoFaGeneration = 0;
  let childEnded = false;
  let childError = null;
  let processIdentity = null;
  /** @type {Promise<void>} */
  let processing = Promise.resolve();
  const stopper = createChildStopper(child, {
    ...childStopperOptions,
    graceMs: killGraceMs,
    useProcessGroup: !usesBrowserBroker && !usesOuterProcessSupervisor,
    verifyProcessGroupIdentity: usesProcessStateSupervisor
      ? () => {
          if (!processIdentity) return false;
          const current = readProcessIdentity(child.pid);
          return Boolean(
            current &&
              current.pgid === processIdentity.pgid &&
              current.startedAt === processIdentity.startedAt &&
              current.command === processIdentity.command
          );
        }
      : undefined,
  });
  let terminationSignal = null;
  let resolveTermination;
  const terminationOutcome = new Promise((resolve) => {
    resolveTermination = resolve;
  });
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (terminationSignal) return;
      terminationSignal = signal;
      acceptingStdout = false;
      writeRuyiPageLaunchCancel(launchCancelPath);
      stopper.stop();
      resolveTermination();
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const stdinWriteRejectors = new Set();
  let stdinFailure = null;
  const failStdin = () => {
    if (stdinFailure) return stdinFailure;
    stdinFailure = new Error(
      usesBrowserBroker
        ? BROWSER_BROKER_ERRORS.io
        : "ruyipage backend stdin failed"
    );
    processingError ??= stdinFailure;
    for (const rejectWrite of stdinWriteRejectors) rejectWrite(stdinFailure);
    stdinWriteRejectors.clear();
    if (!childEnded) stopper.stop();
    return stdinFailure;
  };
  if (!usesBrowserBroker) child.stdin?.on("error", failStdin);
  let resolveBackendTimeout;
  const backendTimeoutOutcome = new Promise((resolve) => {
    resolveBackendTimeout = resolve;
  });
  const childOutcome = new Promise((resolve) => {
    child.once("error", (error) => {
      childEnded = true;
      childError = error;
      resolve({ error, exitCode: null });
    });
    child.once("exit", (code) => {
      childEnded = true;
      exitCode = code;
      resolve({ error: null, exitCode: code });
    });
  });
  const childCloseOutcome = new Promise((resolve) => {
    child.once("close", (code) => {
      finishStdoutDecoding();
      exitCode = code;
      stopper.cancelForce();
      resolve({ error: childError, exitCode: code });
    });
  });
  if (usesOuterProcessSupervisor) {
    try {
      writeRuyiPageLifecycleState(lifecycleStatePath, "active", processNonce);
    } catch {
      stopper.stop();
      let cleanupFailed = false;
      try {
        await stopper.waitForCleanup();
      } catch {
        cleanupFailed = true;
      } finally {
        try {
          writeRuyiPageLifecycleState(
            lifecycleStatePath,
            cleanupFailed ? "cleanup_failed" : "inactive",
            processNonce
          );
        } catch {
          cleanupFailed = true;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        for (const [signal, handler] of signalHandlers) {
          process.removeListener(signal, handler);
        }
      }
      if (cleanupFailed) throw new Error("ruyipage backend cleanup failed");
      throw new Error("ruyipage lifecycle initialization failed");
    }
  }
  if (usesProcessStateSupervisor) {
    try {
      processIdentity = await waitForProcessIdentity(
        child.pid,
        (identity) =>
          identity.pgid === child.pid &&
          identity.command.includes("ruyipage-supervisor") &&
          identity.command.includes(processNonce) &&
          identity.command.includes(script)
      );
      if (!processIdentity) {
        throw new Error("ruyipage process identity is unavailable");
      }
      if (terminationSignal || Date.now() >= backendDeadlineMs) {
        throw new Error("ruyipage process launch was cancelled");
      }
      writeRuyiPageProcessState(
        processStatePath,
        processIdentity,
        "starting",
        processNonce
      );
      writeRuyiPageLaunchGate(launchGatePath, child.pid, processNonce);
      writeRuyiPageProcessState(
        processStatePath,
        processIdentity,
        "active",
        processNonce
      );
      writeRuyiPageLifecycleState(lifecycleStatePath, "active", processNonce);
    } catch {
      writeRuyiPageLaunchCancel(launchCancelPath);
      stopper.stop();
      let cleanupFailed = false;
      try {
        await stopper.waitForCleanup();
      } catch {
        cleanupFailed = true;
      } finally {
        try {
          writeRuyiPageLifecycleState(
            lifecycleStatePath,
            cleanupFailed ? "cleanup_failed" : "inactive",
            processNonce
          );
        } catch {
          cleanupFailed = true;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        removeRuyiPageLaunchGate(launchGatePath);
        removeRuyiPageLaunchGate(launchCancelPath);
        for (const [signal, handler] of signalHandlers) {
          process.removeListener(signal, handler);
        }
      }
      if (cleanupFailed) throw new Error("ruyipage backend cleanup failed");
      if (terminationSignal) throw new Error("ruyipage backend interrupted");
      throw new Error("ruyipage process state initialization failed");
    }
  }
  const terminalError = (outcome) => {
    if (timedOut) {
      return new Error(`ruyipage backend timed out after ${timeoutMs}ms`);
    }
    if (outcome?.error) return outcome.error;
    return new Error(`ruyipage backend exited ${outcome?.exitCode ?? "unknown"}`);
  };
  const whileChildAlive = async (operation) => {
    if (childEnded) throw terminalError(await childOutcome);
    return Promise.race([
      Promise.resolve().then(operation),
      childOutcome.then((outcome) => {
        throw terminalError(outcome);
      }),
      backendTimeoutOutcome.then(() => {
        throw terminalError();
      }),
    ]);
  };
  const callExternal = (operation, failureMessage) =>
    Promise.resolve()
      .then(operation)
      .catch(() => {
        throw new Error(failureMessage);
      });
  const callOnEvent = async (event) => {
    if (typeof onEvent !== "function") return;

    const safeEventNames = new Set([
      "ready",
      "status",
      "diagnostic",
      "prepare_2fa",
      "need_2fa",
      "warning",
      "result",
    ]);
    const eventName = safeEventNames.has(event?.event) ? event.event : "unknown";
    let handlerTimer;
    const handlerOutcome = callExternal(
      () => onEvent(event),
      "ruyipage event handler failed"
    );
    const handlerTimeout = new Promise((_, reject) => {
      handlerTimer = setTimeout(() => {
        reject(
          new Error(
            `ruyipage onEvent handler timed out for ${eventName} after ${eventHandlerTimeoutMs}ms`
          )
        );
      }, eventHandlerTimeoutMs);
    });
    const candidates = [
      handlerOutcome,
      handlerTimeout,
      backendTimeoutOutcome.then(() => {
        throw terminalError();
      }),
    ];
    const terminalFailureEvent =
      event?.event === "diagnostic" ||
      (event?.event === "status" && event.status === "browser_failure") ||
      event?.event === "result";
    if (!terminalFailureEvent) {
      candidates.push(
        childOutcome.then((outcome) => {
          throw terminalError(outcome);
        })
      );
    }

    try {
      await Promise.race(candidates);
    } finally {
      clearTimeout(handlerTimer);
    }
  };
  const writeCommand = (command) =>
    whileChildAlive(
      () =>
        new Promise((resolve, reject) => {
          const stdin = child.stdin;
          let settled = false;
          const settleWrite = (error = null) => {
            if (settled) return;
            settled = true;
            stdinWriteRejectors.delete(settleWrite);
            if (error) reject(error);
            else resolve();
          };
          if (stdinFailure) {
            settleWrite(stdinFailure);
            return;
          }
          if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
            settleWrite(failStdin());
            return;
          }
          stdinWriteRejectors.add(settleWrite);
          try {
            stdin.write(`${JSON.stringify(command)}\n`, (error) => {
              if (error) failStdin();
              else settleWrite();
            });
          } catch {
            failStdin();
          }
        })
    );
  const timer = setTimeout(() => {
    timedOut = true;
    acceptingStdout = false;
    writeRuyiPageLaunchCancel(launchCancelPath);
    stopper.stop();
    resolveBackendTimeout();
  }, Math.max(1, backendDeadlineMs - Date.now()));

  child.stderr.resume();

  const processLine = async (line) => {
    const event = parseJsonLine(line);
    await callOnEvent(event);
    if (event?.event === "prepare_2fa") {
      if (twoFaPrepared) {
        throw new Error("ruyipage backend requested duplicate 2FA preparation");
      }
      if (typeof prepare2FA !== "function") {
        throw new Error("ruyipage backend requested 2FA preparation without a handler");
      }
      await whileChildAlive(() =>
        callExternal(prepare2FA, "ruyipage 2FA preparation failed")
      );
      twoFaPrepared = true;
      await writeCommand({ type: "2fa_prepared" });
    } else if (event?.event === "need_2fa") {
      if (!twoFaPrepared) {
        throw new Error("ruyipage backend requested a 2FA code before preparation");
      }
      const generation = event.generation;
      if (
        !Number.isInteger(generation) ||
        generation < 1 ||
        generation > 2 ||
        generation !== twoFaGeneration + 1
      ) {
        throw new Error("ruyipage backend sent invalid 2FA generation");
      }
      twoFaGeneration = generation;
      const code = await whileChildAlive(() =>
        callExternal(
          () =>
            get2FACode({
              generation,
              rejectPrevious: generation === 2,
            }),
          "ruyipage 2FA code provider failed"
        )
      );
      await writeCommand({ type: "2fa_code", generation, code });
    }
    if (event?.event === "result") finalResult = event;
  };
  const enqueueLine = (line) => {
    if (!line.trim()) return;
    processing = processing
      .then(() => processLine(line))
      .catch((error) => {
        processingError ??= error;
        if (!childEnded) stopper.stop();
      });
  };

  child.stdout.on("data", (buf) => {
    if (!acceptingStdout) return;
    stdoutBuffer += stdoutDecoder.write(buf);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) enqueueLine(line);
  });
  child.stdout.once("end", finishStdoutDecoding);
  child.stdout.once("close", finishStdoutDecoding);

  let outcome;
  try {
    const completion = await Promise.race([
      childCloseOutcome.then((value) => ({ type: "close", value })),
      backendTimeoutOutcome.then(() => ({ type: "timeout" })),
      terminationOutcome.then(() => ({ type: "termination" })),
    ]);
    if (completion.type === "timeout" || completion.type === "termination") {
      await processing;
    } else {
      outcome = completion.value;
      enqueueLine(stdoutBuffer);
      stdoutBuffer = "";
      await processing;
    }
  } finally {
    clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    let cleanupConfirmed = false;
    try {
      if (!timedOut) stopper.stopIfProcessGroupAlive();
      await stopper.waitForCleanup();
      cleanupConfirmed = true;
    } finally {
      try {
        if (processStatePath && processIdentity) {
          writeRuyiPageProcessState(
            processStatePath,
            processIdentity,
            cleanupConfirmed ? "inactive" : "cleanup_failed",
            processNonce
          );
        }
        if (usesLifecycleState) {
          writeRuyiPageLifecycleState(
            lifecycleStatePath,
            cleanupConfirmed ? "inactive" : "cleanup_failed",
            processNonce
          );
        }
      } finally {
        removeRuyiPageLaunchGate(launchGatePath);
        removeRuyiPageLaunchGate(launchCancelPath);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
  }
  if (terminationSignal) {
    throw new Error("ruyipage backend interrupted");
  }
  if (timedOut) {
    throw new Error(`ruyipage backend timed out after ${timeoutMs}ms`);
  }
  if (processingError) throw processingError;
  if (outcome.error) throw outcome.error;

  if (!finalResult) {
    if (exitCode !== 0) {
      throw new Error(`ruyipage backend exited ${exitCode}`);
    }
    throw new Error(
      usesBrowserBroker
        ? BROWSER_BROKER_ERRORS.eof
        : "ruyipage backend exited without result"
    );
  }
  if (finalResult.success !== true) {
    throw new Error("ruyipage backend failed");
  }
  if (exitCode !== 0) {
    throw new Error(`ruyipage backend exited ${exitCode}`);
  }
  return finalResult;
}
