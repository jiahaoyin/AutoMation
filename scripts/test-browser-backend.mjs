import { strict as assert } from "node:assert";

import {
  buildEnvironmentSummary,
  checkEnvironmentOk,
  selectBrowserBackend,
} from "./lib/browser-backend.js";

assert.equal(
  selectBrowserBackend({ BROWSER_BACKEND: "camoufox" }, { camoufoxAvailable: true }).backend,
  "camoufox"
);

assert.equal(
  selectBrowserBackend({ BROWSER_BACKEND: "ruyipage" }, { ruyipageAvailable: true }).backend,
  "camoufox"
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "node-bidi" }, { camoufoxAvailable: true }),
  /camoufox.*only|only.*camoufox|BROWSER_BACKEND/i
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "camoufox" }, { camoufoxAvailable: false }),
  /camoufox/i
);

const autoCamoufox = selectBrowserBackend(
  { BROWSER_BACKEND: "auto" },
  { camoufoxAvailable: true }
);
assert.equal(autoCamoufox.backend, "camoufox");
assert.match(autoCamoufox.reason, /available/i);

assert.throws(
  () =>
    selectBrowserBackend(
      {},
      { camoufoxAvailable: false, camoufoxError: "python not found" }
    ),
  /camoufox.*python not found/i
);

assert.throws(
  () => selectBrowserBackend({ BROWSER_BACKEND: "selenium" }, {}),
  /BROWSER_BACKEND/
);

const summary = buildEnvironmentSummary({
  platform: "win32",
  backend: autoCamoufox,
  runtime: {
    python: "python3",
    available: true,
    version: "0.4.11",
    error: null,
  },
  profile: {
    mode: "persistent",
    dir: "/Users/demo/Library/Application Support/Firefox/Profiles/xxx.default-release",
  },
});

assert.equal(summary.backend, "camoufox");
assert.equal(summary.platform, "win32");
assert.equal(summary.profileMode, "persistent");
assert.ok(summary.warnings.some((w) => /Windows/i.test(w)));
assert.equal(summary.camoufoxAvailable, true);

assert.equal(
  checkEnvironmentOk({
    issues: ["非 macOS", "Firefox 未安装", "camoufox package not installed"],
    platform: "win32",
    strictPlatform: false,
  }),
  true
);
assert.equal(
  checkEnvironmentOk({
    issues: ["非 macOS", "Firefox 未安装", "camoufox package not installed"],
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

console.log("test-browser-backend: ok");
