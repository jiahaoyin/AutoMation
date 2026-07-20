# Mac Codex Continuation Handoff

> Purpose: give a new Codex session on the Mac enough context to continue the
> Apple-AutoMation project without rediscovering its architecture, safety
> boundaries, or current 2FA state. This document contains no credentials,
> Apple ID, password, OTP, raw AX/OCR output, or page content.

## 1. Read This First

This repository automates an Apple Account browser sign-in on macOS. Browser
launch, navigation, page inspection, input, click, screenshot, and shutdown
must use **ruyiPage only**. Do not add or fall back to Playwright, Puppeteer,
Selenium, AppleScript browser control, or a Node browser driver.

The user currently wants to test the Mac flow manually and then provide
sanitized evidence for targeted repair. Mac Codex must **never** directly
start a real Apple Account flow, browser, System Settings, supervised GUI
flow, or automatic Mac test. If supervised GUI verification is restored later,
only the Windows orchestrator may start it through a synchronized exclusive
run with `--allow-supervised-gui`; Mac Codex remains read-only.

Current development branch:

```text
codex/ruyipage-risk-reduction
```

Latest functional baseline when this handoff was written:

```text
dbd641d fix: route settings smoke to native helper
```

The handoff document itself may be committed after that SHA. Always inspect
the current checked-out commit rather than treating this SHA as permanent.

## 2. Platform Roles

| Environment | Responsibility |
| --- | --- |
| Windows development host | Read source, make changes, run Windows-safe tests, review, commit, and push. |
| Mac verification host | Pull the exact pushed commit, run user-approved manual checks, collect sanitized evidence, and report results. Do not edit, commit, or push source from Mac Codex. |

The normal Mac repository path is:

```text
/Users/admin/Desktop/Apple-AutoMation
```

Before changing anything, read these files in order:

1. `AGENTS.md`
2. `docs/MAC_CODEX_HANDOFF.md` (this file)
3. `docs/PROJECT.md`
4. `README.md`
5. `docs/WINDOWS_MAC_CODEX.md` only when using the Windows-to-Mac orchestration path

Do not reset, clean, revert, or delete unrelated worktree changes. Treat them
as user-owned until their owner says otherwise.

## 3. Current Product Behavior

### Browser flow

The main entry point is `run.sh`. The browser-only manual test command is:

```bash
./run.sh --skip-mac
```

The high-level path is:

```text
run.sh
  -> scripts/apple-id-full-flow.mjs
  -> scripts/lib/account-browser-flow.js
  -> scripts/lib/ruyipage-backend-runner.js
  -> scripts/ruyipage/apple_account_flow.py
```

`scripts/ruyipage/apple_account_flow.py` owns every Firefox page operation.
It uses ruyiPage BiDi-native input for email, password, checkbox, OTP input,
and page transitions. The Node side exchanges only framed JSONL events and
commands with it.

Do not replace the trusted ruyiPage input path with DOM `dispatchEvent`, a
second browser library, or coordinate clicking.

### 2FA provider policy

The formal 2FA collector is `scripts/lib/two-fa-sidecar.js`, created by
`scripts/lib/account-browser-flow.js` through `createMac2FACollector(...)`.

The default is **not** Settings-only. Keep the strict serial fallback:

1. A real acquisition begins only when ruyiPage emits `need_2fa`. The popup
   watcher gets a 30-second primary window to read the trusted Apple
   verification popup through Accessibility (AX).
2. If AX cannot produce a valid code, the same verified Apple window may use
   Vision OCR as a read-only fallback. OCR never clicks the screen. A confirmed
   Allow action gives popup AX/OCR a further 30 seconds before Settings may run.
3. Only after the popup-primary window ends without a valid fresh code may
   System Settings start. It can try at most twice, up to 60 seconds per try,
   with a five-second backoff. Once Settings has started, a late popup candidate
   cannot win that acquisition.
4. Only after the bounded Settings attempts finish may a real TTY offer hidden
   manual code input, and never before 90 seconds from the first acquisition.
5. A validated six-digit code from the current serial stage is sent immediately
   to ruyiPage. Later stages are not started; native helper and popup cleanup is
   bounded background work and must not hold up webpage input.
6. The shared acquisition deadline is 240 seconds from the first acquisition.
   The two-attempt Settings budget is shared by the whole collector and is not
   reset for generation 2. A second OTP generation is requested only when the
   Apple page explicitly reports an invalid, expired, or rejected first code;
   it restarts at popup-primary. Captcha, lockout, or unknown login errors stop
   the flow instead of endlessly retrying.

Relevant defaults:

```text
BROWSER_2FA_SETTINGS_AFTER_MS=30000
BROWSER_2FA_SETTINGS_FALLBACK=1
BROWSER_2FA_MANUAL_FALLBACK=1
BROWSER_2FA_POLL_MS=800
BROWSER_PRESERVE_ON_FAILURE=1
```

