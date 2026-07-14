#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUYIPAGE_SUPERVISOR_COMMAND_ID } from "./lib/ruyipage-backend-runner.js";
import { readBoundedRegularFile } from "./supervised-terminal-bridge.mjs";

const STATES = new Set(["starting", "active", "inactive", "cleanup_failed"]);

function isStartedAt(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    !/[\r\n\0]/.test(value) &&
    value === value.trim().replace(/\s+/g, " ")
  );
}

export function validateRuyiPageProcessState(source, expected = {}) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Number.isInteger(value.pid) ||
    !Number.isInteger(value.pgid) ||
    value.pid <= 0 ||
    value.pgid !== value.pid ||
    !isStartedAt(value.startedAt) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.nonce) ||
    value.commandId !== RUYIPAGE_SUPERVISOR_COMMAND_ID ||
    typeof value.commandSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.commandSha256) ||
    !STATES.has(value.state) ||
    Object.keys(value).sort().join(",") !==
      "commandId,commandSha256,nonce,pgid,pid,startedAt,state,version" ||
    (expected.nonce !== undefined && value.nonce !== expected.nonce)
  ) {
    return null;
  }
  return value;
}

export function readVerifiedRuyiPageProcessState(filePath, expected = {}) {
  if (!path.isAbsolute(filePath)) return null;
  const file = readBoundedRegularFile(filePath, 512);
  if (file.state !== "present") return null;
  return validateRuyiPageProcessState(file.text, expected);
}

function isMainModule() {
  return (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule()) {
  const [kind, filePath, expectedNonce, ...extra] = process.argv.slice(2);
  const state =
    kind === "ruyipage" &&
    extra.length === 0 &&
    /^[0-9a-f]{32}$/.test(String(expectedNonce ?? ""))
      ? readVerifiedRuyiPageProcessState(String(filePath ?? ""), {
          nonce: expectedNonce,
        })
      : null;
  if (!state) {
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${state.pid}\n${state.pgid}\n${Buffer.from(state.startedAt, "utf8").toString("base64")}\n${state.state}\n${state.commandSha256}\n`
    );
  }
}
