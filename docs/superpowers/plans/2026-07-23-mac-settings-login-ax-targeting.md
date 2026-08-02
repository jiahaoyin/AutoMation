# macOS System Settings Login AX Targeting Plan

1. Add exact `AXIdentifier` discovery and bounded wait helpers to
   `scripts/swift/mac-settings-ax-fill.swift`.
2. Replace ordinal email/password and localized-button selection in the Swift
   login phases with `USERNAME_TEXT_FIELD`, `PASSWORD_TEXT_FIELD`, and
   `LOGIN_BUTTON` resolution.
3. Apply the same identifiers to the AppleScript fallback and require the
   exact enabled `LOGIN_BUTTON` for both transitions.
4. Pass native-helper credentials through its child environment, normalize
   failures to fixed phase states, and keep preflight/debug output structural.
5. Make the Node wrapper treat Continue or password failure as a failed Swift
   login attempt so the existing fallback can take over instead of reporting a
   partial success.
6. Run Windows-safe syntax/diff checks, conduct two read-only reviews, then
   commit and push for the supervised macOS verification host.
