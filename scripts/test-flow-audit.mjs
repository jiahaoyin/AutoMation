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
const SPLIT_OTP = "1 2 3 4 5 6";
const HYPHEN_OTP = "123-456";
const LOWERCASE_SECRET = "lowercase-password-canary";
const AX = "AX_PRIVATE_CANARY";
const OCR = "OCR_PRIVATE_CANARY";
const SCREENSHOT = "SCREENSHOT_PRIVATE_CANARY";
const SCREENSHOT_PATH_WIN = "C:\\Users\\person\\Desktop\\screenshots\\99-ruyipage-failure.png";
const SCREENSHOT_PATH_MAC = "/Users/admin/Desktop/Apple-AutoMation/data/reports/screenshots/99-ruyipage-failure.png";
const PROFILE_NAME = "Profile Name Private Canary";
const BIRTHDAY = "1999-12-31";

function assertNoSecret(text) {
  for (const secret of [
    PASSWORD,
    EMAIL,
    OTP,
    SPLIT_OTP,
    HYPHEN_OTP,
    LOWERCASE_SECRET,
    "123456",
    AX,
    OCR,
    SCREENSHOT,
    "BUFFER_PRIVATE_CANARY",
    PROFILE_NAME,
    BIRTHDAY,
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
    const audit = createFlowAudit(tempDir, {
      secrets: [PASSWORD, EMAIL, LOWERCASE_SECRET],
    });
    const circular = { label: "normal" };
    circular.self = circular;
    const details = {
      safeToken: "flow_started",
      unsafeText: `raw ${PASSWORD} ${SPLIT_OTP}`,
      diagnosticMessage: `helper failed at ${SCREENSHOT_PATH_WIN} ${SCREENSHOT_PATH_MAC}`,
      diagnosticTraceback: "raw AX tree: AXWindow AXStaticText OCR text",
      helperStderr: "Vision OCR rawocr dump /tmp/apple/screenshots/capture.png",
      credentialInUnexpectedField: PASSWORD,
      lowercaseCredentialInUnexpectedField: LOWERCASE_SECRET,
      [LOWERCASE_SECRET]: "unexpected_dynamic_key",
      [`${LOWERCASE_SECRET}-two`]: "unexpected_dynamic_key_2",
      otpInUnexpectedField: "123456",
      rawDiagnostic: `${AX} ${OCR}`,
      route: "/account?token=secret",
      message: "untrusted_message",
      stack: "untrusted_stack",
      cause: "untrusted_cause",
      traceback: "untrusted_traceback",
      appleId: EMAIL,
      name: PROFILE_NAME,
      fullName: PROFILE_NAME,
      birthday: BIRTHDAY,
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
      `top ${EMAIL} ${OTP} ${SPLIT_OTP} ${HYPHEN_OTP} https://user:pw@example.invalid/path?token=secret#otp`,
      { cause: new Error(`cause ${PASSWORD}`) }
    );
    error.code = "BACKEND_FAILED";

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
    assert.equal(lines[0].details.safeToken, "flow_started");
    assert.equal(lines[0].details.unsafeText, "unknown");
    assert.equal("diagnosticMessage" in lines[0].details, false);
    assert.equal("diagnosticTraceback" in lines[0].details, false);
    assert.equal("helperStderr" in lines[0].details, false);
    assert.equal(lines[0].details.credentialInUnexpectedField, "unknown");
    assert.equal(lines[0].details.lowercaseCredentialInUnexpectedField, "unknown");
    assert.equal(LOWERCASE_SECRET in lines[0].details, false);
    assert.equal(`${LOWERCASE_SECRET}-two` in lines[0].details, false);
    assert.ok(lines[0].details.redactedKeyCount > 1);
    assert.equal(lines[0].details.otpInUnexpectedField, "unknown");
    assert.equal(lines[0].details.rawDiagnostic, "unknown");
    assert.equal(lines[0].details.route, "unknown");
    assert.equal(lines[0].details.unreadable, "[ACCESSOR_OMITTED]");
    assert.equal("message" in lines[0].details, false);
    assert.equal("name" in lines[0].details, false);
    assert.equal("fullName" in lines[0].details, false);
    assert.equal("birthday" in lines[0].details, false);
    assert.equal("stack" in lines[0].details, false);
    assert.equal("cause" in lines[0].details, false);
    assert.equal("traceback" in lines[0].details, false);
    assert.deepEqual(lines[1].details.error, {
      errorType: "aggregateerror",
      errorCode: "backend_failed",
      hasStack: true,
      hasCause: true,
      hasAggregateErrors: true,
    });
    assert.equal(lines[1].details.failureCode, "backend_failed");
    assert.equal("message" in lines[1].details.error, false);
    assert.equal("stack" in lines[1].details.error, false);
    assert.equal("cause" in lines[1].details.error, false);
    assert.equal("traceback" in lines[1].details.error, false);
    assertNoSecret(JSON.stringify(lines));
    assert.equal(JSON.stringify(lines).includes("99-ruyipage-failure.png"), false);
    assert.equal(JSON.stringify(lines).includes("AXWindow"), false);
    assert.equal(JSON.stringify(lines).includes("OCR text"), false);
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
    Object.assign(new Error(`failure ${PASSWORD} ${OTP}`), { code: "123456" }),
    [PASSWORD]
  );
  assert.deepEqual(error, {
    errorType: "error",
    errorCode: "unknown",
    hasStack: true,
    hasCause: false,
  });
}

function runSplitOtpAndRelativeQueryRedactionTest() {
  const redacted = redactFlowAuditText(
    `${SPLIT_OTP} ${HYPHEN_OTP} /account?token=secret https://example.invalid/account%3Ftoken=SECRET password=plain code:123456`
  );
  assert.equal(redacted.includes(SPLIT_OTP), false);
  assert.equal(redacted.includes(HYPHEN_OTP), false);
  assert.equal(redacted.includes("token=secret"), false);
  assert.equal(redacted.includes("token=SECRET"), false);
  assert.equal(redacted.includes("plain"), false);
  assert.equal(redacted.includes("code:123456"), false);
}

runAuditRedactionTest();
runRedactBeforeTruncateTest();
runSplitOtpAndRelativeQueryRedactionTest();

console.log("flow audit: ok");
