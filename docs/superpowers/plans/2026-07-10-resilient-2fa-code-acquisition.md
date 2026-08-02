# Resilient 2FA Code Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably acquire the current Apple six-digit verification code whether the macOS popup arrives before or after the web page requests 2FA, with System Settings racing as an automatic fallback.

**Architecture:** Python and Node establish a `prepare_2fa` handshake immediately before password submission. One Node-owned collector then watches native popup state continuously and, after an eight-second grace period, races a cancellable System Settings helper; the browser itself remains entirely owned by ruyiPage.

**Tech Stack:** Node.js ESM and `node:assert`, Python 3.10+ and `unittest`, Swift/AppKit/Accessibility on macOS, JSONL over child-process stdin/stdout, ruyiPage for every Firefox operation.

## Global Constraints

- All Firefox launch, attachment, page reads, element location, screenshots, and interaction remain in `scripts/ruyipage/apple_account_flow.py` through ruyiPage.
- Node may only coordinate JSONL and native macOS helpers; it must not inspect or control Firefox.
- The default System Settings grace period is `BROWSER_2FA_SETTINGS_AFTER_MS=8000`.
- `BROWSER_2FA_SETTINGS_FALLBACK=0` is the only setting that disables the fallback.
- The popup polling default remains `BROWSER_2FA_POLL_MS=800`.
- `BROWSER_2FA_POPUP_WAIT_MS` is removed because popup and Settings are no longer sequential phases.
- Every accepted candidate normalizes to exactly six digits and popup candidates require two matching reads.
- Tests run on Windows with injected native boundaries; the real Swift helper and full login are verified after the branch is pulled on macOS.

## File Map

- `scripts/ruyipage/apple_account_flow.py`: emits and validates the pre-submit handshake.
- `scripts/ruyipage/test_apple_account_flow.py`: unit tests for handshake acceptance and rejection.
- `scripts/lib/ruyipage-backend-runner.js`: handles `prepare_2fa` before handling `need_2fa`.
- `scripts/test-ruyipage-protocol.mjs`: end-to-end JSONL ordering and preparation-failure tests.
- `scripts/lib/mac-settings-2fa.js`: starts, cancels, force-stops, and parses the Settings helper.
- `scripts/swift/mac-settings-2fa-code.swift`: watches a cancellation marker and closes its own code alert.
- `scripts/test-mac-settings-2fa.mjs`: cross-platform child lifecycle and marker cleanup tests.
- `scripts/lib/two-fa-sidecar.js`: implements the dual-source collector.
- `scripts/test-two-fa-sidecar.mjs`: deterministic collector race, stale-code, failure, and disposal tests.
- `scripts/lib/account-browser-flow.js`: owns one collector for one runner lifecycle.
- `scripts/test-account-browser-flow.mjs`: proves prepare/get/dispose ordering.
- `.env.example`, `README.md`, `docs/PROJECT.md`, `package.json`: configuration and test entry points.

---

### Task 1: Pre-submit JSONL handshake

**Files:**
- Modify: `scripts/ruyipage/apple_account_flow.py`
- Modify: `scripts/ruyipage/test_apple_account_flow.py`
- Modify: `scripts/lib/ruyipage-backend-runner.js`
- Modify: `scripts/test-ruyipage-protocol.mjs`

**Interfaces:**
- Produces: Python `request_two_factor_preparation() -> None`.
- Consumes: runner callback `prepare2FA: () => Promise<void>`.
- Protocol: Python event `{"event":"prepare_2fa"}` and Node command `{"type":"2fa_prepared"}`.

- [ ] **Step 1: Add failing Python handshake tests**

```python
class TwoFactorPreparationTests(unittest.TestCase):
    def test_accepts_only_two_factor_prepared_ack(self):
        with patch("apple_account_flow.emit") as emit_event, patch(
            "apple_account_flow.read_command", return_value={"type": "2fa_prepared"}
        ):
            request_two_factor_preparation()
        emit_event.assert_called_once_with({"event": "prepare_2fa"})

    def test_rejects_unexpected_preparation_command(self):
        with patch("apple_account_flow.emit"), patch(
            "apple_account_flow.read_command", return_value={"type": "2fa_code", "code": "123456"}
        ), self.assertRaisesRegex(RuntimeError, "2FA preparation"):
            request_two_factor_preparation()
```

