# ruyiPage 2FA State and Allow Confirmation Implementation Plan

> **Status: Deprecated.** This historical plan contains the earlier Settings
> timing/race wording. The active implementation contract is
> [`docs/2FA_SERIAL_FALLBACK_PLAN.md`](../../2FA_SERIAL_FALLBACK_PLAN.md), which
> requires popup-first collection with a serial Settings fallback.

> **Execution:** Use subagents directly in the current checkout. Do not create worktrees. Follow TDD: each production behavior requires a focused failing test observed before implementation.

**Goal:** Detect the visible Apple 2FA phase independently of its concrete OTP control, discover safe OTP targets through current ruyiPage page/frame/shadow scopes, and confirm macOS Allow results before treating a native action as successful.

**Design:** `D:\Work\Apple-AutoMation\docs\superpowers\specs\2026-07-11-ruyipage-2fa-state-and-allow-confirmation-design.md`

**Baseline:** commit `1144d9e` on branch `codex/ruyipage-risk-reduction`.

## Global Constraints

- Every Firefox operation remains in `scripts/ruyipage/apple_account_flow.py` and uses ruyiPage public APIs with BiDi-backed input.
- Native Node/Swift code may operate FollowUpUI and System Settings only; it must not inspect or control Firefox.
- Do not add Selenium, Playwright, Puppeteer, pyautogui, JavaScript synthetic input, blind keystrokes, or a legacy browser backend.
- Rebuild page, frame, shadow-root, and element scopes on each polling iteration; do not cache browser contexts.
- Never log credentials, verification codes, OCR raw text, page bodies, URL queries, cookies, or tokens.
- Do not use bulk deletion. Do not revert unrelated edits from another agent.
- Real macOS UI validation occurs only after push; Windows tests use injected boundaries and source-contract checks.

## Task 1: ruyiPage web-state and OTP-target split

**Owner files:**

- `scripts/ruyipage/apple_account_flow.py`
- `scripts/ruyipage/test_apple_account_flow.py`

**Steps:**

1. Add RED tests proving `wait_for_2fa_or_session()` returns when a validated Apple scope reports `twofa=true` even if `security_code_fields()` is empty.
2. Add RED tests for a bounded `wait_for_otp_target()` that waits after code acquisition, never types without a concrete target, and recovers after a stale frame/context iteration.
3. Add ruyiPage test doubles for page, nested frame, and `shadow_roots(mode="all", include_frames=False)` scopes. Cover a role textbox/contenteditable OTP target inside a shadow root and rejection of equivalent targets in non-Apple scopes.
4. Implement fresh page/frame/shadow scope enumeration using only public ruyiPage APIs. Keep ordinary scopes available when optional shadow enumeration fails.
5. Implement trusted Apple 2FA scope detection and constrained OTP fallback selectors. Preserve one-target and six-target input semantics through `human_click`/`input_and_verify`.
6. Change the main flow to emit `need_2fa` after the phase is visible, obtain the code, then wait for a concrete target before typing.
7. Run focused Python tests and the complete `scripts.ruyipage.test_apple_account_flow` module.

## Task 2: Collector result confirmation and audit

**Owner files:**

- `scripts/lib/two-fa-sidecar.js`
- `scripts/test-two-fa-sidecar.mjs`

**Expected native adapter contract:**

- `probe2FAState()` returns `idle`, `has_allow_dialog`, or `has_code_dialog`.
- `tryAllowOnce()` may report an attempted strategy, but `clicked=true` is accepted only after native confirmation.
- The collector must not pass `confirmClick:false`.

**Steps:**

1. Add RED tests where the injected Allow strategy claims an attempt but the following probe still reports `has_allow_dialog`; assert no `popup_allow` success, no confirmed flag, and later strategy/polling continues.
2. Add a RED success test where the follow-up probe reports `has_code_dialog` or stable Allow disappearance.
3. Add RED tests for throttled sanitized probe/attempt audit events and for late `need_2fa` starting Settings immediately.
4. Remove confirmation bypasses, record attempted versus confirmed outcomes, and keep the popup watcher active while Settings races.
5. Ensure disposal clears all timers and expected loser/provider failures remain handled.
6. Run `node scripts/test-two-fa-sidecar.mjs`.

## Task 3: Native Allow targeting and mouse safety

**Owner files:**

- `scripts/lib/mac-2fa-allow.js`
- `scripts/swift/mac-2fa-click-allow.swift`
- `scripts/test-2fa-allow.mjs`

**Steps:**

