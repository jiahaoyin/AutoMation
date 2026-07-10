import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveFirefoxExecutable,
  resolveFirefoxProfileOptions,
} from "./firefox-runtime.js";
import { resolvePythonCommand } from "./ruyipage-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_SCRIPT = path.join(ROOT, "scripts", "ruyipage", "apple_account_flow.py");

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`Invalid JSONL from ruyipage backend: ${line}`);
  }
}

export function resolveBackendTimeouts(env = process.env) {
  const positiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs: positiveNumber(env.RUYIPAGE_BACKEND_TIMEOUT_MS, 720_000),
    killGraceMs: positiveNumber(env.RUYIPAGE_KILL_GRACE_MS, 5_000),
  };
}

/**
 * @param {{
 *   python?: string|null,
 *   script?: string,
 *   cwd?: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   killGraceMs?: number
 * }} [options]
 */
export function createRuyiPageBackendRunner(options = {}) {
  const python = options.python || resolvePythonCommand();
  if (!python) {
    throw new Error("Python 3.10+ with ruyiPage is required. Run ./install.sh first.");
  }
  const script = options.script || DEFAULT_SCRIPT;
  const cwd = options.cwd || ROOT;
  const extraArgs = options.args || [];
  const configuredTimeouts = resolveBackendTimeouts();
  const timeoutMs = options.timeoutMs ?? configuredTimeouts.timeoutMs;
  const killGraceMs = options.killGraceMs ?? configuredTimeouts.killGraceMs;

  return {
    /**
     * @param {object} params
     * @param {{ appleId: string, password: string }} params.creds
     * @param {string} params.reportDir
     * @param {(event: object) => void|Promise<void>} [params.onEvent]
     * @param {() => Promise<string>} params.get2FACode
     */
    run(params) {
      return runRuyiPageBackend({
        python,
        script,
        cwd,
        args: extraArgs,
        timeoutMs,
        killGraceMs,
        ...params,
      });
    },
  };
}

export function createChildStopper(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 5_000;
  const signalProcessGroup = options.signalProcessGroup ?? process.kill;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let forceTimer = null;

  const signal = (signalName) => {
    if (platform !== "win32" && child.pid) {
      try {
        signalProcessGroup(-child.pid, signalName);
        return;
      } catch {
        /* fall through to child.kill */
      }
    }
    try {
      child.kill(signalName);
    } catch {
      /* ignore */
    }
  };

  return {
    stop() {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      signal(platform === "win32" ? "SIGTERM" : "SIGINT");
      if (forceTimer == null) {
        forceTimer = schedule(() => {
          signal("SIGKILL");
        }, graceMs);
      }
    },
    cancelForce() {
      if (forceTimer != null) {
        cancel(forceTimer);
        forceTimer = null;
      }
    },
  };
}

async function runRuyiPageBackend({
  python,
  script,
  cwd,
  args,
  timeoutMs,
  killGraceMs,
  creds,
  reportDir,
  onEvent,
  get2FACode,
}) {
  const child = spawn(
    python,
    [
      script,
      "--report-dir",
      reportDir,
      "--profile-dir",
      resolveFirefoxProfileOptions(process.env, path.basename(reportDir || "ruyipage-run")).profileDir,
      "--firefox",
      resolveFirefoxExecutable(),
      ...args,
    ],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        APPLE_ID: creds.appleId,
        APPLE_PASSWORD: creds.password,
      },
    }
  );

  let stderr = "";
  let stdoutBuffer = "";
  let finalResult = null;
  let exitCode = null;
  let processingError = null;
  let timedOut = false;
  /** @type {Promise<void>} */
  let processing = Promise.resolve();
  const stopper = createChildStopper(child, { graceMs: killGraceMs });
  const timer = setTimeout(() => {
    timedOut = true;
    stopper.stop();
  }, timeoutMs);

  child.stderr.on("data", (buf) => {
    stderr += buf.toString();
  });

  child.stdout.on("data", (buf) => {
    stdoutBuffer += buf.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      processing = processing
        .then(async () => {
          const event = parseJsonLine(line);
          if (onEvent) await onEvent(event);
          if (event.event === "need_2fa") {
            const code = await get2FACode();
            child.stdin.write(JSON.stringify({ type: "2fa_code", code }) + "\n");
          }
          if (event.event === "result") {
            finalResult = event;
          }
        })
        .catch((err) => {
          processingError = err;
          stopper.stop();
        });
    }
  });

  exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  }).finally(() => {
    clearTimeout(timer);
    stopper.cancelForce();
  });
  await processing;
  if (processingError) throw processingError;
  if (timedOut) {
    throw new Error(`ruyipage backend timed out after ${timeoutMs}ms`);
  }

  if (stdoutBuffer.trim()) {
    const event = parseJsonLine(stdoutBuffer.trim());
    if (onEvent) await onEvent(event);
    if (event.event === "result") finalResult = event;
  }

  if (exitCode !== 0) {
    throw new Error(`ruyipage backend exited ${exitCode}: ${stderr.trim()}`);
  }
  if (!finalResult) {
    throw new Error(`ruyipage backend exited without result: ${stderr.trim()}`);
  }
  if (finalResult.success === false) {
    throw new Error(finalResult.error || "ruyipage backend failed");
  }
  return finalResult;
}
