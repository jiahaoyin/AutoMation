#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPERVISED_COMMAND_ID,
  SUPERVISED_SUCCESS_MARKER,
  parseSupervisedAttestation,
} from "./lib/supervised-attestation.js";

export const DEFAULT_RUYIPAGE_BACKEND_TIMEOUT_MS = 720_000;
export const SUPERVISED_HELPER_CLEANUP_MARGIN_MS = 60_000;
export const DEFAULT_SUPERVISED_HELPER_WAIT_MS =
  DEFAULT_RUYIPAGE_BACKEND_TIMEOUT_MS + SUPERVISED_HELPER_CLEANUP_MARGIN_MS;
const POLL_MS = 250;

class FixedFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function regularFileText(filePath, maxBytes = 4096) {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
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

function validateEnvironment(env, nowMs) {
  if (env.APPLE_AUTOMATION_SUPERVISED_GUI !== "1") {
    throw new FixedFailure("supervised GUI mode is unavailable", 77);
  }
  if (!env.TMPDIR) throw new FixedFailure("supervised temporary directory is unavailable", 77);
  const tmpDir = path.resolve(env.TMPDIR);
  if (!fs.statSync(tmpDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new FixedFailure("supervised temporary directory is unavailable", 77);
  }
  const nonce = env.APPLE_AUTOMATION_SUPERVISED_TOKEN ?? "";
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw new FixedFailure("supervised bridge token is unavailable", 77);
  }
  const expectedHead = env.APPLE_AUTOMATION_EXPECTED_HEAD ?? "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHead)) {
    throw new FixedFailure("supervised expected head is unavailable", 77);
  }
  const outerDeadlineMs = Number(
    env.APPLE_AUTOMATION_SUPERVISED_DEADLINE_EPOCH_MS
  );
  if (!Number.isSafeInteger(outerDeadlineMs) || outerDeadlineMs <= nowMs) {
    throw new FixedFailure("supervised absolute deadline is unavailable", 77);
  }
  const triggerPath = path.resolve(env.APPLE_AUTOMATION_SUPERVISED_TRIGGER ?? "");
  const cancelPath = path.resolve(env.APPLE_AUTOMATION_SUPERVISED_CANCEL ?? "");
  const attestationPath = path.resolve(env.APPLE_AUTOMATION_SUPERVISED_ATTESTATION ?? "");
  if (!pathIsWithin(tmpDir, triggerPath) || !pathIsWithin(tmpDir, cancelPath)) {
    throw new FixedFailure("supervised trigger path is out of scope", 77);
  }
  if (pathIsWithin(tmpDir, attestationPath) || attestationPath === tmpDir) {
    throw new FixedFailure("supervised attestation path is not protected", 77);
  }
  return {
    tmpDir,
    nonce,
    expectedHead,
    triggerPath,
    cancelPath,
    attestationPath,
    outerDeadlineMs,
  };
}

function writeExclusiveJson(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  const handle = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.linkSync(temporaryPath, targetPath);
  } finally {
    fs.unlinkSync(temporaryPath);
  }
}

export async function runSupervisedMacAcceptance(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  if (args.length !== 0) throw new FixedFailure("supervised helper takes no arguments", 64);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISED_HELPER_WAIT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new FixedFailure("supervised helper timeout is invalid", 77);
  }
  const stdout = options.stdout ?? process.stdout;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt)) {
    throw new FixedFailure("supervised clock is invalid", 77);
  }
  const {
    nonce,
    expectedHead,
    triggerPath,
    cancelPath,
    attestationPath,
    outerDeadlineMs,
  } = validateEnvironment(env, startedAt);
  const budgetDeadline = startedAt + timeoutMs;
  if (!Number.isSafeInteger(budgetDeadline)) {
    throw new FixedFailure("supervised helper deadline is invalid", 77);
  }
  const deadline = Math.min(budgetDeadline, outerDeadlineMs);

  try {
    writeExclusiveJson(triggerPath, {
      version: 1,
      nonce,
      commandId: SUPERVISED_COMMAND_ID,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new FixedFailure("supervised request already exists", 75);
    }
    throw error;
  }

  while (now() < deadline) {
    const source = regularFileText(attestationPath);
    if (source != null) {
      const parsed = parseSupervisedAttestation(source, { nonce, expectedHead });
      if (parsed.errors.length > 0) {
        throw new FixedFailure("supervised attestation is invalid", 78);
      }
      if (parsed.value.status === "accepted") {
        stdout.write(`${SUPERVISED_SUCCESS_MARKER}\n`);
        return 0;
      }
      if (["failed", "cancelled"].includes(parsed.value.status)) {
        stdout.write(`[mac:supervised] ${parsed.value.failureClass}\n`);
        return parsed.value.exitCode && parsed.value.exitCode > 0
          ? parsed.value.exitCode
          : 1;
      }
    }
    const remainingMs = deadline - now();
    if (remainingMs > 0) await wait(Math.min(POLL_MS, remainingMs));
  }

  try {
    writeExclusiveJson(cancelPath, { version: 1, nonce });
  } catch {
    /* the outer runner still has its own absolute deadline */
  }
  throw new FixedFailure("supervised production timed out", 124);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  runSupervisedMacAcceptance()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const failure =
        error instanceof FixedFailure
          ? error
          : new FixedFailure("supervised acceptance failed", 1);
      console.error(`[mac:supervised] ${failure.message}`);
      process.exitCode = failure.exitCode;
    });
}
