# Password Hydration Recovery

## Evidence

- `password_wait` began at `08:06:14.236Z`.
- `password_input` began only 1.403 seconds later at `08:06:15.639Z`; the
  configured 45-second maximum did not expire.
- The trusted owner-context input was sent, but readback was explicitly empty:
  `owner_bidi_typed -> owner_bidi_value_empty`.
- The subsequent keyboard retry reused the previously resolved element and
  failed focus confirmation.
- The final diagnostic incorrectly classified the generic focus error as
  `twofa_focus_unconfirmed` while the fixed failure stage was
  `password_input`.

## Root Cause

Apple can expose an apparently displayed and enabled password input before the
new form has finished painting and hydrating. Two rapid selector observations
can therefore accept a transient element. If Apple replaces that element while
ruyiPage is sending BiDi key actions, the value remains empty. Reusing the old
wrapper for the keyboard retry then targets a stale or retiring node.

## Implementation

1. Add a password-specific readiness probe. Require an exact password input
   that is connected, visible, enabled, editable, and geometrically non-empty.
2. Require that readiness evidence, including a per-node in-frame identity,
   remains stable for a bounded minimum window before input. Keep the existing
   45-second overall deadline.
3. When trusted input returns an empty or unreadable value, re-resolve a fresh
   password target from the root page before the bounded keyboard recovery.
   Return the refreshed scope and element so password submission cannot reuse
   the retired target.
4. Emit fixed, secret-free progress steps for target refresh.
5. Classify focus and readiness failures according to the fixed browser stage.
   A password focus failure must never be reported as a 2FA failure, and a
   target that never stabilizes must remain distinguishable from a generic
   backend exception.

## Verification

- A pre-paint password element does not pass the readiness window.
- A node replaced after the first trusted input is re-resolved and filled.
- The refreshed element is the one later used for password submission.
- A refresh/focus failure remains in `password_input` and receives a
  password-specific diagnostic class.
- Existing email, OTP, profile, Developer membership, audit, and protocol tests
  remain green.