- [ ] **Step 2: Run the focused Python test and confirm RED**

Run: `python -m unittest scripts.ruyipage.test_apple_account_flow.TwoFactorPreparationTests -v`

Expected: import failure because `request_two_factor_preparation` does not exist.

- [ ] **Step 3: Add the minimal Python handshake and call it before password submission**

```python
def request_two_factor_preparation() -> None:
    emit({"event": "prepare_2fa"})
    command = read_command()
    if command.get("type") != "2fa_prepared":
        raise RuntimeError("2FA preparation acknowledgement was not received")
```

Call it after `ensure_remember_checked(page)` and before `submit_with_enter(...)`. Update `node_self_test()` to perform the same handshake before it emits `need_2fa`.

- [ ] **Step 4: Add failing runner protocol expectations**

```javascript
let prepared = false;
const result = await runner.run({
  creds,
  reportDir,
  async prepare2FA() { prepared = true; },
  async get2FACode() {
    assert.equal(prepared, true);
    return "123456";
  },
});
assert.deepEqual(events, ["ready", "prepare_2fa", "need_2fa", "result"]);
```

Also assert that a rejected `prepare2FA()` causes the runner to terminate without calling `get2FACode()`.

- [ ] **Step 5: Implement runner handling and verify GREEN**

On `prepare_2fa`, await `prepare2FA()` and write exactly one `2fa_prepared` command. On `need_2fa`, preserve the existing code path. Run:

```powershell
python -m unittest scripts.ruyipage.test_apple_account_flow.TwoFactorPreparationTests -v
node scripts/test-ruyipage-protocol.mjs
```

Expected: both commands pass.

- [ ] **Step 6: Commit the protocol boundary**

```powershell
git add scripts/ruyipage/apple_account_flow.py scripts/ruyipage/test_apple_account_flow.py scripts/lib/ruyipage-backend-runner.js scripts/test-ruyipage-protocol.mjs
git commit -m "feat: prepare 2fa before password submission"
```

---

### Task 2: Cancellable System Settings provider

**Files:**
- Create: `scripts/test-mac-settings-2fa.mjs`
- Modify: `scripts/lib/mac-settings-2fa.js`
- Modify: `scripts/swift/mac-settings-2fa-code.swift`

**Interfaces:**
- Produces: `start2FASettingsCodeRequest(opts) -> { promise, cancel, forceStop }`.
- `opts` supports `timeoutMs`, `screenshotPath`, `reportDir`, and injected process/filesystem boundaries for unit tests.
- `promise` resolves `{ code, raw, screenshot }`; cancellation rejects with an error whose `code` is `2FA_SETTINGS_CANCELLED`.

- [ ] **Step 1: Write failing request lifecycle tests**

Use an EventEmitter-based child double with real stdout/stderr streams. Assert that:

```javascript
const request = start2FASettingsCodeRequest({ reportDir, runtime });
assert.ok(child.args.includes("--cancel-file"));
request.cancel();
assert.equal(fs.existsSync(cancelFile), true);
child.stdout.emit("data", Buffer.from('{"ok":false,"message":"cancelled"}\n'));
child.emit("close", 2, null);
await assert.rejects(request.promise, err => err.code === "2FA_SETTINGS_CANCELLED");
assert.equal(fs.existsSync(cancelFile), false);
```

Add a second test proving `forceStop()` signals the child and still removes the marker after close.

- [ ] **Step 2: Run the new test and confirm RED**

Run: `node scripts/test-mac-settings-2fa.mjs`

Expected: import failure because `start2FASettingsCodeRequest` does not exist.

- [ ] **Step 3: Implement the Node child handle**

