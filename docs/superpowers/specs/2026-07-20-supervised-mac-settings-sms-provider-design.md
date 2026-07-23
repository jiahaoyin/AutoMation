# Supervised Mac Settings SMS Provider Verification Design

## Goal

Complete the independent, supervised macOS System Settings SMS-verification module. Given one trusted phone number and its privately owned SMS provider URL, it selects the matching trusted number when necessary, polls the provider for a six-digit verification code, and submits the code through the narrow AX helper. It does not change browser 2FA collection or its serial fallback.

## Configuration and Boundary

The module is enabled only in a macOS supervised GUI session. It reads a complete `APPLE_AUTOMATION_SMS_PHONE` and `APPLE_AUTOMATION_SMS_API_URL` pair from the private local `.env` configuration. If neither is present, it interactively collects the number and full HTTPS URL from the supervised terminal and atomically saves the validated pair with mode `0600`; a partial configuration requests the full pair again before UI actions begin. The verification code remains process-local and must never be persisted, passed as child arguments, copied into child environments, logged, or included in reports/screenshots/errors. The phone and URL are captured immediately after `.env` loading and are likewise excluded from child arguments, child environments, diagnostics, reports, and screenshots.

The URL must be absolute HTTPS and include a non-empty query parameter or fragment token/value. The module performs a direct GET without redirects and with a bounded response size. It supports JSON, text, and HTML response bodies through a provider-neutral parser that extracts only isolated six-digit values. If a returned message associates a phone suffix with a code, it must match the supplied phone suffix; unassociated codes remain eligible because supported providers may return message text only.

## State Model

The existing AX helper remains the UI authority. `phone_selection` makes the coordinator select exactly one enabled number matching the final two supplied digits then press Continue. `code_entry` begins provider polling. A direct `code_entry` route represents a single trusted phone and skips selection. `waiting` is retried until the UI deadline. Duplicate suffix matches, missing/disabled Continue controls, and unsupported screen structures fail closed.

Provider polling has a dedicated 120-second deadline, with a three-second default interval and abortable requests. Valid codes are sent only on the AX helper's short-lived stdin. When provider polling exhausts its deadline or yields no valid code, a hidden terminal prompt receives an additional five-minute manual deadline. The resulting code follows the same stdin-only path.

## Error and Privacy Handling

Public state/errors are fixed SMS tokens. Network failures, malformed bodies, provider URL, full phone number, provider response, and OTP are never emitted. Provider response parsing is conservative: it never guesses across arbitrary longer numeric strings, and uses only standalone six-digit candidates. The caller receives status labels only; no secrets are returned.

## Integration

`runMacSettingsLoginPhase` invokes this module only after account/password submission and only when the supervised SMS configuration has been deliberately enabled. This Mac Settings-only path remains separate from the browser account flow and its 2FA sidecar. Non-supervised sessions retain existing manual behavior. The Apple ID full-flow report/audit receives only a fixed SMS completion/failure token.

## Verification

Node tests cover configuration source selection and invalid partial inputs; HTTPS/token validation; response extraction from JSON/text/HTML; suffix filtering; polling, timeout, abort, and manual fallback deadline; direct and number-selection AX state routes; and redaction contracts. Windows runs unit tests only. Real Apple login, external provider polling, and AX UI actions are allowed only in an explicit supervised Mac session.