1. Add RED JavaScript/source-contract tests proving the native wrapper does not expose a confirmation bypass to normal callers and only reports `clicked` after a follow-up probe confirms Allow disappeared or a code dialog appeared.
2. Add RED source-contract tests proving the Swift helper locates a matching Allow button/window before application activation, propagates click failure, creates mouse-up before posting mouse-down, and posts mouse-up on every post-down exit path.
3. Align click helper matching with the popup probe's actual positive Allow `AXButton` predicate; window prose is optional ranking evidence, not a hard gate.
4. Move application activation until after a matching target is found. Return `attempted_allow` from raw action helpers; let confirmed native state determine final `clicked` status.
5. Make CGEvent down/up construction and cleanup explicit and bounded. Do not ignore `clickScreenPoint()` results.
6. Run `node scripts/test-2fa-allow.mjs`. Record that `/usr/bin/xcrun swiftc -typecheck` remains a required Mac-side command after pull.

## Task 4: Integration verification and documentation consistency

**Owner:** controller after Tasks 1-3 are integrated.

1. Run the focused Python, sidecar, Allow, ruyiPage protocol, account-browser-flow, Settings lifecycle, environment, and bootstrap tests.
2. Run an appropriate repository-wide test scan from the scripts listed in `package.json`; do not run unrelated destructive packaging or upload commands.
3. Search for forbidden browser automation imports and obsolete `confirmClick:false` calls.
4. Review the final diff for secret-bearing logs and unrelated churn.
5. Run at least three independent read-only reviewers in parallel: ruyiPage/browser safety, native macOS lifecycle, and end-to-end protocol/testing. Fix all Critical/Important findings and re-run reviewers until all approve.
6. Commit and push `codex/ruyipage-risk-reduction` for the Mac test machine.

## Mac Test-Machine Checklist

After pull:

```bash
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-click-allow.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-read.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-ocr.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift
./run.sh --skip-mac
```

Expected evidence:

- terminal/audit records `twofaVisible=true` before code acquisition;
- the Settings provider starts immediately if the eight-second deadline already elapsed;
- an Allow attempt is not marked confirmed while the Allow dialog remains;
- the OTP target becomes ready and receives exactly one six-digit code through ruyiPage;
- the final account session is confirmed or a sanitized state-specific error is reported.

## Review Fix Wave

Four independent reviewers returned `FAIL`. The following findings are accepted and must be fixed in one coordinated TDD wave before re-review.

### Browser and protocol fixes

1. Preserve `probe_error` as a non-success state in the collector. Only an explicit `idle` probe may count toward stable Allow disappearance.
2. Remove the unconditional `len(textboxes) == 6` OTP path. Six custom textboxes must each have OTP/per-digit semantics or be rejected.
3. A single `inputmode=numeric` or `maxlength=1` input is not a strong 2FA marker. Strong evidence is explicit 2FA text, OTP semantics, or a six-cell digit pattern.
4. Treat element-state exceptions and `aria-disabled=true` as non-interactable so stale references are rediscovered instead of returned.
5. Aggregate OTP candidates across ordinary DOM plus every shadow root owned by one Apple browsing context, deduplicate them, then enforce the global `1 or 6` rule.
6. Detect strong 2FA text/OTP evidence inside open or closed ruyiPage shadow roots without returning or logging their text.
7. Before coordinate-based frame input, use public ruyiPage scrolling for the field and every hosting iframe, recompute coordinates, then query the concrete element's focus state. Never send keys when focus is unconfirmed.
8. Verify native inputs with `value`; verify contenteditable/non-form role textboxes with a read-only ruyiPage element query of rendered text. `None` or query failure is not success.
9. Remove page-body snippets from state and errors. Errors and protocol diagnostics may contain only fixed reasons, sanitized Apple host/path, booleans, counts, and elapsed milliseconds.
10. Validate the command after `need_2fa` is exactly `{type: "2fa_code"}` before consuming it.
11. Make `need_2fa.state` include bounded elapsed time.
12. Bound runner event handlers by the Python child lifetime. If Python exits while `prepare2FA`/`get2FACode` is pending, reject promptly, do not write to closed stdin, and preserve the configured timeout error when timeout caused the exit.

### Native Allow fixes