Do not switch `settingsOnly` on, reintroduce a provider race, or disable
popup/OCR/manual sources merely to work around one failed test. The user's
current requirement is: popup first, then Settings only after popup-primary
expires, then manual input only after Settings ends.

Terminal output never prints OTP. It must never be written to audit JSONL,
reports, screenshots, error text, or evidence handed back to Windows.

### Native helper map

| File | Responsibility |
| --- | --- |
| `scripts/swift/mac-2fa-popup-read.swift` | Read a trusted native Apple popup through AX. |
| `scripts/swift/mac-2fa-popup-ocr.swift` | Read only a trusted popup through Vision OCR; no OCR click path. |
| `scripts/swift/mac-2fa-click-allow.swift` | Narrow native Allow action with process/window/button checks. |
| `scripts/swift/mac-settings-2fa-code.swift` | Navigate System Settings to Apple Account, request a verification code, read it, then close the dialog. |
| `scripts/lib/mac-settings-2fa.js` | Spawn/cancel the Settings helper and map its fixed failure codes. |
| `scripts/lib/mac-2fa-popup.js` | Popup lifecycle and cleanup helpers. |
| `scripts/preflight-2fa-permissions.mjs` | Accessibility and Screen Recording preflight for the normal browser flow. |

## 4. Permissions and Environment

Run `./install.sh` on the Mac after a new pull or when native helpers are
missing/outdated. It handles the project runtime and native helper compilation.
It may request administrator authorization for a trusted Python installation.
The project must never save, print, or commit that password.

The actual runtime identity needs the following macOS permissions:

| Permission | Why it is needed |
| --- | --- |
| Accessibility | Native popup and System Settings AX helpers. The item visible in macOS may be Terminal, Codex, or a helper; trust the actual item shown by macOS rather than assuming a different checked app covers it. |
| Screen & System Audio Recording | Required for Vision OCR. Browser login intentionally stops before credential submission if this permission is missing. |
| Automation | Needed only for the separate macOS System Settings login stage, not for `./run.sh --skip-mac` browser-only work. |

After macOS changes a permission, close and reopen the runtime application when
the system asks. Do not try to bypass TCC with AppleScript, shell hacks, or
untrusted helper replacements.

If Swift compilation fails, collect the fixed compiler diagnostic and the exact
command shown by `install.sh`. Do not delete Xcode, Python, project runtimes,
or user data while diagnosing it.

## 5. Current Known State

The most recent focused change, `dbd641d`, fixed a real routing defect in the
supervised **Settings smoke** mode: it had been launching `./run.sh --skip-mac`
instead of the dedicated `scripts/supervised-settings-2fa-smoke.mjs` entry.
The attestation now also binds the digest to the mode-specific production
command.

The last supervised Settings smoke attempt reached the dedicated route but
returned the fixed failure class `TWO_FA_CODE_UNAVAILABLE` after roughly two
per-provider time windows. It did not produce two fresh Settings codes. This
does **not** prove a particular UI label, dialog, or permission is wrong:
the smoke runner currently collapses the underlying helper result into a fixed
privacy-safe failure. No automatic Mac retest is pending.

The next evidence should come from the user's manual test. Concentrate on the
first actual observable failure point rather than broad refactors:

- Settings never opens.
- Settings opens but cannot reach Sign-In & Security / Two-Factor
  Authentication.
- Get Verification Code is visible but is not pressed.
- The code dialog appears but no code is read.
- A code is read but browser OTP entry or final account-home confirmation fails.
- The main browser flow exits earlier, for example at password input.

## 6. Manual Mac Test Procedure

The user, not Codex, performs the real GUI test. A new Mac Codex session may
help inspect results after the user finishes.

1. The user (or the Windows orchestrator), not Mac Codex, updates the Mac
   checkout. First require a clean worktree and obtain the exact Windows SHA
   that has already been pushed. If either check fails, stop and report the
   mismatch instead of forcing synchronization:

   ```bash
   cd /Users/admin/Desktop/Apple-AutoMation
   git status --short
   git fetch origin
   git switch codex/ruyipage-risk-reduction
   git pull --ff-only origin codex/ruyipage-risk-reduction
   git rev-parse HEAD
   ```

   `git status --short` must be empty before synchronization. The final
   `git rev-parse HEAD` output must equal the Windows SHA. Do not use
   `git reset --hard`, `git clean`, a forced checkout, or any workaround when
   that contract is not met.

2. Prepare the environment when needed:

   ```bash
   ./install.sh
   ```

3. The user starts the browser-only real flow manually:

   ```bash
   ./run.sh --skip-mac
   ```

4. The user records the visible behavior and sends only safe evidence back to
   the Windows development session. Preferred artifacts are the sanitized
   `flow-audit.jsonl` and `2fa-audit.jsonl` files from the affected report
   directory. Do not send a full `report.json` unless it has first been
   verified to contain no personal profile fields, account-page content,
   email, session value, credentials, or OTP; otherwise send only the relevant
   fixed-status JSONL lines. A screenshot or video may be sent only after it
   is cropped and redacted so it contains no Apple ID, password field, OTP,
   personal profile data, session value, URL query, authentication-page text,
   raw AX/OCR, or full authentication page. If that cannot be confirmed before
   sending, do not send the image or video.

