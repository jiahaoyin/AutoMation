import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export function resolveReportRoot(env = process.env) {
  const override = String(env.APPLE_AUTOMATION_REPORT_ROOT ?? "").trim();
  return override ? path.resolve(override) : path.join(ROOT, "data", "reports");
}

export function writeAccountHomeAcceptanceMarker(env = process.env) {
  const configuredPath = String(env.APPLE_AUTOMATION_ACCEPTANCE_MARKER ?? "").trim();
  if (!configuredPath) return null;

  const reportRoot = path.resolve(resolveReportRoot(env));
  const markerPath = path.resolve(configuredPath);
  if (path.dirname(markerPath) !== reportRoot) {
    throw new Error("Account-home acceptance marker must be a direct child of the report root");
  }
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(markerPath, "REAL_ACCOUNT_HOME_CONFIRMED\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return markerPath;
}

export function createReportDir(prefix = "apple-id") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(resolveReportRoot(), `${prefix}-${stamp}`);
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  return dir;
}

export function writeReport(dir, report) {
  const file = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
  return file;
}

export function saveScreenshot(dir, name, base64) {
  if (!base64) return null;
  const file = path.join(dir, "screenshots", `${name}.png`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}
