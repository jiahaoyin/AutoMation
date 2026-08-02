import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SIX_DIGIT_CODE_RE = /(?<!\d)(\d{6})(?!\d)/g;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PROVIDER_REDIRECTS = 3;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SMS_PROVIDER_HEADERS = Object.freeze({
  accept: "application/json, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
});
const FIXED_INCOMPLETE_CONFIG_NOTICE =
  "[Mac 设置][短信] 手机号码与短信服务地址必须同时填写，请重新输入。";
const FIXED_INVALID_CONFIG_NOTICE =
  "[Mac 设置][短信] 手机号码或短信服务地址无效，请重新输入。";
const SMS_RUNTIME_SECRET_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
  "APPLE_AUTOMATION_MANUAL_SMS_CODE",
];
const SMS_RUNTIME_CONFIG_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_ENABLED",
  "APPLE_AUTOMATION_SMS_RECONFIGURE",
];

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fixedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function captureMacSettingsSmsRuntimeEnv(env = process.env) {
  const captured = {};
  for (const key of SMS_RUNTIME_CONFIG_ENV_KEYS) {
    if (typeof env[key] === "string") captured[key] = env[key];
    delete env[key];
  }
  for (const key of SMS_RUNTIME_SECRET_ENV_KEYS) {
    if (typeof env[key] === "string") captured[key] = env[key];
    delete env[key];
  }
  return captured;
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

function normalizeLixSmsProviderRequestUrl(url) {
  const code = url.searchParams.get("code");
  if (url.hostname === "lixsms.com" && url.pathname === "/" && code?.trim()) {
    url.pathname = "/message";
  }
  return url;
}

export function validateSmsProviderPhone(value) {
  const phone = fixedString(value);
  if (!/^\+?[0-9()\s.-]+$/.test(phone) || phone.replace(/\D/g, "").length < 4) {
    throw failure("MAC_SETTINGS_SMS_PHONE_INVALID");
  }
  return phone;
}

export function isMacSettingsSmsReconfigureRequested(env = process.env) {
  return fixedString(env.APPLE_AUTOMATION_SMS_RECONFIGURE) === "1";
}

async function promptForSecretLine(label) {
  if (
    input.isTTY !== true ||
    output.isTTY !== true ||
    typeof input.setRawMode !== "function"
  ) {
    return null;
  }

  return new Promise((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" && input.isPaused();
    let value = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // A detached terminal must not leave a secret prompt hanging.
      }
      if (wasPaused && typeof input.pause === "function") input.pause();
      try {
        output.write("\n");
      } catch {
        // Output closure does not change the prompt result.
      }
      resolve(result);
    };

    function onError() {
      finish(null);
    }

    function onData(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      for (const character of text) {
        if (character === "\u0003" || character === "\u001b") {
          finish(null);
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    }

    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.once("error", onError);
      input.resume();
      output.write(`[Mac 设置][短信] ${label}: `);
    } catch {
      finish(null);
    }
  });
}

export async function promptForMacSettingsSmsProviderField({ field, secret }) {
  if (input.isTTY !== true || output.isTTY !== true) return null;
  const label = field === "phone" ? "受信任手机号码" : "私有短信服务 HTTPS 地址";
  if (secret === true) return promptForSecretLine(`${label}（输入内容不会显示）`);
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    // This runtime-only prompt never writes the value to shell history or project files.
    return await rl.question(`[Mac 设置][短信] ${label}: `);
  } finally {
    rl.close();
  }
}

