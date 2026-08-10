import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/** @deprecated historical name; package is now Camoufox */
export const RUYIPAGE_PACKAGE_SPEC = "camoufox[geoip]";
export const CAMOUFOX_PACKAGE_SPEC = "camoufox[geoip]";
/** Default browser channel: official FF152 dev/prerelease from https://github.com/daijro/camoufox */
export const CAMOUFOX_BROWSER_CHANNEL = "official/prerelease";
export const CAMOUFOX_PIP_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
export const CAMOUFOX_TRUSTED_HOSTS = Object.freeze([
  "pypi.tuna.tsinghua.edu.cn",
  "files.pythonhosted.org",
  "pypi.org",
]);

const PIP_TLS_OVERRIDE_ENV_NAMES = new Set([
  "CURL_CA_BUNDLE",
  "PIP_CERT",
  "PIP_NO_VERIFY_CERTS",
  "PIP_TRUSTED_HOST",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
]);
export const RUYIPAGE_COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MACOS_SYSTEM_ROOT_CA_KEYCHAIN =
  "/System/Library/Keychains/SystemRootCertificates.keychain";
const MACOS_ADMIN_SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
const MACOS_SYSTEM_CA_KEYCHAINS = Object.freeze([
  MACOS_SYSTEM_ROOT_CA_KEYCHAIN,
  MACOS_ADMIN_SYSTEM_KEYCHAIN,
]);
const PEM_CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Build the Camoufox pip install command.
 * On macOS managed venvs, prefer truststore; callers may also pass
 * --trusted-host + mirror as an SSL bypass fallback.
 *
 * @param {{
 *   platform?: NodeJS.Platform|string,
 *   managedVenv?: boolean,
 *   truststoreSupported?: boolean,
 *   useMirror?: boolean
 * }} [options]
 */
export function buildRuyiPagePipInstallArgs(options = {}) {
  return buildCamoufoxPipInstallArgs(options);
}

export function buildCamoufoxPipInstallArgs(options = {}) {
  const platform = options.platform ?? process.platform;
  const managedVenv = options.managedVenv ?? false;
  const truststoreSupported = options.truststoreSupported ?? false;
  const useMirror = options.useMirror ?? false;
  const args = ["-m", "pip", "install"];
  if (platform === "darwin" && managedVenv && truststoreSupported && !useMirror) {
    args.push("--use-feature=truststore");
  }
  if (useMirror) {
    args.push("-i", CAMOUFOX_PIP_MIRROR);
    for (const host of CAMOUFOX_TRUSTED_HOSTS) {
      args.push("--trusted-host", host);
    }
  }
  args.push("--upgrade", CAMOUFOX_PACKAGE_SPEC);
  return args;
}

export function isPipTruststoreSupported(versionText) {
  const match = String(versionText).match(/\bpip\s+(\d+)\.(\d+)/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 2);
}

export function buildVerifiedPipEnvironment(env = process.env) {
  const verified = { ...env };
  for (const name of Object.keys(verified)) {
    if (PIP_TLS_OVERRIDE_ENV_NAMES.has(name.toUpperCase())) {
      delete verified[name];
    }
  }
  return verified;
}

export function isPipTLSCertificateFailure(value) {
  return /CERTIFICATE_VERIFY_FAILED|SSL\s*certificate|confirming the ssl certificate|unable to get local issuer certificate/i.test(
    String(value ?? "")
  );
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: "pipe",
    shell: false,
    maxBuffer: RUYIPAGE_COMMAND_MAX_BUFFER_BYTES,
    ...options,
  });
}

function cleanupTemporaryFile(
  filePath,
  directory,
  unlinkSync = fs.unlinkSync,
  rmdirSync = fs.rmdirSync
) {
  let completed = true;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") completed = false;
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") completed = false;
  }
  return completed;
}

