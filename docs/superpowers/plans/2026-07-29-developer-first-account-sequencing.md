# Developer-First Account Sequencing

## Objective

Run the Apple Developer module before the Account profile module in one
ruyiPage Firefox session:

1. Use the initial tab for `https://developer.apple.com/account`.
2. Complete the existing Apple authentication and membership check there.
3. Persist the fixed membership result and capture the existing active-member
   screenshot before opening the Account module.
4. Open a distinct Account tab and retain the existing account login, personal
   information screenshot, collection, and browser-preservation behavior.

## Membership Gate

- `DEVELOPER_MEMBERSHIP_GATE=0` is the default test mode. After a confirmed
  Developer authentication it runs both modules regardless of `active`,
  `not_enrolled`, or `unknown` membership. A visible Developer sign-in form or
  failed credential/2FA handoff is not a membership result and must stop before
  Account tab creation.
- `DEVELOPER_MEMBERSHIP_GATE=1` is the business mode. It opens Account only
  when the authenticated Developer result is `active`; authenticated
  `not_enrolled` or `unknown` results produce a successful, explicitly gated
  terminal result without entering Account. Developer authentication failures
  remain browser failures, not gate stops.
- The gate decision is fixed metadata only. Logs and reports retain the
  membership class, gate state, page-state booleans, and screenshot filenames;
  they never contain credentials, OTPs, cookies, or page text.

## Implementation Boundaries

- Reuse the current ruyiPage authentication and shared 2FA generation context.
- Keep Developer in the initial tab, then create a new Account tab. Do not
  launch another browser or a second 2FA collector.
- Persist Developer membership before profile persistence in Node only after
  `developer_membership_checked`, or an authenticated post-login membership
  partial, so a gated result still writes `developer_membership` to the private
  `.env` without treating a failed login as `unknown` membership.
- Persist immediately when the sanitized `developer_membership_checked` event
  arrives, rather than waiting for the final backend result. This preserves the
  checked membership when Account tab creation or later Account authentication
  fails; a normal final result reuses the same single persistence attempt.
- Preserve both tabs when the configured success/failure policy requires it.
- Keep the existing Account acceptance marker when Account runs. A gated stop
  has no account-home marker and is reported as an intentional skipped module.

## Verification

- Python tests cover Developer-first ordering, use of the initial Developer
  tab, Account new-tab creation, shared authentication state, and both gate
  values.
- Node tests cover Developer persistence before Account/profile handling,
  fixed audit events, terminal progress, and a successful gated completion.
- Run Python, account-browser-flow, ruyiPage protocol/flow, flow-audit, and
  static diff checks. No real Apple login is run from Windows.
