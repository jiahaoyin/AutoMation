import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SSH_ALIAS = "mac-codex";
const DEFAULT_REMOTE_REPO = "/Users/admin/Desktop/Apple-AutoMation";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 86_400_000;
const CODEX_BIN = "/Users/admin/.local/bin/codex";
const REQUIRED_ARTIFACTS = [
  "events.jsonl",
  "stderr.log",
  "final.json",
  "git-before.txt",
  "git-after.txt",
  "head-before.txt",
  "head-after.txt",
  "codex-exit.txt",
];

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(value, option, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${option}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${option}: ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  let taskText;
  let taskFile;
  let sync = true;
  let sshAlias = DEFAULT_SSH_ALIAS;
  let remoteRepo = DEFAULT_REMOTE_REPO;
  let round = 1;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--task":
        taskText = requireValue(argv, index, option);
        index += 1;
        break;
      case "--task-file":
        taskFile = requireValue(argv, index, option);
        index += 1;
        break;
      case "--round":
        round = parsePositiveInteger(requireValue(argv, index, option), "round", {
          max: 9_999,
        });
        index += 1;
        break;
      case "--timeout-ms":
        timeoutMs = parsePositiveInteger(
          requireValue(argv, index, option),
          "timeout",
          { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }
        );
        index += 1;
        break;
      case "--ssh-alias":
        sshAlias = requireValue(argv, index, option).trim();
        index += 1;
        break;
      case "--remote-repo":
        remoteRepo = requireValue(argv, index, option).trim();
        index += 1;
        break;
      case "--no-sync":
        sync = false;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (taskText !== undefined && taskFile !== undefined) {
    throw new Error("Use only one of --task or --task-file");
  }
  if (taskText === undefined && taskFile === undefined) {
    throw new Error("One of --task or --task-file is required");
  }

  const task = (taskFile === undefined ? taskText : fs.readFileSync(taskFile, "utf8")).trim();
  if (!task) throw new Error("Task must not be empty");
  if (!/^[A-Za-z0-9._-]+$/.test(sshAlias)) {
    throw new Error(`Invalid SSH alias: ${sshAlias}`);
  }
  if (!remoteRepo.startsWith("/") || /[\r\n]/.test(remoteRepo)) {
    throw new Error(`Invalid remote repository path: ${remoteRepo}`);
  }

  return {
    task,
    sync,
    sshAlias,
    remoteRepo,
    round,
    roundName: `round-${String(round).padStart(2, "0")}`,
    timeoutMs,
  };
}

