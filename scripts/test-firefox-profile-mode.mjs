import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveFirefoxProfileOptions,
  resolveSystemFirefoxDefaultProfile,
} from "./lib/firefox-runtime.js";

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

const persistent = resolveFirefoxProfileOptions({}, "run-001");
assert.equal(persistent.mode, "persistent");
const systemProfile = resolveSystemFirefoxDefaultProfile({});
if (systemProfile) {
  assert.equal(persistent.profileDir, systemProfile);
} else {
  assert.ok(
    persistent.profileDir.endsWith(path.join("data", "firefox-apple-automation")) ||
      persistent.profileDir.includes("Firefox")
  );
}

// Synthetic profiles.ini discovery
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ff-profile-test-"));
const profilesDir = path.join(fakeRoot, "Profiles");
const profilePath = path.join(profilesDir, "abcd1234.default-release");
fs.mkdirSync(profilePath, { recursive: true });
fs.writeFileSync(
  path.join(fakeRoot, "profiles.ini"),
  `[InstallDEADBEEF]
Default=Profiles/abcd1234.default-release
Locked=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/abcd1234.default-release
Default=1
`,
  "utf-8"
);

// Monkey-patch via env override is enough for resolveFirefoxProfileOptions;
// resolveSystemFirefoxDefaultProfile reads real OS paths, so validate explicit override.
const overridden = resolveSystemFirefoxDefaultProfile({
  FIREFOX_PROFILE_DIR: profilePath,
});
assert.equal(overridden, path.resolve(profilePath));

console.log("firefox profile mode: ok");
