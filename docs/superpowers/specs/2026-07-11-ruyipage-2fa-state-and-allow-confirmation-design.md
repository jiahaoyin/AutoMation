# ruyiPage 2FA State and macOS Allow Confirmation Design

## Objective

Fix the macOS 15 login failure where the Apple page visibly reaches the six-digit two-factor authentication view, but the Python browser process times out before emitting `need_2fa`, while the native Allow dialog may lose focus or remain visible after a click attempt.

The browser remains ruyiPage-only. Every Firefox launch, page read, frame or shadow-root lookup, click, focus, keystroke, verification, screenshot, and navigation must use ruyiPage public APIs backed by WebDriver BiDi. Native helpers may operate macOS FollowUpUI and System Settings only; they must never inspect or control Firefox.

## Confirmed Root Causes

1. `wait_for_2fa_or_session()` treats a concrete OTP input match as the only proof that the 2FA phase was reached. It ignores the already computed, trusted Apple-scope `twofa` state, so the runner never receives `need_2fa` and the System Settings provider never starts.
2. OTP discovery searches only four ordinary `<input>` selectors in page and frame scopes. It does not explicitly search ruyiPage shadow-root scopes or constrained `role=textbox` and `contenteditable` targets.
3. The native watcher calls the Allow strategy with confirmation disabled and records success from an attempted action. The click helper activates applications before proving that their window contains the Allow button, which can remove focus from the real dialog. Failed attempts and idle probe state are mostly absent from the audit trail.
4. The CGEvent helper can post mouse-down before proving mouse-up can be created, and a caller ignores the click result.

## Selected Design

### Two independent web states

Split the browser phase into two states:

- `twofaVisible`: a strong 2FA marker was found inside a current HTTPS Apple authentication scope.
- `inputReady`: a concrete, displayed, enabled OTP target has been found inside that same trusted scope.

`wait_for_2fa_or_session()` returns as soon as the account is trusted or `twofaVisible` is true. The browser process then emits `need_2fa` immediately, starting active acquisition. The already armed popup collector continues, and the System Settings fallback may run once its `preparedAt + 8s` eligibility gate is reached.

After Node returns a verified six-digit code, Python calls a separate bounded `wait_for_otp_target()`. No input occurs until this function returns one concrete target or six concrete digit targets. Failure reports `twofaVisible=true` and `inputReady=false` without blind typing.

### Fresh ruyiPage scope discovery

Each polling iteration rebuilds the scope list. It never caches frame, shadow-root, element, or context objects across iterations.

The search order is deterministic:

1. root page;
2. recursively discovered current frames;
3. for each page or frame, its ruyiPage public shadow roots from `scope.shadow_roots(mode="all", include_frames=False)`;
4. nested public shadow roots when exposed by the same API.

Failure to enumerate one optional shadow scope does not hide ordinary page/frame scopes. A stale frame or context is discarded and the next bounded polling iteration discovers the current tree again.

Queries may inspect DOM state, but input must use the existing trusted ruyiPage interaction path (`human_click` followed by `actions.type` or the established `input_and_verify` wrapper). Do not use JavaScript `click()`, value assignment, `dispatchEvent`, Selenium, Playwright, Puppeteer, pyautogui, or coordinate-only blind typing.

### OTP target policy

Strong selectors retain priority:

- `input[autocomplete='one-time-code']`;
- `.security-code-input input`;
- six visible one-character numeric inputs;
- six visible one-character inputs.

Inside a scope already proven to be an Apple 2FA scope, fallback candidates may include:

- displayed and enabled `input` elements with OTP semantics in `aria-label`, `aria-describedby`, `name`, `id`, class, autocomplete, input mode, or maximum length;
- displayed and enabled `[role='textbox']` elements with OTP semantics or a six-cell group;
- displayed and enabled `[contenteditable='true']` elements with OTP semantics.

An unconstrained textbox or contenteditable on a non-Apple scope is never eligible. One target receives the complete six-digit code. Six targets receive one digit each. Other candidate counts are rejected. All six digits are normalized and validated before any focus or input action.

### Native Allow action confirmation

Probe and click helpers use the same Allow-button predicate: an actual `AXButton` whose normalized title is `Allow`, `允许`, or an equivalent positive Allow title that explicitly excludes `Don't Allow` and `不允许`. Whole-window prose may rank a candidate but cannot be a prerequisite when the button is present.

No candidate application is activated until a matching window and Allow button are found. A strategy result means only `attempted` until a follow-up probe proves either:

- the Allow dialog disappeared and a code dialog appeared; or
- the Allow dialog disappeared for consecutive bounded probes.

If the Allow dialog remains, the attempt is a failure and is audited. Automatic Allow is bounded to two attempts; after that the UI asks the user to click Allow manually while popup monitoring and other code providers continue. The collector must not record `popup_allow` or set `allowConfirmed` from an unverified action. The System Settings fallback remains independent, starts only during active `getCode` acquisition, and uses `preparedAt + 8s` as its eligibility gate.

