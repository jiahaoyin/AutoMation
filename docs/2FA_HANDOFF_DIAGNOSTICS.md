# 2FA Handoff Diagnostics

When the collector has a valid code, that only proves code acquisition. The
following fixed, non-secret checkpoints prove each successive browser handoff:

```text
twofa_code_delivery_started
twofa_code_delivery_sent
code_received
twofa_code_delivery_acknowledged
target_resolved
input_completed
submit_sent
transition_confirmed
```

The direct ruyiPage runner emits the acknowledgement only after Python has
read the JSONL command. This separates an stdin delivery failure from a
Firefox target/input/submit/transition failure.

On failure, inspect `flow-audit.jsonl` for the `account_browser` event
`runner_failed`. Its fixed details include:

- `failureStage` and `runnerStage`
- `twoFaPhase` and `twoFaGeneration`
- `codeDeliveryAttempted`, `codeDeliverySent`, and `codeDeliveryAcknowledged`
- `browserPreserved`
- `browserErrorClass`
- `cleanupFailed`

The record intentionally excludes Apple ID, password, OTP, page text, raw
AX/OCR output, and traceback content. Error classes are sufficient for a
repeatable repair decision without creating a credential-bearing diagnostic
file.

For direct `./run.sh` or `./run.sh --skip-mac` sessions,
`BROWSER_PRESERVE_ON_FAILURE=1` is the default. Firefox remains open after a
failure so the final Apple page can be checked manually. Set the variable to
`0` to restore close-on-failure behavior. Supervised broker sessions always
clean up their browser process.
