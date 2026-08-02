# Post-Login Profile Capture Plan

## Objective

Treat the authenticated Apple Account manage page as a successful terminal
state, then use ruyiPage-only navigation and page interaction to collect the
profile values requested for the local account record without placing those
values in diagnostics or reports.

## Scope

1. Keep the persistent Firefox profile and leave the successful browser window
   and tab open. A later run must recognize an existing authenticated session
   after the normal sign-in navigation redirects to the manage page.
2. Navigate to the stable personal-information URL, wait for hydration, capture
   a consistently named screenshot, then read the birthday card structurally.
3. Click the name card through ruyiPage, wait for its modal, and read the
   separate given/family fields through DOM queries. Normalize the stored name
   as `given + " " + family`.
4. Hand the values only from the Python result to the Node coordinator. Node
   writes lowercase `name` and `birthday` to `.env` and prints them directly to
   the interactive terminal. Audits and `report.json` retain only non-sensitive
   collection booleans and screenshot metadata.
5. Cover English and Chinese UI variants through semantic input attributes,
   card/modal structure, and localized labels as bounded fallbacks.

## Verification

- Python unit tests cover authenticated-session detection, personal-information
  navigation, screenshot ordering, birthday extraction, name modal extraction,
  ambiguous target rejection, and success browser preservation.
- Node tests cover `.env` profile upsert, direct terminal confirmation, and
  report/audit redaction.
- Run the focused Python and Node suites, static checks, diff checks, then two
  independent read-only reviews before commit and push.
