import { promptForHiddenVerificationCode } from "./manual-verification-prompt.js";
import { runMacSettingsSmsHelper } from "./mac-settings-sms-ax.js";
import { sleep } from "./prompt.js";

const VALID_STAGES = new Set(["phone_selection", "code_entry", "waiting"]);
const SIX_DIGIT_CODE_RE = /^[0-9]{6}$/;
const TWO_DIGIT_SUFFIX_RE = /^[0-9]{2}$/;
function failure(code) { const error = new Error(code); error.code = code; return error; }
function readRemainingMs(deadline, now) { return Math.max(0, deadline - now()); }
function boundedPositiveInteger(value, fallback, errorCode) { const candidate = value ?? fallback; if (!Number.isFinite(candidate) || candidate <= 0) throw failure(errorCode); const normalized = Math.trunc(candidate); if (normalized <= 0) throw failure(errorCode); return normalized; }
export function trustedPhoneSuffix(phoneNumber) { const raw = String(phoneNumber ?? "").trim(); if (!/^\+?[0-9()\s.-]+$/.test(raw)) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID"); const digits = raw.replace(/\D/g, ""); if (digits.length < 4) throw failure("MAC_SETTINGS_SMS_PHONE_INVALID"); return digits.slice(-2); }
export function normalizeManualSmsCode(value) { const code = typeof value === "string" ? value.trim() : ""; return SIX_DIGIT_CODE_RE.test(code) ? code : null; }
export function normalizeMacSettingsSmsState(value) { if (!value || typeof value !== "object" || value.ok !== true) return { ok: false, stage: "invalid" }; const stage = value.stage; return { ok: true, stage: VALID_STAGES.has(stage) ? stage : "invalid" }; }
function requireSupervisedSession({ platform, supervised, isTTY }) { if (platform !== "darwin") throw failure("MAC_SETTINGS_SMS_UNSUPPORTED_PLATFORM"); if (supervised !== true) throw failure("MAC_SETTINGS_SMS_SUPERVISION_REQUIRED"); if (isTTY !== true) throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED"); }
async function readCodeWithinDeadline(provider, { signal, timeoutMs }) { let removeAbortListener = () => {}; const aborted = new Promise((resolve) => { const onAbort = () => resolve(null); if (signal.aborted) { onAbort(); return; } signal.addEventListener("abort", onAbort, { once: true }); removeAbortListener = () => signal.removeEventListener("abort", onAbort); }); try { return await Promise.race([Promise.resolve().then(() => provider({ signal, timeoutMs })).catch(() => null), aborted]); } finally { removeAbortListener(); } }
async function defaultNativeRunner(phase, options) { return runMacSettingsSmsHelper(phase, options); }

/** Complete supervised Mac Settings SMS verification. Provider polling is independent from browser 2FA and falls back to hidden local entry. */
export async function completeSupervisedMacSettingsSmsVerification(options = {}) {
  const suffix = trustedPhoneSuffix(options.phoneNumber);
  const platform = options.platform ?? process.platform;
  const supervised = options.supervised ?? process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
  const isTTY = options.isTTY ?? Boolean(process.stdin?.isTTY === true && (process.stdout?.isTTY === true || supervised === true));
  requireSupervisedSession({ platform, supervised, isTTY });
  const codeProvider = options.codeProvider ?? null;
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, codeProvider ? 420_000 : 120_000, "MAC_SETTINGS_SMS_TIMEOUT_INVALID");
  const providerTimeoutMs = boundedPositiveInteger(options.providerTimeoutMs, 120_000, "MAC_SETTINGS_SMS_PROVIDER_TIMEOUT_INVALID");
  const manualTimeoutMs = boundedPositiveInteger(options.manualTimeoutMs, 300_000, "MAC_SETTINGS_SMS_MANUAL_TIMEOUT_INVALID");
  const pollIntervalMs = Math.max(50, boundedPositiveInteger(options.pollIntervalMs, 500, "MAC_SETTINGS_SMS_POLL_INTERVAL_INVALID"));
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const nativeRunner = options.nativeRunner ?? defaultNativeRunner;
 const manualCodeProvider = options.manualCodeProvider ?? promptForHiddenVerificationCode;
  const deadline = now() + timeoutMs;
  let selectionSubmitted = false;
  const invokeNative = async (phase, values = {}) => { const remainingMs = readRemainingMs(deadline, now); if (remainingMs <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT"); const result = await nativeRunner(phase, { ...values, timeoutMs: remainingMs }); if (readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT"); return result; };
  const acquireCode = async (provider, maxMs) => { const availableMs = Math.min(maxMs, readRemainingMs(deadline, now)); if (availableMs <= 0) return null; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), availableMs); try { const value = await readCodeWithinDeadline(provider, { signal: controller.signal, timeoutMs: availableMs }); return controller.signal.aborted ? null : normalizeManualSmsCode(value); } finally { clearTimeout(timer); } };
  while (readRemainingMs(deadline, now) > 0) {
    const state = normalizeMacSettingsSmsState(await invokeNative("sms-state", { suffix }));
    if (!state.ok || state.stage === "invalid") throw failure("MAC_SETTINGS_SMS_STATE_UNAVAILABLE");
    if (state.stage === "phone_selection" && !selectionSubmitted) { const selection = await invokeNative("sms-select", { suffix }); if (selection?.ok !== true) throw failure("MAC_SETTINGS_SMS_PHONE_NOT_MATCHED"); const continued = await invokeNative("sms-continue", { suffix }); if (continued?.ok !== true) throw failure("MAC_SETTINGS_SMS_CONTINUE_FAILED"); selectionSubmitted = true; continue; }
    if (state.stage === "code_entry") { const providerCode = codeProvider ? await acquireCode(codeProvider, providerTimeoutMs) : null; const code = providerCode ?? await acquireCode(manualCodeProvider, manualTimeoutMs); if (!code && readRemainingMs(deadline, now) <= 0) throw failure("MAC_SETTINGS_SMS_TIMEOUT"); if (!code) throw failure("MAC_SETTINGS_SMS_MANUAL_CODE_INVALID"); const filled = await invokeNative("sms-code", { code, suffix }); if (filled?.ok !== true) throw failure("MAC_SETTINGS_SMS_CODE_FILL_FAILED"); return { status: "submitted" }; }
    await pause(Math.min(pollIntervalMs, readRemainingMs(deadline, now)));
  }
  throw failure("MAC_SETTINGS_SMS_TIMEOUT");
}
export const MAC_SETTINGS_SMS_SUFFIX_RE = TWO_DIGIT_SUFFIX_RE;