1. Make `tryAllowOnce()` perform one raw strategy attempt and return `attempted`, not run its own confirmation loop. The collector is the sole confirmation owner; legacy `waitForAllowClick()` may explicitly confirm within its remaining deadline.
2. Put mouse-button release in `finally` around every raw strategy attempt.
3. In Swift `--probe-coords` mode, never call `AXPress`, CGEvent, Return, or any other action. Missing coordinates return no attempt.
4. Restore `CoreAuthentication` and align candidate process rules with the probe helper.
5. Require a candidate process to be an expected Apple system executable. Dedicated authentication processes may use a positive Allow button; generic shared hosts additionally require Apple-login dialog evidence.
6. Support simplified Chinese, traditional Chinese, and English positive/negative Allow titles.
7. Remove raw AX button text from stderr/log forwarding.
8. Keep Swift CGEvent mouse-up construction before mouse-down posting and guaranteed cleanup after posting.
9. Preserve the original `npm run test:2fa-allow` manual behavior. Add a separate cross-platform unit-test command.

### Required regression tests

- Sidecar: attempted action plus repeated `probe_error` never confirms and is audited as probe failure.
- Python: one numeric field does not trigger 2FA; strong text and six cells do; shadow-only marker does.
- Python: six unrelated role textboxes, two one-time-code fields split across shadow roots, stale element state, unfocused frame target, and secret-bearing page text are rejected safely.
- Native JS/Swift source contract: coordinate probe is read-only, traditional titles are covered, candidate app validation is system-bound, raw AX text is not logged, and raw attempts are not internally confirmed.
- Runner: Python exits immediately after `need_2fa` while `get2FACode()` remains pending; runner rejects within a short bound and does not hang.

## Third Review Fix Wave

The second four-way review remains `FAIL`. The following findings are accepted for a final focused wave.

### Python browser boundary

1. Shadow-only 2FA text evidence must be built from visible rendered elements; hidden/template `textContent` must not trigger acquisition.
2. Screenshot, quit, navigation, BiDi, and top-level exceptions must never cross JSONL or stderr as raw `str(exc)`. Map them to fixed safe reasons.
3. Make the strong 2FA decision a directly tested pure classifier: one numeric field is false; explicit text, one semantic OTP target, or exactly six digit cells is true.
4. Replace private ruyiPage `_shared_id`/`_owner` access with the public `FirefoxElement` equality/hash contract for deduplication.

### Native Allow and sensitive output

1. Default automatic Allow strategies must contain only the atomic constrained Swift action. Remove AppleScript Return/AX actions and cross-process cliclick coordinate actions from the default path.
2. Use executable path component/bundle identity rather than localized display name to classify expected Apple system processes.
3. Shared hosts must require independent Apple-login evidence that tolerates location/device text between Chinese markers.
4. AppleScript and Swift popup probes must recognize simplified Chinese, traditional Chinese, and English positive/negative Allow titles.
5. Legacy confirmation must race each in-flight probe against the remaining deadline; a never-resolving probe cannot block the caller.
6. Manual fallback remains reachable after repeated attempted-but-unconfirmed actions.
7. Remove verification codes, OCR raw text, full OCR text, and raw helper stderr forwarding from `mac-2fa-popup.js`, `mac-2fa-ocr.js`, and `mac-2fa-popup-ocr.swift`.

### Runner and collector lifetime

1. Bound every `onEvent` callback independently. Non-result callbacks additionally race child exit; result callbacks may finish after child exit but cannot wait forever.
2. `dispose()` must await/cancel an in-progress `preparePromise`; preparation checks `disposed` after each native await and never starts a watcher after disposal.

All fixes require focused RED evidence, GREEN focused tests, related full suites, syntax checks, and a third four-way review with no Critical or Important findings.

## Final Security Closure Wave

Controller review after the third fix wave found additional paths that still
violated the global constraints. These are required before the final review and
push:

1. Remove every executable legacy automatic Allow path outside
   `scripts/swift/mac-2fa-click-allow.swift`: AppleScript Return/AX actions,
   `pre_allow`, Swift popup-reader `all`/Allow actions, and cliclick coordinate
   actions or install guidance. Manual fallback may only wait for a user action
   and confirm it through bounded probes.
2. Sanitize `personalInfo.href` before protocol output so Apple URL query and
   fragment data can never enter JSONL or `report.json`.
3. Treat the Node runner as an independent trust boundary. Invalid JSONL,
   backend stderr, and arbitrary failed-result messages must map to fixed safe
   reasons rather than being copied into errors.
4. Do not forward arbitrary ruyiPage warning text, collector cleanup errors, or
   phase exceptions into terminal output or `report.json`; use fixed phase
   status messages while preserving the original exception only for control
   flow.
