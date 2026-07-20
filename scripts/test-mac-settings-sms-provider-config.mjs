import assert from "node:assert/strict";
import fs from "node:fs";
import { promptForMacSettingsSmsProviderField, resolveMacSettingsSmsProviderConfig } from "./lib/mac-settings-sms-provider.js";

await assert.rejects(
  () => resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051" } }),
  (error) => error?.code === "MAC_SETTINGS_SMS_PROVIDER_CONFIG_INCOMPLETE"
);
const config = await resolveMacSettingsSmsProviderConfig({ env: { APPLE_AUTOMATION_SMS_PHONE: "+8613800130051", APPLE_AUTOMATION_SMS_API_URL: "https://example.test/record?token=private" } });
assert.equal(config.phoneNumber, "+8613800130051");
const prompted = await resolveMacSettingsSmsProviderConfig({ env: {}, prompt: async ({ field }) => field === "phone" ? "+8613800130051" : "https://example.test/record?token=private" });
assert.equal(prompted.phoneNumber, "+8613800130051");
assert.equal(await promptForMacSettingsSmsProviderField({ field: "phone", secret: false }), null, "non-TTY interactive config is rejected without emitting secrets");
assert.doesNotMatch(fs.readFileSync(new URL("./lib/mac-settings-sms-ax.js", import.meta.url), "utf8"), /env\.APPLE_AUTOMATION_SMS_API_URL =/);
console.log("sms provider config: ok");
