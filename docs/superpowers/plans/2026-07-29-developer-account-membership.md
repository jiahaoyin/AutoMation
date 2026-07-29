# Apple Developer Account Membership Module

> **Historical implementation plan (superseded by sequence):** this document records the original Account-then-Developer design. The current runtime is Developer-first; use [the runtime runbook](../../RUNTIME_RUNBOOK.md) and [the Developer-first plan](2026-07-29-developer-first-account-sequencing.md).

## Objective

After the existing `account.apple.com` profile workflow succeeds, use the same
ruyiPage Firefox session to open a new tab at
`https://developer.apple.com/account`, complete Apple authentication when
required, and determine Apple Developer Program membership.

## Contracts

1. Keep the existing account profile, screenshot, 2FA, and browser-preservation
   behavior unchanged.
2. All Developer browser actions use ruyiPage. Open a distinct tab and keep it
   open with the existing successful Firefox session.
3. Reuse the existing Apple ID/password input and 2FA broker primitives. Do not
   start a second browser or a second 2FA collector.
4. Bind authentication controls to the trusted `idmsa.apple.com` frame and use
   the supplied stable controls where available:
   `#account_name_text_field`, `#password_text_field`, `#remember-me-label`,
   `#sign-in`, the six `.form-security-code-input` cells, and the trust button.
5. Membership is three-state internally:
   - `not_enrolled`: authenticated Developer account page plus an explicit
     "Join Apple Developer Program" marker.
   - `active`: authenticated Developer account page plus a unique
     "Membership details" navigation item. Click that item and require the
     rendered membership-details section to identify `Apple Developer Program`
     before accepting the state.
   - `unknown`: authenticated page without either positive marker.
   Never infer `active` only because the join banner is absent.
6. Keep the fixed protocol classification as
   `active|not_enrolled|unknown`, then persist the corresponding public value
   as `developer_membership=已加入|未加入|未确认` in the private `.env`.
   Print the same concise Chinese result in the interactive terminal.
7. For `active`, save one private screenshot after the membership-details
   section is visible as `screenshots/03-developer-membership.png`. Capture the
   current viewport after the navigation click so the image centers the details
   section instead of duplicating a full-page account screenshot. Screenshot
   metadata may be reported, but the Team ID, phone, address, renewal date,
   billing data, and raw page text must not be copied into logs or reports.
8. Reports and audit logs may contain only the fixed classification and
   boolean/stage metadata. They must not contain credentials, OTP, cookies, or
   raw page text.
9. Developer module failure is post-login partial completion: preserve both
   tabs and the already successful account/profile result, with a fixed failure
   stage/class in diagnostics.

## Verification

- Python unit tests cover new-tab creation, already-authenticated Developer
  state, email/password/remember/sign-in controls, 2FA and trust reuse, explicit
  membership markers, and fail-closed unknown classification.
- Node tests cover result-schema validation, `.env` persistence, concise
  terminal output, and audit redaction.
- Run the existing ruyiPage, protocol, account-browser-flow, and flow-audit
  regressions. No real Apple login is run from Windows.
