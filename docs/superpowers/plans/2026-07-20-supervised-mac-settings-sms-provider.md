# Supervised Mac Settings SMS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a supervised, independent SMS-provider acquisition path to the Mac Settings verification helper while preserving browser 2FA behavior.

**Architecture:** A new provider module owns secret configuration validation, bounded HTTPS reads, and response-to-OTP parsing. The existing Mac Settings coordinator accepts a code-provider dependency, polls it for two minutes, and uses the hidden terminal only as a five-minute fallback. Mac Settings login conditionally invokes the coordinator in supervised mode after password submission.

**Tech Stack:** Node.js ESM, native `fetch`, AbortController, existing Swift AX helper, node:assert tests.

## Global Constraints

- Only macOS supervised GUI sessions can perform SMS UI automation.
- Browser/2FA sidecar files remain untouched; SMS is an independent Mac Settings module.
- URL, provider token, full phone number, response body, and OTP never enter reports, logs, errors, child argv, or child environments.
- Provider GET requests are HTTPS-only, redirect-disabled, response-size-bounded, and time-bounded.
- Provider polling has a fixed 120-second deadline; hidden manual entry has a separate fixed five-minute deadline.

---

### Task 1: Provider Configuration and Parser

**Files:**
- Create: `scripts/lib/mac-settings-sms-provider.js`
- Modify: `scripts/test-mac-settings-sms-verification.mjs`

**Interfaces:**
- Produces `validateSmsProviderUrl(url): URL`, `resolveMacSettingsSmsProviderConfig(options)`, `extractSmsVerificationCode(body, suffix)`, and `createSmsProviderCodePoller(config, options)`.

- [ ] **Step 1: Write failing config/parser tests**
- [ ] **Step 2: Run `node scripts/test-mac-settings-sms-verification.mjs` and confirm failure**
- [ ] **Step 3: Implement strict secret-preserving config validation and parsing**
- [ ] **Step 4: Re-run isolated test and confirm parser/config tests pass**

### Task 2: Polling Coordinator and Manual Fallback

**Files:**
- Modify: `scripts/lib/mac-settings-sms-verification.js`
- Modify: `scripts/test-mac-settings-sms-verification.mjs`

**Interfaces:**
- Consumes `codeProvider({signal, timeoutMs}): Promise<string|null>`.
- Produces `completeSupervisedMacSettingsSmsVerification(options): Promise<{status: "submitted", source: "provider"|"manual"}>`.

- [ ] **Step 1: Add failing tests for provider success, 120-second provider timeout, and five-minute manual fallback**
- [ ] **Step 2: Run the isolated test and confirm expected failure**
- [ ] **Step 3: Add bounded provider-first acquisition without exposing code**
- [ ] **Step 4: Re-run the isolated test and confirm all coordinator tests pass**

### Task 3: Supervised Mac Login Entry Point

**Files:**
- Modify: `scripts/lib/mac-settings-login.js`
- Modify: `scripts/test-mac-settings-sms-verification.mjs`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes validated runtime config from `resolveMacSettingsSmsProviderConfig`.
- Produces a fixed SMS phase status suitable for the existing Mac Settings caller.

- [ ] **Step 1: Add failing tests for supervision-only invocation and partial configuration rejection**
- [ ] **Step 2: Run the isolated test and confirm expected failure**
- [ ] **Step 3: Wire the SMS helper only into the supervised Mac Settings path; document runtime-only settings**
- [ ] **Step 4: Re-run SMS and relevant Mac Settings tests and confirm they pass**

### Task 4: Full Verification and Commit

**Files:**
- Modify: SMS module/docs/tests from Tasks 1-3 only

- [ ] **Step 1: Run `npm.cmd run -s test:mac-settings-sms-verification`**
- [ ] **Step 2: Run syntax checks for changed Node modules and inspect the scoped diff**
- [ ] **Step 3: Run relevant existing Mac Settings tests without invoking a real Apple flow**
- [ ] **Step 4: Commit only the SMS provider implementation, tests, and documentation with a focused message**
