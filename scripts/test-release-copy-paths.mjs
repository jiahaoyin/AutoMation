import { strict as assert } from "node:assert";
import fs from "node:fs";

import {
  collectRuntimeImports,
  COPY_PATHS,
  renderInstallSh,
  renderRunSh,
} from "./build-release.mjs";

for (const rel of [
  "scripts/lib/browser-backend.js",
  "scripts/lib/firefox-runtime.js",
  "scripts/lib/ruyipage-runtime.js",
  "scripts/lib/ruyipage-backend-runner.js",
  "scripts/ruyipage/apple_account_flow.py",
  "scripts/lib/2fa-audit.js",
  "scripts/lib/mac-2fa-allow.js",
  "scripts/lib/mac-2fa-ocr.js",
  "scripts/lib/mac-2fa-popup.js",
  "scripts/apple-2fa-phase.applescript",
  "scripts/swift/mac-2fa-click-allow.swift",
  "scripts/swift/mac-2fa-popup-read.swift",
  "scripts/swift/mac-2fa-popup-ocr.swift",
  "scripts/2fa-automation-check.applescript",
  "scripts/preflight-2fa-permissions.mjs",
]) {
  assert.ok(COPY_PATHS.includes(rel), `${rel} missing from COPY_PATHS`);
}

for (const rel of [
  "scripts/browser-fill-debug.mjs",
  "scripts/lib/bidi-client.js",
  "scripts/lib/human-input-bidi.js",
  "scripts/lib/anti-automation.js",
  "scripts/lib/browser-input.js",
  "scripts/lib/browser-session.js",
]) {
  assert.equal(COPY_PATHS.includes(rel), false, `${rel} must not ship in the ruyipage-only release`);
  assert.equal(fs.existsSync(new URL(`../${rel}`, import.meta.url)), false, `${rel} must be deleted`);
}

for (const rel of COPY_PATHS) {
  assert.equal(fs.existsSync(new URL(`../${rel}`, import.meta.url)), true, `${rel} does not exist`);
}

const imports = collectRuntimeImports(["scripts/lib/account-browser-flow.js"]);
assert.ok(imports.has("scripts/lib/env-setup.js"));
assert.ok(imports.has("scripts/lib/ruyipage-backend-runner.js"));
assert.ok(imports.has("scripts/lib/browser-backend.js"));
assert.ok(imports.has("scripts/lib/firefox-runtime.js"));
for (const rel of [
  "scripts/lib/bidi-client.js",
  "scripts/lib/human-input-bidi.js",
  "scripts/lib/anti-automation.js",
  "scripts/lib/browser-input.js",
  "scripts/lib/browser-session.js",
]) {
  assert.equal(imports.has(rel), false, `${rel} must not be imported by the browser flow`);
}

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
assert.equal(pkg.scripts["browser:debug"], undefined);
assert.equal(pkg.scripts["browser:test-session"], undefined);
assert.match(pkg.scripts["test:ruyipage-flow"], /test-ruyipage-flow\.mjs/);

const releaseImports = collectRuntimeImports([
  "scripts/apple-id-full-flow.mjs",
  "scripts/setup-environment.mjs",
  "scripts/check-environment.mjs",
]);
for (const rel of releaseImports) {
  assert.ok(COPY_PATHS.includes(rel), `${rel} is imported at runtime but missing from COPY_PATHS`);
}

const generatedInstallSh = renderInstallSh("test-version");
for (const helper of [
  "mac-settings-ax-fill",
  "mac-settings-2fa-code",
  "mac-2fa-popup-read",
  "mac-2fa-popup-ocr",
  "mac-2fa-click-allow",
]) {
  assert.match(
    generatedInstallSh,
    new RegExp(`swiftc[\\s\\S]*scripts/bin/${helper}[\\s\\S]*scripts/swift/${helper}\\.swift`),
    `${helper} must be compiled by the release install script`
  );
}
assert.match(generatedInstallSh, /command -v cliclick/);
assert.match(generatedInstallSh, /setup-environment\.mjs --install-ruyipage/);
const generatedRunSh = renderRunSh();
assert.match(generatedRunSh, /--skip-browser/);
assert.match(generatedRunSh, /--skip-firefox --skip-ruyipage/);
assert.match(generatedRunSh, /preflight-2fa-permissions\.mjs --quiet/);
assert.match(
  generatedRunSh,
  /if \[\[ "\$\{skip_browser\}" != "1" \]\]; then[\s\S]*preflight-2fa-permissions\.mjs --quiet[\s\S]*fi/,
  "release run.sh must skip browser-only permission checks for --skip-browser"
);

const rootRunSh = fs.readFileSync(new URL("../run.sh", import.meta.url), "utf-8");
assert.match(rootRunSh, /--skip-browser/);
assert.match(rootRunSh, /--skip-firefox --skip-ruyipage/);
assert.match(
  rootRunSh,
  /if \[\[ "\$\{skip_browser\}" != "1" \]\]; then[\s\S]*preflight-2fa-permissions\.mjs --quiet[\s\S]*fi/
);

const setupEnvironment = fs.readFileSync(
  new URL("./setup-environment.mjs", import.meta.url),
  "utf-8"
);
assert.match(setupEnvironment, /process\.argv\.includes\("--skip-ruyipage"\)/);
assert.match(
  fs.readFileSync(new URL("../.env.example", import.meta.url), "utf-8"),
  /RUYIPAGE_BACKEND_TIMEOUT_MS=720000/
);
assert.match(
  fs.readFileSync(new URL("../README.md", import.meta.url), "utf-8"),
  /RUYIPAGE_BACKEND_TIMEOUT_MS=720000/
);
assert.match(
  fs.readFileSync(new URL("../docs\/PROJECT.md", import.meta.url), "utf-8"),
  /RUYIPAGE_BACKEND_TIMEOUT_MS=720000/
);
assert.match(
  setupEnvironment,
  /checkEnvironment\(\{[\s\S]*skipFirefox,[\s\S]*skipRuyiPage,[\s\S]*skip2FAAutomation:/,
  "setup environment must suppress browser-only checks when the browser phase is skipped"
);

const environmentSetup = fs.readFileSync(
  new URL("./lib/env-setup.js", import.meta.url),
  "utf-8"
);
assert.match(environmentSetup, /if \(!options\.skipFirefox && !firefoxInstalled\(\)\)/);
assert.match(environmentSetup, /if \(!options\.skipRuyiPage\)/);
assert.match(environmentSetup, /if \(!options\.skip2FAAutomation && !twoFaAutomation\.granted\)/);

const browserOrchestrator = fs.readFileSync(
  new URL("./lib/account-browser-flow.js", import.meta.url),
  "utf-8"
);
assert.doesNotMatch(
  browserOrchestrator,
  /WebSocket|remote-debugging|document\.|launchFirefox|BidiClient|webdriver/i,
  "Node browser orchestration must not control or inspect pages"
);

console.log("release copy paths: ok");
