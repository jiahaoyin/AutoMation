# Resilient 2FA Code Acquisition Design

## Objective

Make browser 2FA code acquisition resilient when the macOS web-login verification popup appears early, late, or not at all.

The browser remains ruyiPage-only. Native macOS helpers may operate System Settings and FollowUpUI, but Node must not launch, inspect, or control Firefox.

## Current Failure Modes

The existing implementation already knows how to open:

`System Settings -> Apple Account -> Sign-In & Security -> Two-Factor Authentication -> Get Verification Code`

Its orchestration is unreliable for timing-sensitive cases:

1. The 2FA sidecar starts only after Python emits `need_2fa`.
2. A valid popup that appears between password submission and `need_2fa` can be classified as stale and closed.
3. The sidecar waits up to 120 seconds for the Allow flow before System Settings can be used.
4. System Settings is a sequential fallback, so popup monitoring pauses while the settings helper runs.
5. System Settings is gated on `allowClicked`, even though a manually generated code does not require the web-login Allow popup.

## Considered Approaches

### 1. Pre-arm and race both sources (selected)

Establish a stale-popup boundary before password submission, continuously watch FollowUpUI, and start System Settings after an 8-second popup grace period. The first verified fresh code wins.

This handles every reported timing order while keeping the normal popup path fast.

### 2. Shorten the existing sequential fallback

Change the settings delay from 120 seconds to 8 seconds but keep the current phases sequential.

This is simpler, but a popup arriving while System Settings is active would not be observed promptly and the two native flows could leave overlapping dialogs.

### 3. Always use System Settings first

Open System Settings immediately whenever the page requests 2FA.

This is deterministic but unnecessarily steals focus and performs several native UI actions when the normal popup would have supplied a code within seconds.

## Protocol Boundary

Python emits `prepare_2fa` after entering the password and verifying Remember Account, but before submitting the password.

The runner handles it as a handshake:

1. Node calls `collector.prepare()`.
2. The collector closes and records only popups that existed before the web login was triggered.
3. The collector starts the popup watcher.
4. Node sends `{ "type": "2fa_prepared" }` to Python.
5. Python validates that command and only then submits the password.

This creates an explicit boundary: a code seen before preparation is stale; a code seen after acknowledgement belongs to the current login attempt.

If preparation fails, the password is not submitted and the flow reports a clear 2FA preparation error. It must not guess whether an already visible code is current.

If the account session is already trusted, Python emits neither `prepare_2fa` nor `need_2fa`.

## Collector Lifecycle

Replace the one-shot sidecar promise with a collector that exposes:

- `prepare()`: clear stale dialogs, record rejected codes, arm popup monitoring.
- `getCode()`: return an already buffered fresh popup code or run the two-source acquisition policy.
- `dispose()`: stop watchers and child helpers on success, failure, or a login that does not require 2FA.

`account-browser-flow.js` owns one collector per browser run and always disposes it in `finally`.

## Popup Source

The popup watcher starts during `prepare()` and remains active through the 2FA phase.

It must:

1. Detect and click a current Allow dialog using existing Swift/AppleScript strategies.
2. Accept a code dialog that appears at any time after the preparation boundary, even if `need_2fa` has not arrived yet.
3. Read a six-digit code twice with matching values before accepting it.
4. Reject every code recorded during preparation.
5. Buffer an accepted code until Python emits `need_2fa`.

The old rule that treats a code visible before an observed Allow click as stale is removed after successful preparation. Staleness is determined by the handshake boundary instead.

## System Settings Source

The settings source may start only after Python has emitted `need_2fa`.

The default grace period is 8 seconds from collector preparation. If `need_2fa` arrives after that deadline, System Settings starts immediately; otherwise it starts when the remaining grace period expires.

System Settings starts regardless of whether an Allow dialog was observed. The existing Swift helper continues to navigate by accessibility names in Chinese and English, click Get Verification Code, read a stable six-digit code, capture audit evidence, and close its code alert.

Configuration:

- `BROWSER_2FA_SETTINGS_AFTER_MS=8000`
- `BROWSER_2FA_SETTINGS_FALLBACK=1`
- `BROWSER_2FA_POLL_MS=800`

The obsolete `BROWSER_2FA_POPUP_WAIT_MS` phase is removed.

## Winner and Cancellation Rules

Popup and System Settings providers run concurrently after the grace period. The first fresh, stable six-digit code wins.

When the popup wins after System Settings has started:

1. Node signals cancellation through a per-run cancellation marker in the current report directory, supplied to the Swift helper.
2. The helper checks the marker before and after each navigation step and during its alert polling loop.
3. If a settings code alert already exists, the helper closes it before returning a cancelled result.
4. Node waits for bounded cleanup before returning the popup code to Python; if cleanup times out, it terminates the helper and records a warning.

When System Settings wins, the popup watcher switches to cleanup-only mode. It no longer produces a code or clicks a newly appearing Allow dialog, but it closes a code dialog that is already visible or appears before the browser flow finishes. The collector is disposed after the browser flow confirms success or failure.

Provider cancellation and expected loser errors must never become unhandled promise rejections or keep Node alive after the browser run ends. The cancellation marker is removed on every exit path.

## Validation and Audit

Every candidate code must normalize to exactly six digits. Popup OCR retains the formatted-raw requirement and two-read stability check. System Settings retains its two-read stability check.

Audit entries record:

- preparation result and rejected stale codes;
- Allow strategy, when used;
- settings-source start time;
- winning source;
- loser cancellation and cleanup result;
- source-specific failures and screenshots.

One provider failing does not fail the run while the other provider can still succeed. The overall 240-second acquisition deadline starts when Python emits `need_2fa`; the popup watcher may already have buffered a code before that point.

## Tests

Automated tests will cover:

1. `prepare_2fa` blocks password submission until `2fa_prepared` is received.
2. A popup code arriving before `need_2fa` is buffered and returned without starting System Settings.
3. System Settings does not start before 8 seconds.
4. System Settings starts after 8 seconds even when no Allow dialog appeared.
5. A late popup can beat an in-progress settings helper.
6. A settings code can beat popup polling.
7. Pre-arm stale codes are rejected.
8. The losing settings helper is cancelled and cleans up its alert.
9. Provider failure falls back to the other provider.
10. Collector disposal leaves no timer, watcher, or child process active.

macOS verification will additionally run the real settings helper and one complete `./run.sh --skip-mac` browser login.

## Success Criteria

- Normal popup codes are used without opening System Settings when received within the 8-second preference window.
- System Settings automatically obtains a code when the popup is late or absent.
- A popup appearing while System Settings is active is still accepted and can win.
- No current-attempt popup is dismissed as stale because it appeared before `need_2fa`.
- Only one code is sent to ruyiPage, and all browser interaction remains inside ruyiPage.
- Native helper processes and dialogs are cleaned up on every exit path.
