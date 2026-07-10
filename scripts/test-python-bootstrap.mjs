import { strict as assert } from "node:assert";
import fs from "node:fs";

import { renderInstallSh, renderRunSh } from "./build-release.mjs";

const bootstrap = fs.readFileSync(
  new URL("./bootstrap-macos.sh", import.meta.url),
  "utf-8"
);
const rootInstall = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf-8");
const rootRun = fs.readFileSync(new URL("../run.sh", import.meta.url), "utf-8");
const generatedInstall = renderInstallSh("test-version");
const generatedRun = renderRunSh();

assert.match(rootInstall, /bootstrap_macos_install_runtime/);
assert.match(generatedInstall, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(rootRun, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(generatedRun, /bootstrap_macos_install_runtime/);
assert.match(rootRun, /bootstrap_macos_runtime/);
assert.match(generatedRun, /bootstrap_macos_runtime/);

const installFunction = bootstrap.match(
  /bootstrap_macos_install_runtime\(\)\s*\{([\s\S]*?)\n\}/
)?.[1];
assert.ok(installFunction, "privileged install bootstrap function is required");
const sudoIndex = installFunction.indexOf("acquire_admin_authorization");
const pythonIndex = installFunction.indexOf("ensure_python");
const nodeIndex = installFunction.indexOf("ensure_node");
assert.ok(sudoIndex >= 0 && sudoIndex < pythonIndex);
assert.ok(pythonIndex >= 0 && pythonIndex < nodeIndex);

assert.match(bootstrap, /sudo -v/);
assert.match(bootstrap, /PYTHON_BOOTSTRAP_VERSION:-3\.12\.10/);
assert.match(
  bootstrap,
  /https:\/\/www\.python\.org\/ftp\/python\/3\.12\.10\/python-3\.12\.10-macos11\.pkg/
);
assert.match(bootstrap, /pkgutil --check-signature/);
assert.match(bootstrap, /Python Software Foundation/);
assert.match(bootstrap, /sudo installer -pkg "\$pkg" -target \//);
assert.match(bootstrap, /major > 3 \|\| \(major == 3 && minor >= 10\)/);

console.log("python bootstrap contract: ok");
