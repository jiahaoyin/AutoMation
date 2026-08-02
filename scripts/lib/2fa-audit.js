/** 2FA 审计日志。 */

import fs from "node:fs";
import path from "node:path";

import { normalizeFlowRunId } from "./flow-audit.js";

function normalizeAuditSequence(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function omitReservedAuditFields(entry) {
  if (!entry || typeof entry !== "object") return {};
  const { version: _version, runId: _runId, sequence: _sequence, ts: _ts, ...details } = entry;
  return details;
}

/**
 * @param {string} reportDir
 * @param {object} entry
 * @param {{ runId?: string, sequence?: number }} [context]
 */
export function append2FAAudit(reportDir, entry, context = {}) {
  if (!reportDir) return;
  const auditPath = path.join(reportDir, "2fa-audit.jsonl");
  const line = JSON.stringify({
    version: 1,
    runId: normalizeFlowRunId(context.runId),
    sequence: normalizeAuditSequence(context.sequence),
    ts: new Date().toISOString(),
    ...omitReservedAuditFields(entry),
  });
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${line}\n`, "utf-8");
}
