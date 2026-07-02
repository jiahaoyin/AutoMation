import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export function createReportDir(prefix = "apple-id") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, "data", "reports", `${prefix}-${stamp}`);
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
