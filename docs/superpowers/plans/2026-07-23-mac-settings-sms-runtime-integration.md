# Mac Settings SMS Runtime Integration Plan

## Scope

Focused System Settings SMS integration only.  Do not alter browser automation,
browser 2FA, account persistence, or unrelated login selectors.

- [x] Inspect sanitized AX evidence and current native helper selectors.
- [x] Enable explicit local interactive SMS runtime activation while preserving
      supervised orchestration behavior and secret redaction.
- [x] Correct provider parsing so an isolated, unambiguously single provider
      code can be used when the response contains no suffix, while a mismatched
      explicit suffix remains rejected.
- [x] Treat a partial phone/provider pair as an interactive retry rather than
      a flow-ending error, and verify the suffix on the direct code-entry path.
- [x] Add focused regression cases for activation and parsing behavior.
- [x] Run the existing SMS suite, syntax checks, and diff hygiene.
- [x] Complete two independent read-only reviews, repair any findings, then
      commit and push the focused change.