export function isMacOSTrustedSystemCACertificate(value, options = {}) {
  const parseCertificate =
    options.parseCertificate ?? ((certificate) => new X509Certificate(certificate));
  const runCommand = options.runCommand ?? run;
  const mkdtempSync = options.mkdtempSync ?? fs.mkdtempSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const rmdirSync = options.rmdirSync ?? fs.rmdirSync;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  let certificate;
  try {
    certificate = parseCertificate(String(value ?? ""));
  } catch {
    return false;
  }
  if (
    certificate?.ca !== true ||
    certificate.subject !== certificate.issuer
  ) {
    return false;
  }
  const directory = mkdtempSync(
    path.join(tmpDir, "apple-automation-ca-verify-")
  );
  const certificatePath = path.join(directory, "candidate-ca.pem");
  try {
    writeFileSync(certificatePath, `${String(value).trim()}\n`, {
      encoding: "ascii",
      flag: "wx",
      mode: 0o600,
    });
    const result = runCommand(
      "/usr/bin/security",
      [
        "verify-cert",
        "-c",
        certificatePath,
        "-p",
        "basic",
        "-l",
        "-L",
      ],
      { stdio: "pipe" }
    );
    return result.status === 0;
  } finally {
    cleanupTemporaryFile(
      certificatePath,
      directory,
      unlinkSync,
      rmdirSync
    );
  }
}