5. Remove Settings fallback leakage: the Swift helper must not log or return an
   accessibility blob, raw code text, or the verification code in diagnostics;
   the Node wrapper must consume but never forward raw helper output and must
   expose only the validated six-digit code. Verification-code popup screenshots
   are sensitive and must not be persisted.
6. Add RED/GREEN regressions for every boundary above, rerun the related Python,
   protocol, account-browser-flow, Settings, sidecar, Allow, release-copy, and
   source-contract suites, then run a fourth four-way review with no Critical or
   Important findings.

## Review-v3 Fix Wave

The four-way review found no Critical issues and twelve Important issues. The
accepted fixes are now part of the release gate:

1. Revalidate every ruyiPage input target and its focus immediately before
   keyboard actions; aggregate OTP candidates globally across all trusted Apple
   contexts; scroll iframe remember controls and their hosts; bind trust/submit
   buttons to the nearest prompt-bearing form or dialog.
2. Make Vision OCR accept only the helper's exact six-digit `code`, use only a
   verified window-ID capture, register temporary-file cleanup before every
   failure path, and remove the raw-text contract.
3. Remove AppleScript popup probing/reading/clicking from production. All native
   popup work uses constrained Swift helpers whose executable paths are limited
   to explicit read-only Apple system roots; `/System/Volumes/Data` is rejected.
4. Wait for child `close`/stdout drain before final protocol evaluation while
   retaining fast `exit` races for pending handlers. Accept only
   `event=result` with `success === true`.
5. Sanitize audit labels through per-key enumerations rather than shape-only
   regexes. Remove Settings and OCR screenshot parameters and persistence.
6. Fully hide Apple ID local parts of length one or two; longer local parts may
   expose at most their first two characters.

All related RED reproductions, focused GREEN tests, complete Python/Node suites,
syntax checks, static forbidden-path scans, and a fresh four-way review are
required before commit and push.

## Review-v4 Fix Wave

The next four-way review found no Critical issues and eight Important issues.
The accepted fixes are:

1. Remove standalone `security` from OTP semantics; only explicit constructs
   such as `security code` remain valid, and security-question fields are tested
   as negative targets.
2. Delete the unused `apple-2fa-wait.scpt` and
   `apple-2fa-phase.applescript` helpers one file at a time, and remove every
   release, chmod, and source-contract reference.
3. Treat `swiftc` as an installation prerequisite. Request only Apple's
   official Xcode Command Line Tools installer, wait within a fixed bound, fail
   clearly if it remains unavailable, and verify all required helper artifacts
   before reporting installation success.
4. Decode Python stdout with a streaming UTF-8 `StringDecoder` so multibyte
   characters split across chunks remain intact.
5. Carry confirmed Allow history into manual fallback and use a constrained
   Swift `--release-left-button` action as the production `finally` cleanup.
6. Capture native OCR pixels directly in memory by verified window ID; do not
   spawn `screencapture`, create temporary PNGs, or use rectangular screen
   fallback.
7. Close a visible Settings verification-code alert on normal timeout. Force
   stop first signals cancellation, gives the helper a bounded cleanup window,
   and only then sends `SIGKILL`.

These changes require the same focused RED/GREEN evidence, complete related
suites, syntax/static checks, and another fresh four-way review.

## Review-v6 Fix Wave

The fresh v6 four-way review found no Critical issues and seven Important
issues. The accepted fixes and the controller's related fail-closed hardening
are:

1. Limit every ordinary and shadow-root OTP candidate to editable text input
   types. Radio, checkbox, button, submit, file, hidden, and other non-text
   controls cannot establish 2FA state, satisfy prompt semantics, or receive
   verification-code input.
2. Search fresh page, frame, open-shadow, and closed-shadow roots for Trust and
   Verify controls on every pass. Preserve Apple-origin ownership checks and
   use only ruyiPage BiDi trusted clicks.
3. Revalidate interactability and focus immediately before every clear, type,
   fallback input, and Enter action. Authentication failures do not persist a
   full-page failure screenshot that could contain an Apple ID or OTP.
4. Keep the runner's forced process-group kill armed until the entire POSIX
   group is confirmed gone. After collector disposal, recheck the disposed
   state after every native await and before any Allow, code-read, or dialog
   cleanup action.
5. Detect Swift through `/usr/bin/xcrun --find swiftc` plus a real `--version`
   invocation. Runtime helper compilation uses `/usr/bin/xcrun swiftc`, writes
   a unique temporary executable, and atomically replaces the installed helper
   only after successful validation.