For CGEvent mouse clicks, down and up events are created before down is posted. Once down is posted, cleanup always posts up. The helper propagates the click result; it cannot report an attempted action when event creation failed.

### Sanitized observability

Audit only state changes and bounded, throttled idle summaries. New events include:

- web phase: `twofaVisible`, `inputReady`, `codeInputCount`, sanitized host and path, elapsed time;
- native probe transition: `idle`, `has_allow_dialog`, or `has_code_dialog`;
- Allow attempt start/result: strategy, source process name, attempted/confirmed state, elapsed time, and sanitized failure reason;
- Settings source start/result and winning source.

Never log the Apple ID, password, verification code, OCR raw text, full page body, URL query, cookies, tokens, or accessibility text blobs.

## Failure Semantics

- A trusted account session bypasses both `need_2fa` and OTP input.
- A visible 2FA phase starts code acquisition even when `inputReady=false`.
- A returned code waits for a concrete target for a bounded interval; timeout fails safely with no keystrokes.
- One native provider failure does not stop the other provider while the overall acquisition deadline remains.
- Every watcher, timer, child helper, cancellation marker, and native dialog cleanup path remains bounded and disposable.

## Test Requirements

Python tests must cover:

1. `twofaVisible=true` with no known fields returns the 2FA phase immediately.
2. A later OTP target is awaited after code acquisition; no target means zero input actions.
3. OTP targets in nested current frames and open/closed shadow roots are found through ruyiPage public scopes.
4. A stale frame on one iteration is recovered by rediscovery on the next.
5. Non-Apple frames and unrelated textboxes/contenteditable elements are rejected.
6. One target and six-target typing use only the trusted ruyiPage action path.

Node/native tests must cover:

1. An Allow action followed by a still-visible Allow dialog is not success and rotates strategy.
2. A disappearing Allow dialog or appearing code dialog confirms success.
3. `confirmClick:false` is no longer used by the collector.
4. Idle and failed attempts produce throttled, sanitized audit entries.
5. A late `need_2fa` starts Settings without an additional delay when the existing `preparedAt + 8s` gate has already passed.
6. The Swift source confirms target windows before activation and guarantees mouse-up after mouse-down.

Windows verification uses injected ruyiPage/native doubles and source-contract checks. The Mac test machine performs `/usr/bin/xcrun swiftc -typecheck` and one real `./run.sh --skip-mac` after pulling the pushed branch.

## Success Criteria

- A visible Apple six-digit page emits `need_2fa` instead of timing out.
- The Settings fallback starts whenever popup acquisition is late or absent.
- No code is typed until a current, trusted ruyiPage OTP target is interactable.
- Shadow DOM and dynamic frame targets are rediscovered without cached contexts.
- An Allow click is successful only when native UI state confirms it.
- Focus is not stolen by unrelated application scanning, and no mouse button can remain pressed.
- Audit evidence explains the last web and native states without exposing secrets.

## Final Reliability and Release Contract

This section records the final behavior required by the latest 2FA reliability
and release-closure request. It supersedes older timing or fallback wording in
this document when the two conflict.

### Provider timeline

Native preparation clears stale dialogs, records `preparedAt`, and arms the
popup watcher so an early current-login code may be cached before the web flow
requests one. It does not start the active acquisition race or its deadline.
The first `getCode` acquisition starts one shared 240-second deadline; an
optional generation 2 retains that same deadline rather than resetting it:

1. The popup reader first uses Accessibility to read a verified Apple system
   popup.
2. Only when AX returns no legal code may Vision OCR capture the verified Apple
   window ID. Full-window OCR accepts only `NNN NNN`. A contiguous six-digit
   center-crop candidate carries `requiresStability=true` and may be emitted only
   after the same window ID yields the same candidate on two consecutive,
   independent capture passes. A duplicate target in one pass is ignored; an
   empty capture, changed code, or missing window resets that window's state.
3. System Settings may start only after `getCode` acquisition is active. Its
   eligibility gate is `preparedAt + 8s`: if the gate has already passed it
   starts immediately, otherwise it waits for the remaining interval. It may
   run at most twice, each attempt has a 60-second bound, and the retry waits
   five seconds. Popup monitoring remains active.
4. At first acquisition plus 90 seconds, hidden terminal entry joins only when
   both input and output are TTYs and the fallback has not been explicitly
   disabled. It is enabled by default; only
   `BROWSER_2FA_MANUAL_FALLBACK=0` disables it. `=1` remains the documented
   explicit-enable example.
5. The first legal provider wins. Losers are cancelled and complete bounded
   cleanup. No provider may run beyond the shared 240-second deadline.

Vision preflight uses only `CGPreflightScreenCaptureAccess`; it never requests
permission or captures pixels. Its public capability is one of `available`,
`permission_missing`, or `unavailable`. Screen Recording is optional and its
absence must not fail installation. AX, Settings, and hidden terminal entry
remain available. To enable Vision for a later run, the operator grants the
current terminal under System Settings > Privacy & Security > Screen & System
Audio Recording and restarts the terminal before running again.

