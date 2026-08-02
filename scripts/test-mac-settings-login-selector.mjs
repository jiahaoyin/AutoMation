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
assert.match(appleScript, /on currentFrontmostLoginTarget\(/);
assert.match(appleScript, /set passwordW to my currentFrontmostLoginWindow\("password", 1, 0\)/);
assert.match(appleScript, /set emailW to my currentFrontmostLoginWindow\("email", 1, 0\)/);
assert.match(appleScript, /set loginTarget to my currentFrontmostLoginTarget\(18, 0\.25\)/);
assert.match(appleScript, /set targetW to my currentFrontmostLoginWindow\("password", 18, 0\.35\)/);
assert.match(
  appleScript,
  /wantedState is "password" then return usernameCount is less than or equal to 1 and passwordCount is 1/
);
assert.match(appleScript, /keystroke textValue/);
assert.doesNotMatch(appleScript, /set the clipboard|keystroke "v" using command down|set markers to/);
assert.doesNotMatch(appleScript, /continue repeat/);
assert.doesNotMatch(appleScript, /fillIdentifierField\(targetW|clickLoginButton\(targetW/);

assert.match(swiftSource, /enum LoginState/);
assert.match(swiftSource, /func windowMatchesLoginState\(/);
assert.match(swiftSource, /return username\.count <= 1 && password\.count == 1/);
assert.match(swiftSource, /func waitForLoginWindow\(/);
assert.match(swiftSource, /func activeSettingsApp\(/);
assert.match(swiftSource, /func activeFocusedLoginControl\(/);
assert.match(swiftSource, /if isEmail && valueMatchesRequest\(/);
assert.match(swiftSource, /func waitForExactLoginValue\(/);
assert.match(swiftSource, /if isEmail \{/);
assert.match(swiftSource, /let keyboardTargetIsCleared: Bool/);
assert.match(swiftSource, /if keyboardTargetIsCleared \{/);
assert.match(swiftSource, /postUnicodeText\(text\)/);
assert.match(swiftSource, /requireValueChange: false/);
assert.match(swiftSource, /requireValueChange: true/);
assert.match(swiftSource, /func axElementsEqual\(/);
assert.match(swiftSource, /axElementsEqual\(focusedWindow, hit\.window\)/);
assert.match(swiftSource, /func postUnicodeText\(/);
assert.match(swiftSource, /state: \.email/);
assert.match(swiftSource, /state: \.password/);
assert.match(swiftSource, /waitForLoginWindow\(appElement: appElement, state: initialState\)/);
assert.doesNotMatch(swiftSource, /NSPasteboard|postCmdV/);
assert.doesNotMatch(swiftSource, /postCmdA|postCommandKey/);

assert.doesNotMatch(wrapperSource, /await sleep\(/);
assert.match(wrapperSource, /if \(dump\.loginState === "email"\)/);
assert.match(wrapperSource, /else if \(dump\.loginState !== "password"\)/);
assert.match(wrapperSource, /runAxFill\("continue", \{ onStatus: options\.onStatus \}\)/);
assert.match(wrapperSource, /runAxFill\("password"/);
assert.match(wrapperSource, /target_unavailable_before_write/);

console.log("mac settings login selector: ok");
