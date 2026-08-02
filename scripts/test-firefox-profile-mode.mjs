import { strict as assert } from "node:assert";
import path from "node:path";

import { resolveFirefoxProfileOptions } from "./lib/firefox-runtime.js";

const persistent = resolveFirefoxProfileOptions({}, "run-001");
assert.equal(persistent.mode, "persistent");
assert.ok(persistent.profileDir.endsWith(path.join("data", "firefox-apple-automation")));

const explicit = resolveFirefoxProfileOptions(
  { FIREFOX_PROFILE_DIR: path.join("tmp", "profile-a") },
  "run-002"
);
assert.equal(explicit.mode, "persistent");
assert.equal(explicit.profileDir, path.resolve("tmp", "profile-a"));

const fresh = resolveFirefoxProfileOptions({ BROWSER_PROFILE_MODE: "fresh" }, "run-003");
assert.equal(fresh.mode, "fresh");
assert.ok(fresh.profileDir.includes("firefox-apple-automation-fresh"));
assert.ok(fresh.profileDir.endsWith("run-003"));

const freshBase = resolveFirefoxProfileOptions(
  {
    BROWSER_PROFILE_MODE: "fresh",
    FIREFOX_PROFILE_DIR: path.join("tmp", "profiles"),
  },
  "run-004"
);
assert.equal(freshBase.profileDir, path.resolve("tmp", "profiles", "run-004"));

console.log("firefox profile mode: ok");