export async function resolveMacSettingsSmsProviderConfig(options = {}) {
  const env = options.env ?? process.env;
  const prompt = options.prompt ?? promptForMacSettingsSmsProviderField;
  const notify = options.notify ?? ((message) => console.warn(message));
  const canPrompt =
    typeof options.prompt === "function" || (input.isTTY === true && output.isTTY === true);
  const forceReconfigure = isMacSettingsSmsReconfigureRequested(env);
  let phone = fixedString(env.APPLE_AUTOMATION_SMS_PHONE);
  let apiUrl = fixedString(env.APPLE_AUTOMATION_SMS_API_URL);
  let reconfigureNoticeShown = false;

  while (true) {
    if (!forceReconfigure && phone && apiUrl) {
      try {
        return {
          phoneNumber: validateSmsProviderPhone(phone),
          apiUrl: validateSmsProviderUrl(apiUrl).toString(),
          source: "stored",
        };
      } catch {
        if (!canPrompt) throw failure("MAC_SETTINGS_SMS_PROVIDER_CONFIG_INVALID");
        notify(FIXED_INVALID_CONFIG_NOTICE);
      }
    } else if (!forceReconfigure && (phone || apiUrl)) {
      if (!canPrompt) throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
      notify(FIXED_INCOMPLETE_CONFIG_NOTICE);
    } else if (!canPrompt) {
      throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
    }

    if (forceReconfigure && !reconfigureNoticeShown) {
      notify("[Mac 设置][短信] 已请求重新配置，请输入新的手机号和短信服务地址。");
      reconfigureNoticeShown = true;
    }

    const promptedPhone = await prompt({ field: "phone", secret: false });
    const promptedUrl = await prompt({ field: "apiUrl", secret: true });
    if (promptedPhone === null || promptedUrl === null) {
      throw failure("MAC_SETTINGS_SMS_TTY_REQUIRED");
    }
    phone = fixedString(promptedPhone);
    apiUrl = fixedString(promptedUrl);
    try {
      return {
        phoneNumber: validateSmsProviderPhone(phone),
        apiUrl: validateSmsProviderUrl(apiUrl).toString(),
        source: "terminal",
      };
    } catch {
      if (!canPrompt) throw failure("MAC_SETTINGS_SMS_PROVIDER_CONFIG_INVALID");
      notify(FIXED_INVALID_CONFIG_NOTICE);
      phone = "";
      apiUrl = "";
    }
  }
}

function primitiveText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function timestampFromScalar(value) {
  const text = primitiveText(value)?.trim() ?? "";
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return text.length === 10 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampFromText(value) {
  const text = String(value ?? "");
  let newest = null;
  const candidates = [
    ...text.matchAll(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})?)?)?\b/g),
    ...text.matchAll(/\b1\d{9,12}\b/g),
  ];
  for (const match of candidates) {
    const parsed = timestampFromScalar(match[0]);
    if (parsed !== null && (newest === null || parsed > newest)) newest = parsed;
  }
  return newest;
}

function isTimestampFieldName(key) {
  return /(?:^|[_-])(?:time|timestamp|date|created|updated|received|sent|arrival|issued)(?:$|[_-])|(?:time|timestamp|date|created|updated|received|sent|arrival|issued)(?:at|time)?$/i.test(
    key
  );
}

function htmlEntityCodePoint(raw, radix) {
  const numeric = Number.parseInt(raw, radix);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return "";
  try {
    return String.fromCodePoint(numeric);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => htmlEntityCodePoint(code, 16))
    .replace(/&#(\d+);?/g, (_match, code) => htmlEntityCodePoint(code, 10))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, name) => ({
      nbsp: " ",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    })[name.toLowerCase()]);
}

function isSmsRecordHtmlAttribute(key) {
  return /^(?:value|aria-label|title|data-(?:message|sms|code|phone|mobile|number|time|timestamp|date|created(?:-at)?|updated(?:-at)?|received(?:-at)?|sent(?:-at)?))$/i.test(
    key
  );
}

