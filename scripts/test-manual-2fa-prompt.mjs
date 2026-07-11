import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";

import { promptForHidden2FACode } from "./lib/manual-2fa-prompt.js";

class FakeInput extends EventEmitter {
  constructor({ isTTY = true, isRaw = false, paused = true } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.paused = paused;
    this.rawModes = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  isPaused() {
    return this.paused;
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.paused = false;
    this.resumeCalls += 1;
  }

  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }
}

class FakeOutput {
  constructor({ isTTY = true } = {}) {
    this.isTTY = isTTY;
    this.text = "";
  }

  write(value) {
    this.text += String(value);
    return true;
  }
}

function createTimerHarness() {
  let callback = null;
  let cleared = false;
  return {
    setTimeout(fn) {
      callback = fn;
      return 1;
    },
    clearTimeout(id) {
      if (id === 1) cleared = true;
    },
    fire() {
      callback?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

async function hiddenAsciiCodeTest() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const timers = createTimerHarness();
  const result = promptForHidden2FACode({
    timeoutMs: 60_000,
    input,
    output,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  assert.deepEqual(input.rawModes, [true]);
  assert.equal(input.resumeCalls, 1);
  input.emit("data", Buffer.from("123456\r", "ascii"));

  assert.equal(await result, "123456");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.pauseCalls, 1);
  assert.equal(timers.cleared, true);
  assert.equal(output.text.includes("123456"), false);
}

async function rejectsNonAsciiAndMalformedInputTest() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const result = promptForHidden2FACode({ timeoutMs: 60_000, input, output });
  let settled = false;
  result.finally(() => {
    settled = true;
  });

  input.emit("data", Buffer.from("１２３４５６\r", "utf8"));
  await Promise.resolve();
  assert.equal(settled, false, "Unicode digits must not be accepted");

  input.emit("data", Buffer.from("123a456\r", "ascii"));
  await Promise.resolve();
  assert.equal(settled, false, "mixed input must not be accepted");

  input.emit("data", Buffer.from("\u0015"));
  input.emit("data", Buffer.from("654321\n", "ascii"));
  assert.equal(await result, "654321");
  assert.equal(output.text.includes("654321"), false);
}

async function abortRestoresRawModeTest() {
  const input = new FakeInput({ isRaw: true, paused: false });
  const output = new FakeOutput();
  const controller = new AbortController();
  const result = promptForHidden2FACode({
    signal: controller.signal,
    timeoutMs: 60_000,
    input,
    output,
  });

  controller.abort();
  assert.equal(await result, null);
  assert.deepEqual(input.rawModes, [true, true]);
  assert.equal(input.pauseCalls, 0);
  assert.equal(input.listenerCount("data"), 0);
}

async function timeoutRestoresRawModeTest() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const timers = createTimerHarness();
  const result = promptForHidden2FACode({
    timeoutMs: 90_000,
    input,
    output,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  timers.fire();
  assert.equal(await result, null);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.pauseCalls, 1);
}

async function nonTtyAndAlreadyAbortedDoNothingTest() {
  const nonTtyInput = new FakeInput({ isTTY: false });
  const output = new FakeOutput();
  assert.equal(
    await promptForHidden2FACode({ timeoutMs: 60_000, input: nonTtyInput, output }),
    null
  );
  assert.deepEqual(nonTtyInput.rawModes, []);

  const input = new FakeInput();
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await promptForHidden2FACode({
      signal: controller.signal,
      timeoutMs: 60_000,
      input,
      output,
    }),
    null
  );
  assert.deepEqual(input.rawModes, []);
}

await hiddenAsciiCodeTest();
await rejectsNonAsciiAndMalformedInputTest();
await abortRestoresRawModeTest();
await timeoutRestoresRawModeTest();
await nonTtyAndAlreadyAbortedDoNothingTest();

console.log("manual 2FA prompt: ok");
