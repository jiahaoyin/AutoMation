# Windows -> Mac Codex Test Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible Windows-side command that synchronizes the current branch to the Mac, runs Mac Codex as a structured test executor, and returns complete evidence to Windows for repair/retest loops.

**Architecture:** A Node.js script owns UTF-8 transport, SSH/scp process control, remote repository synchronization, Codex invocation, artifact collection, and summary validation. Mac Codex runs with the existing `automation` profile and a repository-owned JSON output schema; it inspects and tests but does not edit.

**Tech Stack:** Node.js ESM, `node:assert`, Windows OpenSSH, macOS zsh, Codex CLI JSONL and output schema, Git.

## Global Constraints

- Work directly on `D:\work\apple-automation`; do not create a worktree.
- Do not use recursive/bulk deletion, `git reset --hard`, or `git clean`.
- Preserve unrelated user changes and do not read `.env`, auth files, API keys, or PAT values.
- Browser automation in Apple-AutoMation must remain ruyiPage-only.
- Mac is a test executor by default: no source edits, commits, or pushes.
- Use `/Users/admin/.local/bin/codex exec -p automation` so Mac receives the aligned model/provider/rate settings.
- Use Base64 for UTF-8 task transport and process argument arrays rather than nested shell quoting.
- Store run evidence outside Git worktrees under platform-specific CodexOrchestrator run directories.
- Do not commit or push until implementation, Mac verification, and review loops are complete.

---

### Task 1: Fix Intel Node Asset Mapping

**Files:**
- Modify: `scripts/test-python-bootstrap.mjs`
- Modify: `scripts/bootstrap-macos.sh`

- [x] Add a failing assertion requiring `x86_64) arch="x64" ;;` and forbidding the old mapping.
- [x] Run `npm.cmd run test:python-bootstrap` and confirm the assertion fails against `arch="x86_64"`.
- [x] Change only the Intel mapping to `x64`.
- [x] Re-run the focused test, release-copy test, Bash syntax check, Node syntax check, and `git diff --check`.

### Task 2: Implement The Windows-Side Orchestrator With TDD

**Files:**
- Create: `scripts/mac-codex-orchestrator.mjs`
- Create: `scripts/test-mac-codex-orchestrator.mjs`
- Create: `scripts/mac-codex-report.schema.json`
- Modify: `package.json`

**Interfaces:**
- `parseArgs(argv)` returns validated task, sync, SSH, repo, round, and timeout options.
- `buildAgentPrompt(options)` returns the fixed no-edit Mac verification contract plus the user task.
- `buildRemoteScript(options)` returns a zsh script with shell-quoted constants and a Base64 prompt.
- `summarizeRun(roundDir, processResults)` validates artifacts and returns the JSON envelope.
- CLI stdout emits one JSON object; progress and diagnostics go to stderr.

- [ ] Write tests for required task input, `--task-file`, round formatting, default values, and invalid timeouts.
- [ ] Write tests proving Chinese task text is Base64 encoded, the absolute Codex path and `-p automation` are used, destructive Git commands are absent, and the no-secret/no-edit/ruyiPage rules are present.
- [ ] Write tests for JSONL event counting, final report parsing, Git-change detection, Codex failure, missing artifacts, and failed report status.
- [ ] Run `node scripts/test-mac-codex-orchestrator.mjs` and verify RED because the module/schema do not exist.
- [ ] Implement the strict JSON Schema with required task understanding, environment observations, commands, tests, findings, recommended Windows actions, and status fields.
- [ ] Implement argument parsing, shell quoting, prompt construction, process timeout, SSH execution, scp collection, and summary validation using Node standard libraries only.
- [ ] Add `mac:codex` and `test:mac-codex` npm scripts.
- [ ] Re-run the focused test and `node --check` for both scripts until GREEN.

### Task 3: Document Session Usage And Failure Recovery

**Files:**
- Create: `AGENTS.md`
- Create: `docs/WINDOWS_MAC_CODEX.md`
- Modify: `README.md`
- Test: `scripts/test-mac-codex-orchestrator.mjs`

- [ ] Extend the source-contract test to require the run command, artifact names, Windows repair/retest loop, and prohibited manual/live tests.
- [ ] Run the test and confirm RED because the guide is absent.
- [ ] Write the complete Chinese guide: prerequisites, current aligned settings, SSH/Mac configuration, first-run bootstrap, project-session commands, artifact interpretation, Windows fix/retest rounds, troubleshooting, and hardening commands that require local Mac sudo.
- [ ] Add durable repository instructions so future Codex tasks automatically use Windows for edits and the Mac orchestrator for macOS verification.
- [ ] Link the guide from `README.md` and keep all real credentials out of documentation.
- [ ] Re-run the focused documentation test and `git diff --check` until GREEN.

### Task 4: Integrate And Run Mac Acceptance

**Files:**
- No new source files expected; generated evidence stays outside the repository.

- [ ] Run all focused Windows tests and relevant broader noninteractive tests.
- [ ] Commit the reviewed implementation and push `codex/ruyipage-risk-reduction`.
- [ ] Fast-forward the Mac repository and verify its HEAD equals Windows HEAD.
- [ ] Run Bash bootstrap on Mac to install local Node 22.14.0; do not invoke privileged Python install when Python is already present.
- [ ] Run Mac shell/Swift typechecks, environment check, bootstrap test, and relevant noninteractive unit suites. Skip `test:2fa-allow` manual mode and real account/UI flows.
- [ ] Run one orchestrated Mac Codex smoke task and confirm `summary.json`, `events.jsonl`, `final.json`, exit code, environment observations, commands, tests, and unchanged Git state.

### Task 5: Review, Fix, Retest, Re-review

**Files:**
- Review the complete diff and evidence; modify only files required by findings.

- [ ] Dispatch at least three parallel read-only reviewers for correctness, security/transport, and documentation/operability.
- [ ] Consolidate all findings into one fix pass, run covering tests, and re-dispatch reviewers that found blocking issues.
- [ ] Continue until all Critical/Important findings are closed and all reviewers approve.
- [ ] Run fresh final verification before reporting completion.
