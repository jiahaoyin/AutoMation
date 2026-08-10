import fs from "node:fs";
import os from "node:os";
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

function firefoxProfilesRoot(platform = process.platform) {
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Firefox");
  }
  if (platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appdata, "Mozilla", "Firefox");
  }
  return path.join(home, ".mozilla", "firefox");
}

/**
 * Resolve the profile Firefox uses when launched from the application icon.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {string} [platform]
 */
export function resolveSystemFirefoxDefaultProfile(env = process.env, platform = process.platform) {
  const configured = env.FIREFOX_PROFILE_DIR?.trim();
  if (configured) return path.resolve(configured);

  const root = firefoxProfilesRoot(platform);
  const iniPath = path.join(root, "profiles.ini");
  if (!fs.existsSync(iniPath)) return null;

  let text;
  try {
    text = fs.readFileSync(iniPath, "utf-8");
  } catch {
    return null;
  }

  const sections = text.split(/\n(?=\[)/);
  let installDefault = null;
  let profileDefault = null;
  for (const section of sections) {
    const nameMatch = section.match(/^\[([^\]]+)\]/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const values = Object.fromEntries(
      [...section.matchAll(/^\s*([A-Za-z]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()])
    );
    if (name.startsWith("Install") && values.Default) {
      installDefault = values.Default;
    }
    if (name.startsWith("Profile") && values.Default === "1" && values.Path) {
      profileDefault =
        values.IsRelative === "0" ? values.Path : path.join(root, values.Path);
    }
  }

  if (installDefault) {
    const candidate = path.isAbsolute(installDefault)
      ? installDefault
      : path.join(root, installDefault);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (profileDefault && fs.existsSync(profileDefault)) return profileDefault;

  const profilesDir = path.join(root, "Profiles");
  if (fs.existsSync(profilesDir)) {
    try {
      const children = fs
        .readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const full = path.join(profilesDir, entry.name);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (children[0]) return children[0].full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Resolve filesystem paths and profile policy.
 * Default persistent mode uses the system Firefox default profile for Camoufox.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {string} [runId]
 */
export function resolveFirefoxProfileOptions(env = process.env, runId = String(Date.now())) {
  const mode =
    (env.BROWSER_PROFILE_MODE || "persistent").trim().toLowerCase() === "fresh"
      ? "fresh"
      : "persistent";

  if (mode === "fresh") {
    const freshBase = env.FIREFOX_PROFILE_DIR
      ? path.resolve(env.FIREFOX_PROFILE_DIR)
      : path.join(ROOT, "data", "firefox-apple-automation-fresh");
    const safeRunId = String(runId).replace(/[^a-zA-Z0-9._-]+/g, "-") || "run";
    return { mode, profileDir: path.join(freshBase, safeRunId) };
  }

  const systemProfile = resolveSystemFirefoxDefaultProfile(env);
  if (systemProfile) {
    return { mode, profileDir: systemProfile };
  }

  // Fallback when Firefox has never been launched interactively.
  const legacy = env.FIREFOX_PROFILE_DIR
    ? path.resolve(env.FIREFOX_PROFILE_DIR)
    : path.join(ROOT, "data", "firefox-apple-automation");
  return { mode, profileDir: legacy };
}
