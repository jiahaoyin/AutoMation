import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendBrowserAnnotation } from "./write-browser-annotation.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "apple-annotation-"));
try {
  const output = appendBrowserAnnotation({
    phase: "developer",
    selectorKind: "membership-card",
    selectorHash: "abc123",
    status: "confirmed",
  }, root);
  assert.equal(output, path.join(root, "browser-annotations.jsonl"));
  assert.equal(
    fs.readFileSync(output, "utf8"),
    '{"phase":"developer","selectorHash":"abc123","selectorKind":"membership-card","status":"confirmed"}\n'
  );
  assert.throws(() => appendBrowserAnnotation({ phase: "developer", url: "https://example.invalid" }, root));
} finally {
  const output = path.join(root, "browser-annotations.jsonl");
  if (fs.existsSync(output)) fs.unlinkSync(output);
  fs.rmdirSync(root);
}

console.log("browser annotation writer: ok");
