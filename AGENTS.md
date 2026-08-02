# Apple-AutoMation Codex Instructions

## Platform Roles

- Windows is the development host. Make source changes, run Windows-safe tests, review diffs,
  commit, and push from Windows.
- The Mac is the macOS verification host. By default it inspects and tests the exact pushed
  Windows commit. The Windows orchestrator may perform a clean fast-forward before Codex starts;
  Mac Codex itself must not edit, commit, or push source.
- Browser automation in this repository must use ruyiPage. Do not add Playwright, Puppeteer,
  Selenium, or a Node browser-control fallback.

## Mac Verification

Before invoking the Mac, require a clean Windows worktree and push the current branch. Then run:

```powershell
npm.cmd run -s mac:codex -- --task "Describe the macOS checks and tests to run"
```

For long UTF-8 instructions, use `--task-file <path>`. Use `--round 2`, `--round 3`, and so on
for repair/retest iterations. Read the returned JSON and the `summary.json`, `final.json`,
`events.jsonl`, and `stderr.log` paths before deciding the next Windows change.
Treat unchanged evidence as insufficient: both Mac Git status files must be empty and both HEAD
files must equal the exact Windows SHA for the round.

The default synchronized run takes an exclusive repository lock. Parallel read-only reviews may
use `--no-sync` only after the Mac HEAD is already the exact pushed Windows SHA; those runs share
a reader lock and cannot overlap a synchronizing writer.

Mac Codex keeps the repository hard read-only. The orchestrator selects a custom permission
profile that extends `:read-only`; its only write entry is the current round's
`$REMOTE_ROUND_DIR/tmp`, also exported as `TMPDIR`. Do not replace this with legacy `--add-dir`,
which does not add writes to the built-in read-only profile. Do not broaden the custom write entry
to the round root, repository, `$HOME`, or a shared system temp directory. The per-round temp
directory follows the protected evidence lifecycle and is not in the fixed artifact download list.
Before model execution, the orchestrator must validate that exact profile with `codex sandbox -P`
and `--include-managed-config`; a managed-policy conflict must fail closed instead of falling back.

When Mac Codex typechecks Swift inside its sandbox, pass a writable cache explicitly:
`/usr/bin/xcrun swiftc -module-cache-path "$TMPDIR/apple-automation-swift-module-cache" -typecheck <file>`.

Do not run manual 2FA, a real Apple account flow, `test:2fa-allow` manual mode, or tests that need
unattended GUI confirmation. Those require an explicitly supervised Mac session.
An explicitly supervised session must use a synchronized exclusive orchestrator run with
`--allow-supervised-gui`; omitting that flag keeps the non-interactive prohibition in force.
The flag does not relax the read-only repository profile, `$TMPDIR` write boundary, secret-redaction
rules, or the requirement that every browser action use ruyiPage.
For supervised runs the orchestrator must force reports, screenshots, 2FA audit/cancel files, and
the Firefox profile under the per-round `$TMPDIR`. A passed result also requires both the completed
`run.sh --skip-mac` command event and the fixed production acceptance artifact.

## Safety

- Do not read or print `.env`, Codex auth files, API keys, GitHub PAT values, or account secrets.
- Do not use recursive/bulk deletion, `git reset --hard`, or `git clean`.
- Preserve unrelated changes. If the Mac worktree is dirty, diverged, or cannot fast-forward to
  the pushed Windows commit, stop and report the mismatch instead of forcing synchronization.

See `docs/WINDOWS_MAC_CODEX.md` for setup, operation, artifacts, and troubleshooting.
