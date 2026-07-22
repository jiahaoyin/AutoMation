import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_CHARS = 128 * 1024;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_OBJECT_DEPTH = 6;
const SAFE_TOKEN_RE = /^[a-z0-9_.-]+$/;
const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,96}$/;
const SAFE_ERROR_CODE_RE = /^[a-z0-9_.-]+$/;
const SAFE_REDACTED_TEXT_FIELDS = new Set();
const SAFE_ERROR_TYPES = new Set([
  "error",
  "typeerror",
  "rangeerror",
  "syntaxerror",
  "aggregateerror",
  "aborterror",
  "unknown",
]);
const SENSITIVE_FIELDS = new Set([
  "appleid",
  "authorization",
  "axdump",
  "axtext",
  "cause",
  "code",
  "cookie",
  "cookies",
  "diagnosticmessage",
  "diagnostictraceback",
  "email",
  "helpermessage",
  "helperstderr",
  "helperstdout",
  "html",
  "image",
  "message",
  "name",
  "fullname",
  "birthday",
  "ocrtext",
  "otp",
  "pagesource",
  "password",
  "passwd",
  "rawax",
  "requestbody",
  "responsebody",
  "screenshot",
  "secret",
  "secrets",
  "setcookie",
  "stack",
  "token",
  "traceback",
  "twofactorcode",
  "verificationcode",
]);

