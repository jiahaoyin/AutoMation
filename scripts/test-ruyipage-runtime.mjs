import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildVerifiedPipEnvironment,
  buildRuyiPagePipInstallArgs,
  createMacOSSystemCABundle,
  detectRuyiPageRuntime,
  getLocalRuyiPagePython,
  installRuyiPage,
  isMacOSTrustedSystemCACertificate,
  isPipTLSCertificateFailure,
  isPipTruststoreSupported,
  isSupportedPythonVersion,
  RUYIPAGE_COMMAND_MAX_BUFFER_BYTES,
  RUYIPAGE_PACKAGE_SPEC,
  resolveBasePythonCommand,
  resolvePythonCommand,
} from "./lib/ruyipage-runtime.js";

assert.equal(RUYIPAGE_PACKAGE_SPEC, "ruyiPage==1.2.45");
assert.equal(RUYIPAGE_COMMAND_MAX_BUFFER_BYTES, 32 * 1024 * 1024);
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
assert.equal(
  isPipTLSCertificateFailure(
    "SSLCertVerificationError: CERTIFICATE_VERIFY_FAILED unable to get local issuer certificate"
  ),
  true
);
assert.equal(
  isPipTLSCertificateFailure("No matching distribution found"),
  false
);
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
assert.equal(
  isMacOSTrustedSystemCACertificate("invalid", {
    parseCertificate() {
      throw new Error("invalid certificate");
    },
  }),
  false
);
assert.equal(
  isMacOSTrustedSystemCACertificate("leaf", {
    parseCertificate: () => ({ ca: false, subject: "leaf", issuer: "root" }),
  }),
  false
);
assert.equal(
  isMacOSTrustedSystemCACertificate("intermediate", {
    parseCertificate: () => ({ ca: true, subject: "intermediate", issuer: "root" }),
  }),
  false
);
let trustVerificationCall = null;
let trustVerificationPath = null;
assert.equal(
  isMacOSTrustedSystemCACertificate("trusted-root", {
    parseCertificate: () => ({ ca: true, subject: "root", issuer: "root" }),
    runCommand(command, args, options) {
      trustVerificationPath = args[args.indexOf("-c") + 1];
      assert.notEqual(trustVerificationPath, "/dev/stdin");
      assert.equal(fs.readFileSync(trustVerificationPath, "ascii"), "trusted-root\n");
      trustVerificationCall = {
        command,
        args: args.map((value) =>
          value === trustVerificationPath ? "<candidate-ca>" : value
        ),
        options,
      };
      return { status: 0, stdout: "", stderr: "" };
    },
  }),
  true
);
assert.deepEqual(trustVerificationCall, {
  command: "/usr/bin/security",
  args: [
    "verify-cert",
    "-c",
    "<candidate-ca>",
    "-p",
    "basic",
    "-l",
    "-L",
  ],
  options: { stdio: "pipe" },
});
assert.equal(fs.existsSync(trustVerificationPath), false);
assert.equal(fs.existsSync(path.dirname(trustVerificationPath)), false);
assert.equal(
  isMacOSTrustedSystemCACertificate("denied-root", {
    parseCertificate: () => ({ ca: true, subject: "root", issuer: "root" }),
    runCommand: () => ({ status: 1, stdout: "", stderr: "certificate denied" }),
  }),
  false
);
if (process.platform === "darwin") {
  const exportedRoots = spawnSync(
    "/usr/bin/security",
    [
      "find-certificate",
      "-a",
      "-p",
      "/System/Library/Keychains/SystemRootCertificates.keychain",
    ],
    {
      encoding: "utf8",
      maxBuffer: RUYIPAGE_COMMAND_MAX_BUFFER_BYTES,
    }
  );
  assert.equal(
    exportedRoots.status,
    0,
    exportedRoots.stderr || exportedRoots.error?.message
  );
  const currentTime = Date.now();
  const trustedRoot = (
    exportedRoots.stdout.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    ) ?? []
  ).find((candidate) => {
    try {
      const parsed = new X509Certificate(candidate);
      return (
        parsed.ca === true &&
        parsed.subject === parsed.issuer &&
        Date.parse(parsed.validFrom) <= currentTime &&
        currentTime <= Date.parse(parsed.validTo)
      );
    } catch {
      return false;
    }
  });
  assert.ok(trustedRoot, "macOS SystemRootCertificates must expose a current root CA");
  assert.equal(isMacOSTrustedSystemCACertificate(trustedRoot), true);
}

const caFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyipage-ca-test-"));
const caKeychains = [
  path.join(caFixtureDir, "SystemRootCertificates.keychain"),
  path.join(caFixtureDir, "System.keychain"),
];
for (const keychain of caKeychains) fs.writeFileSync(keychain, "");
const caBundle = createMacOSSystemCABundle({
  keychains: caKeychains,
  tmpDir: caFixtureDir,
  isTrustedSystemCA: () => true,
  runCommand(_command, args) {
    const label = args.at(-1).includes("SystemRoot") ? "Uk9PVA==" : "U1lTVEVN";
    return {
      status: 0,
      stdout: `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`,
      stderr: "",
    };
  },
});
assert.match(fs.readFileSync(caBundle.path, "ascii"), /Uk9PVA==/);
assert.match(fs.readFileSync(caBundle.path, "ascii"), /U1lTVEVN/);
caBundle.cleanup();
assert.equal(fs.existsSync(caBundle.path), false);

const filteredCABundle = createMacOSSystemCABundle({
  keychains: [caKeychains[1]],
  tmpDir: caFixtureDir,
  isTrustedSystemCA: (certificate) => certificate.includes("VFJVU1RFRA=="),
  runCommand() {
    return {
      status: 0,
      stdout:
        "-----BEGIN CERTIFICATE-----\nVFJVU1RFRA==\n-----END CERTIFICATE-----\n" +
        "-----BEGIN CERTIFICATE-----\nVU5UUlVTVEVE\n-----END CERTIFICATE-----\n",
      stderr: "",
    };
  },
});
const filteredCAContents = fs.readFileSync(filteredCABundle.path, "ascii");
assert.match(filteredCAContents, /VFJVU1RFRA==/);
assert.doesNotMatch(filteredCAContents, /VU5UUlVTVEVE/);
filteredCABundle.cleanup();

const partialCABundle = createMacOSSystemCABundle({
  keychains: caKeychains,
  tmpDir: caFixtureDir,
  isTrustedSystemCA: () => true,
  runCommand(_command, args) {
    if (args.at(-1).includes("SystemRoot")) {
      return {
        status: 0,
        stdout: "-----BEGIN CERTIFICATE-----\nUk9PVA==\n-----END CERTIFICATE-----\n",
        stderr: "",
      };
    }
    return {
      status: 44,
      stdout: "",
      stderr: "The specified item could not be found in the keychain.",
    };
  },
});
assert.match(fs.readFileSync(partialCABundle.path, "ascii"), /Uk9PVA==/);
partialCABundle.cleanup();

let retryCleanupAttempts = 0;
const retryCleanupCABundle = createMacOSSystemCABundle({
  keychains: [caKeychains[0]],
  tmpDir: caFixtureDir,
  isTrustedSystemCA: () => true,
  runCommand() {
    return {
      status: 0,
      stdout: "-----BEGIN CERTIFICATE-----\nUk9PVA==\n-----END CERTIFICATE-----\n",
      stderr: "",
    };
  },
  unlinkSync(target) {
    retryCleanupAttempts += 1;
    if (retryCleanupAttempts === 1) {
      const error = new Error("injected unlink failure");
      error.code = "EACCES";
      throw error;
    }
    fs.unlinkSync(target);
  },
});
assert.equal(retryCleanupCABundle.cleanup(), false);
assert.equal(fs.existsSync(retryCleanupCABundle.path), true);
assert.equal(retryCleanupCABundle.cleanup(), true);
assert.equal(fs.existsSync(retryCleanupCABundle.path), false);

