import path from "node:path";

export function resolveNativeHelperPath(defaultDirectory, filename) {
  const configuredDirectory = process.env.APPLE_AUTOMATION_HELPER_DIR?.trim();
  if (!configuredDirectory) return path.resolve(defaultDirectory, filename);
  if (!path.isAbsolute(configuredDirectory) || configuredDirectory.includes("\0")) {
    throw new Error("Native helper directory must be an absolute path");
  }
  return path.join(path.resolve(configuredDirectory), filename);
}
