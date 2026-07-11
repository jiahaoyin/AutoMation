import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import {
  resolveFirefoxExecutable,
  resolveFirefoxProfileOptions,
} from "./firefox-runtime.js";
import { resolvePythonCommand } from "./ruyipage-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_SCRIPT = path.join(ROOT, "scripts", "ruyipage", "apple_account_flow.py");
const MAX_KILL_GRACE_MS = 5_000;

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Invalid JSONL from ruyipage backend");
  }
}

export function resolveBackendTimeouts(env = process.env) {
  const positiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs: positiveNumber(env.RUYIPAGE_BACKEND_TIMEOUT_MS, 720_000),
    killGraceMs: Math.min(
      positiveNumber(env.RUYIPAGE_KILL_GRACE_MS, MAX_KILL_GRACE_MS),
      MAX_KILL_GRACE_MS
    ),
    eventHandlerTimeoutMs: positiveNumber(
      env.RUYIPAGE_EVENT_HANDLER_TIMEOUT_MS,
      30_000
    ),
  };
}

/**
 * @param {{
 *   python?: string|null,
 *   script?: string,
 *   cwd?: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   killGraceMs?: number,
 *   eventHandlerTimeoutMs?: number,
 *   childStopperOptions?: object
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
  const requestedKillGraceMs = options.killGraceMs ?? configuredTimeouts.killGraceMs;
  const killGraceMs =
    Number.isFinite(requestedKillGraceMs) && requestedKillGraceMs > 0
      ? Math.min(requestedKillGraceMs, MAX_KILL_GRACE_MS)
      : configuredTimeouts.killGraceMs;
  const eventHandlerTimeoutMs =
    Number.isFinite(options.eventHandlerTimeoutMs) && options.eventHandlerTimeoutMs > 0
      ? options.eventHandlerTimeoutMs
      : configuredTimeouts.eventHandlerTimeoutMs;
  const childStopperOptions = options.childStopperOptions ?? {};

  return {
    /**
     * @param {object} params
     * @param {{ appleId: string, password: string }} params.creds
     * @param {string} params.reportDir
     * @param {(event: object) => void|Promise<void>} [params.onEvent]
     * @param {() => Promise<void>} params.prepare2FA
 * @param {(request: {generation: 1|2, rejectPrevious: boolean}) => Promise<string>} params.get2FACode
     */
    run(params) {
      return runRuyiPageBackend({
        python,
        script,
        cwd,
        args: extraArgs,
        timeoutMs,
        killGraceMs,
        eventHandlerTimeoutMs,
        childStopperOptions,
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
  const now = options.now ?? Date.now;
  const forceCleanupTimeoutMs =
    Number.isFinite(options.forceCleanupTimeoutMs) && options.forceCleanupTimeoutMs > 0
      ? options.forceCleanupTimeoutMs
      : 2_000;
  const cleanupPollIntervalMs =
    Number.isFinite(options.cleanupPollIntervalMs) && options.cleanupPollIntervalMs > 0
      ? options.cleanupPollIntervalMs
      : 25;
  let forceTimer = null;
  let cleanupPollTimer = null;
  let forceCleanupDeadline = null;
  let stopRequested = false;
  let cleanupPending = false;
  let resolveCleanup = () => {};
  let rejectCleanup = () => {};
  let cleanup = Promise.resolve();

  const settleCleanup = (error = null) => {
    if (!cleanupPending) return;
    cleanupPending = false;
    if (forceTimer != null) cancel(forceTimer);
    if (cleanupPollTimer != null) cancel(cleanupPollTimer);
    forceTimer = null;
    cleanupPollTimer = null;
    if (error) rejectCleanup(error);
    else resolveCleanup();
  };

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

  const processGroupIsAlive = () => {
    if (platform === "win32" || !child.pid) return false;
    try {
      signalProcessGroup(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };

  const pollProcessGroupAfterForce = () => {
    if (!cleanupPending) return;
    if (!processGroupIsAlive()) {
      settleCleanup();
      return;
    }
    const remainingMs = forceCleanupDeadline - now();
    if (remainingMs <= 0) {
      settleCleanup(new Error("ruyipage backend cleanup failed"));
      return;
    }
    try {
      cleanupPollTimer = schedule(() => {
        cleanupPollTimer = null;
        pollProcessGroupAfterForce();
      }, Math.min(cleanupPollIntervalMs, remainingMs));
    } catch {
      settleCleanup(new Error("ruyipage backend cleanup failed"));
    }
  };

  return {
    stop() {
      if (stopRequested) return;
      stopRequested = true;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      signal(platform === "win32" ? "SIGTERM" : "SIGINT");
      cleanupPending = true;
      cleanup = new Promise((resolve, reject) => {
        resolveCleanup = resolve;
        rejectCleanup = reject;
      });
      void cleanup.catch(() => {});
      try {
        forceTimer = schedule(() => {
          forceTimer = null;
          signal("SIGKILL");
          if (platform === "win32" || !child.pid) {
            settleCleanup();
            return;
          }
          forceCleanupDeadline = now() + forceCleanupTimeoutMs;
          pollProcessGroupAfterForce();
        }, graceMs);
      } catch {
        settleCleanup(new Error("ruyipage backend cleanup failed"));
      }
    },
    cancelForce() {
      if (cleanupPending && !processGroupIsAlive()) {
        settleCleanup();
      }
    },
    stopIfProcessGroupAlive() {
      if (processGroupIsAlive()) {
        this.stop();
        return true;
      }
      return false;
    },
    waitForCleanup() {
      if (cleanupPending && !processGroupIsAlive()) {
        settleCleanup();
      }
      return cleanup;
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
  eventHandlerTimeoutMs,
  childStopperOptions,
  creds,
  reportDir,
  onEvent,
  prepare2FA,
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

  const stdoutDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stdoutDecoderEnded = false;
  const finishStdoutDecoding = () => {
    if (stdoutDecoderEnded) return;
    stdoutDecoderEnded = true;
    stdoutBuffer += stdoutDecoder.end();
  };
  let finalResult = null;
  let exitCode = null;
  let processingError = null;
  let timedOut = false;
  let acceptingStdout = true;
  let twoFaPrepared = false;
  let twoFaGeneration = 0;
  let childEnded = false;
  let childError = null;
  /** @type {Promise<void>} */
  let processing = Promise.resolve();
  const stopper = createChildStopper(child, {
    ...childStopperOptions,
    graceMs: killGraceMs,
  });
  const stdinWriteRejectors = new Set();
  let stdinFailure = null;
  const failStdin = () => {
    if (stdinFailure) return stdinFailure;
    stdinFailure = new Error("ruyipage backend stdin failed");
    processingError ??= stdinFailure;
    for (const rejectWrite of stdinWriteRejectors) rejectWrite(stdinFailure);
    stdinWriteRejectors.clear();
    if (!childEnded) stopper.stop();
    return stdinFailure;
  };
  child.stdin?.on("error", failStdin);
  let resolveBackendTimeout;
  const backendTimeoutOutcome = new Promise((resolve) => {
    resolveBackendTimeout = resolve;
  });
  const childOutcome = new Promise((resolve) => {
    child.once("error", (error) => {
      childEnded = true;
      childError = error;
      resolve({ error, exitCode: null });
    });
    child.once("exit", (code) => {
      childEnded = true;
      exitCode = code;
      resolve({ error: null, exitCode: code });
    });
  });
  const childCloseOutcome = new Promise((resolve) => {
    child.once("close", (code) => {
      finishStdoutDecoding();
      exitCode = code;
      resolve({ error: childError, exitCode: code });
    });
  });
  const terminalError = (outcome) => {
    if (timedOut) {
      return new Error(`ruyipage backend timed out after ${timeoutMs}ms`);
    }
    if (outcome?.error) return outcome.error;
    return new Error(`ruyipage backend exited ${outcome?.exitCode ?? "unknown"}`);
  };
  const whileChildAlive = async (operation) => {
    if (childEnded) throw terminalError(await childOutcome);
    return Promise.race([
      Promise.resolve().then(operation),
      childOutcome.then((outcome) => {
        throw terminalError(outcome);
      }),
      backendTimeoutOutcome.then(() => {
        throw terminalError();
      }),
    ]);
  };
  const callExternal = (operation, failureMessage) =>
    Promise.resolve()
      .then(operation)
      .catch(() => {
        throw new Error(failureMessage);
      });
  const callOnEvent = async (event) => {
    if (typeof onEvent !== "function") return;

    const safeEventNames = new Set(["ready", "prepare_2fa", "need_2fa", "warning", "result"]);
    const eventName = safeEventNames.has(event?.event) ? event.event : "unknown";
    let handlerTimer;
    const handlerOutcome = callExternal(
      () => onEvent(event),
      "ruyipage event handler failed"
    );
    const handlerTimeout = new Promise((_, reject) => {
      handlerTimer = setTimeout(() => {
        reject(
          new Error(
            `ruyipage onEvent handler timed out for ${eventName} after ${eventHandlerTimeoutMs}ms`
          )
        );
      }, eventHandlerTimeoutMs);
    });
    const candidates = [
      handlerOutcome,
      handlerTimeout,
      backendTimeoutOutcome.then(() => {
        throw terminalError();
      }),
    ];
    if (event.event !== "result") {
      candidates.push(
        childOutcome.then((outcome) => {
          throw terminalError(outcome);
        })
      );
    }

    try {
      await Promise.race(candidates);
    } finally {
      clearTimeout(handlerTimer);
    }
  };
  const writeCommand = (command) =>
    whileChildAlive(
      () =>
        new Promise((resolve, reject) => {
          const stdin = child.stdin;
          let settled = false;
          const settleWrite = (error = null) => {
            if (settled) return;
            settled = true;
            stdinWriteRejectors.delete(settleWrite);
            if (error) reject(error);
            else resolve();
          };
          if (stdinFailure) {
            settleWrite(stdinFailure);
            return;
          }
          if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
            settleWrite(failStdin());
            return;
          }
          stdinWriteRejectors.add(settleWrite);
          try {
            stdin.write(`${JSON.stringify(command)}\n`, (error) => {
              if (error) failStdin();
              else settleWrite();
            });
          } catch {
            failStdin();
          }
        })
    );
  const timer = setTimeout(() => {
    timedOut = true;
    acceptingStdout = false;
    stopper.stop();
    resolveBackendTimeout();
  }, timeoutMs);

  child.stderr.resume();

  const processLine = async (line) => {
    const event = parseJsonLine(line);
    await callOnEvent(event);
    if (event?.event === "prepare_2fa") {
      if (twoFaPrepared) {
        throw new Error("ruyipage backend requested duplicate 2FA preparation");
      }
      if (typeof prepare2FA !== "function") {
        throw new Error("ruyipage backend requested 2FA preparation without a handler");
      }
      await whileChildAlive(() =>
        callExternal(prepare2FA, "ruyipage 2FA preparation failed")
      );
      twoFaPrepared = true;
      await writeCommand({ type: "2fa_prepared" });
    } else if (event?.event === "need_2fa") {
      if (!twoFaPrepared) {
        throw new Error("ruyipage backend requested a 2FA code before preparation");
      }
      const generation = event.generation;
      if (
        !Number.isInteger(generation) ||
        generation < 1 ||
        generation > 2 ||
        generation !== twoFaGeneration + 1
      ) {
        throw new Error("ruyipage backend sent invalid 2FA generation");
      }
      twoFaGeneration = generation;
      const code = await whileChildAlive(() =>
        callExternal(
          () =>
            get2FACode({
              generation,
              rejectPrevious: generation === 2,
            }),
          "ruyipage 2FA code provider failed"
        )
      );
      await writeCommand({ type: "2fa_code", generation, code });
    }
    if (event?.event === "result") finalResult = event;
  };
  const enqueueLine = (line) => {
    if (!line.trim()) return;
    processing = processing
      .then(() => processLine(line))
      .catch((error) => {
        processingError ??= error;
        if (!childEnded) stopper.stop();
      });
  };

  child.stdout.on("data", (buf) => {
    if (!acceptingStdout) return;
    stdoutBuffer += stdoutDecoder.write(buf);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) enqueueLine(line);
  });
  child.stdout.once("end", finishStdoutDecoding);
  child.stdout.once("close", finishStdoutDecoding);

  let outcome;
  try {
    const completion = await Promise.race([
      childCloseOutcome.then((value) => ({ type: "close", value })),
      backendTimeoutOutcome.then(() => ({ type: "timeout" })),
    ]);
    if (completion.type === "timeout") {
      await processing;
    } else {
      outcome = completion.value;
      enqueueLine(stdoutBuffer);
      stdoutBuffer = "";
      await processing;
    }
  } finally {
    clearTimeout(timer);
    try {
      if (!timedOut) stopper.stopIfProcessGroupAlive();
      await stopper.waitForCleanup();
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
  if (timedOut) {
    throw new Error(`ruyipage backend timed out after ${timeoutMs}ms`);
  }
  if (processingError) throw processingError;
  if (outcome.error) throw outcome.error;

  if (exitCode !== 0) {
    throw new Error(`ruyipage backend exited ${exitCode}`);
  }
  if (!finalResult) {
    throw new Error("ruyipage backend exited without result");
  }
  if (finalResult.success !== true) {
    throw new Error("ruyipage backend failed");
  }
  return finalResult;
}
