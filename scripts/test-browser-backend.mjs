import { strict as assert } from "node:assert";

import {
  buildEnvironmentSummary,
  checkEnvironmentOk,
  selectBrowserBackend,
} from "./lib/browser-backend.js";

assert.equal(
  selectBrowserBackend({ BROWSER_BACKEND: "ruyipage" }, { ruyipageAvailable: true }).backend,
  "ruyipage"
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "node-bidi" }, { ruyipageAvailable: true }),
  /ruyipage.*only|only.*ruyipage/i
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "ruyipage" }, { ruyipageAvailable: false }),
  /ruyipage/i
);

const autoRuyi = selectBrowserBackend(
  { BROWSER_BACKEND: "auto" },
  { ruyipageAvailable: true }
);
assert.equal(autoRuyi.backend, "ruyipage");
assert.match(autoRuyi.reason, /available/i);

assert.throws(
  () => selectBrowserBackend({}, { ruyipageAvailable: false, ruyipageError: "python not found" }),
  /ruyipage.*python not found/i
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "selenium" }, {}),
  /BROWSER_BACKEND/
);

const summary = buildEnvironmentSummary({
  platform: "win32",
  backend: autoRuyi,
  runtime: {
    python: "python3",
    available: true,
    version: "1.2.3",
    error: null,
  },
  profile: {
    mode: "persistent",
    dir: "data/firefox-apple-automation",
  },
});

assert.equal(summary.backend, "ruyipage");
assert.equal(summary.platform, "win32");
assert.equal(summary.profileMode, "persistent");
assert.ok(summary.warnings.some((w) => /Windows/i.test(w)));
assert.equal(summary.ruyipageAvailable, true);

assert.equal(
  checkEnvironmentOk({
    issues: ["非 macOS", "Firefox 未安装", "ruyipage package not installed"],
    platform: "win32",
    strictPlatform: false,
  }),
  true
);
assert.equal(
  checkEnvironmentOk({
    issues: ["非 macOS", "Firefox 未安装", "ruyipage package not installed"],
    platform: "win32",
    strictPlatform: true,
  }),
  false
);
assert.equal(
  checkEnvironmentOk({
    issues: ["非 macOS", "Node 18+ 未满足"],
    platform: "win32",
    strictPlatform: false,
  }),
  false
);
assert.equal(
  checkEnvironmentOk({
    issues: ["Firefox 未安装"],
    platform: "darwin",
    strictPlatform: false,
  }),
  false
);
assert.equal(
  checkEnvironmentOk({
    issues: [
      "ruyipage is the only supported browser backend; BROWSER_BACKEND must be auto or ruyipage",
    ],
    platform: "win32",
    strictPlatform: false,
  }),
  false
);

console.log("browser-backend logic: ok");
