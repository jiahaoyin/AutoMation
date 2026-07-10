import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_FIREFOX =
  process.platform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : "firefox";

export function resolveFirefoxExecutable(env = process.env) {
  const configured = env.FIREFOX_EXECUTABLE?.trim();
  if (configured) return path.resolve(configured);
  if (fs.existsSync(DEFAULT_FIREFOX)) return DEFAULT_FIREFOX;
  return "firefox";
}

/**
 * Resolve only filesystem paths and profile policy. Browser launch remains owned by ruyiPage.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {string} [runId]
 */
export function resolveFirefoxProfileOptions(env = process.env, runId = String(Date.now())) {
  const mode = (env.BROWSER_PROFILE_MODE || "persistent").trim().toLowerCase() === "fresh"
    ? "fresh"
    : "persistent";
  const baseDir = env.FIREFOX_PROFILE_DIR
    ? path.resolve(env.FIREFOX_PROFILE_DIR)
    : path.join(ROOT, "data", "firefox-apple-automation");

  if (mode === "fresh") {
    const freshBase = env.FIREFOX_PROFILE_DIR
      ? baseDir
      : path.join(ROOT, "data", "firefox-apple-automation-fresh");
    const safeRunId = String(runId).replace(/[^a-zA-Z0-9._-]+/g, "-") || "run";
    return { mode, profileDir: path.join(freshBase, safeRunId) };
  }

  return { mode, profileDir: baseDir };
}
