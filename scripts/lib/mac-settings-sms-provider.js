import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SIX_DIGIT_CODE_RE = /(?<!\d)(\d{6})(?!\d)/g;
const MAX_RESPONSE_BYTES = 256 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fixedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateSmsProviderUrl(value) {
  const raw = fixedString(value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  }
  if (url.protocol !== "https:" || !url.hostname || !url.search) {
    throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  }
  const hasSecretValue = [...url.searchParams.values()].some((item) => item.trim().length > 0);
  if (!hasSecretValue) throw failure("MAC_SETTINGS_SMS_PROVIDER_URL_INVALID");
  return url;
}

export function validateSmsProviderPhone(value) {
  const phone = fixedString(value);
  if (!/^\+?[0-9()\s.-]+$/.test(phone) || phone.replace(/\D/g, "").length < 4) {
    throw failure("MAC_SETTINGS_SMS_PHONE_INVALID");
  }
  return phone;
}

export async function promptForMacSettingsSmsProviderField({ field, secret }) {
  if (input.isTTY !== true || output.isTTY !== true) return null;
  const label = field === "phone" ? "Trusted phone number" : "Private SMS provider HTTPS URL";
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    // This runtime-only prompt never writes the value to shell history or project files.
    return await rl.question(`[SMS] ${label}: `);
  } finally {
    rl.close();
  }
}

export async function resolveMacSettingsSmsProviderConfig(options = {}) {
  const env = options.env ?? process.env;
  const phone = fixedString(env.APPLE_AUTOMATION_SMS_PHONE);
  const apiUrl = fixedString(env.APPLE_AUTOMATION_SMS_API_URL);
  if (Boolean(phone) !== Boolean(apiUrl)) throw failure("MAC_SETTINGS_SMS_PROVIDER_CONFIG_INCOMPLETE");
  if (phone && apiUrl) return { phoneNumber: validateSmsProviderPhone(phone), apiUrl: validateSmsProviderUrl(apiUrl).toString() };
  const prompt = options.prompt ?? promptForMacSettingsSmsProviderField;
  const promptedPhone = await prompt({ field: "phone", secret: false });
  const promptedUrl = await prompt({ field: "apiUrl", secret: true });
  return { phoneNumber: validateSmsProviderPhone(promptedPhone), apiUrl: validateSmsProviderUrl(promptedUrl).toString() };
}

function flattenStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => flattenStrings(item, result));
  return result;
}

function messageSuffixes(text) {
  const result = new Set();
  for (const match of text.matchAll(/(?:to|尾号|末尾|ending|\*{2,})[^\d]{0,12}(\d{2})(?!\d)/gi)) result.add(match[1]);
  return result;
}

export function extractSmsVerificationCode(body, suffix) {
  const text = typeof body === "string" ? body : "";
  const strings = (() => {
    try { return flattenStrings(JSON.parse(text)); } catch { return [text]; }
  })();
  for (const item of strings) {
    const suffixes = messageSuffixes(item);
    if (suffixes.size !== 1 || !suffixes.has(suffix)) continue;
    const codes = [...item.matchAll(SIX_DIGIT_CODE_RE)].map((match) => match[1]);
    if (codes.length === 1) return codes[0];
  }
  return null;
}

async function readBoundedBody(response, signal) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null;
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (signal?.aborted) return null;
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } finally {
    reader.releaseLock?.();
  }
}

export function createSmsProviderCodePoller(config, options = {}) {
  const providerUrl = validateSmsProviderUrl(config?.apiUrl).toString();
  const suffix = validateSmsProviderPhone(config?.phoneNumber).replace(/\D/g, "").slice(-2);
  const request = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(250, Math.trunc(options.pollIntervalMs ?? 3_000));
  if (typeof request !== "function") throw failure("MAC_SETTINGS_SMS_PROVIDER_UNAVAILABLE");
  return async ({ signal, timeoutMs }) => {
    const deadline = now() + timeoutMs;
    while (!signal?.aborted && now() < deadline) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const remainingMs = Math.max(1, deadline - now());
        const timer = setTimeout(() => controller.abort(), Math.min(15_000, remainingMs));
        let response;
        try {
          response = await request(providerUrl, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json, text/plain, text/html" } });
          if (response?.ok) {
            const code = extractSmsVerificationCode(await readBoundedBody(response, controller.signal), suffix);
            if (code) return code;
          }
        } finally { clearTimeout(timer); }
      } catch {
        // Provider availability details and secret URL are intentionally not exposed.
      } finally { signal?.removeEventListener("abort", onAbort); }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await pause(Math.min(pollIntervalMs, remainingMs));
    }
    return null;
  };
}
