#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import {
  SUPERVISED_ACCOUNT_MODE,
  SUPERVISED_COMMAND_ID,
  SUPERVISED_MODE_ENV_KEY,
  SUPERVISED_MODES,
  SUPERVISED_NODE_FAILURES,
  SUPERVISED_PRODUCTION_ENV_POLICY,
  SUPERVISED_PRODUCTION_STAGES,
  SUPERVISED_SETTINGS_SMOKE_MODE,
  SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS,
  SUPERVISED_SETTINGS_PROVIDER_STATES,
  SUPERVISED_SUCCESS_MARKER,
  SUPERVISED_STDOUT_STAGE_TOKENS,
  createSupervisedProductionPermissionProfile,
  createSupervisedAttestation,
  supervisedAcceptanceValueForMode,
  supervisedSuccessMarkerForMode,
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
const BROWSER_BROKER_CONNECT_TIMEOUT_MS = 60_000;
const BROWSER_BROKER_LISTEN_TIMEOUT_MS = 5_000;
const BROWSER_BROKER_CLOSE_TIMEOUT_MS = 2_000;
const MAX_RAW_LOG_BYTES = 1024 * 1024;
const SETTINGS_HELPER_NAME = "mac-settings-2fa-code";
const SETTINGS_AUDIT_NAME = "2fa-audit.jsonl";
const MAX_SETTINGS_AUDIT_BYTES = 64 * 1024;
const MAX_SETTINGS_AUDIT_LINES = 256;
const MAX_SETTINGS_REPORT_ENTRIES = 8;
const MAX_SETTINGS_PROCESS_MEMBERS = 512;
const SETTINGS_REPORT_DIRECTORY_NAME =
  /^apple-id-flow-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const SETTINGS_AUDIT_PHASES = new Set([
  "settings_provider_start",
  "settings_provider_failed",
  "settings_provider_cancelled",
  "settings_provider_result",
  "2fa_winner",
]);
const MANUAL_CODE_PROMPT =
  "[2FA] 自动取码仍未完成，请输入 Mac 上显示的 6 位验证码: ";
const RUYIPAGE_FAILURE_STAGES = new Set(
  [...SUPERVISED_PRODUCTION_STAGES]
    .filter((stage) => stage.startsWith("browser_failure:"))
    .map((stage) => stage.slice("browser_failure:".length))
);
const TWO_FA_PENDING_STATUSES = new Set([
  "settings_start",
  "settings_retry",
  "settings_accessibility",
  "settings_failed",
  "manual_allow",
  "manual_code",
  "manual_unavailable",
  "ocr_permission_missing",
  "popup_accessibility",
  "popup_scanning",
  "popup_close_pending",
]);
const SUPERVISED_TWO_FA_STATUS_MESSAGES = Object.freeze({
  native_helper_accessibility_granted:
    "[mac:supervised] 原生 2FA helper 的辅助功能授权已确认",
  native_helper_accessibility_missing:
    "[mac:supervised] 原生 2FA helper 尚未获辅助功能授权；请以 macOS 弹窗或辅助功能列表实际显示的条目为准，不要只依据其他终端或宿主应用的勾选状态",
  native_helper_accessibility_probe_unavailable:
    "[mac:supervised] 原生 2FA helper 的辅助功能状态暂时无法探测；OCR、系统设置与手动兜底仍会继续",
  settings_accessibility:
    "[mac:supervised] 系统设置取码需要辅助功能授权，正在请求 macOS 授权",
  settings_retry:
    "[mac:supervised] 系统设置取码正在进行受限重试；其他可用取码路径仍在继续",
  settings_failed:
    "[mac:supervised] 系统设置取码未成功；其他可用取码路径仍在继续",
  popup_close_pending:
    "[mac:supervised] 原生弹窗验证码已读取，正在后台清理弹窗并继续网页登录",
  popup_scanning:
    "[mac:supervised] 网页已请求验证码；正在对受限 Apple 原生窗口进行持续读码",
  screen_recording_ready:
    "[mac:supervised] 屏幕录制 OCR 权限已就绪，可作为原生弹窗读码回退",
  screen_recording_missing:
    "[mac:supervised] 屏幕录制 OCR 尚未获授权，浏览器尚未启动；请允许后重新运行",
  screen_recording_unavailable:
    "[mac:supervised] 屏幕录制 OCR helper 暂不可用，浏览器尚未启动；请先运行 install.sh 修复环境",
});
const SUPERVISED_TWO_FA_WINNER_MESSAGES = Object.freeze({
  "winner:popup":
    "[mac:supervised] 已从原生 Apple 验证码弹窗取得验证码，正在继续网页登录",
  "winner:settings":
    "[mac:supervised] 已通过系统设置取得验证码，正在继续网页登录",
  "winner:manual":
    "[mac:supervised] 已收到终端隐藏输入的验证码，正在继续网页登录",
});

export function supervisedTwoFaStatusMessage(status) {
  return typeof status === "string" &&
    Object.hasOwn(SUPERVISED_TWO_FA_STATUS_MESSAGES, status)
    ? SUPERVISED_TWO_FA_STATUS_MESSAGES[status]
    : null;
}

export function supervisedTwoFaWinnerMessage(status) {
  return typeof status === "string" &&
    Object.hasOwn(SUPERVISED_TWO_FA_WINNER_MESSAGES, status)
    ? SUPERVISED_TWO_FA_WINNER_MESSAGES[status]
    : null;
}

