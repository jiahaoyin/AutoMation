# Apple-AutoMation Codex Instructions

## Platform Roles

- Windows is the development host. Make source changes, run Windows-safe tests, review diffs,
  commit, and push from Windows.
- The Mac is the macOS verification host. By default it inspects and tests the exact pushed
  Windows commit; it must not edit, commit, or push source.
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

When Mac Codex typechecks Swift inside its sandbox, pass a writable cache explicitly:
`/usr/bin/xcrun swiftc -module-cache-path "$TMPDIR/apple-automation-swift-module-cache" -typecheck <file>`.

Do not run manual 2FA, a real Apple account flow, `test:2fa-allow` manual mode, or tests that need
unattended GUI confirmation. Those require an explicitly supervised Mac session.

## Safety

- Do not read or print `.env`, Codex auth files, API keys, GitHub PAT values, or account secrets.
- Do not use recursive/bulk deletion, `git reset --hard`, or `git clean`.
- Preserve unrelated changes. If the Mac worktree is dirty or its HEAD differs from Windows,
  stop and report the mismatch instead of forcing synchronization.

See `docs/WINDOWS_MAC_CODEX.md` for setup, operation, artifacts, and troubleshooting.
