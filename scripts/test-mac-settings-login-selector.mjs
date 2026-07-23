import assert from "node:assert/strict";
import fs from "node:fs";

const appleScript = fs.readFileSync(
  new URL("./mac-settings-apple-login.applescript", import.meta.url),
  "utf8"
);
const swiftSource = fs.readFileSync(
  new URL("./swift/mac-settings-ax-fill.swift", import.meta.url),
  "utf8"
);
const wrapperSource = fs.readFileSync(
  new URL("./lib/mac-settings-ax-fill.js", import.meta.url),
  "utf8"
);

assert.match(appleScript, /on bfsUniqueElementWithIdentifier\(/);
assert.match(appleScript, /on targetWindowMatchesLoginState\(/);
assert.match(appleScript, /USERNAME_TEXT_FIELD", "field"/);
assert.match(appleScript, /PASSWORD_TEXT_FIELD", "field"/);
assert.match(appleScript, /LOGIN_BUTTON", "button"/);
assert.match(appleScript, /set targetW to my currentFrontmostLoginWindow\("email", 15, 0\.25\)/);
assert.match(appleScript, /set targetW to my currentFrontmostLoginWindow\("password", 18, 0\.35\)/);
assert.match(appleScript, /keystroke textValue/);
assert.doesNotMatch(appleScript, /set the clipboard|keystroke "v" using command down|set markers to/);
assert.doesNotMatch(appleScript, /continue repeat/);
assert.doesNotMatch(appleScript, /fillIdentifierField\(targetW|clickLoginButton\(targetW/);

assert.match(swiftSource, /enum LoginState/);
assert.match(swiftSource, /func windowMatchesLoginState\(/);
assert.match(swiftSource, /func waitForLoginWindow\(/);
assert.match(swiftSource, /func activeSettingsApp\(/);
assert.match(swiftSource, /func activeFocusedLoginControl\(/);
assert.match(swiftSource, /func axElementsEqual\(/);
assert.match(swiftSource, /axElementsEqual\(focusedWindow, hit\.window\)/);
assert.match(swiftSource, /func postUnicodeText\(/);
assert.match(swiftSource, /state: \.email/);
assert.match(swiftSource, /state: \.password/);
assert.match(swiftSource, /waitForLoginWindow\(appElement: appElement, state: initialState\)/);
assert.doesNotMatch(swiftSource, /NSPasteboard|postCmdV/);

assert.doesNotMatch(wrapperSource, /await sleep\(/);
assert.match(wrapperSource, /runAxFill\("continue"\)/);
assert.match(wrapperSource, /runAxFill\("password"/);

console.log("mac settings login selector: ok");
