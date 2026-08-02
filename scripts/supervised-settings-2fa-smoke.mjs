#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetch2FACodeFromSystemSettings } from "./lib/mac-settings-2fa.js";
import {
  SUPERVISED_SETTINGS_SMOKE_ACCEPTANCE_VALUE,
  SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER,
  SUPERVISED_SETTINGS_SMOKE_MODE,
} from "./lib/supervised-attestation.js";

const REQUEST_TIMEOUT_MS = 90_000;
export const SETTINGS_SMOKE_FAILURE_CODE = "SETTINGS_SMOKE_CODE_UNAVAILABLE";
const DISALLOWED_BROWSER_ENVIRONMENT_KEYS = [
  "APPLE_AUTOMATION_BROWSER_BROKER_SOCKET",
  "APPLE_AUTOMATION_RUYIPAGE_PROCESS_STATE_FILE",
  "FIREFOX_PROFILE_DIR",
  "BROWSER_PROFILE_MODE",
];

function settingsSmokeFailure() {
  const error = new Error("settings smoke did not receive two fresh codes");
  error.code = SETTINGS_SMOKE_FAILURE_CODE;
  return error;
}

function pathIsWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function pathIsWithinOrEqual(parentPath, candidatePath) {
  return parentPath === candidatePath || pathIsWithin(parentPath, candidatePath);
}

function settingsSmokeEnvironmentFailure() {
  const error = new Error("settings smoke environment is invalid");
  error.code = SETTINGS_SMOKE_FAILURE_CODE;
  return error;
}

function validateEnvironment(env) {
  try {
    if (
      env.APPLE_AUTOMATION_SUPERVISED_GUI !== "1" ||
      env.APPLE_AUTOMATION_SETTINGS_SMOKE !== "1" ||
      env.APPLE_AUTOMATION_SUPERVISED_MODE !== SUPERVISED_SETTINGS_SMOKE_MODE ||
      DISALLOWED_BROWSER_ENVIRONMENT_KEYS.some((key) => env[key] !== undefined)
    ) {
      throw settingsSmokeEnvironmentFailure();
    }

    const configuredReportRoot = env.APPLE_AUTOMATION_REPORT_ROOT;
    const configuredMarkerPath = env.APPLE_AUTOMATION_ACCEPTANCE_MARKER;
    if (
      typeof configuredReportRoot !== "string" ||
      typeof configuredMarkerPath !== "string" ||
      !path.isAbsolute(configuredReportRoot) ||
      !path.isAbsolute(configuredMarkerPath)
    ) {
      throw settingsSmokeEnvironmentFailure();
    }

    const reportRoot = path.resolve(configuredReportRoot);
    const markerPath = path.resolve(configuredMarkerPath);
    const reportRootStats = fs.statSync(reportRoot, { throwIfNoEntry: false });
    const markerParentStats = fs.statSync(path.dirname(markerPath), {
      throwIfNoEntry: false,
    });
    if (
      !reportRootStats?.isDirectory() ||
      !markerParentStats?.isDirectory() ||
      !pathIsWithin(reportRoot, markerPath)
    ) {
      throw settingsSmokeEnvironmentFailure();
    }

    const resolvedReportRoot = fs.realpathSync(reportRoot);
    const resolvedMarkerParent = fs.realpathSync(path.dirname(markerPath));
    if (!pathIsWithinOrEqual(resolvedReportRoot, resolvedMarkerParent)) {
      throw settingsSmokeEnvironmentFailure();
    }

    // lstat intentionally rejects a symlink rather than following it.
    if (fs.lstatSync(markerPath, { throwIfNoEntry: false })) {
      throw settingsSmokeEnvironmentFailure();
    }
    return { markerPath };
  } catch {
    throw settingsSmokeEnvironmentFailure();
  }
}

function writeMarker(markerPath) {
  let markerFile;
  let failed = false;
  try {
    markerFile = fs.openSync(markerPath, "wx", 0o600);
    fs.writeFileSync(
      markerFile,
      `${SUPERVISED_SETTINGS_SMOKE_ACCEPTANCE_VALUE}\n`,
      "utf8"
    );
  } catch {
    failed = true;
  } finally {
    if (markerFile !== undefined) {
      try {
        fs.closeSync(markerFile);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw settingsSmokeFailure();
}

async function receivedTwoFreshSixDigitCodes(fetchCode) {
  try {
    const first = await fetchCode({
      timeoutMs: REQUEST_TIMEOUT_MS,
      verbose: false,
      runtime: { compileIfNeeded: false },
    });
    const second = await fetchCode({
      timeoutMs: REQUEST_TIMEOUT_MS,
      verbose: false,
      runtime: { compileIfNeeded: false },
    });
    const firstCode = String(first?.code ?? "");
    const secondCode = String(second?.code ?? "");
    return (
      /^\d{6}$/.test(firstCode) &&
      /^\d{6}$/.test(secondCode) &&
      firstCode !== secondCode
    );
  } catch {
    return false;
  }
}

export async function runSupervisedSettings2FASmoke(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const fetchCode = options.fetchCode ?? fetch2FACodeFromSystemSettings;
  const { markerPath } = validateEnvironment(env);

  if (!(await receivedTwoFreshSixDigitCodes(fetchCode))) {
    throw settingsSmokeFailure();
  }

  writeMarker(markerPath);
  try {
    stdout.write(`${SUPERVISED_SETTINGS_SMOKE_SUCCESS_MARKER}\n`);
  } catch {
    throw settingsSmokeFailure();
  }
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runSupervisedSettings2FASmoke().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      console.error("[mac:supervised] SETTINGS_SMOKE_FAILED");
      process.exitCode = 1;
    }
  );
}
