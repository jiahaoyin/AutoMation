# Browser 2FA Serial Fallback Plan

## Objective

Make browser two-factor authentication deterministic and serial:

1. Wait for the trusted Apple verification popup and use AX, then Vision OCR if
   AX cannot expose the code.
2. Start System Settings only after the popup-primary window expires without a
   valid fresh code.
3. Start hidden terminal entry only after the bounded Settings attempts end.
4. Send the first valid fresh code directly to ruyiPage and cancel later
   providers. Do not race popup, Settings, and terminal entry.

## Required Behavior

- Default popup-primary window: 30 seconds from the `need_2fa` request.
- A confirmed Allow action gives the popup/OCR reader a further 30 seconds
  before Settings may start.
- Settings has at most two attempts, with the existing bounded timeout and
  retry delay. It never runs alongside popup-primary or terminal entry.
- A second webpage code request returns to popup-primary while retaining the
  shared 240-second deadline and the global Settings attempt budget.
- Terminal/audit/report output is redacted by default. An explicitly enabled
  local terminal-only debug display may show the code, but must never write it
  to audit JSONL, reports, screenshots, or error text.

## Verification

- Popup code before expiry starts no Settings request.
- Settings starts only after popup-primary expiry; a later popup cannot win.
- Terminal entry begins only after Settings finishes its bounded attempts.
- Generation two rejects the first code and re-enters popup-primary.
- All 2FA audit and browser-flow tests remain free of code leakage.