OCR is read-only. It performs no OCR coordinate click, whole-screen search,
temporary PNG creation, or `screencapture` invocation. Pixels remain in memory
and are restricted to the AX-verified Apple window ID.

### Allow and code generations

The constrained Swift Allow action may run at most twice. Each raw result is
only `attempted`; a later native probe must confirm the code dialog appeared or
the Allow dialog disappeared stably. After two unconfirmed attempts, emit a
fixed manual-Allow stage prompt and continue popup, Settings, and terminal
providers.

The browser protocol permits exactly generations 1 and 2, in order. Generation
2 is legal only after a current trusted Apple page explicitly classifies the
previous OTP as incorrect, invalid, or expired in English, simplified Chinese,
or traditional Chinese. The first code is then permanently rejected by popup,
Settings, and manual providers. Captcha, account lock, or an unknown login error
stops the flow; it must never be converted into a code refresh.

### Permission boundaries

- Browser-only `./run.sh --skip-mac` requires Accessibility, but does not require
  the terminal to automate System Events or System Settings.
- Browser Accessibility preflight/prompt uses `mac-2fa-popup-read.swift` with
  `AXIsProcessTrusted()` and `AXIsProcessTrustedWithOptions(...)`. The obsolete
  `accessibility-check.applescript` and `2fa-automation-check.applescript`
  probes have been removed.
- Automation permission to control System Settings is required only by the
  macOS System Settings account-login phase.
- Screen Recording is an optional Vision capability, not an install gate.

### User-facing status and privacy

User-facing stages may identify only fixed states such as preparing 2FA,
waiting for popup, starting or retrying Settings, waiting for manual Allow,
opening hidden terminal entry, selecting a provider, and timing out. They must
not include OTP values, original AX or OCR text, helper stderr, full Apple IDs,
page bodies, or URL queries.

Authentication failures produce fixed failure reports and sanitized audit
events. They do not persist a full-page authentication screenshot. Verification
popup pixels and OCR intermediates are never written to disk.

## Implementation Status

Status at the current shared-tree review point:

- Implemented with fresh Windows behavior/source-contract evidence: constrained
  AX popup and Allow paths; AX-first OCR fallback; fixed screen-capture
  capability; full-window formatted-code policy; center-crop
  two-independent-capture gate by window ID; two Allow attempts; Settings
  `2 x 60s` with `5s` backoff; default-on/explicit-`0` manual fallback; one
  deadline from first acquisition with runner process-group cleanup; sanitized
  audit contracts; and fixed sidecar `onStatus` stages wired to the outer
  terminal UI.
- Generation integration is complete: ruyiPage emits generation 2 only for an
  explicit English, zh-Hans, or zh-Hant OTP rejection in a trusted Apple page;
  runner passes `{generation, rejectPrevious}` through
  `account-browser-flow.js` unchanged to `collector.getCode`; generation 1 is
  rejected globally; and captcha, lock, or unknown errors stop. Fresh results
  are Python 126/126 plus passing ruyipage flow, protocol, sidecar,
  account-browser-flow, Allow 61/61, permissions, and release suites; all four
  final focused reviewers returned PASS.
- **Pending macOS 15 acceptance**: Swift typecheck/compile, real AX hierarchy,
  Vision permission behavior, English/zh-Hans/zh-Hant UI, Allow confirmation,
  Settings cancellation and late-alert cleanup, TTY restoration, and privacy
  inspection. Windows evidence does not establish native macOS behavior.

## Final Acceptance Matrix

| Area | Required evidence |
|------|-------------------|
| Popup AX | Trusted Apple process/window only; exact six digits; no Firefox or ordinary-app enumeration |
| Vision | permission available/missing; AX-first; verified window ID; full `NNN NNN`; center candidate needs two independent matching captures; empty/change resets |
| Allow | English/zh-Hans/zh-Hant positive and negative titles; at most two automatic attempts; attempted is not confirmed; mouse-up guaranteed |
| Settings | Starts only during active `getCode`, gated by `preparedAt + 8s`; at most two 60s attempts; 5s backoff; cancellation, timeout, force-stop, and late alert close |
| Manual | Starts at first acquisition +90s only for TTY; default enabled and only explicit `0` disables it; input hidden; cancel/timeout restores terminal |
| Generations | Exactly 1 then optional 2; localized explicit OTP rejection only; generation-1 code rejected globally; captcha/lock/unknown stop |
| Deadline | All providers and both generations share first-acquisition +240s; generation 2 does not reset it; runner cleans helper processes and process groups |
| Privacy | No OTP/raw AX/raw OCR/helper stderr/full Apple ID/auth full-page screenshot/OCR image on terminal, report, audit, or disk |
| Platform | Windows logic/source-contract plus macOS 15 Swift compilation and real UI in all three locales |
