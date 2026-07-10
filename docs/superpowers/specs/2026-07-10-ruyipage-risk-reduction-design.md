# ruyiPage-only Browser Automation Design

## Goal

Move the complete account.apple.com browser phase to Python ruyiPage and remove every legacy Node browser/page automation path. macOS native UI automation and 2FA collection remain unchanged.

## Boundary

- ruyiPage owns Firefox launch/attach, navigation, page queries, element input, clicks, screenshots, and quit.
- Node owns credentials, report paths, process timeout, JSONL transport, and the macOS 2FA sidecar.
- Node must never open a WebDriver connection, query DOM state, or dispatch page input.
- Missing Python or ruyiPage is a hard browser-phase failure. There is no fallback backend.

## Interaction Priority

1. ruyiPage native BiDi element/action APIs for all input and clicks.
2. ruyiPage `run_js()` only for read-only state/text queries.
3. Bounded randomized pacing between actions and condition-based waits.
4. Exact input-state verification where ruyiPage exposes element values.
5. Stop safely when a required control or state cannot be identified.

The 2FA code is entered only after the page exposes either one OTP field or six digit fields. The remember-account checkbox is required during a fresh login and must be verified as checked.

## Runtime And Profiles

`install.sh` uses an existing Python 3.10+ to create `.runtime/ruyipage-venv` and installs the verified `ruyiPage==1.2.45` release there. It does not use a privileged system-Python installer. An explicit `RUYIPAGE_PYTHON` overrides the local environment. The project uses the installed Firefox path directly, so ruyiPage's downloadable browser runtime is not required.

Persistent profiles remain the default for repeated tests of one account. `BROWSER_PROFILE_MODE=fresh` creates a run-specific profile and is recommended when changing identity.

## Failure And Reporting

- Python emits JSONL `ready`, `warning`, `need_2fa`, and final `result` events.
- Node kills the child on timeout or 2FA sidecar failure.
- Python captures a failure screenshot when possible before ruyiPage quits Firefox.
- Credentials travel through child environment variables, not command-line arguments.

## Verification

Windows verifies backend policy, profile paths, runtime selection, JSONL behavior, ruyiPage flow helpers, release copy paths, syntax, and environment reporting. Final browser behavior is verified on the macOS test machine after pulling the pushed branch.
