import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createSmsProviderCodePoller,
  extractSmsVerificationCode,
  validateSmsProviderUrl,
} from "./lib/mac-settings-sms-provider.js";

assert.throws(() => validateSmsProviderUrl("http://example.test/?token=x"), /MAC_SETTINGS_SMS_PROVIDER_URL_INVALID/);
assert.throws(() => validateSmsProviderUrl("https://example.test/"), /MAC_SETTINGS_SMS_PROVIDER_URL_INVALID/);
assert.throws(() => validateSmsProviderUrl("https://example.test/record#token=private"), /MAC_SETTINGS_SMS_PROVIDER_URL_INVALID/);
assert.equal(validateSmsProviderUrl("https://example.test/record?token=private").hostname, "example.test");
assert.equal(extractSmsVerificationCode("Apple code: 123456", "51"), "123456");
assert.equal(extractSmsVerificationCode(JSON.stringify(["code 111111 sent to **52", "code 123456"]), "51"), null);
assert.equal(extractSmsVerificationCode(JSON.stringify({ message: "code 654321 sent to **51" }), "51"), "654321");
assert.equal(
  extractSmsVerificationCode(
    JSON.stringify({ phone: "+8613800130051", code: "234567" }),
    "51"
  ),
  "234567"
);
assert.equal(extractSmsVerificationCode("sent to **52: code 123456", "51"), null);
assert.equal(extractSmsVerificationCode("code 123456 phone +8613800130052", "51"), null);
assert.equal(extractSmsVerificationCode("code 123456; previous code 654321", "51"), null);
assert.equal(
  extractSmsVerificationCode(
    JSON.stringify([
      { phone: "+8613800130051", message: "Apple code 222222", receivedAt: "2026-07-31T10:02:00Z" },
      { phone: "+8613800130051", message: "Apple code 111111", receivedAt: "2026-07-31T10:01:00Z" },
    ]),
    "51"
  ),
  "222222",
  "multiple JSON records must choose the newest matching message rather than list order"
);
assert.equal(
  extractSmsVerificationCode(
    `<table><tr><td>2026-07-31 10:01:00</td><td>sent to **51</td><td>Apple code 111111</td></tr><tr><td>2026-07-31 10:02:00</td><td>sent to **51</td><td>Apple code 222222</td></tr></table>`,
    "51"
  ),
  "222222",
  "rendered HTML rows must preserve each message timestamp and target suffix"
);
assert.equal(
  extractSmsVerificationCode(
    `<html><script type="application/json">[{"phone":"+8613800130051","code":"111111","timestamp":1785492060000},{"phone":"+8613800130051","code":"222222","timestamp":1785492120000}]</script><div>正在查询</div></html>`,
    "51"
  ),
  "222222",
  "front-end pages with embedded JSON state must be parsed without executing page scripts"
);
assert.equal(
  extractSmsVerificationCode(
    `<section data-received-at="2026-07-31T10:01:00Z"><span>sent to **51</span><input value="Apple code 111111"></section><section data-received-at="2026-07-31T10:02:00Z"><span>sent to **51</span><input value="Apple code 222222"></section>`,
    "51"
  ),
  "222222",
  "a front-end query input value must be treated as page data, not discarded with HTML tags"
);

function providerResponse(body, { status = 200, headers = {}, setCookies = [] } = {}) {
  const baseHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return baseHeaders.get(name);
      },
      getSetCookie() {
        return setCookies;
      },
    },
    body: new Response(body).body,
  };
}

{
  const calls = [];
  const poller = createSmsProviderCodePoller(
    {
      phoneNumber: "+8613800130051",
      apiUrl: "https://example.test/record?token=private",
    },
    {
      pollIntervalMs: 1,
      sleep: async () => {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          return providerResponse("", {
            status: 302,
            headers: { location: "/inbox" },
            setCookies: ["sms_session=ready; Path=/; HttpOnly"],
          });
        }
        if (calls.length === 2) return providerResponse("<div>正在查询短信记录</div>");
        return providerResponse(
          JSON.stringify([
            { phone: "+8613800130051", code: "111111", createdAt: "2026-07-31T10:01:00Z" },
            { phone: "+8613800130051", code: "222222", createdAt: "2026-07-31T10:02:00Z" },
          ])
        );
      },
    }
  );
  const code = await poller({ signal: new AbortController().signal, timeoutMs: 2_000 });
  assert.equal(code, "222222");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.keepalive, true);
  assert.match(calls[0].options.headers.accept, /application\/json/);
  assert.match(calls[0].options.headers.accept, /text\/html/);
  assert.match(calls[0].options.headers["accept-language"], /zh-CN/);
  assert.match(calls[0].options.headers["user-agent"], /^Mozilla\/5\.0/);
  assert.equal(calls[0].options.headers.referer, "https://example.test/");
  assert.equal(calls[1].url, "https://example.test/inbox");
  assert.match(calls[1].options.headers.cookie, /sms_session=ready/);
  assert.match(calls[2].options.headers.cookie, /sms_session=ready/);
}

{
  const calls = [];
  const poller = createSmsProviderCodePoller(
    {
      phoneNumber: "+8613800130051",
      apiUrl: "https://lixsms.com/?code=private&view=latest#fragment",
    },
    {
      pollIntervalMs: 1,
      sleep: async () => {},
      fetch: async (url) => {
        calls.push(url);
        return providerResponse("Apple code 123456 sent to **51");
      },
    }
  );
  const code = await poller({ signal: new AbortController().signal, timeoutMs: 2_000 });
  assert.equal(code, "123456");
  assert.equal(calls[0], "https://lixsms.com/message?code=private&view=latest#fragment");
}

{
  const cases = [
    ["https://lixsms.com/message?code=private", "https://lixsms.com/message?code=private"],
    ["https://lixsms.com/api?code=private", "https://lixsms.com/api?code=private"],
    ["https://example.test/?code=private", "https://example.test/?code=private"],
  ];
  for (const [apiUrl, expectedUrl] of cases) {
    const calls = [];
    const poller = createSmsProviderCodePoller(
      { phoneNumber: "+8613800130051", apiUrl },
      {
        pollIntervalMs: 1,
        sleep: async () => {},
        fetch: async (url) => {
          calls.push(url);
          return providerResponse("Apple code 123456 sent to **51");
        },
      }
    );
    const code = await poller({ signal: new AbortController().signal, timeoutMs: 2_000 });
    assert.equal(code, "123456");
    assert.equal(calls[0], expectedUrl);
  }
}

const providerSource = fs.readFileSync(new URL("./lib/mac-settings-sms-provider.js", import.meta.url), "utf8");
assert.match(providerSource, /response\.body\.getReader/);
assert.match(providerSource, /bytes > MAX_RESPONSE_BYTES/);
assert.doesNotMatch(providerSource, /await response\.text\(\)/);
assert.match(providerSource, /DEFAULT_SMS_PROVIDER_HEADERS/);
assert.match(providerSource, /updateProviderCookieJar/);
assert.match(providerSource, /safeProviderRedirect/);
assert.match(providerSource, /recordsFromEmbeddedJson/);
console.log("sms provider: ok");