function smsRecordHtmlAttributeText(tag) {
  const values = [];
  const attributes = tag.matchAll(/\b([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g);
  for (const attribute of attributes) {
    const key = attribute[1];
    if (!isSmsRecordHtmlAttribute(key)) continue;
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    if (value) values.push(`${key}: ${decodeHtmlEntities(value)}`);
  }
  return values.length > 0 ? ` ${values.join(" ")} ` : "";
}

function recordsFromHtml(value) {
  const html = String(value ?? "");
  const rows = decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "\n")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "\n")
      .replace(/<[^>]+>/g, (tag) => `${tag}${smsRecordHtmlAttributeText(tag)}`)
      .replace(/<\/?(?:tr|li|article|section|p|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<\/?(?:td|th|br|div)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\r?\n+/)
    .map((row) => row.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return rows.flatMap((row) => collectSmsMessageRecords(row));
}

function recordsFromEmbeddedJson(value) {
  const records = [];
  const html = String(value ?? "");
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/gi
  );
  for (const script of scripts) {
    try {
      records.push(...collectSmsMessageRecords(JSON.parse(decodeHtmlEntities(script[1]))));
    } catch {
      // A malformed script block is ignored; plain rendered rows remain usable.
    }
  }
  return records;
}

function providerMessageSuffixes(text) {
  const result = new Set();
  const expression =
    /(?:to|sent\s+to|ending(?:\s+in)?|suffix|phone|mobile|number|tel|\*{2}|\u53d1\u9001(?:\u77ed\u4fe1)?\u81f3|\u5c3e\u53f7|\u672b\u5c3e)[^\d]{0,20}(\d{2})(?!\d)/gi;
  for (const match of text.matchAll(expression)) result.add(match[1]);
  const fullPhoneExpression =
    /(?:phone(?:\s+number)?|mobile(?:\s+number)?|tel(?:ephone)?|cell(?:\s+number)?|\u624b\u673a(?:\u53f7)?|\u7535\u8bdd(?:\u53f7)?)[^\d]{0,20}([+\d][\d()\s.-]{1,})/gi;
  for (const match of text.matchAll(fullPhoneExpression)) {
    const digits = match[1].replace(/\D/g, "");
    if (digits.length >= 2) result.add(digits.slice(-2));
  }
  return result;
}

function isPhoneFieldName(key) {
  return /(?:phone|mobile|number|tel|\u624b\u673a|\u53f7\u7801)/i.test(key);
}

function collectSmsMessageRecords(value, inheritedTimestamp = null) {
  const scalar = primitiveText(value);
  if (scalar !== null) {
    return [{
      text: scalar,
      suffixes: providerMessageSuffixes(scalar),
      timestamp: timestampFromText(scalar) ?? inheritedTimestamp,
    }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSmsMessageRecords(item, inheritedTimestamp));
  }
  if (!value || typeof value !== "object") return [];

  const directParts = [];
  const directSuffixes = new Set();
  const nestedRecords = [];
  let timestamp = inheritedTimestamp;
  for (const [key, item] of Object.entries(value)) {
    const itemText = primitiveText(item);
    if (itemText !== null) {
      directParts.push(`${key}: ${itemText}`);
      for (const suffix of providerMessageSuffixes(itemText)) directSuffixes.add(suffix);
      if (isPhoneFieldName(key)) {
        const digits = itemText.replace(/\D/g, "");
        if (digits.length >= 2) directSuffixes.add(digits.slice(-2));
      }
      if (isTimestampFieldName(key)) {
        const parsed = timestampFromScalar(itemText) ?? timestampFromText(itemText);
        if (parsed !== null && (timestamp === null || parsed > timestamp)) timestamp = parsed;
      }
      continue;
    }
  }
  for (const item of Object.values(value)) {
    if (primitiveText(item) === null) {
      nestedRecords.push(...collectSmsMessageRecords(item, timestamp));
    }
  }
  if (directParts.length > 0) {
    const text = directParts.join("\n");
    return [{
      text,
      suffixes: directSuffixes,
      timestamp: timestampFromText(text) ?? timestamp,
    }, ...nestedRecords];
  }
  return nestedRecords;
}

export function extractSmsVerificationCode(body, suffix) {
  const text = typeof body === "string" ? body : "";
  const records = (() => {
    try {
      return collectSmsMessageRecords(JSON.parse(text));
    } catch {
      const embeddedJson = recordsFromEmbeddedJson(text);
      const renderedRows = recordsFromHtml(text);
      return embeddedJson.length > 0 || renderedRows.length > 0
        ? [...embeddedJson, ...renderedRows]
        : collectSmsMessageRecords(text);
    }
  })();
  const candidates = [];
  const otherPhoneCodes = new Set();
  for (const [index, record] of records.entries()) {
    const codes = [...new Set([...record.text.matchAll(SIX_DIGIT_CODE_RE)].map((match) => match[1]))];
    if (codes.length !== 1) continue;
    const association = record.suffixes.size === 0
      ? "unassociated"
      : record.suffixes.size === 1 && record.suffixes.has(suffix)
        ? "target"
        : "other";
    if (association === "other") {
      otherPhoneCodes.add(codes[0]);
      continue;
    }
    candidates.push({
      code: codes[0],
      association,
      timestamp: Number.isFinite(record.timestamp) ? record.timestamp : null,
      index,
    });
  }

  const targetCandidates = candidates.filter((candidate) => candidate.association === "target");
  const eligible = targetCandidates.length > 0
    ? targetCandidates
    : candidates.filter((candidate) => candidate.association === "unassociated");
  if (eligible.length === 0) return null;
  if (
    targetCandidates.length === 0 &&
    [...otherPhoneCodes].some((code) => !eligible.some((candidate) => candidate.code === code))
  ) {
    // A page with another explicitly-labelled phone record plus a bare code
    // cannot safely associate that bare code with the configured number.
    return null;
  }
  if (new Set(eligible.map((candidate) => candidate.code)).size === 1) return eligible[0].code;

  const timestamped = eligible
    .filter((candidate) => candidate.timestamp !== null)
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  if (timestamped.length === 0) return null;
  if (
    timestamped.length > 1 &&
    timestamped[0].timestamp === timestamped[1].timestamp &&
    timestamped[0].code !== timestamped[1].code
  ) {
    return null;
  }
  return timestamped[0].code;
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

function splitSetCookieHeader(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  // `Expires=Wed, ...` contains a comma. Only split where the following token
  // is another cookie name rather than an attribute date fragment.
  return value.split(/,(?=[^;,=\s]+=[^;,\s]+)/g).map((item) => item.trim()).filter(Boolean);
}

function responseSetCookies(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    try {
      return headers.getSetCookie().filter((item) => typeof item === "string" && item.trim());
    } catch {
      // The standard Headers implementation on older Node releases can throw
      // for a forbidden response header. Fall through to its raw value.
    }
  }
  return splitSetCookieHeader(headers.get?.("set-cookie"));
}

function updateProviderCookieJar(cookieJar, headers) {
  for (const line of responseSetCookies(headers)) {
    const [pair, ...attributes] = line.split(";");
    const divider = pair.indexOf("=");
    if (divider <= 0) continue;
    const name = pair.slice(0, divider).trim();
    const value = pair.slice(divider + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n;]/.test(value)) continue;
    const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
    if (expired || !value) cookieJar.delete(name);
    else cookieJar.set(name, value);
  }
}

