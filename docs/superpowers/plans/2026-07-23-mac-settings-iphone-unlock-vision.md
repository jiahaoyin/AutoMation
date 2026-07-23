# macOS System Settings iPhone Unlock Vision Fallback Plan

1. Bind a trusted System Settings recovery surface and scan the four observed
   modal kinds: terms, Mac password, AX-invisible iPhone unlock, and Find My
   Mac location.
2. Add strict stdin-only action phases. Terms must re-scan after the checkbox;
   Mac password uses `000000`; iPhone uses a verified 4/6 zero string; location
   clicks only `action-button-2` (“Later”).
3. Keep Vision title/rectangle detection for the iPhone page, with the same
   PID/visual-host/CGWindowID binding and no manual passcode prompt.
4. Add a Node wrapper/controller that processes one stable modal per poll and
   remains enabled for later sheets. Keep the feature disabled unless
   `APPLE_AUTOMATION_POST_SMS_FINALIZATION_ENABLED=1`.
5. Invoke it after both automatic and manual SMS paths, update install/release
   fallback behavior, and run focused Windows-safe source/protocol checks.
5. Update install/release wiring and focused Windows-safe source/protocol
   checks, then review the resulting diff before publishing.
