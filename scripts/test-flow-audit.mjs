import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createFlowAudit,
  redactFlowAuditText,
  serializeFlowAuditError,
} from "./lib/flow-audit.js";

const PASSWORD = "Synthetic-Password-Canary";
const EMAIL = "synthetic.person@example.invalid";
const OTP = "123 456";
const AX = "AX_PRIVATE_CANARY";
const OCR = "OCR_PRIVATE_CANARY";
const SCREENSHOT = "SCREENSHOT_PRIVATE_CANARY";

function assertNoSecret(text) {
  for (const secret of [
    PASSWORD,
    EMAIL,
    OTP,
    "123456",
    AX,
    OCR,
    SCREENSHOT,
    "BUFFER_PRIVATE_CANARY",
  ]) {
    assert.equal(text.includes(secret), false, `audit leaked ${secret}`);
  }
  assert.equal(text.includes("user:pw@"), false, "audit leaked URL userinfo");
  assert.equal(text.includes("?token=secret"), false, "audit leaked URL query");
  assert.equal(text.includes("#otp"), false, "audit leaked URL fragment");
}

function runAuditRedactionTest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-flow-audit-"));
  let getterReads = 0;
  try {
    const audit = createFlowAudit(tempDir, { secrets: [PASSWORD, EMAIL] });
    const circular = { label: "normal" };
    circular.self = circular;
    const details = {
      appleId: EMAIL,
      password: PASSWORD,
      code: OTP,
      rawAx: AX,
      ocrText: OCR,
      rawScreenshot: SCREENSHOT,
      screenshotPath: SCREENSHOT,
      bytes: Buffer.from("BUFFER_PRIVATE_CANARY"),
      circular,
    };
    Object.defineProperty(details, "unreadable", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("getter must not run");
      },
    });
    const error = new AggregateError(
      [new Error(`nested ${PASSWORD}`)],
      `top ${EMAIL} ${OTP} https://user:pw@example.invalid/path?token=secret#otp`,
      { cause: new Error(`cause ${PASSWORD}`) }
    );

    audit.write("flow", "started", details);
    audit.writeError("flow", "failed", error, { failureCode: "backend_failed" });
    assert.equal(audit.close(), true);
    assert.equal(getterReads, 0);

    const lines = fs
      .readFileSync(path.join(tempDir, "flow-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.sequence), [1, 2]);
    assert.equal(lines[0].details.rawAx, "[REDACTED_FIELD]");
    assert.equal(lines[0].details.ocrText, "[REDACTED_FIELD]");
    assert.equal(lines[0].details.rawScreenshot, "[REDACTED_FIELD]");
    assert.equal(lines[0].details.screenshotPath, "[REDACTED_FIELD]");
    assert.equal(lines[0].details.unreadable, "[ACCESSOR_OMITTED]");
    assert.equal(lines[1].details.error.name, "AggregateError");
    assert.equal(lines[1].details.failureCode, "backend_failed");
    assertNoSecret(JSON.stringify(lines));
  } finally {
    const auditPath = path.join(tempDir, "flow-audit.jsonl");
    if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath);
    fs.rmdirSync(tempDir);
  }
}

function runRedactBeforeTruncateTest() {
  const longText = `${"x".repeat(140 * 1024)}${PASSWORD}`;
  const redacted = redactFlowAuditText(longText, [PASSWORD]);
  assert.equal(redacted.includes(PASSWORD), false);
  assert.match(redacted, /\[TRUNCATED\]$/);

  const error = serializeFlowAuditError(
    new Error(`failure ${PASSWORD} ${OTP}`),
    [PASSWORD]
  );
  assert.equal(error.message.includes(PASSWORD), false);
  assert.equal(error.message.includes(OTP), false);
}

runAuditRedactionTest();
runRedactBeforeTruncateTest();

console.log("flow audit: ok");
