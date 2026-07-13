import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAgentPrompt,
  buildRemoteScript,
  buildScpArgs,
  buildSshArgs,
  parseArgs,
  runProcess,
  summarizeRun,
  validateFinalReport,
} from "./mac-codex-orchestrator.mjs";

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_REMOTE_REPO = "/Users/admin/Desktop/Apple-AutoMation";
const projectInstructions = fs.readFileSync(
  new URL("../AGENTS.md", import.meta.url),
  "utf8"
);
const operationsGuide = fs.readFileSync(
  new URL("../docs/WINDOWS_MAC_CODEX.md", import.meta.url),
  "utf8"
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
]) {
  assert.match(prompt, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const remoteOptions = {
  task: "检查中文任务与登录流程",
  sync: true,
  remoteRepo: DEFAULT_REMOTE_REPO,
  remoteRoundDir: "/Users/admin/.codex-orchestrator/runs/run-test/mac/round-02",
  branch: "codex/ruyipage-risk-reduction",
  expectedHead: "0123456789abcdef",
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
assert.ok(
  remoteScript.includes(
    'PERMISSION_PROFILE="{ extends = \\":read-only\\", filesystem = { \\"$RUN_TMP_DIR\\" = \\"write\\" } }"'
  )
);
assert.match(remoteScript, /RUN_TMP_DIR="\$REMOTE_ROUND_DIR\/tmp"/);
assert.match(remoteScript, /export TMPDIR="\$RUN_TMP_DIR"/);
assert.equal((remoteScript.match(/PERMISSION_PROFILE=/g) ?? []).length, 1);
assert.equal((remoteScript.match(/permissions\.mac_verification=/g) ?? []).length, 2);
assert.equal((remoteScript.match(/default_permissions=/g) ?? []).length, 1);
assert.equal((remoteScript.match(/\n  -c /g) ?? []).length, 3);
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
  /"\$CODEX_BIN" sandbox -p automation \\\n  -c "permissions\.mac_verification=\$PERMISSION_PROFILE" \\\n  -P mac_verification \\\n  --include-managed-config \\\n  -C "\$REMOTE_REPO" \\\n  \/usr\/bin\/true/
);
assert.match(
  remoteScript,
  /"\$CODEX_BIN" exec -p automation \\\n  -c "permissions\.mac_verification=\$PERMISSION_PROFILE" \\\n  -c 'default_permissions="mac_verification"' \\\n  --json/
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
assert.match(remoteScript, /trap cleanup_lock EXIT INT TERM/);
assert.match(remoteScript, /READERS_DIR/);
assert.match(remoteScript, /WRITER_LOCK/);

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
    "status",
  ])
);
for (const property of ["commands", "tests", "findings"]) {
  assert.equal(schema.properties[property].items.additionalProperties, false);
}
assert.deepEqual(schema.properties.status.enum, ["passed", "failed"]);

function validReport(status = "passed") {
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
    status,
  };
}

assert.deepEqual(validateFinalReport(validReport()), []);
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

function writeArtifacts(roundDir, overrides = {}) {
  fs.mkdirSync(roundDir, { recursive: true });
  const artifacts = {
    "events.jsonl":
      '{"type":"thread.started"}\n{"type":"item.completed"}\n{"type":"turn.completed"}\n',
    "stderr.log": "",
    "final.json": `${JSON.stringify(validReport())}\n`,
    "git-before.txt": "",
    "git-after.txt": "",
    "head-before.txt": "0123456789abcdef\n",
    "head-after.txt": "0123456789abcdef\n",
    "codex-exit.txt": "0\n",
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
  const passed = summarizeRun(passedDir, processResults);
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
  assert.deepEqual(passed.report, validReport());
  assert.equal(passed.artifacts.finalReport, path.join(passedDir, "final.json"));

  const changedDir = path.join(artifactRoot, "changed");
  writeArtifacts(changedDir, { "git-after.txt": " M scripts/file.mjs\n" });
  const changed = summarizeRun(changedDir, processResults);
  assert.equal(changed.status, "failed");
  assert.equal(changed.git.changed, true);
  assert.ok(changed.errors.some((error) => error.code === "git_changed"));

  const codexFailedDir = path.join(artifactRoot, "codex-failed");
  writeArtifacts(codexFailedDir, { "codex-exit.txt": "17\n" });
  const codexFailed = summarizeRun(codexFailedDir, processResults);
  assert.equal(codexFailed.status, "failed");
  assert.ok(codexFailed.errors.some((error) => error.code === "codex_failed"));

  const missingDir = path.join(artifactRoot, "missing");
  writeArtifacts(missingDir, { "final.json": null });
  const missing = summarizeRun(missingDir, processResults);
  assert.equal(missing.status, "failed");
  assert.ok(missing.errors.some((error) => error.code === "missing_artifact"));

  const failedReportDir = path.join(artifactRoot, "failed-report");
  writeArtifacts(failedReportDir, {
    "final.json": `${JSON.stringify(validReport("failed"))}\n`,
  });
  const failedReport = summarizeRun(failedReportDir, processResults);
  assert.equal(failedReport.status, "failed");
  assert.ok(failedReport.errors.some((error) => error.code === "report_failed"));

  const invalidReportDir = path.join(artifactRoot, "invalid-report");
  writeArtifacts(invalidReportDir, {
    "final.json": '{"status":"passed"}\n',
  });
  const invalidReport = summarizeRun(invalidReportDir, processResults);
  assert.equal(invalidReport.status, "failed");
  assert.ok(
    invalidReport.errors.some((error) => error.code === "invalid_final_report")
  );

  const emptyEventsDir = path.join(artifactRoot, "empty-events");
  writeArtifacts(emptyEventsDir, { "events.jsonl": "" });
  const emptyEvents = summarizeRun(emptyEventsDir, processResults);
  assert.equal(emptyEvents.status, "failed");
  assert.ok(emptyEvents.errors.some((error) => error.code === "missing_events"));

  const primitiveEventsDir = path.join(artifactRoot, "primitive-events");
  writeArtifacts(primitiveEventsDir, { "events.jsonl": "42\n" });
  const primitiveEvents = summarizeRun(primitiveEventsDir, processResults);
  assert.equal(primitiveEvents.status, "failed");
  assert.ok(primitiveEvents.errors.some((error) => error.code === "invalid_events"));

  const processFailedDir = path.join(artifactRoot, "process-failed");
  writeArtifacts(processFailedDir);
  const processFailed = summarizeRun(processFailedDir, {
    ssh: { exitCode: 255, timedOut: false },
    scp: { exitCode: 1, timedOut: true },
  });
  assert.equal(processFailed.status, "failed");
  assert.ok(processFailed.errors.some((error) => error.code === "ssh_failed"));
  assert.ok(processFailed.errors.some((error) => error.code === "scp_failed"));
} finally {
  removeTreeOneFileAtATime(artifactRoot);
}

const timeoutResult = await runProcess(
  process.execPath,
  ["-e", "setTimeout(() => {}, 10000)"],
  { timeoutMs: 100 }
);
assert.equal(timeoutResult.timedOut, true);

console.log("mac codex orchestrator contract: ok");
