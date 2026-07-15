#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPERVISED_COMMAND_ID,
  SUPERVISED_MODES,
} from "./lib/supervised-attestation.js";
import { readBoundedRegularFile } from "./supervised-terminal-bridge.mjs";

function exactObject(file, expected) {
  if (file.state !== "present") return false;
  let value;
  try {
    value = JSON.parse(file.text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => value[key] === expected[key])
  );
}

export function validateSupervisedRequestArtifacts(options = {}) {
  const triggerPath = path.resolve(String(options.triggerPath ?? ""));
  const cancelPath = path.resolve(String(options.cancelPath ?? ""));
  const nonce = String(options.nonce ?? "");
  const expectedMode = String(options.expectedMode ?? "");
  const accepted = options.accepted === true;
  if (
    !path.isAbsolute(String(options.triggerPath ?? "")) ||
    !path.isAbsolute(String(options.cancelPath ?? "")) ||
    triggerPath === cancelPath ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    !SUPERVISED_MODES.has(expectedMode)
  ) {
    return false;
  }

  const trigger = readBoundedRegularFile(triggerPath, 256);
  let triggerMode = null;
  if (trigger.state === "present") {
    try {
      triggerMode = JSON.parse(trigger.text)?.mode ?? null;
    } catch {
      triggerMode = null;
    }
  }
  if (
    triggerMode !== expectedMode ||
    !exactObject(trigger, {
      version: 1,
      nonce,
      commandId: SUPERVISED_COMMAND_ID,
      mode: triggerMode,
    })
  ) {
    return false;
  }

  const cancel = readBoundedRegularFile(cancelPath, 256);
  if (accepted) return cancel.state === "missing";
  return (
    cancel.state === "missing" ||
    exactObject(cancel, { version: 1, nonce })
  );
}

function isMainModule() {
  return (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule()) {
  const [triggerPath, cancelPath, nonce, expectedMode, acceptanceState, ...extra] =
    process.argv.slice(2);
  const validMode = acceptanceState === "accepted" || acceptanceState === "not_accepted";
  const valid =
    extra.length === 0 &&
    validMode &&
    validateSupervisedRequestArtifacts({
      triggerPath,
      cancelPath,
      nonce,
      expectedMode,
      accepted: acceptanceState === "accepted",
    });
  process.exitCode = valid ? 0 : 1;
}
