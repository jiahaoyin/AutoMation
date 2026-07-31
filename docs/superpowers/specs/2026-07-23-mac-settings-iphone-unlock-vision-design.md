# macOS System Settings iPhone Unlock Vision Fallback Design

## Scope

After the supervised System Settings SMS flow submits its verification code,
optionally handle the observed terms, Mac password, iPhone passcode, and Find
My Mac location sheets. Phone selection is optional; a stable six-digit page
is mandatory before provider polling begins.
The supplied AX evidence exposes recovery controls and secondary Apple Account
evidence, but can omit both the sheet title and the four or six visual passcode
cells.

This module is isolated from browser automation, browser 2FA collection, SMS
provider polling, and the existing read-only 2FA OCR helper.

## Trust And Privacy Boundary

- The helper accepts only one on-screen, active, trusted System Settings or
  AppleIDSettings owner, bound by both PID and CGWindowID.
- AX must prove a unique Apple Account recovery surface and unique
  Cancel/Continue button pair in the same window. The iPhone-unlock title is
  not an AX hard requirement because macOS can omit it; Vision is the required
  in-memory title anchor instead. Vision accepts one direct title or one
  tightly adjacent two-line English/Chinese
  title combination, never arbitrary page text. No OCR text, screenshot,
  device name, or image is emitted or written.
- Vision detects an empty four- or six-cell rectangle group only between the
  title and the button row. Two independent captures must agree on the count,
  ordering, geometry, and window frame.
- The Mac password and iPhone passcode pages are always manual handoff points.
  They are never filled with a fixture, placeholder, or value from `.env`,
  argv, environment variables, diagnostics, reports, screenshots, or Apple ID
  password state.
- Because hidden terminal input moves foreground focus, the helper first
  re-resolves the same PID/window binding, raises only that trusted window,
  and waits for foreground ownership plus AX hit testing to become true again.
- Before the sole click into the leftmost cell, the helper revalidates the
  target window, foreground ownership, and AX hit test. It sends the complete
  value with Unicode keyboard events, never by fixed coordinate typing.
- Any ambiguous window, OCR result, rectangle set, frame change, or foreground
  change returns a fixed manual-required status and leaves the sheet untouched.
- The terms action clicks only the unique agreement checkbox, rescans until the
  agreement button is enabled, and then clicks it. The Mac password action uses
  the fixed supervised fixture `000000` through stdin. The iPhone action sends
  the same-length zero string for the verified four/six-cell group. The Find My
  Mac action accepts only the `action-button-2`/“Later” control and never the
  adjacent `action-button-1`/“Allow” control.

## Runtime Behavior

The optional path is enabled by default for supervised Mac Settings sessions:
an omitted value or `APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1` enables
it, while `=0` explicitly disables it. After the mandatory SMS code page
advances, it keeps an initial bounded observation window before the normal
signed-in probe may complete the run. It then polls one optional module at a time:

1. no unlock sheet: return to the normal signed-in wait;
2. terms or location sheet: perform the corresponding bound action and return
   to a probe-only transition wait;
3. Mac password or verified four/six cell sheet: retain the exact bound page
   for manual completion, then resume scanning after Enter;
4. every same stage/window action is limited to three tries; manual Enter does
   not reset that limit;
5. no stable target, unavailable visual capability, invalid input, or an
   unknown sheet: remain in the bounded dynamic observation window before
   requesting manual completion.

The real success condition remains the existing signed-in check; the helper
does not infer Apple Account completion from a button state.

## Audit Contract

The outer coordinator writes only fixed and redacted `source=mac_settings`
events to `flow-audit.jsonl`. Event data may include state/stage/phase,
attempts, timeout, boolean results, and bound PID/window numbers. It never
includes phone numbers, SMS codes, account credentials, raw AX/OCR text,
device labels, screenshots, or page content. `sms_provider_config_failed`,
`sms_module_failed`, and `mac_settings_login_wait_failed` are the terminal
module closure events; any `failureCode` is a fixed `mac_settings_*` token.
