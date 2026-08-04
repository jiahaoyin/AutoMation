import assert from "node:assert/strict";
import { sanitizeBrowserAnnotations } from "./sanitize-browser-annotations.mjs";

const clean = sanitizeBrowserAnnotations(
  '\uFEFF{"phase":"developer","selectorKind":"membership-card","selectorHash":"abc123","status":"confirmed","durationMs":10,"elementCount":1}\n'
);
assert.equal(
  clean,
  '{"durationMs":10,"elementCount":1,"phase":"developer","selectorHash":"abc123","selectorKind":"membership-card","status":"confirmed"}\n'
);
assert.throws(() => sanitizeBrowserAnnotations('{"phase":"developer","url":"https://example.invalid"}'));
assert.throws(() => sanitizeBrowserAnnotations('{"phase":"developer","rawText":"private"}'));
assert.throws(() => sanitizeBrowserAnnotations('{"phase":"developer","selectorHash":""}'));
console.log("browser annotation sanitizer: ok");
