import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 5_000_000;
const MAX_LINES = 20_000;
const MAX_TEXT_LENGTH = 512;
const BLOCKED_IMPLEMENTATION_ROOTS = new Set([".git", ".runtime"]);
const SENSITIVE_IMPLEMENTATION_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.git|\.runtime|[^/]*(?:credential|cookie|session|secret)[^/]*|screenshots?|reports?|firefox-profile)(?:\/|$)|\.(?:png|jpe?g|gif|webp|pdf|zip)$/i;
const IMPLEMENTATION_SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Za-z]{2,}\b|(?:\b(?:password|passwd|secret|token|cookie|authorization|api[-_ ]?key)\b|[A-Za-z_$][A-Za-z0-9_$]*(?:password|passwd|secret|token|cookie|authorization|api[_-]?key)[A-Za-z0-9_$]*)\s*[:=]\s*(?:["'`][^"'`\r\n]{8,}["'`]|[A-Z0-9_./+=-]{8,}))/i;
const LOCAL_IMPLEMENTATION_PATH = /(?:^|[\s"'=])(?:\/(?:Users|Volumes|private|tmp|var\/folders)\/|[A-Za-z]:\\|\\\\)/m;
const TRUSTED_HELPER_COMMANDS = new Set([
  "node scripts/supervised-mac-acceptance.mjs",
  "node scripts/supervised-mac-acceptance.mjs --settings-smoke",
  "/bin/zsh -lc 'node scripts/supervised-mac-acceptance.mjs'",
  "/bin/zsh -lc 'node scripts/supervised-mac-acceptance.mjs --settings-smoke'",
]);
const TRUSTED_SUCCESS_MARKERS = new Set([
  "[验收] REAL_ACCOUNT_HOME_CONFIRMED",
  "[验收] SETTINGS_2FA_TWICE_CONFIRMED",
]);
const REPORT_MODES = new Set(["noninteractive", "supervised_gui", "mac_implementation"]);
const REPORT_GUI_STATUSES = new Set(["not_requested", "passed", "failed", "skipped"]);
const REPORT_STATUSES = new Set(["passed", "failed"]);
const TEST_STATUSES = new Set(["passed", "failed", "skipped"]);

// Keep useful high-level diagnostics while removing paths, URLs, credentials,
// and long opaque values before any Mac output leaves the remote host.
const REDACTIONS = [
  { pattern: /https?:\/\/[^\s)\]}>'"]+/gi, replacement: "[redacted-url]" },
  { pattern: /(?:file|ssh|ftp):\/\/[^\s)\]}>'"]+/gi, replacement: "[redacted-url]" },
  { pattern: /(^|[\s"'=])(?:\/(?:Users|Volumes|private|tmp|var|etc|Library)\/[^\s"'`)>\]}]+|[A-Za-z]:\\[^\s"'`)>\]}]+|\\\\[^\s"'`)>\]}]+)/g, replacement: "$1[redacted-path]" },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: "[redacted-email]" },
  { pattern: /\b(?:password|passwd|secret|token|cookie|authorization|bearer|api[-_ ]?key|credential|otp|raw[-_ ]?(?:ax|ocr|text|value)|session)\b\s*[:=]\s*[^\s,;]+/gi, replacement: "[redacted-field]" },
  { pattern: /\b(?:password|passwd|secret|token|cookie|authorization|bearer|api[-_ ]?key|credential|otp|raw[-_ ]?(?:ax|ocr|text|value)|session)\b/gi, replacement: "[redacted-label]" },
  { pattern: /\b\d{6,}\b/g, replacement: "[redacted-number]" },
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRegularFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular`);
  return resolved;
}

function safeText(value, label, { maxLength = MAX_TEXT_LENGTH } = {}) {
  if (typeof value !== "string") throw new Error(`invalid_${label}`);
  let output = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!output) throw new Error(`empty_${label}`);
  if (output.length > maxLength) output = `${output.slice(0, maxLength - 14)} [truncated]`;
  for (const { pattern, replacement } of REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

function safeId(value, label) {
  const output = safeText(value, label, { maxLength: 128 });
  if (!/^[A-Za-z0-9._:-]+$/.test(output)) return `id-${Buffer.from(output).toString("hex").slice(0, 32)}`;
  return output;
}

function sanitizeEvents(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) throw new Error("events_too_large");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length > MAX_LINES) throw new Error("too_many_events");
  const output = lines.map((line) => {
    const event = JSON.parse(line);
    if (!isPlainObject(event)) throw new Error("event_not_object");
    const safe = {};
    if (typeof event.type === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(event.type)) {
      safe.type = event.type;
    } else {
      safe.type = "unknown";
    }
    const item = event.item;
    if (!isPlainObject(item)) return safe;
    if (item.type === "agent_message" || item.type === "reasoning") {
      safe.item = { type: item.type };
      return safe;
    }
    if (item.type !== "command_execution") return safe;
    const safeItem = {
      id: safeId(item.id, "item_id"),
      type: "command_execution",
      command: TRUSTED_HELPER_COMMANDS.has(item.command) ? item.command : "[redacted-command]",
      status: ["completed", "failed", "in_progress"].includes(item.status) ? item.status : "unknown",
      exit_code: Number.isInteger(item.exit_code) && item.exit_code >= -255 && item.exit_code <= 255 ? item.exit_code : null,
      aggregated_output: TRUSTED_HELPER_COMMANDS.has(item.command) && TRUSTED_SUCCESS_MARKERS.has(String(item.aggregated_output ?? "").trim())
        ? `${String(item.aggregated_output).trim()}\n`
        : "",
    };
    safe.item = safeItem;
    return safe;
  });
  return output.map((event) => JSON.stringify(event)).join("\n") + (output.length ? "\n" : "");
}

function sanitizeStderr(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) throw new Error("stderr_too_large");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  return `stderr_present:${Math.min(lines.length, MAX_LINES)}\n`;
}

function opaqueReportText(value, label, options) {
  // Final reports are model-authored. Even a text value without a recognisable
  // secret marker can be page content or a personal name, so never return it.
  safeText(value, label, options);
  return `sanitized_${label}`;
}

function sanitizeReport(source) {
  const report = JSON.parse(source);
  if (!isPlainObject(report)) throw new Error("report_not_object");
  const expected = [
    "taskUnderstanding",
    "environmentObservations",
    "commands",
    "tests",
    "findings",
    "recommendedWindowsActions",
    "executionMode",
    "supervisedGuiStatus",
    "status",
  ];
  if (Object.keys(report).some((key) => !expected.includes(key)) || expected.some((key) => !(key in report))) {
    throw new Error("report_keys_invalid");
  }
  if (!REPORT_MODES.has(report.executionMode)) throw new Error("report_execution_mode_invalid");
  if (!REPORT_GUI_STATUSES.has(report.supervisedGuiStatus)) throw new Error("report_gui_status_invalid");
  if (!REPORT_STATUSES.has(report.status)) throw new Error("report_status_invalid");
  if (!Array.isArray(report.environmentObservations) || report.environmentObservations.length === 0 || report.environmentObservations.length > 100) throw new Error("report_environment_invalid");
  if (!Array.isArray(report.commands) || report.commands.length === 0 || report.commands.length > 100) throw new Error("report_commands_invalid");
  if (!Array.isArray(report.tests) || report.tests.length === 0 || report.tests.length > 100) throw new Error("report_tests_invalid");
  if (!Array.isArray(report.findings) || report.findings.length > 100) throw new Error("report_findings_invalid");
  if (!Array.isArray(report.recommendedWindowsActions) || report.recommendedWindowsActions.length > 100) throw new Error("report_actions_invalid");

  const safe = {
    taskUnderstanding: opaqueReportText(report.taskUnderstanding, "taskUnderstanding"),
    environmentObservations: report.environmentObservations.map((value, index) => opaqueReportText(value, `environment_${index}`)),
    commands: report.commands.map((command, index) => {
      if (!isPlainObject(command) || Object.keys(command).some((key) => !["purpose", "command", "exitCode", "summary"].includes(key))) throw new Error(`report_command_${index}_invalid`);
      if (!Number.isInteger(command.exitCode)) throw new Error(`report_command_${index}_exit_invalid`);
      return {
        purpose: opaqueReportText(command.purpose, `command_${index}_purpose`),
        command: opaqueReportText(command.command, `command_${index}_command`, { maxLength: 256 }),
        exitCode: command.exitCode,
        summary: opaqueReportText(command.summary, `command_${index}_summary`),
      };
    }),
    tests: report.tests.map((test, index) => {
      if (!isPlainObject(test) || Object.keys(test).some((key) => !["name", "command", "status", "exitCode", "summary"].includes(key))) throw new Error(`report_test_${index}_invalid`);
      if (!TEST_STATUSES.has(test.status) || (test.exitCode !== null && !Number.isInteger(test.exitCode))) throw new Error(`report_test_${index}_status_invalid`);
      return {
        name: opaqueReportText(test.name, `test_${index}_name`),
        command: opaqueReportText(test.command, `test_${index}_command`, { maxLength: 256 }),
        status: test.status,
        exitCode: test.exitCode,
        summary: opaqueReportText(test.summary, `test_${index}_summary`),
      };
    }),
    findings: report.findings.map((finding, index) => {
      if (!isPlainObject(finding) || Object.keys(finding).some((key) => !["severity", "title", "details"].includes(key))) throw new Error(`report_finding_${index}_invalid`);
      if (!["critical", "important", "warning", "info"].includes(finding.severity)) throw new Error(`report_finding_${index}_severity_invalid`);
      return {
        severity: finding.severity,
        title: opaqueReportText(finding.title, `finding_${index}_title`),
        details: opaqueReportText(finding.details, `finding_${index}_details`),
      };
    }),
    recommendedWindowsActions: report.recommendedWindowsActions.map((value, index) => opaqueReportText(value, `action_${index}`)),
    executionMode: report.executionMode,
    supervisedGuiStatus: report.supervisedGuiStatus,
    status: report.status,
  };
  return `${JSON.stringify(safe)}\n`;
}

export function sanitizeMacCodexArtifacts({ events, stderr, finalReport }) {
  return {
    events: sanitizeEvents(events),
    stderr: sanitizeStderr(stderr),
    finalReport: sanitizeReport(finalReport),
  };
}

function assertSafeImplementationPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    SENSITIVE_IMPLEMENTATION_PATH.test(value)
  ) {
    throw new Error("unsafe_implementation_path");
  }
  if (BLOCKED_IMPLEMENTATION_ROOTS.has(value.split("/", 1)[0])) throw new Error("implementation_path_not_allowed");
}

export function validateMacImplementationArtifacts({ gitDiff, gitUntracked }) {
  const diff = String(gitDiff ?? "").replace(/^\uFEFF/, "");
  const untracked = String(gitUntracked ?? "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(diff, "utf8") > MAX_INPUT_BYTES || Buffer.byteLength(untracked, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("implementation_artifacts_too_large");
  }
  if (/GIT binary patch|Binary files /i.test(diff)) throw new Error("implementation_binary_patch");
  if (IMPLEMENTATION_SECRET.test(diff) || LOCAL_IMPLEMENTATION_PATH.test(diff)) {
    throw new Error("implementation_patch_sensitive_content");
  }
  const headerPaths = [...diff.matchAll(/^diff --git a\/([^\r\n]+) b\/([^\r\n]+)$/gm)];
  if (diff.trim() && headerPaths.length === 0) throw new Error("implementation_patch_invalid");
  const patchPaths = new Set();
  for (const match of headerPaths) {
    if (match[1] !== match[2]) throw new Error("implementation_rename_not_allowed");
    assertSafeImplementationPath(match[1]);
    patchPaths.add(match[1]);
  }
  const lines = untracked.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length > MAX_LINES) throw new Error("too_many_untracked_files");
  const seen = new Set();
  for (const line of lines) {
    assertSafeImplementationPath(line);
    if (seen.has(line)) throw new Error("duplicate_untracked_file");
    seen.add(line);
    if (!patchPaths.has(line)) throw new Error("untracked_content_missing");
  }
  const canonicalUntracked = [...lines].sort();
  if (canonicalUntracked.some((value, index) => value !== lines[index])) {
    throw new Error("untracked_manifest_not_sorted");
  }
  return {
    gitDiff: diff,
    gitUntracked: canonicalUntracked.join("\n") + (canonicalUntracked.length ? "\n" : ""),
  };
}

export function sanitizeMacCodexArtifactsFiles(eventsPath, stderrPath, finalPath) {
  const events = assertRegularFile(eventsPath, "events");
  const stderr = assertRegularFile(stderrPath, "stderr");
  const finalReport = assertRegularFile(finalPath, "final");
  const sanitized = sanitizeMacCodexArtifacts({
    events: fs.readFileSync(events, "utf8"),
    stderr: fs.readFileSync(stderr, "utf8"),
    finalReport: fs.readFileSync(finalReport, "utf8"),
  });
  fs.writeFileSync(events, sanitized.events, "utf8");
  fs.writeFileSync(stderr, sanitized.stderr, "utf8");
  fs.writeFileSync(finalReport, sanitized.finalReport, "utf8");
}

export function sanitizeMacImplementationArtifactsFiles(gitDiffPath, gitUntrackedPath) {
  const gitDiff = assertRegularFile(gitDiffPath, "git_diff");
  const gitUntracked = assertRegularFile(gitUntrackedPath, "git_untracked");
  const sanitized = validateMacImplementationArtifacts({
    gitDiff: fs.readFileSync(gitDiff, "utf8"),
    gitUntracked: fs.readFileSync(gitUntracked, "utf8"),
  });
  fs.writeFileSync(gitDiff, sanitized.gitDiff, "utf8");
  fs.writeFileSync(gitUntracked, sanitized.gitUntracked, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === "--implementation" && process.argv.length === 5) {
      sanitizeMacImplementationArtifactsFiles(process.argv[3], process.argv[4]);
    } else if (process.argv.length === 5) {
      sanitizeMacCodexArtifactsFiles(process.argv[2], process.argv[3], process.argv[4]);
    } else {
      throw new Error("usage");
    }
  } catch {
    console.error("mac_codex_artifact_sanitization_failed");
    process.exitCode = 1;
  }
}