export function createMacOSSystemCABundle(options = {}) {
  const keychains = options.keychains ?? MACOS_SYSTEM_CA_KEYCHAINS;
  const existsSync = options.existsSync ?? fs.existsSync;
  const runCommand = options.runCommand ?? run;
  const mkdtempSync = options.mkdtempSync ?? fs.mkdtempSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const rmdirSync = options.rmdirSync ?? fs.rmdirSync;
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const isTrustedSystemCA =
    options.isTrustedSystemCA ??
    ((certificate) =>
      isMacOSTrustedSystemCACertificate(certificate, {
        runCommand,
        mkdtempSync,
        writeFileSync,
        unlinkSync,
        rmdirSync,
        tmpDir,
      }));
  const certificates = new Set();
  const exportFailures = [];

  for (const keychain of keychains) {
    if (!existsSync(keychain)) continue;
    const result = runCommand(
      "/usr/bin/security",
      ["find-certificate", "-a", "-p", keychain],
      { stdio: "pipe" }
    );
    if (result.status !== 0) {
      exportFailures.push(
        commandFailure(
          "/usr/bin/security",
          ["find-certificate", "-a", "-p", keychain],
          result
        )
      );
      continue;
    }
    for (const certificate of String(result.stdout ?? "").match(PEM_CERTIFICATE_PATTERN) ?? []) {
      const normalized = certificate.trim();
      if (
        keychain !== MACOS_SYSTEM_ROOT_CA_KEYCHAIN &&
        !isTrustedSystemCA(normalized)
      ) {
        continue;
      }
      certificates.add(normalized);
    }
  }

  if (certificates.size === 0) {
    if (exportFailures.length > 0) {
      throw new Error(
        `[camoufox-install:macos_ca_export] Unable to export certificates from the macOS System keychains: ${exportFailures
          .map((error) => error.message)
          .join("; ")}`
      );
    }
    throw new Error("macOS system keychains did not provide any CA certificates");
  }

  const directory = mkdtempSync(path.join(tmpDir, "apple-automation-ca-"));
  const bundlePath = path.join(directory, "macos-system-ca.pem");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return true;
    const completed = cleanupTemporaryFile(
      bundlePath,
      directory,
      unlinkSync,
      rmdirSync
    );
    cleaned = completed;
    return completed;
  };
  try {
    writeFileSync(bundlePath, `${[...certificates].join("\n")}\n`, {
      encoding: "ascii",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    path: bundlePath,
    cleanup,
  };
}

function defaultCommandWorks(cmd) {
  const result = run(cmd, ["--version"]);
  return result.status === 0 && isSupportedPythonVersion(result.stdout || result.stderr || "");
}

export function isSupportedPythonVersion(versionText) {
  const match = String(versionText).match(/Python\s+(\d+)\.(\d+)/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 10);
}

export function getLocalRuyiPagePython(root = ROOT, platform = process.platform) {
  return getLocalCamoufoxPython(root, platform);
}

export function getLocalCamoufoxPython(root = ROOT, platform = process.platform) {
  const primary =
    platform === "win32"
      ? path.join(root, ".runtime", "camoufox-venv", "Scripts", "python.exe")
      : path.join(root, ".runtime", "camoufox-venv", "bin", "python");
  const legacy =
    platform === "win32"
      ? path.join(root, ".runtime", "ruyipage-venv", "Scripts", "python.exe")
      : path.join(root, ".runtime", "ruyipage-venv", "bin", "python");
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {{ root?: string, platform?: string, commandWorks?: (command: string) => boolean }} [options]
 */
export function resolvePythonCommand(env = process.env, options = {}) {
  const requested = (env.CAMOUFOX_PYTHON || env.RUYIPAGE_PYTHON)?.trim();
  const root = options.root ?? ROOT;
  const platform = options.platform ?? process.platform;
  const commandWorks = options.commandWorks ?? defaultCommandWorks;
  if (requested) return commandWorks(requested) ? requested : null;

  const localPython = getLocalCamoufoxPython(root, platform);
  if (commandWorks(localPython)) return localPython;
  if (commandWorks("python3")) return "python3";
  if (commandWorks("python")) return "python";
  return null;
}

export function resolveBasePythonCommand(env = process.env, options = {}) {
  const commandWorks = options.commandWorks ?? defaultCommandWorks;
  const bootstrapPython = env.PYTHON_BOOTSTRAP_EXECUTABLE?.trim();
  if (bootstrapPython) {
    return commandWorks(bootstrapPython) ? bootstrapPython : null;
  }
  if (commandWorks("python3")) return "python3";
  if (commandWorks("python")) return "python";
  return null;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @param {{
 *   resolvePython?: (env: NodeJS.ProcessEnv|Record<string,string|undefined>) => string|null,
 *   runCommand?: typeof run
 * }} [options]
 */
export function detectRuyiPageRuntime(env = process.env, options = {}) {
  return detectCamoufoxRuntime(env, options);
}

export function detectCamoufoxRuntime(env = process.env, options = {}) {
  const resolvePython = options.resolvePython ?? resolvePythonCommand;
  const runCommand = options.runCommand ?? run;
  const python = resolvePython(env);
  if (!python) {
    const requested = (env.CAMOUFOX_PYTHON || env.RUYIPAGE_PYTHON)?.trim();
    return {
      python: null,
      available: false,
      version: null,
      browserVersion: null,
      error: requested
        ? `CAMOUFOX_PYTHON/RUYIPAGE_PYTHON is missing or older than Python 3.10: ${requested}`
        : "python/python3 not found",
    };
  }

  const result = runCommand(python, [
    "-c",
    "import camoufox; import importlib.metadata as m; print(m.version('camoufox'))",
  ]);

  if (result.status === 0) {
    const version = result.stdout.trim() || null;
    let browserVersion = null;
    const browserProbe = runCommand(python, ["-m", "camoufox", "version"], {
      stdio: "pipe",
    });
    if (browserProbe.status === 0) {
      const text = `${browserProbe.stdout || ""}\n${browserProbe.stderr || ""}`;
      const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:-beta\.\d+)?)/);
      browserVersion = match ? match[1] : text.trim().split(/\r?\n/).find(Boolean) || null;
    }
    // geoip / playwright are pulled in by camoufox[geoip]; probe lightly.
    const deps = runCommand(python, [
      "-c",
      "import importlib.util as u; print('geoip=' + str(u.find_spec('geoip2') is not None)); print('playwright=' + str(u.find_spec('playwright') is not None))",
    ]);
    if (deps.status === 0) {
      const depText = deps.stdout || "";
      if (/geoip=False/.test(depText) || /playwright=False/.test(depText)) {
        return {
          python,
          available: false,
          version,
          browserVersion,
          error:
            "camoufox extras incomplete (need camoufox[geoip] + playwright). Re-run ./install.sh",
        };
      }
    }
    return {
      python,
      available: true,
      version,
      browserVersion,
      error: null,
    };
  }

  const detail = (result.stderr || result.stdout || "").trim();
  const error = /PackageNotFoundError|No package metadata was found|No module named ['\"]camoufox['\"]/i.test(detail)
    ? "camoufox package not installed"
    : detail || "camoufox import failed";
  return {
    python,
    available: false,
    version: null,
    browserVersion: null,
    error,
  };
}

function commandFailure(command, args, result) {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  return new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}

function camoufoxPipInstallFailure(command, args, result, systemCABundleUsed) {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  if (isPipTLSCertificateFailure(detail)) {
    const trustSource = systemCABundleUsed
      ? "the exported macOS System keychains"
      : "Python's default trust configuration";
    return new Error(
      `[camoufox-install:tls_certificate] PyPI HTTPS certificate verification failed with ${trustSource}. ` +
        "install will retry with --trusted-host + Tsinghua mirror. " +
        "If that also fails, install the active network or enterprise proxy root certificate.\n" +
        detail
    );
  }
  return commandFailure(command, args, result);
}

function forwardCommandOutput(result, quiet) {
  if (quiet) return;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function cleanupMacOSSystemCABundle(bundle, quiet) {
  if (!bundle) return;
  try {
    if (bundle.cleanup() === false && !quiet) {
      process.stderr.write(
        "[camoufox-install:ca_cleanup] Temporary macOS CA bundle cleanup was incomplete.\n"
      );
    }
  } catch (error) {
    if (!quiet) {
      process.stderr.write(
        `[camoufox-install:ca_cleanup] Temporary macOS CA bundle cleanup failed: ${
          error?.message ?? error
        }\n`
      );
    }
  }
}

function pipTruststoreSupported(python, runCommand, env) {
  const result = runCommand(python, ["-m", "pip", "--version"], {
    stdio: "pipe",
    env,
  });
  return result.status === 0 && isPipTruststoreSupported(result.stdout || result.stderr || "");
}

function resolveCamoufoxBrowserChannel(env = process.env) {
  const configured = String(env.CAMOUFOX_CHANNEL || "").trim();
  return configured || CAMOUFOX_BROWSER_CHANNEL;
}

function fetchCamoufoxDevChannel(python, runCommand, quiet, env = process.env) {
  const channel = resolveCamoufoxBrowserChannel(env);
  const syncResult = runCommand(python, ["-m", "camoufox", "sync"], {
    stdio: "pipe",
  });
  forwardCommandOutput(syncResult, quiet);
  const setResult = runCommand(
    python,
    ["-m", "camoufox", "set", channel],
    { stdio: "pipe" }
  );
  forwardCommandOutput(setResult, quiet);
  if (!quiet) {
    process.stdout.write(
      `[camoufox-install] browser channel: ${channel} (FF152 dev/prerelease from daijro/camoufox)\n`
    );
  }
  const fetchResult = runCommand(python, ["-m", "camoufox", "fetch"], {
    stdio: quiet ? "pipe" : "inherit",
  });
  if (fetchResult.status !== 0 && !quiet) {
    process.stderr.write(
      `[camoufox-install] warning: camoufox fetch (${channel}) did not complete; run \`python -m camoufox set ${channel} && python -m camoufox fetch\` later.\n`
    );
  }
}

/**
 * Install Camoufox into the project virtual environment.
 * macOS SSL failures automatically retry with --trusted-host + mirror.
 */
export function installRuyiPage(options = {}) {
  return installCamoufox(options);
}

export function installCamoufox(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const root = options.root ?? ROOT;
  const commandWorks = options.commandWorks ?? defaultCommandWorks;
  const runCommand = options.runCommand ?? run;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const createMacCABundle =
    options.createMacCABundle ?? createMacOSSystemCABundle;
  const resolveBasePython = options.resolveBasePython ?? ((candidateEnv) =>
    resolveBasePythonCommand(candidateEnv, { commandWorks })
  );
  const requested = (env.CAMOUFOX_PYTHON || env.RUYIPAGE_PYTHON)?.trim();
  let python = requested || null;

  if (python && !commandWorks(python)) {
    throw new Error(
      `CAMOUFOX_PYTHON/RUYIPAGE_PYTHON is missing or older than Python 3.10: ${python}`
    );
  }

  if (!python) {
    const basePython = resolveBasePython(env);
    if (!basePython) throw new Error("python/python3 not found; install Python 3.10+ first");

    const localPython = getLocalCamoufoxPython(root, platform);
    if (!commandWorks(localPython)) {
      const venvDir = path.dirname(path.dirname(localPython));
      mkdirSync(path.dirname(venvDir), { recursive: true });
      const args = ["-m", "venv", venvDir];
      const result = runCommand(basePython, args, {
        stdio: options.quiet ? "pipe" : "inherit",
      });
      if (result.status !== 0) throw commandFailure(basePython, args, result);
    }
    python = localPython;
  }

  const managedVenv = !requested;
  let pipEnv = buildVerifiedPipEnvironment(options.pipEnvironment ?? process.env);
  let macCABundle = null;
  try {
    if (platform === "darwin" && managedVenv) {
      try {
        macCABundle = createMacCABundle();
        pipEnv = {
          ...pipEnv,
          PIP_CERT: macCABundle.path,
          SSL_CERT_FILE: macCABundle.path,
        };
      } catch (error) {
        if (!options.quiet) {
          process.stderr.write(
            `[camoufox-install] macOS CA bundle unavailable (${error?.message ?? error}); will use mirror fallback if needed.\n`
          );
        }
      }
    }
    const truststoreSupported =
      platform === "darwin" &&
      managedVenv &&
      pipTruststoreSupported(python, runCommand, pipEnv);

    let args = buildCamoufoxPipInstallArgs({
      platform,
      managedVenv,
      truststoreSupported,
      useMirror: false,
    });
    let result = runCommand(python, args, {
      stdio: "pipe",
      env: pipEnv,
    });
    forwardCommandOutput(result, options.quiet === true);

    if (result.status !== 0 && isPipTLSCertificateFailure(result.stderr || result.stdout)) {
      if (!options.quiet) {
        process.stderr.write(
          "[camoufox-install] SSL verify failed; retrying with --trusted-host + Tsinghua mirror.\n"
        );
      }
      // Mirror retry: drop custom CA overrides that may still fail.
      const mirrorEnv = buildVerifiedPipEnvironment(options.pipEnvironment ?? process.env);
      args = buildCamoufoxPipInstallArgs({
        platform,
        managedVenv,
        truststoreSupported: false,
        useMirror: true,
      });
      result = runCommand(python, args, {
        stdio: "pipe",
        env: mirrorEnv,
      });
      forwardCommandOutput(result, options.quiet === true);
    }

    // Always offer mirror path when first attempt fails for any TLS-ish reason on darwin.
    if (result.status !== 0 && platform === "darwin") {
      const mirrorEnv = buildVerifiedPipEnvironment(options.pipEnvironment ?? process.env);
      args = buildCamoufoxPipInstallArgs({
        platform,
        managedVenv,
        truststoreSupported: false,
        useMirror: true,
      });
      result = runCommand(python, args, {
        stdio: "pipe",
        env: mirrorEnv,
      });
      forwardCommandOutput(result, options.quiet === true);
    }

    if (result.status !== 0) {
      throw camoufoxPipInstallFailure(
        python,
        args,
        result,
        macCABundle !== null
      );
    }

    fetchCamoufoxDevChannel(python, runCommand, options.quiet === true, env);
    return { python };
  } finally {
    cleanupMacOSSystemCABundle(macCABundle, options.quiet === true);
  }
}