const entriesBeforePartialWrite = fs.readdirSync(caFixtureDir).sort();
assert.throws(
  () =>
    createMacOSSystemCABundle({
      keychains: [caKeychains[0]],
      tmpDir: caFixtureDir,
      isTrustedSystemCA: () => true,
      runCommand() {
        return {
          status: 0,
          stdout: "-----BEGIN CERTIFICATE-----\nUk9PVA==\n-----END CERTIFICATE-----\n",
          stderr: "",
        };
      },
      writeFileSync(target, data, options) {
        fs.writeFileSync(target, data.slice(0, 20), options);
        throw new Error("injected partial CA write failure");
      },
    }),
  /injected partial CA write failure/
);
assert.deepEqual(fs.readdirSync(caFixtureDir).sort(), entriesBeforePartialWrite);
assert.throws(
  () =>
    createMacOSSystemCABundle({
      keychains: caKeychains,
      tmpDir: caFixtureDir,
      runCommand() {
        return {
          status: 44,
          stdout: "",
          stderr: "The specified item could not be found in the keychain.",
        };
      },
    }),
  /ruyipage-install:macos_ca_export/
);
for (const keychain of caKeychains) fs.unlinkSync(keychain);
fs.rmdirSync(caFixtureDir);
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
let managedCABundleCleanupCount = 0;
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
  createMacCABundle() {
    return {
      path: "/trusted/macos-system-ca.pem",
      cleanup() {
        managedCABundleCleanupCount += 1;
      },
    };
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
assert.equal(managedCABundleCleanupCount, 1);
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
  assert.deepEqual(options.env, {
    ...verifiedPipEnvironment,
    PIP_CERT: "/trusted/macos-system-ca.pem",
    SSL_CERT_FILE: "/trusted/macos-system-ca.pem",
  });
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
  createMacCABundle() {
    return {
      path: "/trusted/macos-system-ca.pem",
      cleanup() {},
    };
  },
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

let failedCABundleCleanupCount = 0;
assert.throws(
  () =>
    installRuyiPage({
      quiet: true,
      env: {},
      platform: "darwin",
      root: path.resolve("tmp", "ruyipage-runtime-tls-failure"),
      commandWorks: () => true,
      createMacCABundle() {
        return {
          path: "/trusted/macos-system-ca.pem",
          cleanup() {
            failedCABundleCleanupCount += 1;
            throw new Error("injected cleanup failure");
          },
        };
      },
      runCommand(_command, args) {
        if (args.at(-1) === "--version") {
          return { status: 0, stdout: "pip 24.2 from /trusted/pip\n", stderr: "" };
        }
        return {
          status: 1,
          stdout: "",
          stderr:
            "SSLCertVerificationError: CERTIFICATE_VERIFY_FAILED unable to get local issuer certificate",
        };
      },
    }),
  /ruyipage-install:tls_certificate/
);
assert.equal(failedCABundleCleanupCount, 1);

const cleanupFailureInstall = installRuyiPage({
  quiet: true,
  env: {},
  platform: "darwin",
  root: path.resolve("tmp", "ruyipage-runtime-cleanup-failure"),
  commandWorks: () => true,
  createMacCABundle() {
    return {
      path: "/trusted/macos-system-ca.pem",
      cleanup() {
        throw new Error("injected cleanup failure");
      },
    };
  },
  runCommand(_command, args) {
    return {
      status: 0,
      stdout: args.at(-1) === "--version" ? "pip 24.2 from /trusted/pip\n" : "",
      stderr: "",
    };
  },
});
assert.equal(
  cleanupFailureInstall.python,
  getLocalRuyiPagePython(
    path.resolve("tmp", "ruyipage-runtime-cleanup-failure"),
    "darwin"
  )
);

let probeFailureCleanupCount = 0;
assert.throws(
  () =>
    installRuyiPage({
      quiet: true,
      env: {},
      platform: "darwin",
      root: path.resolve("tmp", "ruyipage-runtime-pip-probe-failure"),
      commandWorks: () => true,
      createMacCABundle() {
        return {
          path: "/trusted/macos-system-ca.pem",
          cleanup() {
            probeFailureCleanupCount += 1;
          },
        };
      },
      runCommand() {
        throw new Error("injected pip version probe failure");
      },
    }),
  /injected pip version probe failure/
);
assert.equal(probeFailureCleanupCount, 1);

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