export function createProductionProtocolState() {
  let productionStage = "not_started";
  let nodeFailure = "none";
  let accessibilityPreflight = "unknown";
  let settingsProviderState = "not_started";
  let settingsProviderAttempt = 0;
  let settingsProviderFailureReason = "none";

  const recordSettingsRequestCreated = (attempt) => {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) return false;
    if (attempt < settingsProviderAttempt) return true;
    if (attempt === settingsProviderAttempt) return true;
    if (
      attempt !== settingsProviderAttempt + 1 ||
      ["winner", "cancelled"].includes(settingsProviderState)
    ) {
      return false;
    }
    settingsProviderState = "request_created";
    settingsProviderAttempt = attempt;
    settingsProviderFailureReason = "none";
    return true;
  };

  const recordSettingsTerminalState = (state, attempt, reason = "none") => {
    if (
      !["failed", "cancelled", "winner"].includes(state) ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > 2 ||
      !SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS.has(reason)
    ) {
      return false;
    }
    if (attempt < settingsProviderAttempt) return true;
    if (attempt !== settingsProviderAttempt || settingsProviderAttempt === 0) {
      return false;
    }
    if (settingsProviderState === "winner" || settingsProviderState === "cancelled") {
      return true;
    }
    if (settingsProviderState === "failed") {
      return state === "failed" && settingsProviderFailureReason === reason;
    }
    if (state === "failed" && reason === "none") return false;
    if (state !== "failed" && reason !== "none") return false;
    settingsProviderState = state;
    settingsProviderFailureReason = reason;
    return true;
  };

  const processSettingsAuditEvent = (event) => {
    if (!event || typeof event !== "object") return false;
    switch (event.phase) {
      case "settings_provider_start":
        return recordSettingsRequestCreated(event.attempt);
      case "settings_provider_failed":
        return recordSettingsTerminalState("failed", event.attempt, event.reason);
      case "settings_provider_cancelled":
        return recordSettingsTerminalState("cancelled", event.attempt);
      case "settings_provider_result":
        return Number.isInteger(event.attempt) && event.attempt === settingsProviderAttempt;
      case "2fa_winner":
        return recordSettingsTerminalState("winner", event.attempt);
      default:
        return false;
    }
  };

  const processStdoutLine = (line) => {
    if (typeof line !== "string") return false;
    if (line === SUPERVISED_SUCCESS_MARKER) return true;

    const stagePrefix = "[apple-automation] stage:";
    if (line.startsWith(stagePrefix)) {
      const stage = line.slice(stagePrefix.length);
      if (SUPERVISED_STDOUT_STAGE_TOKENS.has(stage)) {
        productionStage = stage;
        return true;
      }
      return false;
    }

    const twoFaPrefix = "[2FA] status:";
    if (line.startsWith(twoFaPrefix)) {
      const status = line.slice(twoFaPrefix.length);
      if (status === "native_helper_accessibility_granted") {
        accessibilityPreflight = "ready";
        productionStage = "accessibility_ready";
        return true;
      }
      if (status === "native_helper_accessibility_missing") {
        accessibilityPreflight = "missing";
        productionStage = "accessibility_missing";
        return true;
      }
      if (status === "native_helper_accessibility_probe_unavailable") {
        productionStage = "accessibility_preflight";
        return true;
      }
      if (status === "permission_preflight_start") {
        productionStage = "accessibility_preflight";
        return true;
      }
      if (status === "permission_preflight_prompted") {
        productionStage = "accessibility_prompted";
        return true;
      }
      if (status === "permission_preflight_ready") {
        accessibilityPreflight = "ready";
        productionStage = "accessibility_ready";
        return true;
      }
      if (status === "permission_preflight_missing") {
        accessibilityPreflight = "missing";
        productionStage = "accessibility_missing";
        return true;
      }
      if (["winner:popup", "winner:settings", "winner:manual"].includes(status)) {
        if (status === "winner:settings") {
          recordSettingsTerminalState("winner", settingsProviderAttempt);
        }
        productionStage = "two_fa_code_acquired";
        return true;
      }
      if (status === "timeout") {
        productionStage = "two_fa_code_unavailable";
        return true;
      }
      if (status === "screen_recording_ready") return true;
      if (status === "screen_recording_missing") {
        productionStage = "accessibility_missing";
        return true;
      }
      if (status === "screen_recording_unavailable") {
        productionStage = "accessibility_preflight";
        return true;
      }
      if (TWO_FA_PENDING_STATUSES.has(status)) {
        if (status === "settings_start") {
          recordSettingsRequestCreated(settingsProviderAttempt + 1);
        }
        if (productionStage !== "two_fa_code_acquired") {
          productionStage = "two_fa_code_pending";
        }
        return true;
      }
      return false;
    }

    const ruyiStatusPrefix = "[ruyipage] status:";
    if (line.startsWith(ruyiStatusPrefix)) {
      const status = line.slice(ruyiStatusPrefix.length);
      const fixedStages = new Map([
        ["runtime_resolving", "browser_runtime_resolving"],
        ["backend_starting", "browser_backend_starting"],
        ["broker_credentials_received", "browser_credentials_received"],
        ["browser_url_validated", "browser_url_validated"],
        ["browser_runtime_imported", "browser_runtime_imported"],
        ["browser_constructing", "browser_constructing"],
      ]);
      if (fixedStages.has(status)) {
        productionStage = fixedStages.get(status);
        return true;
      }
      if (status.startsWith("failure:")) {
        const failureStage = status.slice("failure:".length);
        if (RUYIPAGE_FAILURE_STAGES.has(failureStage)) {
          productionStage = `browser_failure:${failureStage}`;
          return true;
        }
        return false;
      }
      if (status.startsWith("node-failure:")) {
        const failure = status.slice("node-failure:".length);
        if (failure !== "none" && SUPERVISED_NODE_FAILURES.has(failure)) {
          nodeFailure = failure;
          return true;
        }
      }
    }
    return false;
  };

  return {
    processStdoutLine,
    processSettingsAuditEvent,
    observeSettingsHelperSpawned() {
      if (
        settingsProviderState !== "request_created" ||
        settingsProviderAttempt < 1 ||
        settingsProviderAttempt > 2
      ) {
        return false;
      }
      settingsProviderState = "helper_spawned";
      return true;
    },
    get productionStage() {
      return productionStage;
    },
    get nodeFailure() {
      return nodeFailure;
    },
    get accessibilityPreflight() {
      return accessibilityPreflight;
    },
    get settingsProviderState() {
      return settingsProviderState;
    },
    get settingsProviderAttempt() {
      return settingsProviderAttempt;
    },
    get settingsProviderFailureReason() {
      return settingsProviderFailureReason;
    },
  };
}