5. Do not run `npm run mac:codex`, `node scripts/supervised-mac-acceptance.mjs`,
   `test:2fa-allow` manual mode, or a real flow automatically unless the user
   explicitly restores that authorization.

Never paste or ask for:

- `.env` contents
- Apple ID, password, session tokens, API keys, or GitHub credentials
- OTP values
- raw AX trees, OCR text, network payloads, URL query strings, or full auth-page text

## 7. Evidence Triage Map

| User-visible phase or fixed status | Start reading here |
| --- | --- |
| Firefox does not launch | `scripts/lib/ruyipage-runtime.js`, `scripts/lib/ruyipage-backend-runner.js`, `scripts/ruyipage/apple_account_flow.py` |
| Email/password/remember-account failure | `scripts/ruyipage/apple_account_flow.py` and `scripts/test-account-browser-flow.mjs` |
| Page requests a code but none arrives | `scripts/lib/account-browser-flow.js`, `scripts/lib/two-fa-sidecar.js`, popup/settings helpers |
| Popup appears but code is not read | `scripts/swift/mac-2fa-popup-read.swift`, `scripts/swift/mac-2fa-popup-ocr.swift`, `scripts/lib/mac-2fa-popup.js` |
| Settings path is stuck | `scripts/swift/mac-settings-2fa-code.swift`, `scripts/lib/mac-settings-2fa.js` |
| Code is acquired but not entered into web page | `scripts/ruyipage/apple_account_flow.py`, especially `need_2fa`, `2fa_code`, generation, focus, and target validation |
| Code is rejected | `scripts/ruyipage/apple_account_flow.py` explicit invalid/expired-code detection and generation 2 handling |

Start from fixed status lines and sanitized JSONL fields. Do not "fix" a
failure by suppressing verification, weakening target validation, using raw
coordinate clicks, or logging secret material.

## 8. Safe Development Loop

When the user provides a concrete failure:

1. Reproduce the state from the sanitized evidence in Windows source analysis.
2. Change the smallest owning module.
3. Add or update a focused unit/contract test for that behavior.
4. Run only the relevant Windows-safe tests, plus `node --check` or
   `python -m py_compile` for touched code and `git diff --check`.
5. Review the diff for secret exposure and accidental fallback browser tooling.
6. Commit only the intended files and push
   `codex/ruyipage-risk-reduction` from Windows.
7. Ask the user to pull and run the manual Mac test again.

Do not let local tests become a substitute for real macOS GUI evidence. Also do
not launch repeated Mac GUI tests automatically: the user has explicitly
requested a manual-feedback repair cycle.

## 9. Safe Test Commands

Use only tests relevant to the touched module. Typical Windows-safe examples:

```bash
node scripts/test-two-fa-sidecar.mjs
node scripts/test-account-browser-flow.mjs
node scripts/test-ruyipage-protocol.mjs
node scripts/test-ruyipage-flow.mjs
node scripts/test-supervised-settings-2fa-smoke.mjs
node --check scripts/lib/two-fa-sidecar.js
node --check scripts/lib/account-browser-flow.js
python -m py_compile scripts/ruyipage/apple_account_flow.py
git diff --check
```

Do not run a broad full-suite loop unless the change crosses those modules.

## 10. New Mac Codex Session Prompt

Paste this into a new Mac Codex session after opening the repository:

```text
Read /Users/admin/Desktop/Apple-AutoMation/AGENTS.md and
/Users/admin/Desktop/Apple-AutoMation/docs/MAC_CODEX_HANDOFF.md first.

This is a manual-feedback phase. Do not start a real Apple Account flow,
supervised GUI flow, browser, Settings, or automatic test. Do not read .env or
output credentials, OTP, raw AX/OCR, screenshots, URLs, or auth-page text.

Browser actions in this project must remain ruyiPage-only. Keep strict serial
2FA fallback: popup AX/OCR first, System Settings only after the popup-primary
window expires, then optional hidden manual entry only after Settings ends. Do
not switch to Settings-only or reintroduce a provider race.

Wait for my sanitized logs or properly redacted visual evidence. Once I
provide evidence, identify the smallest owning module and give a targeted
Windows change list. Mac Codex must not edit, commit, or push source, even if
I ask for an implementation; hand the change list to the Windows development
session. Preserve unrelated worktree changes and never use git reset --hard,
git clean, or recursive deletion.
```

## 11. Repository Rules That Must Survive Handoff

- Keep browser automation ruyiPage-only.
- Do not read or expose secrets.
- Do not use bulk/recursive deletion or destructive Git commands.
- Preserve unrelated user changes.
- Keep fixed, sanitized diagnostics; do not insert raw helper stderr, AX/OCR,
  screenshots, OTP, or page text into reports.
- Prefer the smallest targeted repair over broad architecture changes.
- Windows changes source and pushes. Mac verifies manually and returns evidence.
