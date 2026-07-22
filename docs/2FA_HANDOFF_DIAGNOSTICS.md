# 2FA Handoff Diagnostics

When the collector has a valid code, that only proves code acquisition. The
following fixed, non-secret checkpoints prove each successive browser handoff:

```text
twofa_code_delivery_started
twofa_code_delivery_sent
code_received
twofa_code_delivery_acknowledged
target_resolved
input_completed
submit_sent
transition_confirmed
```

The direct ruyiPage runner emits the acknowledgement only after Python has
read the JSONL command. This separates an stdin delivery failure from a
Firefox target/input/submit/transition failure.

The initial `need_2fa` audit event records only the bounded, non-secret page
state: `twofaVisible`, `inputReady`, `codeInputCount` (`0`, `1`, or `6`), and
`elapsedMs` (capped at `75000`). It intentionally excludes frame URLs, DOM
text, Apple ID, password, and OTP values.

## ruyiPage OTP Interaction Contract

The Apple six-cell widget is commonly hosted below `hsa2-sk7` in an Apple
iframe. ruyiPage exposes each iframe as its own BiDi browsing context, so the
implementation follows this fixed order:

1. Discover a stable one- or six-cell target through `get_frames()` and
   shadow-root enumeration. Keep the `(owner_scope, field)` pair together.
2. Use JS only to query non-secret state: trusted Apple origin, element
   visibility/focus, and input length. It must never synthesize input events.
3. For a one- or six-cell widget, click the first field through
   `owner_scope.actions`, clear once, and send one human-paced
   `owner_scope.actions.type(code)` sequence. Apple advances between six cells
   itself. The code must not be entered by six `field.input(..., clear=True)`
   calls because each clear can erase a prior cell after focus has advanced.
4. For the visible top-level six-cell `iframe#aid-auth-widget-iFrame` widget
   only, if the primary sequence cannot create a confirmed entry and all six
   cells can still be proven empty,
   use one `field.input(digit, clear=False)` call per already-discovered cell.
   Before the first clear, the flow snapshots six zero-length fields. The live
   `form-security-code-inputs input` set must still contain exactly the same
   six ordered ruyiPage elements in the same `tab_id` context. Wrapper
   recreation for the same DOM element is accepted; a replaced cell, frame,
   generic numeric control, or any initial or newly observed partial entry
   stops before clearing or sending another digit.
5. Revalidate the trusted Apple frame before clearing, before typing, and
   after typing. A changed or untrusted frame stops the flow before another
   key action.
6. Confirm the rendered widget only through per-cell value lengths. When the
   widget has disappeared, treat it as automatic submission only after a
   confirmed signed-in state or Apple trust-browser prompt; otherwise an
   unconfirmed write stops before submit.

The browser action is always ruyiPage BiDi. No Playwright, Puppeteer,
Selenium, JavaScript `dispatchEvent`, coordinate OCR click, or root-context
keyboard fallback is used for browser input.

## macOS System Settings AX Recovery

System Settings is only used to obtain a code when the Apple verification
popup is unavailable. On current macOS releases the AppleIDSettings
ExtensionKit accessibility subtree can become empty after a confirmed
`Two-Factor Authentication` press even though the visible `Get Verification
Code` control is still present. The Settings helper first retries normal AX
discovery. After a confirmed Two-Factor press, it measures the missing `Get
Verification Code` control itself rather than treating residual Login &
Security page chrome as recovery. It considers the visual recovery only after
that post-press AX gap has remained stable for two seconds.

The recovery is deliberately narrow:

1. Before the successful Two-Factor press, it binds either the direct trusted
   Settings window or, for a windowless AppleIDSettings extension, the unique
   trusted System Settings host window. That owner identity remains the trust
   anchor. If the press replaces the main window with a same-owner sheet, the
   helper refreshes only to that owner's current focused window. The refresh
   uses the already-confirmed owner chain rather than rereading the empty
   ExtensionKit AX window list; it never scans or selects an arbitrary
   on-screen window.
2. A prepared Vision helper may make one click only. It requires both
   Accessibility and Screen Recording, captures the bound window in memory,
   recognizes exactly one fixed `Get Verification Code` label in English,
   Simplified Chinese, or Traditional Chinese, and never writes a screenshot,
   OCR text, or code to disk.
3. It captures the bound window twice in memory. Both captures must contain
   exactly one label in the same normalized region; the bound frame must stay
   stable before, between, and after those captures. It then rechecks the
   active display, topmost ownership at the click point, and AX hit-test
   ownership immediately before posting the click. Any changed frame,
   in-window redraw, overlay, ambiguous label, cancellation marker, or missing
   permission stops without an action.
4. A successful child response is not treated as success by itself. The
   parent still waits for the normal masked verification-code alert; otherwise
   the Settings attempt remains a fixed failure and does not publish a code.

For a supervised Mac test, `2FA_SETTINGS_TWO_FACTOR_AX_UNAVAILABLE` means the
normal AX route remained unreadable and the visual route was unavailable or
could not prove its bound click. Check only the fixed prerequisites: the
install-prepared `mac-2fa-popup-ocr` helper, Accessibility, Screen Recording,
and that the System Settings window stayed foregrounded. `2FA_SETTINGS_ALERT_NOT_OPENED`
means a visual or AX request did not produce the required masked alert within
its bounded confirmation wait. The audit remains code-free in both cases.

On failure, inspect `flow-audit.jsonl` for the `account_browser` event
`runner_failed`. Its fixed details include:

- `failureStage` and `runnerStage`
- `twoFaPhase` and `twoFaGeneration`
- `codeDeliveryAttempted`, `codeDeliverySent`, and `codeDeliveryAcknowledged`
- `browserPreserved`
- `browserErrorClass`
- `cleanupFailed`

`browserErrorClass: twofa_input_unconfirmed` means the code reached the
ruyiPage handoff but the six-cell widget could not prove a complete entry.
Firefox is preserved for manual inspection in a direct run; the flow does not
send an Enter or a second code into that unresolved widget.

`target_resolved` followed by `sequence_focus_started`, with neither
`sequence_cleared` nor `sequence_typed`, identifies the exact focus-observation
failure seen with Apple's `hsa2-sk7` widget: the target was found in its owner
iframe, but the post-click `activeElement` query did not confirm focus before
the owner-frame keyboard sequence could start. It is not a selector failure.
For that narrow case the current flow records `sequence_focus_unconfirmed` and,
only after revalidating the visible Apple iframe and six empty cells, starts
the element-owned ruyiPage BiDi path with `cell_bidi_fallback_started`. A live
six-cell widget with all per-cell length checks emits
`cell_bidi_fallback_completed`. If Apple removes the widget after the sixth
cell, that branch has no completion event; it is accepted only after it
observes the signed-in account state or a trust-browser prompt and records
`sequence_auto_submitted`. Any partial entry, changed frame, changed cell, or
missing length confirmation remains
`twofa_input_unconfirmed` and leaves Firefox open for inspection.

`browserPreserved: true` is emitted only after ruyiPage confirms
`page.states.is_alive`. A requested-but-dead browser is cleaned up and is not
reported as preserved.

The record intentionally excludes Apple ID, password, OTP, page text, raw
AX/OCR output, and traceback content. Error classes are sufficient for a
repeatable repair decision without creating a credential-bearing diagnostic
file.

For direct `./run.sh` or `./run.sh --skip-mac` sessions,
`BROWSER_PRESERVE_ON_FAILURE=1` is the default. Firefox remains open after a
failure so the final Apple page can be checked manually. Set the variable to
`0` to restore close-on-failure behavior. Supervised broker sessions always
clean up their browser process.
