import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeBrowserAnnotations } from "./sanitize-browser-annotations.mjs";

const FILE_NAME = "browser-annotations.jsonl";

function ensureDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("annotation_report_root_not_directory");
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("annotation_report_root_not_directory");
  }
}

export function appendBrowserAnnotation(record, reportRoot = process.env.APPLE_AUTOMATION_REPORT_ROOT) {
  if (typeof reportRoot !== "string" || !path.isAbsolute(reportRoot)) {
    throw new Error("annotation_report_root_missing");
  }
  const root = path.resolve(reportRoot);
  const output = path.resolve(root, FILE_NAME);
  if (path.dirname(output) !== root) throw new Error("annotation_output_invalid");
  ensureDirectory(root);
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("annotation_output_not_regular");
  }
  const line = sanitizeBrowserAnnotations(`${JSON.stringify(record)}\n`);
  fs.appendFileSync(output, line, { encoding: "utf8", mode: 0o600 });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 3) throw new Error("usage");
    appendBrowserAnnotation(JSON.parse(process.argv[2]));
  } catch {
    console.error("browser_annotation_write_failed");
    process.exitCode = 1;
  }
}