export function buildAgentPrompt({ task }) {
  return [
    "你是 Windows 调度的 Mac Codex 只读验证执行器。先理解任务和环境，再执行检查。",
    "",
    "用户任务：",
    task,
    "",
    "固定执行合同：",
    "1. 读取并遵守仓库中的 AGENTS.md 等指令；Apple-AutoMation 的浏览器操作只能使用 ruyiPage。",
    "2. 不读取、复制或输出 .env、Codex auth.json、API Key、GitHub PAT 或其他秘密。",
    "3. 不修改、不创建、不删除、不提交、不推送源码；不得执行 git reset、git clean 或其他破坏性 Git 命令。",
    "4. 只执行与任务相关的非交互检查和测试，不执行人工 2FA、真实账号流程或需要 GUI 人工确认的测试。",
    "5. 对每条命令记录目的、完整命令、退出码和关键结果；发现无法执行的测试时记录原因。",
    "6. 先记录任务理解和环境观察，再报告测试、发现和建议 Windows 采取的动作。",
    "7. 最终响应必须是符合命令提供的 JSON Schema 的单一 JSON 对象；status 只能是 passed 或 failed。",
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validateRemoteValue(value, label) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${label}`);
}

export function buildRemoteScript(options) {
  const {
    task,
    sync,
    remoteRepo,
    remoteRoundDir,
    branch,
    expectedHead,
  } = options;
  for (const [value, label] of [
    [task, "task"],
    [remoteRepo, "remote repository"],
    [remoteRoundDir, "remote round directory"],
    [branch, "branch"],
    [expectedHead, "expected HEAD"],
  ]) {
    validateRemoteValue(value, label);
  }

  const promptBase64 = Buffer.from(buildAgentPrompt(options), "utf8").toString("base64");
  const syncCommands = sync
    ? [
        "git fetch origin",
        'git switch -- "$BRANCH"',
        'git merge --ff-only -- "origin/$BRANCH"',
      ]
    : [];

  return [
    "#!/bin/zsh",
    "set -euo pipefail",
    `REMOTE_REPO=${shellQuote(remoteRepo)}`,
    `REMOTE_ROUND_DIR=${shellQuote(remoteRoundDir)}`,
    `BRANCH=${shellQuote(branch)}`,
    `EXPECTED_HEAD=${shellQuote(expectedHead)}`,
    `CODEX_BIN=${shellQuote(CODEX_BIN)}`,
    `PROMPT_B64=${shellQuote(promptBase64)}`,
    'SCHEMA_PATH="$REMOTE_REPO/scripts/mac-codex-report.schema.json"',
    '/bin/mkdir -p "$REMOTE_ROUND_DIR"',
    'cd "$REMOTE_REPO"',
    'export PATH="$REMOTE_REPO/.runtime/node/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    'if [[ -n "$(git status --porcelain)" ]]; then',
    '  print -u2 -- "Mac repository is not clean"',
    "  exit 20",
    "fi",
    ...syncCommands,
    'CURRENT_HEAD="$(git rev-parse HEAD)"',
    'if [[ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]]; then',
    '  print -u2 -- "Mac HEAD does not match the Windows HEAD"',
    "  exit 21",
    "fi",
    'git status --porcelain=v1 > "$REMOTE_ROUND_DIR/git-before.txt"',
    'git rev-parse HEAD > "$REMOTE_ROUND_DIR/head-before.txt"',
    'PROMPT="$(printf \'%s\' "$PROMPT_B64" | /usr/bin/base64 -D)"',
    "set +e",
    '"$CODEX_BIN" exec -p automation \\',
    "  --json \\",
    '  --output-schema "$SCHEMA_PATH" \\',
    '  -o "$REMOTE_ROUND_DIR/final.json" \\',
    '  -C "$REMOTE_REPO" \\',
    '  "$PROMPT" \\',
    "  < /dev/null \\",
    '  > "$REMOTE_ROUND_DIR/events.jsonl" \\',
    '  2> "$REMOTE_ROUND_DIR/stderr.log"',
    "CODEX_EXIT=$?",
    "set -e",
    'printf \'%s\\n\' "$CODEX_EXIT" > "$REMOTE_ROUND_DIR/codex-exit.txt"',
    'git status --porcelain=v1 > "$REMOTE_ROUND_DIR/git-after.txt"',
    'git rev-parse HEAD > "$REMOTE_ROUND_DIR/head-after.txt"',
    "exit 0",
    "",
  ].join("\n");
}

export function buildSshArgs({ sshAlias }) {
  return ["-o", "BatchMode=yes", sshAlias, "/bin/zsh", "-s"];
}

export function buildScpArgs({ sshAlias, remoteRoundDir, roundDir }) {
  return ["-r", `${sshAlias}:${remoteRoundDir}/.`, roundDir];
}

export function runProcess(command, args, options = {}) {
  if (!Array.isArray(args)) throw new TypeError("Process arguments must be an array");
  const { cwd, input = "", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let timedOut = false;
    let launchError = null;
    const stdout = [];
    const stderr = [];

    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        command,
        args: [...args],
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error: launchError?.message ?? null,
      });
    };

    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      launchError = error;
      resolve({
        command,
        args: [...args],
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: error.message,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
    child.stdin.end(input);
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, required, allowed, errors, label) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label}.${key} is not allowed`);
  }
  return true;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateStringArray(value, label, errors, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems) {
    errors.push(`${label} must contain at least ${minItems} item(s)`);
    return;
  }
  value.forEach((item, index) => {
    if (!nonEmptyString(item)) errors.push(`${label}[${index}] must be a non-empty string`);
  });
}

