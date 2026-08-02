# Supervised Mac Settings SMS Verification Plan

1. Add a narrow native AX helper that reports only a redacted state, selects a
   single trusted-phone control by final two digits, and fills only a recognized
   one- or six-field code input.
2. Add a Node coordinator with strict phone/code validation, explicit
   supervised-session gating, bounded polling, and hidden terminal code entry.
3. Keep the coordinator out of the current production entrypoint until a
   dedicated, attested Mac-supervision mode is added; existing Settings login
   remains manual.
4. Add deterministic Node tests using a fake native helper and fake clock.
5. Run the isolated test, syntax checks, and review the diff. Do not run a real
   Apple Account flow or retrieve codes from external SMS services.