export function drainProductionStderr(chunk) {
  return Buffer.from(chunk).length;
}

export function supervisedTtyCapability(input) {
  return input?.isTTY === true && typeof input.setRawMode === "function"
    ? "available"
    : "unavailable";
}

export function productionStdinForSupervisedInput(input, ttyCapability) {
  return ttyCapability === "available" ? input : "ignore";
}

export function supervisedTwoFaDetail({
  failureClass,
  ttyCapability,
  manualPromptObserved,
}) {
  if (failureClass !== "TWO_FA_CODE_UNAVAILABLE") return "none";
  if (manualPromptObserved) return "manual_prompt_timeout";
  if (ttyCapability === "unavailable") return "manual_tty_unavailable";
  return "automatic_code_unavailable";
}

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

export function resolveSupervisedHelperDirectory(homeDirectory) {
  const home = requireAbsolutePath(homeDirectory, "home directory");
  return path.join(home, ".apple-automation", "supervised-helpers");
}

export function validateSupervisedHelperDirectory(helperDirectory, homeDirectory) {
  const helperDir = requireAbsolutePath(helperDirectory, "helper directory");
  const expected = resolveSupervisedHelperDirectory(homeDirectory);
  if (helperDir !== expected) {
    throw new Error("helper directory is invalid");
  }
  return helperDir;
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

function assertPrivateSocket(fileSystem, socketPath, label) {
  const stats = fileSystem.lstatSync(socketPath);
  if (!stats.isSocket() || stats.isSymbolicLink() || permissionBits(stats) !== 0o600) {
    throw new Error(`${label} is invalid`);
  }
}

function createPrivateDirectory(fileSystem, directory, label) {
  if (lstatIfPresent(fileSystem, directory)) throw new Error(`${label} already exists`);
  fileSystem.mkdirSync(directory, { recursive: false, mode: 0o700 });
  fileSystem.chmodSync(directory, 0o700);
  assertPrivateDirectory(fileSystem, directory, label);
}

export function resolveBrowserBrokerPaths({ repo, productionDir, nonce }) {
  const resolvedRepo = requireAbsolutePosixPath(repo, "repository");
  const resolvedProductionDir = requireAbsolutePosixPath(
    productionDir,
    "production directory"
  );
  const brokerDir = path.posix.join(resolvedProductionDir, "browser-broker");
  const reportDir = path.posix.join(brokerDir, "report");
  const reportScreenshotsDir = path.posix.join(reportDir, "screenshots");
  if (!/^[0-9a-f]{32}$/.test(String(nonce ?? ""))) {
    throw new Error("browser broker nonce is invalid");
  }
  const socketPath = `/tmp/apple-automation-${nonce}.sock`;
  const launchGatePath = path.posix.join(brokerDir, "broker.ready");
  const reportRoot = path.posix.join(resolvedProductionDir, "reports");
  const values = {
    repo: resolvedRepo,
    productionDir: resolvedProductionDir,
    nonce,
    reportRoot,
    brokerDir,
    reportDir,
    reportScreenshotsDir,
    stagePath: path.posix.join(reportDir, ".browser-stage.json"),
    socketPath,
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
  if (values.socketPath !== `/tmp/apple-automation-${values.nonce}.sock`) {
    throw new Error("browser broker socket is out of scope");
  }
  for (const [candidate, parent, label] of [
    [values.brokerDir, values.productionDir, "browser broker directory"],
    [values.reportDir, values.brokerDir, "browser broker report directory"],
    [
      values.reportScreenshotsDir,
      values.reportDir,
      "browser broker screenshots directory",
    ],
    [values.stagePath, values.reportDir, "browser stage file"],
    [values.launchGatePath, values.brokerDir, "browser broker launch gate"],
    [values.statePath, values.reportRoot, "ruyipage process state"],
    [values.lifecyclePath, values.reportRoot, "ruyipage lifecycle state"],
    [values.pythonPath, values.repo, "ruyipage Python"],
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
  validateBrowserBrokerPathScope(paths);
  assertPrivateDirectory(fileSystem, paths.profileDir, "Firefox profile directory");
  for (const [directory, label] of [
    [paths.brokerDir, "browser broker directory"],
    [paths.reportDir, "browser broker report directory"],
    [paths.reportScreenshotsDir, "browser broker screenshots directory"],
  ]) {
    createPrivateDirectory(fileSystem, directory, label);
  }
  if (lstatIfPresent(fileSystem, paths.socketPath)) {
    throw new Error("browser broker socket already exists");
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

function isBoundedAuditTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  );
}

function isBoundedAuditElapsed(value) {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60 * 60 * 1000
  );
}

function parseSettingsAuditLine(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 1024) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!SETTINGS_AUDIT_PHASES.has(value.phase)) return null;
  const keys = Object.keys(value);
  const hasOnly = (allowed) => keys.every((key) => allowed.has(key));
  if (!isBoundedAuditTimestamp(value.ts) || !isBoundedAuditElapsed(value.elapsedSincePrepareMs)) {
    return null;
  }
  switch (value.phase) {
    case "settings_provider_start":
      return hasOnly(new Set(["ts", "phase", "elapsedSincePrepareMs"]))
        ? { phase: value.phase }
        : null;
    case "settings_provider_failed":
      return hasOnly(new Set(["ts", "phase", "reason", "elapsedSincePrepareMs"])) &&
        SUPERVISED_SETTINGS_PROVIDER_FAILURE_REASONS.has(value.reason) &&
        value.reason !== "none"
        ? { phase: value.phase, reason: value.reason }
        : null;
    case "settings_provider_cancelled":
      return hasOnly(new Set(["ts", "phase", "reason", "elapsedSincePrepareMs"])) &&
        value.reason === "cancelled"
        ? { phase: value.phase }
        : null;
    case "settings_provider_result":
      return hasOnly(new Set(["ts", "phase", "outcome", "elapsedSincePrepareMs"])) &&
        value.outcome === "candidate_ready"
        ? { phase: value.phase }
        : null;
    case "2fa_winner":
      return hasOnly(new Set(["ts", "phase", "source", "elapsedSincePrepareMs"])) &&
        value.source === "settings"
        ? { phase: value.phase }
        : null;
    default:
      return null;
  }
}

export function readSettingsProviderAudit(reportRoot) {
  if (typeof reportRoot !== "string" || !path.isAbsolute(reportRoot)) return [];
  try {
    const resolvedRoot = path.resolve(reportRoot);
    const rootStats = fs.lstatSync(resolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return [];
    const rootEntries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    if (rootEntries.length > MAX_SETTINGS_REPORT_ENTRIES) return [];
    const reportDirectories = rootEntries.filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        SETTINGS_REPORT_DIRECTORY_NAME.test(entry.name)
    );
    if (reportDirectories.length !== 1) return [];
    const reportDirectory = path.resolve(resolvedRoot, reportDirectories[0].name);
    if (!pathIsWithin(resolvedRoot, reportDirectory)) return [];
    const reportStats = fs.lstatSync(reportDirectory);
    if (!reportStats.isDirectory() || reportStats.isSymbolicLink()) return [];
    const auditPath = path.join(reportDirectory, SETTINGS_AUDIT_NAME);
    const auditFile = readBoundedRegularFile(auditPath, MAX_SETTINGS_AUDIT_BYTES);
    if (auditFile.state !== "present") return [];
    const lines = auditFile.text.split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_SETTINGS_AUDIT_LINES) return [];
    const events = [];
    let attempt = 0;
    for (const line of lines) {
      const event = parseSettingsAuditLine(line);
      if (!event) continue;
      if (event.phase === "settings_provider_start") {
        attempt += 1;
        if (attempt > 2) return [];
        events.push({ phase: event.phase, attempt });
        continue;
      }
      if (attempt === 0) continue;
      if (event.phase === "settings_provider_failed") {
        events.push({ phase: event.phase, attempt, reason: event.reason });
      } else {
        events.push({ phase: event.phase, attempt });
      }
    }
    return events;
  } catch {
    return [];
  }
}