function truncateText(value) {
  const text = String(value);
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n[TRUNCATED]`;
}

function normalizeFieldName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveField(value) {
  const normalized = normalizeFieldName(value);
  if (SENSITIVE_FIELDS.has(normalized)) return true;
  return (
    normalized.includes("accessibilitytree") ||
    normalized.includes("rawaccessibility") ||
    normalized.includes("rawax") ||
    normalized.includes("ocr") ||
    normalized.includes("rawocr") ||
    normalized.includes("screenshot")
  );
}

function redactAbsoluteUrls(text) {
  return text.replace(
    /\bhttps?:\/\/[^\s"'<>]+/gi,
    (candidate) => {
      try {
        const parsed = new URL(candidate);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        const marker = candidate.search(/[?#]/);
        return marker < 0
          ? candidate.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1")
          : `${candidate.slice(0, marker).replace(/^(https?:\/\/)[^/@\s]+@/i, "$1")}`;
      }
    }
  );
}

export function redactFlowAuditText(value, secrets = []) {
  let text = String(value);
  const normalizedSecrets = [...new Set(secrets.map(String).filter(Boolean))].sort(
    (left, right) => right.length - left.length
  );
  for (const secret of normalizedSecrets) {
    text = text.split(secret).join("[REDACTED_SECRET]");
  }
  text = redactAbsoluteUrls(text);
  text = text.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]"
  );
  text = text.replace(/\b\d(?:[\s-]+\d){5}\b/g, "[REDACTED_OTP]");
  text = text.replace(/\b\d{3}[\s-]+\d{3}\b/g, "[REDACTED_OTP]");
  text = text.replace(/\b\d{6}\b/g, "[REDACTED_OTP]");
  text = text.replace(
    /((?:https?:\/\/[^\s"'<>?#]+|\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*)\?)[^\s"'<>]*/gi,
    "$1[REDACTED_QUERY]"
  );
  text = text.replace(
    /%3[fF][^\s"'<>]*(?:token|secret|password|code)[^\s"'<>]*/gi,
    "%3F[REDACTED_QUERY]"
  );
  text = text.replace(
    /\b(?:password|passwd|secret|token|otp|code|verificationcode|twofactorcode)\s*[:=]\s*[^\s"'<>]+/gi,
    "[REDACTED_SECRET_ASSIGNMENT]"
  );
  text = text.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[REDACTED_PATH]");
  text = text.replace(
    /(?:^|[\s"'(])\/(?:Users|tmp|private|var|Volumes|home|data|Library|System|Applications|opt)\/[^\s"'<>]+/g,
    (match) => `${match[0].trim() === "" ? match[0] : ""}[REDACTED_PATH]`
  );
  text = text.replace(
    /\b[^\s"'<>]*(?:screenshot|screenshots|\.png|\.jpe?g|\.webp|\.tiff?|\.gif)[^\s"'<>]*/gi,
    "[REDACTED_SCREENSHOT]"
  );
  if (
    /\b(?:raw\s*(?:ax|ocr)|rawax|rawocr|axdump|ocrtext|accessibility\s*tree|rawaccessibility|vision\s*ocr)\b/i.test(
      text
    )
  ) {
    text = "[REDACTED_RAW_DIAGNOSTIC]";
  }
  return truncateText(text);
}

function isSensitiveAuditText(value, secrets = []) {
  const text = String(value);
  if (
    /\b\d(?:[\s-]+\d){5}\b/.test(text) ||
    /\b\d{3}[\s-]+\d{3}\b/.test(text) ||
    /\b\d{6}\b/.test(text)
  ) {
    return true;
  }
  return secrets.some((secret) => {
    const normalizedSecret = String(secret);
    return normalizedSecret && text.includes(normalizedSecret);
  });
}

function safeAuditToken(value, secrets = []) {
  if (typeof value !== "string") return "unknown";
  const token = value.trim();
  if (
    token !== token.toLowerCase() ||
    !SAFE_TOKEN_RE.test(token) ||
    token.length > 96 ||
    isSensitiveField(token) ||
    isSensitiveAuditText(token, secrets)
  ) {
    return "unknown";
  }
  return token;
}

function safeAuditKey(value, secrets = []) {
  const key = typeof value === "string" ? value : "";
  return SAFE_KEY_RE.test(key) &&
    !isSensitiveField(key) &&
    !isSensitiveAuditText(key, secrets)
    ? key
    : "unknown";
}

function safeErrorType(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAFE_ERROR_TYPES.has(type) ? type : "unknown";
}

function safeErrorCode(value, secrets = []) {
  if (typeof value !== "string" && typeof value !== "number") return "unknown";
  const rawCode = String(value).trim();
  const code = rawCode.toLowerCase();
  if (
    !SAFE_ERROR_CODE_RE.test(code) ||
    code.length > 96 ||
    isSensitiveField(code) ||
    isSensitiveAuditText(rawCode, secrets)
  ) {
    return "unknown";
  }
  return code;
}

function safeRedactedAuditText(value, secrets = []) {
  if (typeof value !== "string") return undefined;
  return redactFlowAuditText(value, secrets);
}

function readDataProperty(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorProperty(error, key, fallback) {
  const own = readDataProperty(error, key);
  if (own !== undefined) return own;
  try {
    return error?.[key] ?? fallback;
  } catch {
    return fallback;
  }
}

function sanitizeValue(value, secrets, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return safeAuditToken(value, secrets);
  if (typeof value !== "object" && typeof value !== "function") {
    return "unknown";
  }
  if (value instanceof Error) {
    return serializeFlowAuditError(value, secrets);
  }
  if (seen.has(value)) return "circular";
  if (depth >= MAX_OBJECT_DEPTH) return "max_depth";
  seen.add(value);

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const byteLength = Number(value.byteLength ?? value.length ?? 0);
    return {
      type: "binary",
      byteLength: Number.isFinite(byteLength) ? byteLength : 0,
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "arraybuffer", byteLength: value.byteLength };
  }
  if (value instanceof Date) {
    return "date";
  }
  if (value instanceof Map || value instanceof Set) {
    return { type: value instanceof Map ? "map" : "set", size: value.size };
  }
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index += 1) {
      const item = readDataProperty(value, String(index));
      result.push(sanitizeValue(item, secrets, depth + 1, seen));
    }
    if (value.length > MAX_ARRAY_ITEMS) result.push("truncated_items");
    return result;
  }

  const result = {};
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "unreadable_object";
  }
  const entries = Object.entries(descriptors).slice(0, MAX_OBJECT_KEYS);
  let redactedKeyCount = 0;
  for (const [key, descriptor] of entries) {
    let safeKey = safeAuditKey(key, secrets);
    if (safeKey === "unknown" && key !== "unknown") {
      redactedKeyCount += 1;
      safeKey = `redacted_key_${redactedKeyCount}`;
    }
    if (isSensitiveField(key)) {
      result[safeKey] = "[REDACTED_FIELD]";
    } else if (Object.hasOwn(descriptor, "value")) {
      if (SAFE_REDACTED_TEXT_FIELDS.has(normalizeFieldName(key))) {
        const textValue = safeRedactedAuditText(descriptor.value, secrets);
        result[safeKey] = textValue === undefined ? "unknown" : textValue;
      } else {
        result[safeKey] = sanitizeValue(
          descriptor.value,
          secrets,
          depth + 1,
          seen
        );
      }
    } else {
      result[safeKey] = "[ACCESSOR_OMITTED]";
    }
  }
  if (Object.keys(descriptors).length > MAX_OBJECT_KEYS) {
    result.__truncatedKeys = true;
  }
  if (redactedKeyCount > 0) result.redactedKeyCount = redactedKeyCount;
  return result;
}

export function serializeFlowAuditError(error, secrets = []) {
  const normalized =
    error && (typeof error === "object" || typeof error === "function")
      ? error
      : new Error(String(error));
  const result = {
    errorType: safeErrorType(safeErrorProperty(normalized, "name", "Error")),
    errorCode: safeErrorCode(safeErrorProperty(normalized, "code", undefined), secrets),
    hasStack: typeof safeErrorProperty(normalized, "stack", undefined) === "string",
    hasCause: safeErrorProperty(normalized, "cause", undefined) !== undefined,
  };
  const aggregateErrors = readDataProperty(normalized, "errors");
  if (Array.isArray(aggregateErrors)) {
    result.hasAggregateErrors = true;
  }
  return result;
}

function requireToken(value, label) {
  const token = String(value ?? "").trim();
  if (!SAFE_TOKEN_RE.test(token)) throw new Error(`${label} is invalid`);
  return token;
}

export function createFlowAudit(reportDir, options = {}) {
  const auditPath = path.join(path.resolve(reportDir), "flow-audit.jsonl");
  const now = options.now ?? Date.now;
  const startedAt = now();
  const secrets = new Set((options.secrets ?? []).map(String).filter(Boolean));
  const onWriteFailure =
    typeof options.onWriteFailure === "function" ? options.onWriteFailure : null;
  let sequence = 0;
  let closed = false;
  let writeFailed = false;

  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(auditPath, "ax", 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
  } catch {
    /* Windows does not expose POSIX file modes; creation still used 0600. */
  }

  const reportWriteFailure = (error) => {
    if (writeFailed) return;
    writeFailed = true;
    try {
      onWriteFailure?.(error);
    } catch {
      /* Diagnostic failure reporting must never replace the business error. */
    }
  };

  const writeLine = (line) => {
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset
      );
    }
  };

  const write = (source, event, details = {}) => {
    if (closed || writeFailed) return null;
    try {
      const timestamp = now();
      const entry = {
        version: 1,
        sequence: ++sequence,
        timestamp: new Date(timestamp).toISOString(),
        elapsedMs: Math.max(0, timestamp - startedAt),
        source: requireToken(source, "flow audit source"),
        event: requireToken(event, "flow audit event"),
        details: sanitizeValue(details, [...secrets]),
      };
      writeLine(`${JSON.stringify(entry)}\n`);
      return entry;
    } catch (error) {
      reportWriteFailure(error);
      return null;
    }
  };

  return {
    path: auditPath,
    addSecrets(values) {
      for (const value of values ?? []) {
        if (value != null && String(value)) secrets.add(String(value));
      }
    },
    write,
    writeError(source, event, error, details = {}) {
      return write(source, event, {
        ...details,
        error: serializeFlowAuditError(error, [...secrets]),
      });
    },
    close() {
      if (closed) return !writeFailed;
      closed = true;
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        reportWriteFailure(error);
      }
      return !writeFailed;
    },
  };
}
