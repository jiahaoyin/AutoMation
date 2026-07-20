# Supervised Mac Settings SMS Verification Design

## Goal

Add a supervised macOS System Settings helper for the Apple Account sign-in
screen. It must recognize either the trusted-phone selection page or the SMS
verification-code page, select one explicitly supplied trusted-phone suffix,
and fill a six-digit code that an operator enters locally.

## Boundary

The helper does not request, open, scrape, parse, store, or relay SMS provider
URLs, API tokens, or message bodies. A six-digit code is accepted only from a
local hidden terminal prompt in an explicitly supervised session. The code,
phone number, and raw accessibility text must not be written to reports or
logs.

## State Model

The native helper exposes three redacted states:

- `phone_selection`: one or more trusted-phone controls and a Continue button
  are visible.
- `code_entry`: a recognized one-field or six-field verification-code input is
  visible in a delivery context that uniquely displays the supplied trusted
  phone suffix.
- `waiting`: neither supported state is currently visible.

The Node coordinator polls until its deadline. At `phone_selection`, it derives
the final two digits from an operator-supplied phone number, asks the helper to
select exactly one matching control, and then asks the helper to continue. At
`code_entry`, it opens a hidden local prompt and passes the exact six digits to
the native helper. Ambiguous suffixes, mismatched suffixes, unsupported input
shapes, and expired deadlines stop without pressing a control or logging
sensitive text.

## Supervision and Safety

The coordinator is a library for a future attested Mac-supervision mode. It is
intentionally not wired into `run.sh` or the current production attestation,
because those paths do not attest a System Settings SMS-verification session.
That future mode must provide the repository's supervised-session evidence
before calling the coordinator. The coordinator itself requires macOS, a TTY,
and a local manual-code provider. It never falls back to browser automation,
AppleScript, OCR, screen capture, or an external SMS endpoint. It returns only
fixed state and error tokens suitable for audit logging.

## Verification

Windows unit tests cover normalization, state transitions, suffix mismatch and
ambiguity rejection, deadline handling, manual-code validation, and the
absence of external-network behavior. macOS typechecking and actual UI testing
remain supervised-only and must use the repository's Mac verification process.
