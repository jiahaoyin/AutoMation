# macOS System Settings iPhone Unlock Vision Fallback Design

## Scope

After the supervised System Settings SMS flow submits its verification code,
optionally handle the observed terms, Mac password, iPhone passcode, and Find
My Mac location sheets.
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
- The passcode is collected only from a hidden supervised terminal prompt and
  sent to the native helper through stdin. It is never stored in `.env`, argv,
  environment variables, diagnostics, reports, screenshots, or Apple ID
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

`APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1` enables the optional path
for supervised Mac Settings sessions. It polls briefly after SMS submission:

1. no unlock sheet: return to the normal signed-in wait;
2. terms, Mac password, verified four/six cell, or location sheet: perform the
   corresponding bound action and return to the poll;
3. successful native submission: return to the normal signed-in wait;
4. no stable target, unavailable visual capability, invalid input, or an
   unknown sheet: retain the page for manual completion.

The real success condition remains the existing signed-in check; the helper
does not infer Apple Account completion from a button state.
