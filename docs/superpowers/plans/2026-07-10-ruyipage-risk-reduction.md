# ruyiPage-only Browser Automation Plan

**Goal:** Make ruyiPage the sole owner of all browser and page operations, remove the legacy Node BiDi implementation, and prepare a macOS test handoff.

## Tasks

1. Lock backend policy to ruyiPage-only; reject legacy backend values and fail when the runtime is unavailable.
2. Move Firefox executable/Profile path resolution into a neutral module that does not launch or control a browser.
3. Reduce `account-browser-flow.js` to JSONL and macOS 2FA orchestration.
4. Harden `apple_account_flow.py` around bounded waits, verified credentials, required remember-account state, detected 2FA fields, trust handling, session verification, and failure screenshots.
5. Install ruyiPage into `.runtime/ruyipage-venv` from `install.sh` and prefer that Python at runtime.
6. Remove legacy BiDi client, input, anti-automation, session, browser debug files, tests, package scripts, release entries, and documentation.
7. Run all pure Windows tests and syntax checks, audit for stale references, review the final diff, then commit and push the test branch.

## Verification Commands

```text
node scripts/test-browser-backend.mjs
node scripts/test-ruyipage-runtime.mjs
node scripts/test-ruyipage-protocol.mjs
node scripts/test-firefox-profile-mode.mjs
node scripts/test-release-copy-paths.mjs
npm run test:ruyipage-flow
npm run check
git diff --check
```

The macOS machine then runs `./install.sh`, `npm run check`, and `./run.sh` while observing the checkpoints in `docs/PROJECT.md`.
