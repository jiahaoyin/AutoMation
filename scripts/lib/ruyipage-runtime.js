import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export const RUYIPAGE_PACKAGE_SPEC = "ruyiPage==1.2.45";

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: "pipe",
    shell: false,
    ...options,
  });
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
  return platform === "win32"
    ? path.join(root, ".runtime", "ruyipage-venv", "Scripts", "python.exe")
    : path.join(root, ".runtime", "ruyipage-venv", "bin", "python");
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {{ root?: string, platform?: string, commandWorks?: (command: string) => boolean }} [options]
 */
export function resolvePythonCommand(env = process.env, options = {}) {
  const requested = env.RUYIPAGE_PYTHON?.trim();
  const root = options.root ?? ROOT;
  const platform = options.platform ?? process.platform;
  const commandWorks = options.commandWorks ?? defaultCommandWorks;
  if (requested) return commandWorks(requested) ? requested : null;

  const localPython = getLocalRuyiPagePython(root, platform);
  if (commandWorks(localPython)) return localPython;
  if (commandWorks("python3")) return "python3";
  if (commandWorks("python")) return "python";
  return null;
}

/**
 * Resolve the base interpreter used only to create the project-local venv.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {{ commandWorks?: (command: string) => boolean }} [options]
 */
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
  const resolvePython = options.resolvePython ?? resolvePythonCommand;
  const runCommand = options.runCommand ?? run;
  const python = resolvePython(env);
  if (!python) {
    const requested = env.RUYIPAGE_PYTHON?.trim();
    return {
      python: null,
      available: false,
      version: null,
      error: requested
        ? `RUYIPAGE_PYTHON is missing or older than Python 3.10: ${requested}`
        : "python/python3 not found",
    };
  }

  const result = runCommand(python, [
    "-c",
    "import ruyipage; import importlib.metadata as m; print(m.version('ruyipage'))",
  ]);

  if (result.status === 0) {
    const version = result.stdout.trim() || null;
    const requiredVersion = RUYIPAGE_PACKAGE_SPEC.split("==")[1];
    if (version !== requiredVersion) {
      return {
        python,
        available: false,
        version,
        error: `ruyipage requires verified version ${requiredVersion}, found ${version || "unknown"}`,
      };
    }
    return {
      python,
      available: true,
      version,
      error: null,
    };
  }

  const detail = (result.stderr || result.stdout || "").trim();
  const error = /PackageNotFoundError|No package metadata was found|No module named ['\"]ruyipage['\"]/i.test(detail)
    ? "ruyipage package not installed"
    : detail || "ruyipage import failed";
  return {
    python,
    available: false,
    version: null,
    error,
  };
}

function commandFailure(command, args, result) {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  return new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}

/**
 * Install ruyiPage into an isolated project virtual environment unless
 * RUYIPAGE_PYTHON explicitly selects another Python environment.
 * @param {{ quiet?: boolean, env?: NodeJS.ProcessEnv|Record<string,string|undefined> }} [options]
 */
export function installRuyiPage(options = {}) {
  const env = options.env ?? process.env;
  const requested = env.RUYIPAGE_PYTHON?.trim();
  let python = requested || null;

  if (python && !defaultCommandWorks(python)) {
    throw new Error(`RUYIPAGE_PYTHON is missing or older than Python 3.10: ${python}`);
  }

  if (!python) {
    const basePython = resolveBasePythonCommand(env);
    if (!basePython) throw new Error("python/python3 not found; install Python 3.10+ first");

    const localPython = getLocalRuyiPagePython();
    if (!defaultCommandWorks(localPython)) {
      const venvDir = path.dirname(path.dirname(localPython));
      fs.mkdirSync(path.dirname(venvDir), { recursive: true });
      const args = ["-m", "venv", venvDir];
      const result = run(basePython, args, {
        stdio: options.quiet ? "pipe" : "inherit",
      });
      if (result.status !== 0) throw commandFailure(basePython, args, result);
    }
    python = localPython;
  }

  const args = ["-m", "pip", "install", "--upgrade", RUYIPAGE_PACKAGE_SPEC];
  const result = run(python, args, {
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) throw commandFailure(python, args, result);
  return { python };
}
