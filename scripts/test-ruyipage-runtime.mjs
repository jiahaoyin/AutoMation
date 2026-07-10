import { strict as assert } from "node:assert";
import path from "node:path";

import {
  detectRuyiPageRuntime,
  getLocalRuyiPagePython,
  isSupportedPythonVersion,
  RUYIPAGE_PACKAGE_SPEC,
  resolvePythonCommand,
} from "./lib/ruyipage-runtime.js";

assert.equal(RUYIPAGE_PACKAGE_SPEC, "ruyiPage==1.2.45");
assert.equal(isSupportedPythonVersion("Python 3.10.0"), true);
assert.equal(isSupportedPythonVersion("Python 3.13.2"), true);
assert.equal(isSupportedPythonVersion("Python 3.9.18"), false);
assert.equal(isSupportedPythonVersion("unexpected"), false);

const root = path.resolve("tmp", "project");
const darwinLocal = getLocalRuyiPagePython(root, "darwin");
assert.equal(darwinLocal, path.join(root, ".runtime", "ruyipage-venv", "bin", "python"));
assert.equal(
  getLocalRuyiPagePython(root, "win32"),
  path.join(root, ".runtime", "ruyipage-venv", "Scripts", "python.exe")
);

assert.equal(
  resolvePythonCommand({ RUYIPAGE_PYTHON: "/custom/python" }, {
    root,
    platform: "darwin",
    commandWorks: (command) => command === "/custom/python",
  }),
  "/custom/python"
);
assert.equal(
  resolvePythonCommand({ RUYIPAGE_PYTHON: "/missing/python" }, {
    root,
    platform: "darwin",
    commandWorks: () => false,
  }),
  null
);

assert.equal(
  resolvePythonCommand({}, {
    root,
    platform: "darwin",
    commandWorks: (command) => command === darwinLocal,
  }),
  darwinLocal
);

assert.equal(
  resolvePythonCommand({}, {
    root,
    platform: "darwin",
    commandWorks: (command) => command === "python3",
  }),
  "python3"
);

let probeScript = "";
const brokenImportRuntime = detectRuyiPageRuntime(
  { RUYIPAGE_PYTHON: "/custom/python" },
  {
    resolvePython: () => "/custom/python",
    runCommand(_command, args) {
      probeScript = args.at(-1);
      return {
        status: probeScript.includes("import ruyipage") ? 1 : 0,
        stdout: probeScript.includes("import ruyipage") ? "" : "9.9.9\n",
        stderr: probeScript.includes("import ruyipage")
          ? "ModuleNotFoundError: No module named 'ruyipage'"
          : "",
      };
    },
  }
);
assert.equal(brokenImportRuntime.available, false);
assert.match(probeScript, /import ruyipage/);

const wrongVersionRuntime = detectRuyiPageRuntime(
  { RUYIPAGE_PYTHON: "/custom/python" },
  {
    resolvePython: () => "/custom/python",
    runCommand() {
      return {
        status: 0,
        stdout: "1.2.44\n",
        stderr: "",
      };
    },
  }
);
assert.equal(wrongVersionRuntime.available, false);
assert.equal(wrongVersionRuntime.version, "1.2.44");
assert.match(wrongVersionRuntime.error, /requires.*1\.2\.45/i);

const verifiedVersionRuntime = detectRuyiPageRuntime(
  { RUYIPAGE_PYTHON: "/custom/python" },
  {
    resolvePython: () => "/custom/python",
    runCommand() {
      return {
        status: 0,
        stdout: "1.2.45\n",
        stderr: "",
      };
    },
  }
);
assert.equal(verifiedVersionRuntime.available, true);
assert.equal(verifiedVersionRuntime.version, "1.2.45");
assert.equal(verifiedVersionRuntime.error, null);

const invalidConfiguredRuntime = detectRuyiPageRuntime(
  { RUYIPAGE_PYTHON: "/missing/python" },
  { resolvePython: () => null }
);
assert.equal(invalidConfiguredRuntime.available, false);
assert.match(invalidConfiguredRuntime.error, /RUYIPAGE_PYTHON.*missing.*3\.10/i);

console.log("ruyipage runtime selection: ok");
