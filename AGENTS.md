# Apple-AutoMation Codex Instructions

## Platform Roles

- Windows and Mac are both full development hosts. Windows remains the default place for source
  changes, review, commit, and push, while Mac implementation has the same project-development
  authority for macOS-specific implementation, browser-page annotation, native GUI optimization,
  Git work, runtime maintenance, and networked verification.
- The default Mac mode is `verify`: it inspects and tests the exact pushed Windows commit.
  Implementation mode is an exclusive writer run, preserves existing Mac edits when
  `--no-sync` is used, and returns a sanitized diff/untracked manifest for review.
- Mac implementation is not a test-only role. It has full project-development permission for the
  complete worktree, including `.git`, `.runtime`, `.env`, task-required local credentials,
  browser/runtime state, native GUI, network access, Git commit, and Git push. Preserve unrelated
  changes and never use destructive Git commands.
- Windows remains the default synchronized review/commit host; Mac is also a first-class
  full-permission implementation host when `--mac-mode implementation` is selected.
- Browser automation in this repository must use ruyiPage. Do not add Playwright, Puppeteer,
  Selenium, or a Node browser-control fallback.

## Mac Verification and Implementation

For `verify` rounds, and implementation rounds explicitly using `--sync`, require a clean Windows
worktree and push the current branch. Then run:

```powershell
npm.cmd run -s mac:codex -- --task "Describe the macOS checks and tests to run"
```

For macOS implementation or browser annotation, use the full-permission writer mode:

```powershell
npm.cmd run -s mac:codex -- --mac-mode implementation --task-file .mac-implementation-task.txt
```

Use `--no-sync` for a follow-up iteration on an existing Mac worktree. That mode still takes
the exclusive writer lock and never overwrites dirty Mac work.

An implementation round without `--sync` defaults to `--no-sync`; it may start from the existing
Mac worktree and returns a sanitized patch/manifest for Windows review rather than forcing a push.

For long UTF-8 instructions, use `--task-file <path>`. Use `--round 2`, `--round 3`, and so on
for repair/retest iterations. Read the returned JSON and the `summary.json`, `final.json`,
`events.jsonl`, and `stderr.log` paths before deciding the next Windows change.
For `verify` rounds, unchanged evidence is insufficient: both Mac Git status files must be empty
and both HEAD files must equal the exact Windows SHA. Implementation rounds instead require the
sanitized diff, untracked manifest, and browser-annotation artifact.

The default synchronized verification run takes an exclusive repository lock. Parallel
read-only reviews may use `--no-sync` only in `verify` mode; implementation runs always take the
exclusive writer lock and cannot overlap any reader or writer.

Verification mode uses a custom `:read-only` profile whose only write entry is the current
round's `$REMOTE_ROUND_DIR/tmp`. Implementation mode opens the complete project worktree,
including `.git`, `.runtime`, `.env`, task-required local credentials, browser/runtime state,
networked development, and native browser/UI work. There is no implementation-mode deny list for
those project-development resources. The per-round temp directory is still exported as `TMPDIR`
for round artifacts.
Before model execution, the orchestrator must validate that exact profile with `codex sandbox -P`
and `--include-managed-config`; a managed-policy conflict must fail closed instead of falling back.

When Mac Codex typechecks Swift inside its sandbox, pass a writable cache explicitly:
`/usr/bin/xcrun swiftc -module-cache-path "$TMPDIR/apple-automation-swift-module-cache" -typecheck <file>`.

In `verify` mode, do not run manual 2FA, a real Apple account flow, `test:2fa-allow` manual mode,
or tests that need unattended GUI confirmation. Those verify actions require an explicitly
supervised Mac session using a synchronized exclusive orchestrator run with `--allow-supervised-gui`;
omitting that flag keeps the verify-mode non-interactive prohibition in force. Implementation mode
uses its full-development contract and may run the task-required credential, 2FA, browser, native
GUI, runtime, and network work.
Every browser action remains ruyiPage-only. Mac implementation may run the task's required
browser, credential, 2FA, native GUI, runtime, and network work, and can record browser
annotations. `--allow-supervised-gui` is accepted for implementation work without replacing its
full-development contract. Outbound reports, logs, annotations, patches, and chat output must
still redact secret values and personal data.
For supervised runs the orchestrator must force reports, screenshots, 2FA audit/cancel files, and
the Firefox profile under the per-round `$TMPDIR`. A passed result also requires both the completed
`run.sh --skip-mac` command event and the fixed production acceptance artifact.

## Safety

- Do not print `.env`, Codex auth files, API keys, GitHub PAT values, or account secrets in
  reports, logs, patches, annotations, or chat output. Implementation may access them inside the
  local task when required.
- Do not use recursive/bulk deletion, `git reset --hard`, or `git clean`.
- Preserve unrelated changes. Verification mode stops when the Mac worktree is dirty, diverged,
  or cannot fast-forward to the pushed Windows commit. Implementation mode with `--no-sync`
  continues from the existing worktree under the writer lock; it never forces synchronization or
  overwrites local edits.

See `docs/WINDOWS_MAC_CODEX.md` for setup, operation, artifacts, and troubleshooting.
