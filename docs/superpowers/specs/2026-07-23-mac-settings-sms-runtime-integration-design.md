# Mac Settings SMS Runtime Integration Design

## Goal

Make the existing System Settings SMS path usable from an explicitly interactive
macOS terminal session.  The trusted phone number and matching private HTTPS
provider URL are persisted in the local `.env` configuration, then captured
into a short-lived runtime snapshot.  The flow selects the native
"send code to ...xx" destination by the final two digits, polls the provider
for one isolated six-digit code, submits it through the narrow AX helper, and
then waits for the existing signed-in confirmation.

## Activation and Boundaries

- The flow remains macOS-only and TTY-only. It is enabled by default: an
  omitted value or `APPLE_AUTOMATION_SMS_ENABLED=1` enables it, while `=0`
  explicitly disables it. A valid saved phone/URL pair is reused without
  prompting. An absent, partial, or invalid pair is
  treated as an incomplete terminal entry: it emits a fixed, non-secret prompt
  and asks for the complete pair again instead of aborting the account flow.
- `APPLE_AUTOMATION_SMS_RECONFIGURE=1` enables replacement input; `=0` keeps
  the saved pair. It does not override `APPLE_AUTOMATION_SMS_ENABLED=0`.
  The complete validated pair is atomically written to `.env` with mode `0600`,
  and the saved reconfigure flag is reset to `0` only after the write succeeds.
- The existing supervised-GUI orchestration continues to work unchanged; the
  local interactive path does not require a remote orchestration flag.
- The phone number and provider URL are private local `.env` configuration;
  provider responses and verification codes stay process-local.  None of them
  may appear in reports, child argv/environments, diagnostics, screenshots, or
  error text.  The code reaches the Swift helper only through short-lived stdin.
- Browser and browser 2FA logic are out of scope.  Native System Settings is
  the only surface modified by this change.

## Native State Model

1. Wait for a uniquely recognized phone-selection screen.
2. Match exactly one enabled selectable control whose displayed digits end in
   the requested two-digit suffix, select it, and press a unique enabled
   Continue control.
3. Wait for a uniquely recognized code-entry screen scoped to the same suffix.
   The mandatory six-cell state must be observed twice before provider polling
   begins. This direct route covers accounts with one trusted number: the visible
   delivery text must independently confirm the final two digits before polling
   begins.
4. Poll the private provider within the bounded SMS deadline. Parse only an isolated
   six-digit candidate.  A candidate explicitly associated with a different
   suffix is rejected; an unassociated single candidate is accepted because
   provider responses are single-number pages.
5. Submit the code to the AX helper.  Apple advances automatically, so the
   coordinator must not invoke a second submit action. It first waits for the
   populated group to disappear and observes the empty transition twice.
6. Keep an initial post-SMS observation window for up to 90 seconds before a
   signed-in result may finish the run. This allows network-loaded Terms,
   Location, or manual pages to appear after the code sheet disappears.
7. Leave System Settings open and wait for the existing signed-in detector so
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