function providerRequestHeaders(origin, cookieJar) {
  const headers = {
    ...DEFAULT_SMS_PROVIDER_HEADERS,
    referer: `${origin}/`,
  };
  if (cookieJar.size > 0) {
    headers.cookie = [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  return headers;
}

function safeProviderRedirect(location, currentUrl, origin) {
  if (typeof location !== "string" || !location.trim()) return null;
  try {
    const next = new URL(location, currentUrl);
    return next.protocol === "https:" && next.origin === origin ? next : null;
  } catch {
    return null;
  }
}

function isRedirectStatus(response) {
  return response?.status === 301 || response?.status === 302 || response?.status === 303 ||
    response?.status === 307 || response?.status === 308;
}

async function requestProviderResponse({ request, state, origin, cookieJar, signal }) {
  let requestUrl = state.url;
  for (let redirectCount = 0; redirectCount <= MAX_PROVIDER_REDIRECTS; redirectCount += 1) {
    const response = await request(requestUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      keepalive: true,
      credentials: "include",
      signal,
      headers: providerRequestHeaders(origin, cookieJar),
    });
    updateProviderCookieJar(cookieJar, response?.headers);
    if (!isRedirectStatus(response)) {
      state.url = requestUrl;
      return response;
    }
    const next = safeProviderRedirect(response.headers?.get?.("location"), requestUrl, origin);
    if (!next) return null;
    requestUrl = next.toString();
    state.url = requestUrl;
  }
  return null;
}

export function createSmsProviderCodePoller(config, options = {}) {
  const providerUrl = normalizeLixSmsProviderRequestUrl(
    validateSmsProviderUrl(config?.apiUrl)
  ).toString();
  const providerOrigin = new URL(providerUrl).origin;
  const suffix = validateSmsProviderPhone(config?.phoneNumber).replace(/\D/g, "").slice(-2);
  const request = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(250, Math.trunc(options.pollIntervalMs ?? 3_000));
  const configuredRequestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.trunc(options.requestTimeoutMs)
    : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs = Math.max(1_000, Math.min(30_000, configuredRequestTimeoutMs));
  if (typeof request !== "function") throw failure("MAC_SETTINGS_SMS_PROVIDER_UNAVAILABLE");
  return async ({ signal, timeoutMs }) => {
    const deadline = now() + timeoutMs;
    const cookieJar = new Map();
    const requestState = { url: providerUrl };
    while (!signal?.aborted && now() < deadline) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const remainingMs = Math.max(1, deadline - now());
        const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remainingMs));
        try {
          const response = await requestProviderResponse({
            request,
            state: requestState,
            origin: providerOrigin,
            cookieJar,
            signal: controller.signal,
          });
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
