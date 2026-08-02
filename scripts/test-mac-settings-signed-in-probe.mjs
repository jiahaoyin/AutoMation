import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("./mac-settings-signed-in.applescript", import.meta.url),
  "utf8"
);

function handlerBody(name) {
  const match = source.match(new RegExp(`on\\s+${name}\\([^)]*\\)([\\s\\S]*?)end\\s+${name}`, "i"));
  assert.ok(match, `missing ${name} AppleScript handler`);
  return match[1];
}

const treeProbe = handlerBody("signedInEvidenceInTree");

assert.match(
  treeProbe,
  /repeat with\s+\w+\s+in\s+UI elements of\s+\w+[\s\S]*?my signedInEvidenceInTree\(\s*\w+\s*\)/i,
  "the signed-in probe must recursively visit descendants of each window"
);

for (const [label, pattern] of [
  ["AX name", /name of\s+\w+/i],
  ["AX description", /description of\s+\w+/i],
  ["AX value", /value of\s+\w+/i],
  ["AX identifier", /value of attribute\s+"AXIdentifier"\s+of\s+\w+/i],
]) {
  assert.match(treeProbe, pattern, `the signed-in probe must read ${label} separately`);
}

assert.match(
  treeProbe,
  /AppleIDSettings/,
  "the AppleIDSettings marker must be part of signed-in evidence, not only the deep-link URL"
);
assert.match(treeProbe, /"Sign Out"/);
assert.match(treeProbe, /"Sign out"/);
assert.match(treeProbe, /"Log Out"/);
assert.match(treeProbe, /"退出登录"/);

assert.match(
  source,
  /set\s+loginInputIdentifiers\s+to\s+\{(?=[^}]*"USERNAME_TEXT_FIELD")(?=[^}]*"PASSWORD_TEXT_FIELD")[^}]*\}/i,
  "login input identifiers must be declared as non-success evidence"
);
assert.match(
  treeProbe,
  /\w+\s+is\s+in\s+loginInputIdentifiers[\s\S]{0,160}?return false/i,
  "login input fields must be excluded before their values are considered"
);
assert.doesNotMatch(
  source,
  /contains\s+"@"\s+then\s+return\s+"yes"/i,
  "an email address in a login input must not be accepted as signed-in evidence"
);

const runBody = source.match(/on\s+run\s+argv([\s\S]*?)end\s+run/i)?.[1] ?? "";
assert.match(
  runBody,
  /repeat with\s+\w+\s+in\s+windows[\s\S]*?my signedInEvidenceInTree\(\s*\w+\s*\)/i,
  "each System Settings window must be evaluated through the recursive signed-in probe"
);

console.log("mac settings signed-in probe: ok");
