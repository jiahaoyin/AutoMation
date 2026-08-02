import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForEnter(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

/**
 * @param {string} message
 * @param {(chunk: string) => boolean | Promise<boolean>} predicate
 * @param {object} [options]
 */
export async function waitUntil(message, predicate, options = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const timeoutCode =
    typeof options.timeoutCode === "string" && /^MAC_SETTINGS_[A-Z0-9_]{1,96}$/.test(options.timeoutCode)
      ? options.timeoutCode
      : null;
  const manualHint =
    options.manualHint ??
    "\n若自动检测失败，可在完成后按 Enter 手动继续…";

  console.log(message);
  const deadline = Date.now() + timeoutMs;

  const manual =
    options.allowManualContinuation === false
      ? new Promise(() => {})
      : (async () => {
          await waitForEnter(manualHint);
          return true;
        })();

  const poll = (async () => {
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(intervalMs);
    }
    const error = new Error(`等待超时（${timeoutMs}ms）`);
    if (timeoutCode) error.code = timeoutCode;
    throw error;
  })();

  return Promise.race([poll, manual]);
}
