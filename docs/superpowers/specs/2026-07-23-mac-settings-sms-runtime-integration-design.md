# Mac Settings SMS Runtime Integration Design

## Goal

Make the existing System Settings SMS path usable from an explicitly interactive
macOS terminal session.  The operator supplies a trusted phone number and its
matching private HTTPS provider URL at runtime.  The flow selects the native
"send code to ...xx" destination by the final two digits, polls the provider
for one isolated six-digit code, submits it through the narrow AX helper, and
then waits for the existing signed-in confirmation.

## Activation and Boundaries

- The flow remains macOS-only, TTY-only, and requires explicit operator intent.
- `APPLE_AUTOMATION_SMS_ENABLED=1` enables runtime prompting when neither SMS
  value is present.  Supplying both SMS values also explicitly enables the
  flow.  A partial pair is treated as an incomplete terminal entry: it emits a
  fixed, non-secret prompt and asks for the complete pair again instead of
  aborting the account flow.
- The existing supervised-GUI orchestration continues to work unchanged; the
  local interactive path does not require a remote orchestration flag.
- Phone number, provider URL, provider response, and verification code stay
  process-local.  They must not appear in reports, child argv/environments,
  diagnostics, screenshots, or error text.  The code reaches the Swift helper
  only through short-lived stdin.
- Browser and browser 2FA logic are out of scope.  Native System Settings is
  the only surface modified by this change.

## Native State Model

1. Wait for a uniquely recognized phone-selection screen.
2. Match exactly one enabled selectable control whose displayed digits end in
   the requested two-digit suffix, select it, and press a unique enabled
   Continue control.
3. Wait for a uniquely recognized code-entry screen scoped to the same suffix.
   This direct route covers accounts with one trusted number: the visible
   delivery text must independently confirm the final two digits before polling
   begins.
4. Poll the private provider for up to two minutes.  Parse only an isolated
   six-digit candidate.  A candidate explicitly associated with a different
   suffix is rejected; an unassociated single candidate is accepted because
   provider responses are single-number pages.
5. Submit the code to the AX helper.  Apple advances automatically, so the
   coordinator must not invoke a second submit action.
6. Leave System Settings open and wait for the existing signed-in detector so
   the operator can finish any additional screen manually.

## AX Evidence Constraints

The supplied Peekaboo captures are used only to confirm role and control
structure.  Matching stays role, enabled-state, visible-surface, semantic-text,
and suffix based.  It must not depend on coordinates, row ordinal, hard-coded
full phone numbers, or raw localized title equality.

## Verification

Windows verifies the existing SMS unit suite, Node syntax, and diff hygiene.
The Mac may typecheck the Swift helper in a read-only orchestrated round.  Real
Apple login and SMS retrieval remain supervised manual validation on the Mac.
