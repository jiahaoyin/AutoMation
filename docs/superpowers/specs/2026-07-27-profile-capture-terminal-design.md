# Apple Profile Capture And Terminal Output Design

## Problem

Authentication now completes and the browser reaches
`https://account.apple.com/account/manage/section/information`, but the profile
phase can inspect a transient or retained account-security view before the SPA
route is structurally ready. Generic authentication text then wins over the
visible personal-information cards, producing `profile_authentication_error`.
The flow consequently saves only the earlier account-home screenshot and never
persists or prints the captured name and birthday.

The terminal also mirrors low-level input, transition, and observation records
that belong in the full audit stream. This obscures the user-visible progress.

## Required Behavior

1. The personal-information phase must use the exact HTTPS Apple information
   path plus stable visible name and birthday cards as its positive page anchor.
2. Editable email, password, Trust Browser, OTP, blocked, or rejected-code state
   remains a hard blocker. Text-only remnants from the previous SPA route cannot
   override a structurally confirmed personal-information page.
3. The requested post-login screenshot is captured only after the information
   route and both profile cards are stable. Its canonical file name is
   `02-account-information.png`.
4. Birthday is read before the name card is opened. Name is read from the
   structured given/family-name fields in the visible modal.
5. After both values are validated, Node writes lowercase `name` and `birthday`
   entries to the repository `.env` through the existing private atomic writer.
   Interactive direct runs print the captured values for operator verification.
   Audit and report artifacts retain only `nameStored` and `birthdayStored`.
6. The authenticated Firefox window and information tab remain open under the
   existing preservation policy.

## Logging Contract

The Python backend continues to emit every fixed, redacted status and browser
observation. Node continues to sanitize and write each event to
`flow-audit.jsonl` in order.

Default terminal output is a concise progress view:

- browser ready;
- account submitted;
- verification code acquired and submitted;
- authenticated account confirmed;
- personal-information page opened;
- requested screenshot saved;
- birthday collected;
- name collected;
- `.env` updated;
- Firefox session retained;
- completed or a concise fixed failure summary.

Low-level `browser_stage`, `input_progress`, `twofa_progress`, and
`browser_observation` lines are audit-only by default. A fixed boolean
`APPLE_AUTOMATION_TERMINAL_DEBUG=1` may mirror those redacted lines for
diagnostics without changing audit completeness.

Terminal icons are limited to stable text symbols that render on macOS:
`[→]`, `[✓]`, `[!]`, and `[×]`. Terminal messages do not include passwords,
OTPs, cookies, raw page text, or exception bodies.

## Verification

Regression coverage must prove:

1. a stable information route with name/birthday cards succeeds even when stale
   account-security prose remains in the DOM;
2. live authentication controls still block profile confirmation;
3. the information screenshot is taken after card readiness and before the name
   modal is opened;
4. successful capture persists exactly one `name=` and one `birthday=` entry;
5. interactive terminal output includes the captured values, while audit/report
   fixtures do not;
6. default terminal output omits raw stage/input/observation lines, debug mode
   restores only the redacted diagnostic lines; and
7. the existing login, 2FA, session preservation, and privacy suites remain green.

## 2026-07-28 Follow-up

The first production modal query reached the correct Apple name dialog but called
an undefined JavaScript `normalize()` helper. The resolver intentionally swallowed
DOM-query exceptions while waiting for hydration, so this defect surfaced only as
`profile_page_unready` and prevented `.env` persistence.

The repaired contract keeps the existing birthday-first and screenshot ordering,
but now:

- executes the exact embedded modal script against English and Chinese DOM fixtures;
- classifies given, family, and middle-name fields without positional guessing;
- combines the confirmed given/family values in their real modal DOM order, preserving
  family-first locales;
- records one fixed `profile_name_modal_query_failed` audit status if the DOM query
  throws, without forwarding DOM text or exception content; and
- records `result_emitting` before the terminal event and persists `result_emitted`
  only after the event was written successfully.
