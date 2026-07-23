# macOS System Settings Login AX Targeting Design

## Scope

Tighten only the first System Settings Apple Account login segment:

1. fill the Apple Account email/phone field;
2. press Continue;
3. wait for, fill, and submit the password field.

Browser automation, 2FA acquisition, SMS verification, session reuse, reporting,
and all later flow states are out of scope.

Native preflight and debug output are in scope only to keep this login segment
from emitting raw AX titles, descriptions, field values, command arguments, or
helper stderr.

## Evidence

The supplied Peekaboo AX captures show stable control identifiers on macOS 15:

| Login state | Control | AX identifier |
| --- | --- | --- |
| Email page | Apple Account email/phone input | `USERNAME_TEXT_FIELD` |
| Email and password pages | Primary Continue/submit button | `LOGIN_BUTTON` |
| Password page | Password input | `PASSWORD_TEXT_FIELD` |

The password page retains `USERNAME_TEXT_FIELD`; therefore field ordinal is not a
valid selector. The sidebar Search field and generic System Settings text fields
also make a first/second text-field strategy unsafe.

## Required Behavior

- Resolve the exact AX identifier from the live login window for every action.
- Re-resolve after Continue and wait for `PASSWORD_TEXT_FIELD` rather than using
  a fixed field index.
- Require an enabled, exact `LOGIN_BUTTON` before pressing it.
- Keep credential verification local to the target field and never add raw
  credential values to logs, diagnostics, or returned messages.
- Pass credentials to the native helper through its child environment, never
  command-line arguments; normalize helper failures before callers log them.
- Emit only fixed state tokens and structural counts from native preflight and
  debug diagnostics.
- Use identifier targeting in both the Swift main path and AppleScript fallback.
- Fail the current login segment when a required exact control never appears;
  do not redirect input to an unrelated text field.
