import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_CHARS = 128 * 1024;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_OBJECT_DEPTH = 6;
const MAX_ERROR_CAUSES = 4;
const MAX_AGGREGATE_ERRORS = 8;
const SAFE_TOKEN_RE = /^[a-z0-9_.-]+$/;
const SENSITIVE_FIELDS = new Set([
  "appleid",
  "authorization",
  "axdump",
  "axtext",
  "code",
  "cookie",
  "cookies",
  "email",
  "html",
  "image",
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
  "token",
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
  text = text.replace(/\b\d{3}[\s-]+\d{3}\b/g, "[REDACTED_OTP]");
  text = text.replace(/\b\d{6}\b/g, "[REDACTED_OTP]");
  return truncateText(text);
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
  if (typeof value === "string") return redactFlowAuditText(value, secrets);
  if (typeof value !== "object" && typeof value !== "function") {
    return redactFlowAuditText(String(value), secrets);
  }
  if (value instanceof Error) {
    return serializeFlowAuditError(value, secrets, 0, seen);
  }
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= MAX_OBJECT_DEPTH) return "[MAX_DEPTH]";
  seen.add(value);

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const byteLength = Number(value.byteLength ?? value.length ?? 0);
    return {
      type: value.constructor?.name ?? "Binary",
      byteLength: Number.isFinite(byteLength) ? byteLength : 0,
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "ArrayBuffer", byteLength: value.byteLength };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Map || value instanceof Set) {
    return { type: value.constructor.name, size: value.size };
  }
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index += 1) {
      const item = readDataProperty(value, String(index));
      result.push(sanitizeValue(item, secrets, depth + 1, seen));
    }
    if (value.length > MAX_ARRAY_ITEMS) result.push("[TRUNCATED_ITEMS]");
    return result;
  }

  const result = {};
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "[UNREADABLE_OBJECT]";
  }
  const entries = Object.entries(descriptors).slice(0, MAX_OBJECT_KEYS);
  for (const [key, descriptor] of entries) {
    const safeKey = redactFlowAuditText(key, secrets);
    if (isSensitiveField(key)) {
      result[safeKey] = "[REDACTED_FIELD]";
    } else if (Object.hasOwn(descriptor, "value")) {
      result[safeKey] = sanitizeValue(
        descriptor.value,
        secrets,
        depth + 1,
        seen
      );
    } else {
      result[safeKey] = "[ACCESSOR_OMITTED]";
    }
  }
  if (Object.keys(descriptors).length > MAX_OBJECT_KEYS) {
    result.__truncatedKeys = true;
  }
  return result;
}

export function serializeFlowAuditError(
  error,
  secrets = [],
  depth = 0,
  seen = new WeakSet()
) {
  if (depth >= MAX_ERROR_CAUSES) {
    return { name: "Error", message: "[MAX_CAUSE_DEPTH]" };
  }
  const normalized =
    error && (typeof error === "object" || typeof error === "function")
      ? error
      : new Error(String(error));
  if (seen.has(normalized)) {
    return { name: "Error", message: "[CIRCULAR_CAUSE]" };
  }
  seen.add(normalized);
  const message = safeErrorProperty(normalized, "message", undefined);
  let fallbackMessage = "Error";
  if (message === undefined) {
    try {
      fallbackMessage = Object.prototype.toString.call(normalized);
    } catch {
      fallbackMessage = "Error";
    }
  }

  const result = {
    name: redactFlowAuditText(
      safeErrorProperty(normalized, "name", "Error"),
      secrets
    ),
    message: redactFlowAuditText(
      message === undefined ? fallbackMessage : message,
      secrets
    ),
  };
  const code = safeErrorProperty(normalized, "code", undefined);
  if (typeof code === "string" || typeof code === "number") {
    result.errorCode = redactFlowAuditText(code, secrets);
  }
  const stack = safeErrorProperty(normalized, "stack", undefined);
  if (typeof stack === "string") {
    result.stack = redactFlowAuditText(stack, secrets);
  }
  const cause = safeErrorProperty(normalized, "cause", undefined);
  if (cause !== undefined) {
    result.cause = serializeFlowAuditError(cause, secrets, depth + 1, seen);
  }
  const aggregateErrors = readDataProperty(normalized, "errors");
  if (Array.isArray(aggregateErrors)) {
    result.errors = aggregateErrors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .map((item) => serializeFlowAuditError(item, secrets, depth + 1, seen));
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
