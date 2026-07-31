# macOS System Settings iPhone Unlock Vision Fallback Plan

1. Bind a trusted System Settings recovery surface and scan the four observed
   modal kinds: terms, Mac password, AX-invisible iPhone unlock, and Find My
   Mac location.
2. Treat phone selection as optional and the six-digit SMS page as mandatory.
   Start provider polling only after two stable code-entry observations; after
   a write, require the code page to retire before handing control to post-SMS.
3. Add strict bound action phases. Terms must re-scan after the checkbox and
   location clicks only `action-button-2` ("Later"). Mac password and iPhone
   unlock always stop for supervised manual entry; they never receive fixture
   values from the automation runtime.
4. Keep Vision title/rectangle detection for the iPhone page, with the same
   PID/visual-host/CGWindowID binding. Each stage/binding has at most three
   automatic actions; after manual Enter the controller resumes observation
   without resetting that budget.
5. Process one dynamic modal per probe. A successful action uses a probe-only
   transition grace window so slow Settings hydration cannot duplicate clicks
   or skip a later optional surface.
6. Emit fixed, redacted lifecycle events into `flow-audit.jsonl`, including
   provider/SMS/final-login failure closures. Update install/release wiring and
   run focused Windows-safe source/protocol checks before publishing.