6. Fail closed when any required Swift source is missing, compilation fails,
   or a compiler product is not executable. Never fall back to an older Allow,
   popup, OCR, or Settings binary after a source/runtime mismatch.
7. Give Settings force-stop four seconds so its three-second late-dialog cleanup
   can finish before SIGKILL. Remove the obsolete screenshot audit path helper
   and its stale persistence contract.

Every item has focused RED/GREEN regression coverage. A fresh v7 package,
complete related suites, syntax/static checks, and a new four-way review with
no Critical or Important findings are required before commit and push.

## Review-v7 Fix Wave

The v7 four-way review found no Critical issues and four Important integration
gaps. The required fixes are:

1. Attempt the fully constrained Trust action on every signed-in wait pass, so
   a Trust prompt that exists only in an open or closed shadow root is not gated
   by ordinary DOM state. An explicit prompt with no legal positive button still
   fails closed.
2. Cover the full zh-Hant macOS 15 acquisition path. Popup AX reading, Vision
   OCR targeting, and Settings navigation recognize traditional-Chinese code
   prompts, Sign-In & Security, Two-Factor Authentication, and Get Verification
   Code labels.
3. Validate untouched Swift compiler products as regular executable files
   before replacement. Allow, popup, and Settings wrappers never `chmod` an
   invalid `0644` product into acceptance and preserve the previous binary on
   failure.
4. Keep forced process-group escalation inside the runner's settlement boundary,
   and set the entry-point exit code without terminating pending cleanup. Install
   a stdin error listener before writes and map stream and callback failures into
   one fixed, idempotent backend error with no uncaught exception or raw detail.

Focused regressions must include the complete shadow-only Trust wait loop,
zh-Hant popup/Settings state predicates, non-executable compiler products, a
real force-grace timer, and an in-flight stdin EOF. A fresh v8 package and a new
four-way review with no Critical or Important findings remain mandatory.

## Task F: Reliability Documentation and Release Acceptance Closure

**Owner files:**

- `README.md`
- `docs/PROJECT.md`
- this plan
- `docs/superpowers/specs/2026-07-11-ruyipage-2fa-state-and-allow-confirmation-design.md`

**Final runtime contract:**

1. Acquisition is AX popup first, then in-memory Vision on the same verified
   Apple window ID only when AX has no legal code. Full-window OCR accepts only
   `NNN NNN`; contiguous center-crop codes require the same code from the same
   window ID on two independent consecutive capture passes. Empty, changed, or
   missing-window observations reset stability. OCR never clicks, searches the
   whole screen, invokes `screencapture`, or creates PNG files.
2. Preparation clears stale dialogs, records `preparedAt`, and arms the popup
   watcher for early caching. The first `getCode` call starts active acquisition
   and one shared 240-second deadline, which generation 2 does not reset. System
   Settings may start only while acquisition is active and becomes eligible at
   `preparedAt + 8s`; it runs at most twice, each attempt bounded to 60 seconds,
   with five seconds before the retry. At first acquisition +90s, hidden manual
   terminal entry becomes eligible for a real TTY. It is enabled by default and
   only `BROWSER_2FA_MANUAL_FALLBACK=0` disables it; `=1` is the documented
   explicit-enable example.
3. Automatic Allow runs at most twice. Afterwards a fixed manual-Allow status is
   shown while popup monitoring, Settings, and terminal entry continue.
4. Exactly two code generations are allowed. Generation 2 is requested only
   after a trusted Apple page explicitly reports an incorrect, invalid, or
   expired OTP in English, zh-Hans, or zh-Hant. Generation 1 is globally
   rejected thereafter. Captcha, account lock, and unknown errors stop.
5. Screen Recording is optional. Missing permission does not fail installation;
   AX, Settings, and hidden terminal input remain available. Browser-only
   `--skip-mac` needs Accessibility but not Terminal automation of System Events
   or System Settings. Automation is required only for the Mac Settings login
   stage. Browser Accessibility preflight/prompt uses
   `mac-2fa-popup-read.swift` with `AXIsProcessTrusted()` and
   `AXIsProcessTrustedWithOptions(...)`; the obsolete
   `accessibility-check.applescript` and `2fa-automation-check.applescript`
   probes are removed.
6. Status output uses fixed stage names and bounded counters/times. It never
   includes OTP, raw AX/OCR/helper stderr, full Apple ID, page body, URL query,
   or sensitive screenshot paths. Authentication failures use fixed reports and
   sanitized audit; no full-page authentication screenshot is retained.

### Implementation status