Spawn the compiled helper, collect bounded stdout/stderr, parse one JSON result, normalize exactly six digits, create a unique marker under `reportDir`, and remove it on every `close`/`error` path. Keep `fetch2FACodeFromSystemSettings()` as a compatibility wrapper that awaits `.promise`.

- [ ] **Step 4: Add Swift cancellation checks**

Parse `--cancel-file`. Before and after every navigation action and during code polling, check the marker. When cancellation is observed after the Settings app is available, click `好`, `OK`, `Done`, or `完成` before emitting a cancelled result.

- [ ] **Step 5: Verify request lifecycle and compile syntax**

Run on Windows: `node scripts/test-mac-settings-2fa.mjs`

Run on macOS after pull: `swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift`

Expected: Node lifecycle tests pass; Swift typecheck exits zero.

- [ ] **Step 6: Commit the cancellable provider**

```powershell
git add scripts/test-mac-settings-2fa.mjs scripts/lib/mac-settings-2fa.js scripts/swift/mac-settings-2fa-code.swift
git commit -m "feat: make settings 2fa provider cancellable"
```

---

### Task 3: Dual-source collector

**Files:**
- Create: `scripts/test-two-fa-sidecar.mjs`
- Modify: `scripts/lib/two-fa-sidecar.js`

**Interfaces:**
- Produces: `createMac2FACollector(options) -> { prepare, getCode, dispose }`.
- Consumes: `start2FASettingsCodeRequest(opts)` from Task 2.
- `prepare()` establishes the stale-code boundary and starts popup monitoring.
- `getCode()` starts the overall deadline and Settings grace timer, then returns one winning code.
- `dispose()` terminates all loops, timers, and child helpers.

- [ ] **Step 1: Write failing collector tests**

Build a deterministic native adapter with queues for popup states/codes and a controllable Settings request. Cover these independent behaviors:

```javascript
await collector.prepare();
popup.pushStableCode("123456");
await popup.flush();
assert.equal(await collector.getCode(), "123456");
assert.equal(settings.starts, 0);
```

```javascript
await collector.prepare();
const codePromise = collector.getCode();
await clock.advance(7_999);
assert.equal(settings.starts, 0);
await clock.advance(1);
assert.equal(settings.starts, 1);
settings.resolve({ code: "654321", raw: "654 321" });
assert.equal(await codePromise, "654321");
```

Also cover late popup winning and cancelling Settings, Settings winning and switching popup to cleanup-only, stale pre-arm code rejection, one provider failing while the other wins, exact six-digit validation, and disposal with no active scheduled work.

- [ ] **Step 2: Run the collector tests and confirm RED**

Run: `node scripts/test-two-fa-sidecar.mjs`

Expected: import failure because `createMac2FACollector` does not exist.

- [ ] **Step 3: Implement preparation and continuous popup monitoring**

During `prepare()`, dismiss and record only already-visible code dialogs, append an audit entry, establish `preparedAt`, then start a polling loop. The loop may click Allow before a winner exists, accepts only two matching fresh six-digit reads, and buffers a code even before `getCode()`.

- [ ] **Step 4: Implement Settings scheduling and race resolution**

Start Settings only from `getCode()` and no earlier than `preparedAt + settingsFallbackAfterMs`. Provider failures append audit entries and leave the other source active. The first valid candidate wins; one overall timeout begins at `getCode()`.

- [ ] **Step 5: Implement loser cleanup and disposal**

When popup wins, call `cancel()`, wait up to the configured cleanup grace, then call `forceStop()` if needed. When Settings wins, keep popup polling in cleanup-only mode until `dispose()`. Attach rejection handlers immediately so expected loser failures cannot become unhandled rejections.

- [ ] **Step 6: Verify GREEN and commit**

```powershell
node scripts/test-two-fa-sidecar.mjs
git add scripts/test-two-fa-sidecar.mjs scripts/lib/two-fa-sidecar.js
git commit -m "feat: race popup and settings 2fa providers"
```

---

### Task 4: Browser-run lifecycle ownership

