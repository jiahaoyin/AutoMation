/**
 * macOS 版本检测（目标平台：macOS 15 Sequoia）
 */

import { execSync, spawnSync } from "node:child_process";

export const TARGET_MACOS_MAJOR = 15;
export const TARGET_MACOS_NAME = "Sequoia";

/** macOS 15 Sequoia — Apple Account 深链 */
export const SEQUOIA_APPLE_ACCOUNT_URL =
  "x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings";

export const APPLE_ACCOUNT_URL_FALLBACKS = [
  SEQUOIA_APPLE_ACCOUNT_URL,
  "x-apple.systempreferences:com.apple.preferences.AppleIDPref",
  "x-apple.systempreferences:com.apple.AccountSettings.AccountsSettingsExtension",
];

export function openAppleAccountSettings() {
  if (process.platform !== "darwin") return false;
  for (const url of APPLE_ACCOUNT_URL_FALLBACKS) {
    const r = spawnSync("open", [url], { encoding: "utf-8" });
    if (r.status === 0) return true;
  }
  return false;
}

/**
 * @returns {{ major: number, minor: number, patch: number, productVersion: string }}
 */
export function getMacOSVersion() {
  if (process.platform !== "darwin") {
    return { major: 0, minor: 0, patch: 0, productVersion: "non-darwin" };
  }
  try {
    const productVersion = execSync("sw_vers -productVersion", {
      encoding: "utf-8",
    }).trim();
    const [major, minor = "0", patch = "0"] = productVersion.split(".");
    return {
      major: parseInt(major, 10) || 0,
      minor: parseInt(minor, 10) || 0,
      patch: parseInt(patch, 10) || 0,
      productVersion,
    };
  } catch {
    return { major: 0, minor: 0, patch: 0, productVersion: "unknown" };
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.strict] 非 15.x 时抛错
 */
export function ensureMacOS15(options = {}) {
  const { strict = false } = options;
  const v = getMacOSVersion();

  if (process.platform !== "darwin") {
    throw new Error("此脚本仅支持 macOS");
  }

  if (v.major === TARGET_MACOS_MAJOR) {
    return v;
  }

  const msg = `目标系统为 macOS ${TARGET_MACOS_MAJOR} (${TARGET_MACOS_NAME})，当前: ${v.productVersion}。系统设置 UI 脚本可能不兼容。`;

  if (strict) {
    throw new Error(msg);
  }

  console.warn(`[警告] ${msg}`);
  return v;
}
