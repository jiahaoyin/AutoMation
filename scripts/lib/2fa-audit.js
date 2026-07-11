/** 2FA 审计日志。 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} reportDir
 * @param {object} entry
 */
export function append2FAAudit(reportDir, entry) {
  if (!reportDir) return;
  const auditPath = path.join(reportDir, "2fa-audit.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  });
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${line}\n`, "utf-8");
}