function fixedProcessGroupMemberPids(pgid) {
  try {
    const result = spawnSync("/bin/ps", ["-ax", "-o", "pid=", "-o", "pgid="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) return null;
    const lines = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_SETTINGS_PROCESS_MEMBERS * 16) return null;
    const members = [];
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match || Number(match[2]) !== pgid) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      members.push(pid);
      if (members.length > MAX_SETTINGS_PROCESS_MEMBERS) return null;
    }
    return members;
  } catch {
    return null;
  }
}

function fixedProcessExecutable(pid) {
  try {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid=", "-o", "comm="], {
      encoding: "utf8",
      maxBuffer: 4096,
    });
    if (result.status !== 0) return null;
    const match = /^\s*(\d+)\s+([^\r\n\0]+)\s*$/.exec(String(result.stdout ?? ""));
    if (!match) return null;
    const pgid = Number(match[1]);
    const executable = match[2];
    if (!Number.isInteger(pgid) || pgid <= 0 || executable.length > 2048) return null;
    return { pgid, executable };
  } catch {
    return null;
  }
}

export function hasTrustedSettingsHelperProcess(
  productionIdentity,
  helperPath,
  dependencies = {}
) {
  if (
    !Number.isInteger(productionIdentity?.pid) ||
    productionIdentity.pid <= 0 ||
    !Number.isInteger(productionIdentity?.pgid) ||
    productionIdentity.pgid <= 0 ||
    typeof helperPath !== "string" ||
    !path.isAbsolute(helperPath) ||
    helperPath.length > 2048 ||
    /[\r\n\0]/.test(helperPath)
  ) {
    return false;
  }
  const listMembers = dependencies.listProcessGroupMembers ?? fixedProcessGroupMemberPids;
  const inspectProcess = dependencies.inspectProcess ?? fixedProcessExecutable;
  let members;
  try {
    members = listMembers(productionIdentity.pgid);
  } catch {
    return false;
  }
  if (!Array.isArray(members) || members.length > MAX_SETTINGS_PROCESS_MEMBERS) return false;
  const expectedPath = path.resolve(helperPath);
  for (const pid of members) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === productionIdentity.pid) continue;
    let candidate;
    try {
      candidate = inspectProcess(pid);
    } catch {
      return false;
    }
    if (
      candidate?.pgid === productionIdentity.pgid &&
      candidate.executable === expectedPath
    ) {
      return true;
    }
  }
  return false;
}

