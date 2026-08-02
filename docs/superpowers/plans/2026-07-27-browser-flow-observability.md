# Browser Flow Observability Plan

1. Add fixed, redacted stage and observation events to the ruyiPage Python flow.
2. Split the post-login profile section into a partial-result boundary that retains a
   confirmed account-home outcome and preservation policy.
3. Extend Node event sanitization, audit forwarding, terminal status lines, and report
   metadata with the new fixed event/result contract, including screenshot checkpoints,
   acceptance-marker states, post-login cleanup partials, and explicit
   skipped/succeeded/partial state tokens.
4. Add focused Python and Node regression tests for partial profile capture, runner
   timeout cleanup that clears stale preservation state, full audit coverage, and
   sensitive-data exclusion.
5. Run targeted Node/Python suites, static diff validation, two independent read-only
   reviews, then commit and push the reviewed result.
