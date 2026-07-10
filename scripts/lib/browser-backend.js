const BACKENDS = new Set(["auto", "ruyipage"]);

function normalizedBackend(env = process.env) {
  const value = (env.BROWSER_BACKEND || "auto").trim().toLowerCase();
  if (!BACKENDS.has(value)) {
    throw new Error(
      `ruyipage is the only supported browser backend; BROWSER_BACKEND must be auto or ruyipage (got "${value}")`
    );
  }
  return value;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @param {{ ruyipageAvailable?: boolean, ruyipageError?: string }} probes
 * @returns {{ backend: "ruyipage", requested: string, reason: string, warnings: string[] }}
 */
export function selectBrowserBackend(env = process.env, probes = {}) {
  const requested = normalizedBackend(env);
  const ruyipageAvailable = probes.ruyipageAvailable === true;
  const ruyipageError = probes.ruyipageError || "ruyipage runtime is unavailable";
  if (!ruyipageAvailable) {
    throw new Error(`ruyipage is required but unavailable: ${ruyipageError}. Run ./install.sh`);
  }

  return {
    backend: "ruyipage",
    requested,
    reason: requested === "ruyipage"
      ? "ruyipage explicitly requested and available"
      : "ruyipage available in auto mode",
    warnings: [],
  };
}

/**
 * @param {object} params
 * @param {string} params.platform
 * @param {{ backend: string, requested?: string, reason: string, warnings?: string[] }} params.backend
 * @param {{ python?: string|null, available: boolean, version?: string|null, error?: string|null }} params.runtime
 * @param {{ mode: string, dir: string }} params.profile
 */
export function buildEnvironmentSummary({ platform, backend, runtime, profile }) {
  const warnings = [...(backend.warnings ?? [])];
  if (platform !== "darwin") {
    warnings.push("Windows/Linux can run logic tests only; full automation runs on macOS.");
  }
  if (!runtime.available) {
    warnings.push(`ruyipage runtime unavailable: ${runtime.error || "unknown reason"}`);
  }

  return {
    platform,
    backend: backend.backend,
    requestedBackend: backend.requested ?? "auto",
    backendReason: backend.reason,
    python: runtime.python ?? null,
    ruyipageAvailable: runtime.available,
    ruyipageVersion: runtime.version ?? null,
    profileMode: profile.mode,
    profileDir: profile.dir,
    warnings,
  };
}

export function checkEnvironmentOk({ issues, platform = process.platform, strictPlatform = false }) {
  if (platform !== "darwin" && !strictPlatform) {
    return issues.every(
      (issue) =>
        issue === "非 macOS" ||
        issue === "Firefox 未安装" ||
        /python\/python3 not found|ruyipage (?:package not installed|runtime unavailable|runtime is unavailable)|ruyipage runtime unavailable/i.test(issue)
    );
  }
  return issues.length === 0;
}
