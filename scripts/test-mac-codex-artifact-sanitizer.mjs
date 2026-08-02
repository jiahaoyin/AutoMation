import assert from "node:assert/strict";

import {
  sanitizeMacCodexArtifacts,
  validateMacImplementationArtifacts,
} from "./sanitize-mac-codex-artifacts.mjs";
import {
  SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER,
  SUPERVISED_SUCCESS_MARKER,
} from "./lib/supervised-attestation.js";

function validReport(overrides = {}) {
  return {
    taskUnderstanding: "Run the focused macOS checks",
    environmentObservations: ["macOS runtime available"],
    commands: [
      {
        purpose: "Run a focused test",
        command: "npm run test:mac-codex",
        exitCode: 0,
        summary: "passed",
      },
    ],
    tests: [
      {
        name: "mac codex contract",
        command: "npm run test:mac-codex",
        status: "passed",
        exitCode: 0,
        summary: "passed",
      },
    ],
    findings: [],
    recommendedWindowsActions: [],
    executionMode: "mac_implementation",
    supervisedGuiStatus: "not_requested",
    status: "passed",
    ...overrides,
  };
}

const sourceEvents = [
  { type: "thread.started" },
  {
    type: "item.completed",
    item: {
      id: "item-1",
      type: "command_execution",
      command: "cat /Users/admin/.env",
      status: "completed",
      exit_code: 0,
      aggregated_output: "raw-secret-canary-must-not-leak",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "item-2",
      type: "command_execution",
      command: "node scripts/supervised-mac-acceptance.mjs",
      status: "completed",
      exit_code: 0,
      aggregated_output: `${SUPERVISED_SUCCESS_MARKER}\n`,
    },
  },
  { type: "turn.completed" },
]
  .map((event) => JSON.stringify(event))
  .join("\n") + "\n";

const sanitized = sanitizeMacCodexArtifacts({
  events: sourceEvents,
  stderr: "raw-secret-canary-must-not-leak https://example.invalid/?token=raw-secret-canary-must-not-leak\n",
  finalReport: JSON.stringify(
    validReport({
      taskUnderstanding: "Inspect https://example.invalid/ and /Users/admin/private.txt",
      environmentObservations: ["raw-secret-canary-must-not-leak"],
      commands: [
        {
          purpose: "inspect user input",
          command: "cat /Users/admin/private.txt",
          exitCode: 0,
          summary: "email user@example.invalid was observed",
        },
      ],
    })
  ),
});

assert.doesNotMatch(sanitized.events, /raw-secret-canary-must-not-leak|\/Users\/admin/);
assert.match(sanitized.events, /\[redacted-command\]/);
assert.match(sanitized.events, new RegExp(SUPERVISED_SUCCESS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const smokeSanitized = sanitizeMacCodexArtifacts({
  events: JSON.stringify({
    type: "item.completed",
    item: {
      id: "item-smoke",
      type: "command_execution",
      command: "node scripts/supervised-mac-acceptance.mjs --settings-smoke",
      status: "completed",
      exit_code: 0,
      aggregated_output: `${SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER}\n`,
    },
  }) + "\n",
  stderr: "",
  finalReport: JSON.stringify(validReport()),
});
assert.match(
  smokeSanitized.events,
  new RegExp(SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
);
assert.equal(sanitized.stderr, "stderr_present:1\n");
assert.doesNotMatch(sanitized.finalReport, /raw-secret-canary-must-not-leak|example\.invalid|\/Users\/admin|user@example\.invalid/);
const report = JSON.parse(sanitized.finalReport);
assert.equal(report.executionMode, "mac_implementation");
assert.equal(report.status, "passed");
assert.equal(report.taskUnderstanding, "sanitized_taskUnderstanding");
assert.equal(report.commands[0].command, "sanitized_command_0_command");
assert.equal(report.commands[0].summary, "sanitized_command_0_summary");

assert.throws(
  () =>
    sanitizeMacCodexArtifacts({
      events: "not-json\n",
      stderr: "",
      finalReport: JSON.stringify(validReport()),
    }),
  /Unexpected token|JSON/
);
assert.throws(
  () =>
    sanitizeMacCodexArtifacts({
      events: sourceEvents,
      stderr: "",
      finalReport: JSON.stringify({ ...validReport(), secret: "must fail" }),
    }),
  /report_keys_invalid/
);

const implementationArtifacts = validateMacImplementationArtifacts({
  gitDiff: [
    "diff --git a/scripts/new-helper.mjs b/scripts/new-helper.mjs",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/scripts/new-helper.mjs",
    "+export const helper = 'safe';",
    "",
  ].join("\n"),
  gitUntracked: "scripts/new-helper.mjs\n",
});
assert.match(implementationArtifacts.gitDiff, /new-helper\.mjs/);
assert.equal(implementationArtifacts.gitUntracked, "scripts/new-helper.mjs\n");
assert.throws(
  () =>
    validateMacImplementationArtifacts({
      gitDiff: "diff --git a/scripts/new-helper.mjs b/scripts/new-helper.mjs\n+const token = 'raw-secret-canary-must-not-leak';\n",
      gitUntracked: "scripts/new-helper.mjs\n",
    }),
  /implementation_patch_sensitive_content/
);
assert.throws(
  () =>
    validateMacImplementationArtifacts({
      gitDiff: "",
      gitUntracked: "scripts/new-helper.mjs\n",
    }),
  /untracked_content_missing/
);
assert.throws(
  () =>
    validateMacImplementationArtifacts({
      gitDiff: "diff --git a/.env b/.env\n",
      gitUntracked: "",
    }),
  /unsafe_implementation_path/
);

console.log("mac Codex artifact sanitizer tests passed");
