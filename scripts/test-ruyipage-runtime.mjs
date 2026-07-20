import { strict as assert } from "node:assert";
import path from "node:path";

import {
  buildVerifiedPipEnvironment,
  buildRuyiPagePipInstallArgs,
  detectRuyiPageRuntime,
  getLocalRuyiPagePython,
  installRuyiPage,
  isPipTruststoreSupported,
  isSupportedPythonVersion,
  RUYIPAGE_PACKAGE_SPEC,
  resolveBasePythonCommand,
  resolvePythonCommand,
} from "./lib/ruyipage-runtime.js";

assert.equal(RUYIPAGE_PACKAGE_SPEC, "ruyiPage==1.2.45");
const macManagedPipArgs = buildRuyiPagePipInstallArgs({
  platform: "darwin",
  managedVenv: true,
  truststoreSupported: true,
});
assert.deepEqual(macManagedPipArgs, [
  "-m",
  "pip",
  "install",
  "--use-feature=truststore",
  "--upgrade",
  RUYIPAGE_PACKAGE_SPEC,
]);
const configuredMacPipArgs = buildRuyiPagePipInstallArgs({
  platform: "darwin",
  managedVenv: false,
});
const windowsPipArgs = buildRuyiPagePipInstallArgs({
  platform: "win32",
  managedVenv: true,
  truststoreSupported: true,
});
assert.deepEqual(configuredMacPipArgs, ["-m", "pip", "install", "--upgrade", RUYIPAGE_PACKAGE_SPEC]);
assert.deepEqual(windowsPipArgs, configuredMacPipArgs);
for (const args of [macManagedPipArgs, configuredMacPipArgs, windowsPipArgs]) {
  assert.equal(args.some((arg) => /trusted-host|no-verify|(?:^|-)cert(?:=|$)/i.test(arg)), false);
}
assert.equal(isPipTruststoreSupported("pip 22.1.2 from /opt/pip"), false);
assert.equal(isPipTruststoreSupported("pip 22.2 from /opt/pip"), true);
assert.equal(isPipTruststoreSupported("pip 24.2 from /opt/pip"), true);
assert.equal(isPipTruststoreSupported("unexpected"), false);
const pipEnvironment = {
  PATH: "/trusted/bin",
  KEEP_PIP_ENV: "preserved",
  PIP_NO_VERIFY_CERTS: "1",
  pip_trusted_host: "insecure.example",
  PIP_CERT: "/tmp/untrusted.pem",
  REQUESTS_CA_BUNDLE: "/tmp/untrusted.pem",
  SSL_CERT_FILE: "/tmp/untrusted.pem",
  CURL_CA_BUNDLE: "/tmp/untrusted.pem",
};
const verifiedPipEnvironment = buildVerifiedPipEnvironment(pipEnvironment);
assert.deepEqual(verifiedPipEnvironment, {
  PATH: "/trusted/bin",
  KEEP_PIP_ENV: "preserved",
});
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

assert.equal(
  resolveBasePythonCommand(
    { PYTHON_BOOTSTRAP_EXECUTABLE: "/opt/python3.12" },
    { commandWorks: (command) => command === "/opt/python3.12" }
  ),
  "/opt/python3.12"
);
assert.equal(
  resolveBasePythonCommand(
    { PYTHON_BOOTSTRAP_EXECUTABLE: "/missing/python" },
    { commandWorks: () => false }
  ),
  null
);
assert.equal(
  resolveBasePythonCommand(
    {},
    { commandWorks: (command) => command === "python" }
  ),
  "python"
);

const installRoot = path.resolve("tmp", "ruyipage-runtime-install");
const managedPython = getLocalRuyiPagePython(installRoot, "darwin");
const managedVenvDir = path.dirname(path.dirname(managedPython));
const managedCalls = [];
let createdVenvParent = null;
const managedInstall = installRuyiPage({
  quiet: true,
  env: {},
  pipEnvironment,
  platform: "darwin",
  root: installRoot,
  commandWorks: (command) => command === "/trusted/python3",
  resolveBasePython: () => "/trusted/python3",
  mkdirSync(directory, options) {
    createdVenvParent = { directory, options };
  },
  runCommand(command, args, options) {
    managedCalls.push({ command, args, options });
    return {
      status: 0,
      stdout: args.at(-1) === "--version" ? "pip 24.2 from /trusted/pip\n" : "",
      stderr: "",
    };
  },
});
assert.equal(managedInstall.python, managedPython);
assert.deepEqual(createdVenvParent, {
  directory: path.dirname(managedVenvDir),
  options: { recursive: true },
});
assert.deepEqual(
  managedCalls.map(({ command, args }) => ({ command, args })),
  [
    { command: "/trusted/python3", args: ["-m", "venv", managedVenvDir] },
    { command: managedPython, args: ["-m", "pip", "--version"] },
    { command: managedPython, args: macManagedPipArgs },
  ]
);
assert.equal(managedCalls.every(({ options }) => options.stdio === "pipe"), true);
const managedPipCalls = managedCalls.filter(({ args }) => args[1] === "pip");
assert.equal(managedPipCalls.length, 2);
for (const { options } of managedPipCalls) {
  assert.deepEqual(options.env, verifiedPipEnvironment);
}

const legacyMacRoot = path.resolve("tmp", "ruyipage-runtime-install-legacy-mac");
const legacyMacPython = getLocalRuyiPagePython(legacyMacRoot, "darwin");
const legacyMacCalls = [];
installRuyiPage({
  quiet: true,
  env: {},
  platform: "darwin",
  root: legacyMacRoot,
  commandWorks: (command) => command === legacyMacPython,
  resolveBasePython: () => "/trusted/python3",
  runCommand(command, args, options) {
    legacyMacCalls.push({ command, args, options });
    return {
      status: 0,
      stdout: args.at(-1) === "--version" ? "pip 22.1.2 from /legacy/pip\n" : "",
      stderr: "",
    };
  },
});
assert.deepEqual(
  legacyMacCalls.map(({ command, args }) => ({ command, args })),
  [
    { command: legacyMacPython, args: ["-m", "pip", "--version"] },
    { command: legacyMacPython, args: configuredMacPipArgs },
  ]
);

const configuredCalls = [];
const configuredInstall = installRuyiPage({
  quiet: true,
  env: { RUYIPAGE_PYTHON: "/custom/python" },
  platform: "darwin",
  commandWorks: (command) => command === "/custom/python",
  runCommand(command, args, options) {
    configuredCalls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  },
});
assert.equal(configuredInstall.python, "/custom/python");
assert.deepEqual(
  configuredCalls.map(({ command, args }) => ({ command, args })),
  [{ command: "/custom/python", args: configuredMacPipArgs }]
);

const windowsRoot = path.resolve("tmp", "ruyipage-runtime-install-windows");
const windowsPython = getLocalRuyiPagePython(windowsRoot, "win32");
const windowsVenvDir = path.dirname(path.dirname(windowsPython));
const windowsCalls = [];
installRuyiPage({
  quiet: true,
  env: {},
  platform: "win32",
  root: windowsRoot,
  commandWorks: (command) => command === "/trusted/python3",
  resolveBasePython: () => "/trusted/python3",
  mkdirSync() {},
  runCommand(command, args, options) {
    windowsCalls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  },
});
assert.deepEqual(
  windowsCalls.map(({ command, args }) => ({ command, args })),
  [
    { command: "/trusted/python3", args: ["-m", "venv", windowsVenvDir] },
    { command: windowsPython, args: windowsPipArgs },
  ]
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
