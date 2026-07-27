# Browser Flow Observability Design

## Problem

The browser flow can confirm an authenticated Apple account home and then fail while
opening or reading the personal-information page. The old result contract raises that
post-login failure as an account-browser failure, which obscures the useful fact that
authentication succeeded and makes terminal evidence too sparse to identify the exact
post-login boundary.

## Goals

1. Emit a machine-readable, ordered checkpoint for every ruyiPage browser stage,
   including credential receipt, URL validation, ruyiPage import, browser construction,
   and browser readiness in both direct and broker modes.
2. Record trusted, non-sensitive observations at login, account-home, profile-page,
   profile-data, and browser-retention boundaries.
3. Report authentication success independently from post-login profile capture.
4. Keep the direct-run Firefox window and account tab available after a partial
   post-login result whenever the existing preservation policy permits it.
5. Preserve the current redaction boundary: no account identifier, password, OTP,
   personal data, raw URL query, page text, AX tree, OCR text, screenshot path, or
   stack trace enters `flow-audit.jsonl` or `report.json`.

## Event Contract

Python emits only fixed tokens and booleans through the existing JSONL protocol:

- `browser_stage`: `stage`, `previousStage`, and `transition=entered`.
- `browser_observation`: `checkpoint`, bounded `generation=0|1|2`, `pageKind`,
  `connectionAlive`, `inspectionAvailable`, `sessionConfirmed`,
  `accountHomeConfirmed`, `twofaVisible`, `inputReady`, `codeInputCount`,
  `authenticationError`, `rootManageUrl`, `rootAccountMarker`,
  `rootAuthenticationError`, `retiringChildError`, and `childAuthUiPresent`.
  `childAuthUiPresent` means a live editable password, email, trust, or OTP control;
  an old frame title with no editable control is not reported as live authentication UI.
- `profile_capture_started`, `profile_capture_completed`, or
  `profile_capture_failed`: fixed failure stage/class and browser-preservation state.
- `screenshot_capture` or `screenshot_failed`: fixed `account_home` or
  `account_information` checkpoint only. File names, paths, image contents, and
  backend exception text never enter the protocol.
- `browser_finalization_started`, `browser_finalization_completed`, or
  `browser_finalization_partial`: fixed `browserFinalizationCompleted`,
  `browserPreservationRequested`, `browserSessionPreserved`, and
  `finalizationClass=completed|browser_connection_lost|browser_quit_failed|backend_cleanup_failed|runner_post_login_failed|collector_dispose_failed`.
- `post_login_finalization_partial`: fixed backend cleanup, collector disposal, and
  browser-finalization booleans when authentication completed but local cleanup did not.
- `acceptance_marker_completed`, `acceptance_marker_partial`, or
  `acceptance_marker_skipped`: the final flow boundary records only whether an
  account-home marker was required and completed. Marker filesystem errors are
  deliberately not forwarded.

`account_home_confirmed` is the independent authentication boundary. In the direct,
non-supervised runner path, a post-home backend exit, cleanup failure, or timeout is
reported as a post-login partial even when process cleanup removed the browser. The
preservation fields only describe the observed browser outcome:
`browser_session_preserved` means the authenticated session is still available; a
failure-only `browser_preserved` event remains diagnostic evidence and can never
claim retained session state. Broker, outer-supervisor, process-state, interruption,
protocol, event-handler, and result-processing failures keep their top-level failure
contract.

When the runner performs process-group cleanup, it clears prior
`browserPreserved`, `browserSessionPreserved`, and `browserFinalizationCompleted`
values before creating the failure context. The audit therefore records a prior
preservation request separately from the real final browser disposition.

Node accepts these fields through explicit allowlists before writing the audit stream.
Terminal output mirrors stage transitions and fixed profile-capture outcomes without
printing backend exception text.

## Ordered Lifecycle

The audit stream is ordered by the same process boundaries as the terminal output:

1. flow launch, environment setup, credential resolution, and optional macOS phase;
2. account-browser runtime resolution and backend startup;
3. each `browser_stage` transition plus a redacted `browser_observation` at login,
   2FA wait, every post-OTP transition observation, account home, personal-information
   page, profile readiness, or profile capture failure;
4. account-home confirmation, screenshot checkpoint, profile capture, and browser
   finalization;
5. collector disposal, acceptance-marker state, and terminal flow completion or a
   fixed failure envelope.

Every lifecycle record carries only allowlisted tokens, booleans, bounded counts, or
fixed stage/class enums. A transient post-OTP ruyiPage inspection failure emits the same
`twofa_transition` checkpoint with `inspectionAvailable=false`; that explicitly means
state inspection was unavailable rather than that every authentication control was absent.
The report and audit intentionally omit all credentials, OTPs, profile values, raw page
text, URLs, screenshot paths, and exception messages.

## Result Contract

`browserLogin` remains the authentication result. `postLoginProfileCapture` is a
separate object:

- completed: `success=true`, `failureStage=unknown`, `failureClass=unknown`.
- partial: `success=false`, fixed failure stage/class, plus whether the browser was
  still connected and retained.

A partial profile result does not overwrite a confirmed authentication result. Profile
values are persisted only after a successful capture and remain excluded from reports
and audit logs.

`postLoginFinalization` separately records backend cleanup, collector disposal, and
the requested browser disposition. A lost ruyiPage connection or a failed `quit()`
after account-home confirmation is `partial`, not an authentication failure. When
preservation was requested, the result is fully completed only after the same session
was explicitly reported as preserved. If the backend supplies no finalization object,
the top-level state is `unknown`; it must not be synthesized as a failed finalization.

A direct-run backend exit, timeout, or cleanup error after a confirmed account home
returns `browserLogin.success=true`, with `profileCaptureState=partial` and
`postLoginFinalizationState=partial`. Its audit record includes the fixed runner stage,
failure code, 2FA delivery booleans, and final browser-preservation booleans. It never
contains the original thrown message. A cleanup failure overwrites any earlier
`completed` finalization class with `backend_cleanup_failed`. Every recognized
failure finalization class forces the corresponding finalization state to `partial`,
even if an upstream result accidentally supplied completed booleans.

The top-level account-browser and flow audit records use fixed state tokens:
`profileCaptureState=succeeded|partial|skipped|unknown` and
`postLoginFinalizationState=completed|partial|skipped|unknown`. A skipped browser
phase is explicitly `skipped`, never represented as a failed profile capture.

## Verification

Regression coverage proves that a profile failure after account-home confirmation:

1. keeps `browserLogin.success=true`;
2. returns a partial profile-capture result instead of throwing a login failure;
3. preserves the browser according to the direct-run policy;
4. logs exact fixed checkpoints and failure tokens; and
5. treats browser disconnect/close failures after account-home confirmation as
   finalization partials instead of failed login; and
6. does not leak sensitive fixtures.
