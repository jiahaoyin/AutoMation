import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1_000_000;
const MAX_LINES = 1_000;
const ALLOWED_KEYS = new Set([
  "annotationId",
  "phase",
  "stage",
  "selectorKind",
  "selectorHash",
  "targetRole",
  "noteKind",
  "status",
  "durationMs",
  "elementCount",
  "result",
]);
const SENSITIVE_KEY = /(url|href|text|html|value|cookie|token|secret|password|otp|ocr|screenshot|image|path|payload|query|account|email|name|birthday|phone|raw)/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shortString(value, key) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error(`invalid_${key}`);
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error(`invalid_${key}`);
  return value;
}

function sanitizeRecord(value) {
  if (!isPlainObject(value)) throw new Error("record_not_object");
  const output = {};
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key) || SENSITIVE_KEY.test(key)) {
      throw new Error("forbidden_annotation_field");
    }
    const raw = value[key];
    if (["annotationId", "phase", "stage", "selectorKind", "selectorHash", "targetRole", "noteKind", "status", "result"].includes(key)) {
      output[key] = shortString(raw, key);
    } else if (key === "durationMs") {
      if (!Number.isInteger(raw) || raw < 0 || raw > 600_000) throw new Error("invalid_durationMs");
      output[key] = raw;
    } else if (key === "elementCount") {
      if (!Number.isInteger(raw) || raw < 0 || raw > 100_000) throw new Error("invalid_elementCount");
      output[key] = raw;
    }
  }
  if (Object.keys(output).length === 0) throw new Error("empty_annotation");
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

export function sanitizeBrowserAnnotations(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("annotations_too_large");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length > MAX_LINES) throw new Error("too_many_annotations");
  return lines.map((line) => JSON.stringify(sanitizeRecord(JSON.parse(line)))).join("\n") + (lines.length ? "\n" : "");
}

export function sanitizeBrowserAnnotationsFile(inputPath, outputPath) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("annotation_input_not_regular");
  if (fs.existsSync(output)) {
    const outputStat = fs.lstatSync(output);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) throw new Error("annotation_output_not_regular");
  }
  const sanitized = sanitizeBrowserAnnotations(fs.readFileSync(input, "utf8"));
  fs.writeFileSync(output, sanitized, { encoding: "utf8", flag: "w" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 4) throw new Error("usage");
    sanitizeBrowserAnnotationsFile(process.argv[2], process.argv[3]);
  } catch {
    console.error("browser_annotation_sanitization_failed");
    process.exitCode = 1;
  }
}
