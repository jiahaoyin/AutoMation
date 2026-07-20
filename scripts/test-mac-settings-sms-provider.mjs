import assert from "node:assert/strict";
import {
  extractSmsVerificationCode,
  validateSmsProviderUrl,
} from "./lib/mac-settings-sms-provider.js";

assert.throws(() => validateSmsProviderUrl("http://example.test/?token=x"), /MAC_SETTINGS_SMS_PROVIDER_URL_INVALID/);
assert.throws(() => validateSmsProviderUrl("https://example.test/"), /MAC_SETTINGS_SMS_PROVIDER_URL_INVALID/);
assert.equal(validateSmsProviderUrl("https://example.test/record?token=private").hostname, "example.test");
assert.equal(extractSmsVerificationCode("Apple code: 123456", "51"), "123456");
assert.equal(extractSmsVerificationCode(JSON.stringify({ message: "code 654321 sent to **51" }), "51"), "654321");
assert.equal(extractSmsVerificationCode("sent to **52: code 123456", "51"), null);
console.log("sms provider: ok");