export function validateFinalReport(report) {
  const errors = [];
  const fields = [
    "taskUnderstanding",
    "environmentObservations",
    "commands",
    "tests",
    "findings",
    "recommendedWindowsActions",
    "status",
  ];
  if (!hasExactKeys(report, fields, fields, errors, "report")) return errors;

  if (!nonEmptyString(report.taskUnderstanding)) {
    errors.push("report.taskUnderstanding must be a non-empty string");
  }
  validateStringArray(report.environmentObservations, "report.environmentObservations", errors, {
    minItems: 1,
  });

  if (!Array.isArray(report.commands) || report.commands.length === 0) {
    errors.push("report.commands must contain at least one command");
  } else {
    report.commands.forEach((command, index) => {
      const label = `report.commands[${index}]`;
      const fields = ["purpose", "command", "exitCode", "summary"];
      if (!hasExactKeys(command, fields, fields, errors, label)) return;
      for (const key of ["purpose", "command", "summary"]) {
        if (!nonEmptyString(command[key])) errors.push(`${label}.${key} must be a non-empty string`);
      }
      if (!Number.isInteger(command.exitCode)) errors.push(`${label}.exitCode must be an integer`);
    });
  }

  if (!Array.isArray(report.tests) || report.tests.length === 0) {
    errors.push("report.tests must contain at least one test");
  } else {
    report.tests.forEach((test, index) => {
      const label = `report.tests[${index}]`;
      const fields = ["name", "command", "status", "exitCode", "summary"];
      if (!hasExactKeys(test, fields, fields, errors, label)) return;
      for (const key of ["name", "command", "summary"]) {
        if (!nonEmptyString(test[key])) errors.push(`${label}.${key} must be a non-empty string`);
      }
      if (!["passed", "failed", "skipped"].includes(test.status)) {
        errors.push(`${label}.status is invalid`);
      }
      if (test.exitCode !== null && !Number.isInteger(test.exitCode)) {
        errors.push(`${label}.exitCode must be an integer or null`);
      }
    });
  }

  if (!Array.isArray(report.findings)) {
    errors.push("report.findings must be an array");
  } else {
    report.findings.forEach((finding, index) => {
      const label = `report.findings[${index}]`;
      const fields = ["severity", "title", "details"];
      if (!hasExactKeys(finding, fields, fields, errors, label)) return;
      if (!["critical", "important", "warning", "info"].includes(finding.severity)) {
        errors.push(`${label}.severity is invalid`);
      }
      for (const key of ["title", "details"]) {
        if (!nonEmptyString(finding[key])) errors.push(`${label}.${key} must be a non-empty string`);
      }
    });
  }
  validateStringArray(
    report.recommendedWindowsActions,
    "report.recommendedWindowsActions",
    errors
  );
  if (!["passed", "failed"].includes(report.status)) errors.push("report.status is invalid");
  return errors;
}

function processExitCode(result) {
  if (!result) return null;
  return Number.isInteger(result.exitCode)
    ? result.exitCode
    : Number.isInteger(result.status)
      ? result.status
      : null;
}

function processSummary(result) {
  return {
    exitCode: processExitCode(result),
    timedOut: Boolean(result?.timedOut),
  };
}

function readArtifact(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function countEvents(source) {
  const summary = { total: 0, valid: 0, invalid: 0, byType: {} };
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    summary.total += 1;
    try {
      const event = JSON.parse(line);
      summary.valid += 1;
      const type =
        (typeof event?.type === "string" && event.type) ||
        (typeof event?.event === "string" && event.event) ||
        "unknown";
      summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    } catch {
      summary.invalid += 1;
    }
  }
  return summary;
}