- **Implemented and covered by fresh Windows behavior/source-contract tests:**
  OCR capability and AX-first fallback; full-window and center-crop policy;
  center candidate two-capture state keyed by window ID; no-click/no-file
  privacy paths; native Swift Accessibility preflight/prompt; fixed
  Accessibility-only Allow guidance; Allow attempt limit; Settings retry;
  default-on/explicit-`0` terminal fallback; first-acquisition deadline with
  runner helper/process-group cleanup; fixed outer-terminal `onStatus` stages;
  and audit allowlists.
- **Generation integration complete:** ruyiPage requests generation 2 only for
  explicit English, zh-Hans, or zh-Hant OTP rejection on a trusted Apple page;
  runner passes `{generation, rejectPrevious}` to account-browser-flow, which
  passes it unchanged to `collector.getCode`; generation-1 codes are globally
  rejected; captcha, lock, and unknown errors stop. Main-controller fresh
  evidence is Python 126/126 plus passing ruyipage flow, protocol, sidecar,
  account-browser-flow, Allow 61/61, permissions, and release suites; all four
  final focused reviewers returned PASS.
- **Pending macOS 15 acceptance:** all Swift helpers typecheck and compile;
  actual FollowUpUI/System Settings AX trees work in English, zh-Hans, and
  zh-Hant; Vision permission transitions, cancellation, late-alert cleanup,
  terminal restoration, and privacy are verified on a Mac. Windows results are
  not native UI evidence.

### Required test matrix

| Contract | Automated acceptance |
|----------|----------------------|
| Screen capability | `available`, `permission_missing`, `unavailable`; no permission request; missing permission suppresses repeated OCR spawn |
| AX-first | AX hit makes zero OCR read calls; illegal/absent AX code permits OCR |
| OCR stability | Full-window `NNN NNN` may publish once; center contiguous first capture cannot publish; second independent same-window/same-code capture can; changed/empty/missing resets; duplicate target in one pass does not increment |
| OCR privacy | No click APIs, full-screen search, temporary PNG, `screencapture`, raw output, or helper stderr forwarding |
| Allow | At most two automatic attempts; follow-up probe confirms; then fixed manual status while providers continue; production guidance mentions Accessibility only |
| Settings | Active `getCode` only, gated by `preparedAt + 8s`; two attempts maximum, 60s each, 5s retry, bounded cancel/force-stop/late-alert close |
| Manual | First acquisition +90s; default enabled and only explicit `0` disables; TTY gate, hidden six ASCII digits, abort/timeout and terminal restoration |
| Generation | Exactly `1 -> optional 2`; explicit localized OTP rejection only; old code globally rejected; captcha/lock/unknown stop |
| Deadline | Both generations and all providers retain one first-acquisition +240s deadline; runner cleanup settles helpers and process groups |
| Permission split | `--skip-mac` skips Automation checks but keeps Accessibility; Screen Recording is optional; full Mac Settings login requires Automation |
| Privacy | Fixed status/audit only; no OTP/raw/full Apple ID/auth body/query/auth full-page screenshot/OCR file |

### macOS 15 acceptance commands

Run on the Mac test machine; do not report these as verified from Windows:

```bash
./install.sh
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-ax-fill.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-click-allow.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-read.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-ocr.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift
npm run check
npm run test:python-bootstrap
npm run test:2fa-allow-unit
npm run test:2fa-sidecar
npm run test:2fa-settings
npm run test:2fa-settings-unit
npm run test:account-browser-flow
npm run test:ruyipage-protocol
npm run test:ruyipage-flow
./run.sh --skip-mac
```

Then run the real UI matrix with Screen Recording both denied and granted,
English/zh-Hans/zh-Hant, popup AX and Vision paths, Allow auto/manual handoff,
Settings retry/cancel/late cleanup, manual terminal input, generation rejection,
and shared timeout. Inspect terminal output, `report.json`, `2fa-audit.jsonl`,
and the report directory for the privacy invariants. Run full `./run.sh`
separately to accept the Mac Settings Automation permission boundary.

### Task F completion gate

1. The four owner documents describe the same timings, attempt limits,
   generation rules, permission split, privacy policy, implementation evidence,
   and remaining macOS acceptance status.
2. `docs/PROJECT.md` contains no obsolete named failure-screenshot guidance.
3. Local Markdown links resolve, forbidden sensitive-debug guidance is absent,
   and `git diff --check` exits zero.
4. Task F2 documentation reconciliation records the fresh code evidence but does
   not imply completion of macOS Swift/TCC/UI acceptance above.
