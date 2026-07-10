import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
assert.doesNotMatch(
  rootInstall.slice(0, rootInstall.indexOf("bootstrap_macos_install_runtime")),
  /\bnode\b/
);
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

assert.match(bootstrap, /\/usr\/bin\/sudo -v/);
assert.match(bootstrap, /readonly LOCAL_PYTHON_VERSION="3\.12\.10"/);
assert.match(
  bootstrap,
  /readonly PYTHON_BOOTSTRAP_PKG_URL="https:\/\/www\.python\.org\/ftp\/python\/\$\{LOCAL_PYTHON_VERSION\}\/python-\$\{LOCAL_PYTHON_VERSION\}-macos11\.pkg"/
);
assert.match(
  bootstrap,
  /8373e58da4ea146b3eb1c1f9834f19a319440b6b679b06050b1f9ee3237aa8e4/
);
assert.match(
  bootstrap,
  /Developer ID Installer: Python Software Foundation \(BMM5U3QVKW\)/
);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/sbin\/pkgutil --check-signature/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/sbin\/installer -pkg/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/mktemp -d/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/install/);
assert.match(bootstrap, /\/usr\/bin\/curl/);
assert.match(bootstrap, /\/usr\/bin\/shasum/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/true/);
assert.match(bootstrap, /SUDO_KEEPALIVE_PID/);
assert.match(bootstrap, /\/usr\/bin\/sudo -k/);
assert.match(bootstrap, /major > 3 \|\| \(major == 3 && minor >= 10\)/);
assert.match(bootstrap, /export PYTHON_BOOTSTRAP_EXECUTABLE="\$python_path"/);
assert.match(bootstrap, /python_path_is_admin_trusted/);
assert.match(bootstrap, /\/usr\/bin\/realpath/);
assert.match(bootstrap, /\/usr\/bin\/stat -f/);
const resolveFunction = bootstrap.match(
  /resolve_supported_python\(\)\s*\{([\s\S]*?)\n\}/
)?.[1];
assert.ok(resolveFunction, "supported Python resolver is required");
const trustIndex = resolveFunction.indexOf("python_path_is_admin_trusted");
const versionIndex = resolveFunction.indexOf("python_version_supported");
assert.ok(
  trustIndex >= 0 && trustIndex < versionIndex,
  "candidate ownership must be checked before executing Python"
);
for (const line of bootstrap.split(/\r?\n/).filter((line) => line.includes("/usr/bin/sudo"))) {
  assert.match(
    line,
    /\/usr\/bin\/sudo (?:-v\b|-k\b|-n\b)/,
    `sudo call may prompt unexpectedly: ${line}`
  );
}

const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "/bin/bash";
assert.equal(fs.existsSync(bash), true, `bash is required: ${bash}`);

function toBashPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-bootstrap-test-"));
const oldPython = path.join(tempDir, "python-old");
const supportedPython = path.join(tempDir, "python-supported");
try {
  fs.writeFileSync(oldPython, "#!/bin/bash\necho 'Python 3.9.18'\n", { mode: 0o755 });
  fs.writeFileSync(supportedPython, "#!/bin/bash\necho 'Python 3.12.10'\n", { mode: 0o755 });
  const bootstrapPath = fileURLToPath(new URL("./bootstrap-macos.sh", import.meta.url));
  const source = `source ${bashQuote(toBashPath(bootstrapPath))}`;
  const oldResult = spawnSync(
    bash,
    ["-lc", `${source}; python_version_supported ${bashQuote(toBashPath(oldPython))}`],
    { encoding: "utf-8" }
  );
  assert.notEqual(oldResult.status, 0);

  const supportedResult = spawnSync(
    bash,
    ["-lc", `${source}; python_version_supported ${bashQuote(toBashPath(supportedPython))}`],
    { encoding: "utf-8" }
  );
  assert.equal(supportedResult.status, 0, supportedResult.stderr);

  const untrustedResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; python_path_is_admin_trusted() { return 1; }; ` +
        `PYTHON_BOOTSTRAP_EXECUTABLE=${bashQuote(toBashPath(supportedPython))}; ` +
        "resolve_supported_python",
    ],
    { encoding: "utf-8" }
  );
  assert.notEqual(
    untrustedResult.status,
    0,
    "an untrusted interpreter must not execute while sudo authorization is active"
  );

  const trustedResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; python_path_is_admin_trusted() { printf '%s\\n' "$1"; }; ` +
        `PYTHON_BOOTSTRAP_EXECUTABLE=${bashQuote(toBashPath(supportedPython))}; ` +
        "resolve_supported_python",
    ],
    { encoding: "utf-8" }
  );
  assert.equal(trustedResult.status, 0, trustedResult.stderr);
  assert.equal(trustedResult.stdout.trim(), toBashPath(supportedPython));

  const ensureResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; resolve_supported_python() { printf '%s\\n' ` +
        `${bashQuote(toBashPath(supportedPython))}; }; ` +
        `ensure_python >/dev/null; printf '%s' "$PYTHON_BOOTSTRAP_EXECUTABLE"`,
    ],
    { encoding: "utf-8" }
  );
  assert.equal(ensureResult.status, 0, ensureResult.stderr);
  assert.equal(ensureResult.stdout, toBashPath(supportedPython));
} finally {
  if (fs.existsSync(oldPython)) fs.unlinkSync(oldPython);
  if (fs.existsSync(supportedPython)) fs.unlinkSync(supportedPython);
  fs.rmdirSync(tempDir);
}

console.log("python bootstrap contract: ok");