export function summarizeRun(roundDir, processResults = {}) {
  const artifacts = {
    events: path.join(roundDir, "events.jsonl"),
    stderr: path.join(roundDir, "stderr.log"),
    finalReport: path.join(roundDir, "final.json"),
    gitBefore: path.join(roundDir, "git-before.txt"),
    gitAfter: path.join(roundDir, "git-after.txt"),
    headBefore: path.join(roundDir, "head-before.txt"),
    headAfter: path.join(roundDir, "head-after.txt"),
    codexExit: path.join(roundDir, "codex-exit.txt"),
    summary: path.join(roundDir, "summary.json"),
  };
  const errors = [];
  const missing = REQUIRED_ARTIFACTS.filter(
    (name) => !fs.existsSync(path.join(roundDir, name))
  );
  for (const name of missing) {
    errors.push({ code: "missing_artifact", message: `Missing artifact: ${name}` });
  }

  const ssh = processSummary(processResults.ssh);
  const scp = processSummary(processResults.scp);
  if (ssh.exitCode !== 0 || ssh.timedOut) {
    errors.push({ code: "ssh_failed", message: "SSH execution failed or timed out" });
  }
  if (scp.exitCode !== 0 || scp.timedOut) {
    errors.push({ code: "scp_failed", message: "SCP collection failed or timed out" });
  }

  let events = { total: 0, valid: 0, invalid: 0, byType: {} };
  if (fs.existsSync(artifacts.events)) {
    events = countEvents(readArtifact(artifacts.events));
    if (events.invalid > 0) {
      errors.push({ code: "invalid_events", message: "events.jsonl contains invalid JSON" });
    }
  }

  let report = null;
  if (fs.existsSync(artifacts.finalReport)) {
    try {
      report = JSON.parse(readArtifact(artifacts.finalReport));
      const reportErrors = validateFinalReport(report);
      if (reportErrors.length > 0) {
        errors.push({
          code: "invalid_final_report",
          message: `final.json violates the report schema: ${reportErrors.join("; ")}`,
        });
      }
    } catch {
      errors.push({ code: "invalid_final_report", message: "final.json is not valid JSON" });
    }
  }

  const gitBefore = fs.existsSync(artifacts.gitBefore)
    ? readArtifact(artifacts.gitBefore).trimEnd()
    : null;
  const gitAfter = fs.existsSync(artifacts.gitAfter)
    ? readArtifact(artifacts.gitAfter).trimEnd()
    : null;
  const headBefore = fs.existsSync(artifacts.headBefore)
    ? readArtifact(artifacts.headBefore).trim()
    : null;
  const headAfter = fs.existsSync(artifacts.headAfter)
    ? readArtifact(artifacts.headAfter).trim()
    : null;
  const gitChanged =
    gitBefore !== null &&
    gitAfter !== null &&
    headBefore !== null &&
    headAfter !== null &&
    (gitBefore !== gitAfter || headBefore !== headAfter);
  if (gitChanged) {
    errors.push({ code: "git_changed", message: "Mac Git state changed during Codex execution" });
  }

  let codexExitCode = null;
  if (fs.existsSync(artifacts.codexExit)) {
    const value = readArtifact(artifacts.codexExit).trim();
    if (/^-?[0-9]+$/.test(value)) codexExitCode = Number(value);
    else errors.push({ code: "invalid_codex_exit", message: "codex-exit.txt is invalid" });
  }
  if (codexExitCode !== null && codexExitCode !== 0) {
    errors.push({ code: "codex_failed", message: `Codex exited with code ${codexExitCode}` });
  }
  if (report && validateFinalReport(report).length === 0 && report.status !== "passed") {
    errors.push({ code: "report_failed", message: "Mac Codex report status is not passed" });
  }

  return {
    status: errors.length === 0 ? "passed" : "failed",
    roundDir,
    processes: { ssh, scp },
    artifacts,
    events,
    git: {
      changed: gitChanged,
      before: gitBefore,
      after: gitAfter,
      headBefore,
      headAfter,
    },
    codex: { exitCode: codexExitCode },
    report,
    errors,
  };
}

function createRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function localRunRoot() {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "CodexOrchestrator", "runs");
}

async function requireGitValue(repoRoot, args, label) {
  const result = await runProcess("git", args, { cwd: repoRoot, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Unable to read ${label}`);
  return result.stdout.trim();
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const localStatus = await requireGitValue(repoRoot, ["status", "--porcelain"], "Git status");
  if (localStatus) {
    throw new Error("Windows repository must be clean before Mac orchestration");
  }
  const branch = await requireGitValue(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "Git branch"
  );
  if (!branch || branch === "HEAD") throw new Error("Windows repository must be on a branch");
  const expectedHead = await requireGitValue(repoRoot, ["rev-parse", "HEAD"], "Git HEAD");
  const runId = createRunId();
  const roundDir = path.join(localRunRoot(), runId, "mac", options.roundName);
  const remoteRoundDir = `/Users/admin/.codex-orchestrator/runs/${runId}/mac/${options.roundName}`;
  fs.mkdirSync(roundDir, { recursive: true });

  const remoteScript = buildRemoteScript({
    ...options,
    remoteRoundDir,
    branch,
    expectedHead,
  });
  console.error(`[mac:codex] SSH run ${runId}/${options.roundName}`);
  const ssh = await runProcess("ssh", buildSshArgs(options), {
    cwd: repoRoot,
    input: remoteScript,
    timeoutMs: options.timeoutMs,
  });
  if (ssh.stderr.trim()) console.error(ssh.stderr.trim());

  console.error(`[mac:codex] collecting ${runId}/${options.roundName}`);
  const scp = await runProcess(
    "scp",
    buildScpArgs({ ...options, remoteRoundDir, roundDir }),
    { cwd: repoRoot, timeoutMs: options.timeoutMs }
  );
  if (scp.stderr.trim()) console.error(scp.stderr.trim());

  const summary = summarizeRun(roundDir, { ssh, scp });
  fs.writeFileSync(summary.artifacts.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
  return summary;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const current = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? current.toLowerCase() === invoked.toLowerCase()
    : current === invoked;
}

if (isMainModule()) {
  runCli().catch((error) => {
    console.error(`[mac:codex] ${error.message}`);
    process.stdout.write(
      `${JSON.stringify({
        status: "failed",
        error: { code: "orchestrator_error", message: error.message },
      })}\n`
    );
    process.exitCode = 1;
  });
}