export function observeTrustedSettingsHelperSpawn(
  productionProtocol,
  productionIdentity,
  helperPath,
  dependencies = {}
) {
  if (
    !productionProtocol ||
    productionProtocol.settingsProviderState !== "request_created" ||
    typeof productionProtocol.observeSettingsHelperSpawned !== "function"
  ) {
    return false;
  }
  if (
    !hasTrustedSettingsHelperProcess(
      productionIdentity,
      helperPath,
      dependencies
    )
  ) {
    return false;
  }
  return productionProtocol.observeSettingsHelperSpawned();
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
  const home = requireAbsolutePath(env.HOME, "home directory");
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
  const helperDir = validateSupervisedHelperDirectory(
    env.APPLE_AUTOMATION_HELPER_DIR,
    home
  );
  const nonce = env.APPLE_AUTOMATION_SUPERVISED_TOKEN ?? "";
  const mode = env[SUPERVISED_MODE_ENV_KEY] ?? "";
  const expectedHead = env.APPLE_AUTOMATION_EXPECTED_HEAD ?? "";
  const deadlineMs = Number(env.APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS);
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("nonce is invalid");
  if (!SUPERVISED_MODES.has(mode)) throw new Error("supervised mode is invalid");
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
  ]) {
    if (!pathIsWithin(parent, candidate)) throw new Error(`${label} is out of scope`);
  }
  if (
    pathIsWithin(writableTmp, controlDir) ||
    pathIsWithin(writableTmp, attestationPath) ||
    pathIsWithin(writableTmp, productionDir)
  ) {
    throw new Error("protected supervised path is writable by the model");
  }
  for (const [directory, label] of [
    [repo, "repository"],
    [controlDir, "control directory"],
    [writableTmp, "writable tmp"],
    [productionDir, "production directory"],
    [path.dirname(helperDir), "helper root"],
    [helperDir, "helper directory"],
  ]) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} is invalid`);
    }
  }
  const permissionProfile = env.APPLE_AUTOMATION_PRODUCTION_PERMISSION_PROFILE ?? "";
  if (
    permissionProfile !==
    createSupervisedProductionPermissionProfile(productionDir, nonce, mode)
  ) {
    throw new Error("production permission profile is invalid");
  }
  const shellEnvironmentPolicy = env.APPLE_AUTOMATION_PRODUCTION_ENV_POLICY ?? "";
  if (shellEnvironmentPolicy !== SUPERVISED_PRODUCTION_ENV_POLICY) {
    throw new Error("production environment policy is invalid");
  }
  return {
    home,
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
    mode,
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
  if (values.mode !== undefined && values.mode !== context.mode) {
    throw new Error("attestation mode does not match trusted mode");
  }
  const attestation = createSupervisedAttestation({
    nonce: context.nonce,
    expectedHead: context.expectedHead,
    ttyCapability: values.ttyCapability ?? context.ttyCapability ?? "unknown",
    mode: context.mode,
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

function readTrigger(context) {
  const file = readBoundedRegularFile(context.triggerPath, 256);
  if (file.state !== "present") return { state: file.state, mode: null };
  try {
    const value = JSON.parse(file.text);
    const valid =
      value?.version === 1 &&
      value?.nonce === context.nonce &&
      value?.commandId === SUPERVISED_COMMAND_ID &&
      value?.mode === context.mode &&
      Object.keys(value).sort().join(",") === "commandId,mode,nonce,version";
    return { state: valid ? "valid" : "invalid", mode: valid ? value.mode : null };
  } catch {
    return { state: "invalid", mode: null };
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
    "shift 9",
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
    "\"$@\" 3>&- <&0 >&1 2>/dev/null &",
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
    APPLE_AUTOMATION_BROWSER_BROKER_SOCKET: paths.socketPath,
    APPLE_AUTOMATION_BROWSER_STAGE_FILE: paths.stagePath,
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

function recordBrowserBrokerTransportError(broker, error) {
  broker.transportError ??= error instanceof Error
    ? error
    : new Error("browser broker socket transport failed");
}

function clearBrowserBrokerConnectionTimer(broker) {
  if (broker.connectionTimer !== null) clearTimeout(broker.connectionTimer);
  broker.connectionTimer = null;
}

function endBrowserBrokerInput(broker) {
  try {
    broker.child?.stdin?.end();
  } catch {
    recordBrowserBrokerTransportError(
      broker,
      new Error("browser broker stdin could not be closed")
    );
  }
}

function wireBrowserBrokerSocket(broker) {
  if (!broker.client || !broker.child || broker.transportWired) return;
  if (
    typeof broker.client.pipe !== "function" ||
    typeof broker.child.stdin?.write !== "function" ||
    typeof broker.child.stdout?.pipe !== "function"
  ) {
    throw new Error("browser broker stdio is unavailable");
  }
  broker.client.pipe(broker.child.stdin);
  broker.child.stdout.pipe(broker.client);
  broker.client.resume?.();
  broker.transportWired = true;
}

export function attachBrowserBrokerSocketClient(broker, socket) {
  if (!socket || typeof socket.destroy !== "function") {
    throw new Error("browser broker socket client is invalid");
  }
  socket.on?.("error", (error) => recordBrowserBrokerTransportError(broker, error));
  if (broker.transportClosing || broker.clientAccepted) {
    socket.destroy();
    return false;
  }
  broker.clientAccepted = true;
  broker.client = socket;
  clearBrowserBrokerConnectionTimer(broker);
  socket.once?.("close", () => endBrowserBrokerInput(broker));
  wireBrowserBrokerSocket(broker);
  return true;
}

export async function listenBrowserBrokerSocket(broker, options = {}) {
  const fileSystem = options.fs ?? fs;
  const createServer = options.createServer ?? net.createServer;
  const now = options.now ?? Date.now;
  const requestedListenTimeout =
    Number.isFinite(options.listenTimeoutMs) && options.listenTimeoutMs > 0
      ? options.listenTimeoutMs
      : BROWSER_BROKER_LISTEN_TIMEOUT_MS;
  const remainingMs = Math.max(1, broker.context.deadlineMs - now());
  const listenTimeoutMs = Math.max(1, Math.min(requestedListenTimeout, remainingMs));
  const server = createServer(
    { allowHalfOpen: false, pauseOnConnect: true },
    (socket) => {
      try {
        attachBrowserBrokerSocketClient(broker, socket);
      } catch (error) {
        recordBrowserBrokerTransportError(broker, error);
        socket?.destroy?.();
        endBrowserBrokerInput(broker);
      }
    }
  );
  if (!server || typeof server.listen !== "function") {
    throw new Error("browser broker socket server is unavailable");
  }
  broker.server = server;
  server.on("error", (error) => recordBrowserBrokerTransportError(broker, error));

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener?.("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("browser broker socket listen timed out")),
      listenTimeoutMs
    );
    server.once("error", onError);
    try {
      server.listen({ path: broker.paths.socketPath, backlog: 1 }, () => finish());
    } catch (error) {
      finish(error);
    }
  });

  fileSystem.chmodSync(broker.paths.socketPath, 0o600);
  assertPrivateSocket(fileSystem, broker.paths.socketPath, "browser broker socket");
  const socketStats = fileSystem.lstatSync(broker.paths.socketPath);
  broker.socketIdentity = { dev: socketStats.dev, ino: socketStats.ino };
  const requestedConnectTimeout =
    Number.isFinite(options.connectTimeoutMs) && options.connectTimeoutMs > 0
      ? options.connectTimeoutMs
      : BROWSER_BROKER_CONNECT_TIMEOUT_MS;
  const connectTimeoutMs = Math.max(
    1,
    Math.min(requestedConnectTimeout, Math.max(1, broker.context.deadlineMs - now()))
  );
  broker.connectionTimer = setTimeout(() => {
    broker.connectionTimer = null;
    broker.transportClosing = true;
    recordBrowserBrokerTransportError(
      broker,
      new Error("browser broker socket connection timed out")
    );
    endBrowserBrokerInput(broker);
    try {
      server.close();
    } catch {
      /* Cleanup will record an unclosed server. */
    }
  }, connectTimeoutMs);
  broker.connectionTimer.unref?.();
  return server;
}

function destroyBrowserBrokerClient(client, timeoutMs) {
  if (!client || client.destroyed === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener?.("close", onClose);
      resolve(ok);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.once?.("close", onClose);
    try {
      client.destroy();
      if (client.destroyed === true && typeof client.once !== "function") finish(true);
    } catch {
      finish(false);
    }
  });
}

function closeBrowserBrokerServer(server, timeoutMs) {
  if (!server) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      server.close((error) => {
        finish(!error || error?.code === "ERR_SERVER_NOT_RUNNING");
      });
    } catch (error) {
      finish(error?.code === "ERR_SERVER_NOT_RUNNING");
    }
  });
}

export function closeBrowserBrokerTransport(broker, options = {}) {
  if (!broker) return Promise.resolve(true);
  if (broker.transportClosePromise) return broker.transportClosePromise;
  const closeTimeoutMs =
    Number.isFinite(options.closeTimeoutMs) && options.closeTimeoutMs > 0
      ? options.closeTimeoutMs
      : BROWSER_BROKER_CLOSE_TIMEOUT_MS;
  broker.transportClosing = true;
  clearBrowserBrokerConnectionTimer(broker);
  try {
    broker.client?.unpipe?.(broker.child?.stdin);
    broker.child?.stdout?.unpipe?.(broker.client);
    broker.child?.stdin?.end?.();
    broker.child?.stdin?.destroy?.();
    broker.child?.stdout?.destroy?.();
  } catch {
    recordBrowserBrokerTransportError(
      broker,
      new Error("browser broker stdio cleanup failed")
    );
  }
  broker.transportClosePromise = Promise.all([
    destroyBrowserBrokerClient(broker.client, closeTimeoutMs),
    closeBrowserBrokerServer(broker.server, closeTimeoutMs),
  ]).then(([clientClosed, serverClosed]) => clientClosed && serverClosed);
  return broker.transportClosePromise;
}

export function createBrowserBroker(context) {
  return {
    context,
    paths: resolveBrowserBrokerPaths(context),
    child: null,
    identity: null,
    server: null,
    client: null,
    clientAccepted: false,
    connectionTimer: null,
    transportError: null,
    transportWired: false,
    transportClosing: false,
    transportClosePromise: null,
    socketIdentity: null,
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
  const listenSocket = options.listenSocket ?? listenBrowserBrokerSocket;
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
  await listenSocket(broker, options.socketOptions);
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
      ...backendArgs,
    ],
    {
      cwd: broker.context.repo,
      detached: true,
      env: buildBrowserBrokerEnvironment(broker.context, broker.paths),
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    }
  );
  if (!Number.isInteger(broker.child?.pid) || broker.child.pid <= 0) {
    throw new Error("browser broker process did not start");
  }
  if (
    typeof broker.child.stdin?.write !== "function" ||
    typeof broker.child.stdout?.pipe !== "function"
  ) {
    throw new Error("browser broker stdio is unavailable");
  }
  broker.stage = "spawned";
  broker.child.stdin?.on?.("error", (error) =>
    recordBrowserBrokerTransportError(broker, error)
  );
  broker.child.stdout?.on?.("error", (error) =>
    recordBrowserBrokerTransportError(broker, error)
  );
  attachBrowserBrokerStatusStream(broker, broker.child.stdio?.[3]);
  wireBrowserBrokerSocket(broker);
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

function removeValidatedBrowserBrokerSocket(fileSystem, socketPath, expectedIdentity) {
  const stats = lstatIfPresent(fileSystem, socketPath);
  if (!stats) return true;
  if (
    !expectedIdentity ||
    !stats.isSocket() ||
    stats.isSymbolicLink() ||
    permissionBits(stats) !== 0o600 ||
    stats.dev !== expectedIdentity.dev ||
    stats.ino !== expectedIdentity.ino
  ) {
    return false;
  }
  try {
    fileSystem.unlinkSync(socketPath);
    return lstatIfPresent(fileSystem, socketPath) === null;
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
  const closeTransport =
    options.closeTransport ?? closeBrowserBrokerTransport;
  const groupExists = options.processGroupExists ?? processGroupExists;
  const writeLifecycle =
    options.writeLifecycle ?? atomicBrowserBrokerLifecycleState;
  const writeProcessState =
    options.writeProcessState ?? atomicBrowserBrokerProcessState;
  const transportClosed = await closeTransport(broker, {
    closeTimeoutMs: options.closeTimeoutMs,
  });
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

  let stateOk = processCleanup.ok && transportClosed;
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
    if (
      !removeValidatedBrowserBrokerSocket(
        fileSystem,
        broker.paths.socketPath,
        broker.socketIdentity
      )
    ) {
      filesOk = false;
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

export function productionEnvironment(context, brokerPaths = null) {
  const mode = context.mode ?? SUPERVISED_ACCOUNT_MODE;
  const settingsSmoke = mode === SUPERVISED_SETTINGS_SMOKE_MODE;
  if (![SUPERVISED_ACCOUNT_MODE, SUPERVISED_SETTINGS_SMOKE_MODE].includes(mode)) {
    throw new Error("supervised production mode is invalid");
  }
  const runtimeTmp = path.posix.join(context.productionDir, "tmp");
  const reportRoot = path.posix.join(context.productionDir, "reports");
  const environment = {
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
      settingsSmoke ? ".settings-2fa-twice-confirmed" : ".account-home-confirmed"
    ),
    APPLE_AUTOMATION_SUPERVISED_GUI: "1",
    APPLE_AUTOMATION_SUPERVISED_TOKEN: context.nonce,
    [SUPERVISED_MODE_ENV_KEY]: mode,
    APPLE_AUTOMATION_HELPER_DIR: context.helperDir,
    SKIP_ENV_SETUP: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (settingsSmoke) {
    return { ...environment, APPLE_AUTOMATION_SETTINGS_SMOKE: "1" };
  }
  if (!brokerPaths) throw new Error("browser broker paths are unavailable");
  return {
    ...environment,
    APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE: path.posix.join(
      reportRoot,
      ".ruyipage-process.json"
    ),
    APPLE_AUTOMATION_BROWSER_BROKER_SOCKET: brokerPaths.socketPath,
    FIREFOX_PROFILE_DIR: path.posix.join(context.productionDir, "firefox-profile"),
    BROWSER_PROFILE_MODE: "persistent",
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
  const ttyCapability = supervisedTtyCapability(input);
  context.ttyCapability = ttyCapability;
  const maxRawLogBytes = options.maxRawLogBytes ?? MAX_RAW_LOG_BYTES;
  let headBefore = null;
  let child = null;
  let outcome = null;
  let productionIdentity = null;
  let productionStatePath = null;
  let productionLaunchGatePath = null;
  let browserBroker = null;
  let productionProtocol = null;
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

    let trigger = { state: "missing", mode: null };
    while (now() < context.deadlineMs && trigger.state !== "valid") {
      trigger = readTrigger(context);
      if (trigger.state === "invalid") {
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
    if (trigger.state !== "valid") {
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
    let promptTail = Buffer.alloc(0);
    let markerConfirmedInOutput = false;
    let manualPromptVisible = false;
    let manualPromptObserved = false;
    let manualPromptCount = 0;
    let twoFaWinnerConfirmations = 0;
    const settingsSmoke = context.mode === SUPERVISED_SETTINGS_SMOKE_MODE;
    const successMarker = supervisedSuccessMarkerForMode(context.mode);
    const acceptanceValue = supervisedAcceptanceValueForMode(context.mode);
    productionProtocol = createProductionProtocolState();
    const settingsHelperPath = path.join(context.helperDir, SETTINGS_HELPER_NAME);
    const observeSettingsHelperSpawn = () => {
      return observeTrustedSettingsHelperSpawn(
        productionProtocol,
        productionIdentity,
        settingsHelperPath
      );
    };
    const supervisorStatusProtocol = createSupervisorStatusProtocol();
    const emittedStatuses = new Set();
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
    const emitTwoFaWinner = (status) => {
      const message = supervisedTwoFaWinnerMessage(status);
      if (!message || twoFaWinnerConfirmations >= 2) return;
      twoFaWinnerConfirmations += 1;
      safeWrite(`${message}\n`);
    };
    const processSafeLine = (line) => {
      if (line === MANUAL_CODE_PROMPT) {
        if (manualPromptVisible) {
          safeWrite("\n");
          manualPromptVisible = false;
        }
        return;
      }
      if (line === successMarker) {
        markerConfirmedInOutput = true;
        if (!settingsSmoke) productionProtocol.processStdoutLine(line);
        emitStatus("success", successMarker);
        return;
      }
      if (!productionProtocol.processStdoutLine(line)) return;
      if (line === "[2FA] status:settings_start") observeSettingsHelperSpawn();

      if (line.startsWith("[2FA] status:")) {
        const status = line.slice("[2FA] status:".length);
        if (supervisedTwoFaWinnerMessage(status)) {
          emitTwoFaWinner(status);
        } else if (supervisedTwoFaStatusMessage(status)) {
          emitStatus(`2fa-${status}`, supervisedTwoFaStatusMessage(status));
        } else if (status === "permission_preflight_prompted") {
          emitStatus(
            "accessibility-prompted",
            "[mac:supervised] 正在请求原生 2FA helper 的辅助功能授权；请按 macOS 弹窗实际显示的条目允许"
          );
        } else if (status === "permission_preflight_missing") {
          emitStatus(
            "accessibility-missing",
            "[mac:supervised] 原生 2FA helper 尚未获辅助功能授权；请以 macOS 弹窗或辅助功能列表实际显示的条目为准，不要只依据其他终端或宿主应用的勾选状态；流程将继续尝试 OCR、系统设置与手动兜底"
          );
        } else if (status === "popup_accessibility") {
          emitStatus(
            "2fa-popup-ocr",
            "[mac:supervised] 原生弹窗 AX 不可用，正在切换到屏幕录制 OCR 读码"
          );
        } else if (status === "ocr_permission_missing") {
          emitStatus(
            "2fa-ocr-permission",
            "[mac:supervised] OCR 已请求屏幕录制授权；系统设置备用取码仍在继续"
          );
        } else if (status === "settings_start") {
          emitStatus(
            "2fa-settings",
            "[mac:supervised] 正在通过系统设置备用路线获取验证码"
          );
        } else if (status === "manual_code") {
          emitStatus(
            "2fa-manual",
            "[mac:supervised] 自动取码尚未完成，已启用终端隐藏输入兜底"
          );
        } else if (TWO_FA_PENDING_STATUSES.has(status)) {
          emitStatus("2fa-progress", "[mac:supervised] 2FA 自动取码处理中");
        }
        return;
      }
      if (line === "[ruyipage] status:runtime_resolving") {
        emitStatus("runtime-resolving", "[mac:supervised] ruyiPage runtime resolving");
      } else if (line === "[ruyipage] status:backend_starting") {
        emitStatus("backend-starting", "[mac:supervised] ruyiPage backend starting");
      } else if (line === "[ruyipage] status:broker_credentials_received") {
        emitStatus("broker-connected", "[mac:supervised] ruyiPage broker connected");
      } else if (line === "[ruyipage] status:browser_runtime_imported") {
        emitStatus("runtime-imported", "[mac:supervised] ruyiPage runtime imported");
      } else if (line === "[ruyipage] status:browser_constructing") {
        emitStatus("browser-constructing", "[mac:supervised] Firefox launch requested by ruyiPage");
      }
    };
    const createStdoutChunkHandler = ({ inspectPrompt = false } = {}) => {
      const decoder = new StringDecoder("utf8");
      let lineBuffer = "";
      let finished = false;
      const handle = (chunk) => {
        const buffer = Buffer.from(chunk);
        rawBytes += buffer.length;
        if (rawBytes > maxRawLogBytes) {
          logLimitExceeded = true;
          return;
        }
        if (inspectPrompt && manualPromptCount < 2 && !manualPromptVisible) {
          const combined = Buffer.concat([promptTail, buffer]);
          if (combined.includes(manualPromptBytes)) {
            manualPromptVisible = true;
            manualPromptObserved = true;
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
      handle.finish = () => {
        if (finished || logLimitExceeded) return;
        finished = true;
        lineBuffer += decoder.end();
        if (lineBuffer.length > 0) processSafeLine(lineBuffer);
        lineBuffer = "";
      };
      return handle;
    };
    const onStdoutChunk = createStdoutChunkHandler({ inspectPrompt: true });
    const onStderrChunk = (chunk) => {
      rawBytes += drainProductionStderr(chunk);
      if (rawBytes > maxRawLogBytes) logLimitExceeded = true;
    };
    emitStatus(
      "starting",
      settingsSmoke
        ? "[mac:supervised] System Settings 双次验证码验收已启动"
        : "[mac:supervised] 受监督 Apple Account 登录已启动"
    );

    browserBroker = settingsSmoke ? null : createBrowserBroker(context);
    const env = productionEnvironment(context, browserBroker?.paths ?? null);
    for (const directory of [
      env.TMPDIR,
      env.APPLE_AUTOMATION_REPORT_ROOT,
      env.FIREFOX_PROFILE_DIR,
    ].filter(Boolean)) {
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
    if (browserBroker) await startBroker(browserBroker, bridgeIdentity);
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
        stdio: [
          productionStdinForSupervisedInput(input, ttyCapability),
          "pipe",
          "pipe",
          "pipe",
        ],
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
    child.stdout.once("end", onStdoutChunk.finish);
    child.stdout.once("close", onStdoutChunk.finish);

    while (
      !outcome.settled &&
      now() < context.deadlineMs &&
      !cancellationRequested &&
      !logLimitExceeded &&
      !outputForwardingFailed
    ) {
      if (cancellationIsPresent(context)) cancellationRequested = true;
      if (!cancellationRequested) {
        observeSettingsHelperSpawn();
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
    const ruyiPageCleanup = browserBroker
      ? await cleanupBroker(browserBroker)
      : { ok: true, cleanupEvidence: true };

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
    const markerConfirmed = markerConfirmedInOutput && markerValue === acceptanceValue;
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

    for (const event of readSettingsProviderAudit(env.APPLE_AUTOMATION_REPORT_ROOT)) {
      productionProtocol.processSettingsAuditEvent(event);
    }

    const trustedProductionStage = productionProtocol.productionStage;
    const productionStage =
      trustedProductionStage === "not_started"
        ? "starting"
        : trustedProductionStage;
    const nodeFailure = productionProtocol.nodeFailure;
    const accessibilityPreflight = productionProtocol.accessibilityPreflight;
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
      if (settingsSmoke) {
        failureClass = "TWO_FA_CODE_UNAVAILABLE";
      } else {
      const accessibilityBlockedTwoFa =
        accessibilityPreflight === "missing" &&
        (
          [
            "two_fa_code_pending",
            "two_fa_code_unavailable",
            "browser_failure:twofa_page_wait",
            "browser_failure:twofa_code_wait",
          ].includes(productionStage) ||
          ["two_fa_preparation", "two_fa_provider"].includes(nodeFailure)
        );
      if (accessibilityBlockedTwoFa) {
        failureClass = "ACCESSIBILITY_PERMISSION_REQUIRED";
      } else if (
        ["starting", "browser_backend_starting"].includes(productionStage) &&
        ["broker_connect", "broker_connect_timeout", "broker_eof", "broker_io"].includes(
          nodeFailure
        )
      ) {
        failureClass = "BROWSER_BROKER_TRANSPORT_FAILED";
      } else if (
        ["two_fa_preparation", "two_fa_provider"].includes(nodeFailure)
      ) {
        failureClass = "TWO_FA_CODE_UNAVAILABLE";
      } else if (nodeFailure === "account_home_unconfirmed") {
        failureClass = "ACCOUNT_INFORMATION_FAILED";
      } else if (
        ["backend_cleanup", "collector_cleanup", "event_handler", "event_handler_timeout", "process_state"].includes(
          nodeFailure
        )
      ) {
        failureClass = "INTERNAL_ERROR";
      } else if (productionStage === "two_fa_code_acquired") {
        failureClass = "TWO_FA_LOGIN_FAILED";
      } else if (
        ["two_fa_code_pending", "two_fa_code_unavailable"].includes(productionStage)
      ) {
        failureClass = "TWO_FA_CODE_UNAVAILABLE";
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
    }
    else if (!markerConfirmed) failureClass = "ACCEPTANCE_EVIDENCE_MISSING";

    const accepted = failureClass === "NONE";
    const cancelled = failureClass === "CANCELLED";
    const attestationProductionStage = cancelled
      ? "not_started"
      : trustedProductionStage;
    const attestationNodeFailure = cancelled ? "none" : nodeFailure;
    const twoFaDetail = supervisedTwoFaDetail({
      failureClass,
      ttyCapability,
      manualPromptObserved,
    });
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
      twoFaDetail,
      productionStage: attestationProductionStage,
      nodeFailure: attestationNodeFailure,
      settingsProviderState: productionProtocol.settingsProviderState,
      settingsProviderAttempt: productionProtocol.settingsProviderAttempt,
      settingsProviderFailureReason: productionProtocol.settingsProviderFailureReason,
      observedHeadBefore: headBefore,
      observedHeadAfter: headAfter,
    });
    if (accepted) {
      emitStatus(
        "accepted",
        settingsSmoke
          ? "[mac:supervised] System Settings 双次验证码验收通过"
          : "[mac:supervised] Apple Account 首页验收通过"
      );
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
    const ruyiPageCleanup = browserBroker
      ? await cleanupBroker(browserBroker)
      : { ok: true, cleanupEvidence: true };
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