**Files:**
- Create: `scripts/test-account-browser-flow.mjs`
- Modify: `scripts/lib/account-browser-flow.js`

**Interfaces:**
- Consumes: `createMac2FACollector({ timeoutMs, reportDir })`.
- Passes `prepare2FA: collector.prepare` and `get2FACode: collector.getCode` to the runner.
- Guarantees `await collector.dispose()` in `finally` for success, runner failure, and trusted sessions without 2FA.

- [ ] **Step 1: Write failing ownership tests**

Inject a runner and collector factory through an optional runtime argument. Assert exact ordering for a 2FA run:

```javascript
assert.deepEqual(calls, ["prepare", "getCode", "dispose"]);
```

Add runner-failure and no-2FA cases that both end with exactly one `dispose` call.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node scripts/test-account-browser-flow.mjs`

Expected: the old flow lazily creates `startMac2FAWait` and does not expose `prepare2FA` or dispose it.

- [ ] **Step 3: Implement lifecycle ownership**

Create one collector before `runner.run`, delegate both callbacks, and wrap only the runner lifetime in `try/finally`. Keep the existing ruyiPage-only result shape and environment logging unchanged.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
node scripts/test-account-browser-flow.mjs
node scripts/test-ruyipage-protocol.mjs
git add scripts/test-account-browser-flow.mjs scripts/lib/account-browser-flow.js
git commit -m "feat: own 2fa collector for browser run"
```

---

### Task 5: Configuration, regression verification, and release handoff

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/PROJECT.md`
- Modify: `package.json`

**Interfaces:**
- Documents `BROWSER_2FA_SETTINGS_AFTER_MS=8000`, `BROWSER_2FA_SETTINGS_FALLBACK=1`, and `BROWSER_2FA_POLL_MS=800`.
- Adds repeatable scripts for the three new Node test files.

- [ ] **Step 1: Update configuration and operational documentation**

Remove every active reference to `BROWSER_2FA_POPUP_WAIT_MS`. Explain that the popup is preferred for eight seconds, Settings then races it, and all Firefox work remains ruyiPage-only.

- [ ] **Step 2: Add package test commands**

```json
"test:2fa-sidecar": "node scripts/test-two-fa-sidecar.mjs",
"test:2fa-settings-unit": "node scripts/test-mac-settings-2fa.mjs",
"test:account-browser-flow": "node scripts/test-account-browser-flow.mjs"
```

- [ ] **Step 3: Run targeted and broad verification**

```powershell
node scripts/test-mac-settings-2fa.mjs
node scripts/test-two-fa-sidecar.mjs
node scripts/test-account-browser-flow.mjs
node scripts/test-ruyipage-protocol.mjs
node scripts/test-ruyipage-flow.mjs
node scripts/test-ruyipage-runtime.mjs
node scripts/test-browser-backend.mjs
python -m py_compile scripts/ruyipage/apple_account_flow.py
git diff --check
```

Expected: all cross-platform tests pass, Python reports 0 failures, compilation exits zero, and `git diff --check` is silent.

- [ ] **Step 4: Review browser ownership and obsolete paths**

Run:

```powershell
rg -n "selenium|playwright|puppeteer|webdriver|BROWSER_2FA_POPUP_WAIT_MS|startMac2FAWait|waitForMac2FACode" scripts README.md docs .env.example
```

Expected: no executable browser fallback and no obsolete sidecar API/config references.

- [ ] **Step 5: Commit documentation and push**

```powershell
git add .env.example README.md docs/PROJECT.md package.json
git commit -m "docs: describe resilient 2fa fallback"
git push origin codex/ruyipage-risk-reduction
```

- [ ] **Step 6: macOS test-machine verification after pull**

```bash
git pull origin codex/ruyipage-risk-reduction
swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift
./run.sh --skip-mac
```

Expected: password submission waits for preparation; an early popup code is retained; Settings starts after about eight seconds only when needed; whichever provider loses closes its dialog/process; the browser flow reaches the authenticated account page.
