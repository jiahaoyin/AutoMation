#!/usr/bin/env node
/**
 * 浏览器登录分步测试：邮箱 → 继续 → 等待密码步骤 → 填密码（不提交）
 * 用法: npm run browser:debug
 */

import {
  BidiClient,
  ensureLoopbackHost,
  launchFirefox,
  stopFirefox,
} from "./lib/bidi-client.js";
import { HumanInput, sleep } from "./lib/human-input-bidi.js";
import {
  fillInputWithVerify,
  getBrowserConfig,
  readInputState,
  readSignInStep,
  waitForPasswordStepAfterContinue,
  waitForVisibleInput,
} from "./lib/browser-input.js";
import { loadEnvFile } from "./lib/credentials.js";

const ACCOUNT_HOME = "https://account.apple.com/";

const USER_SELECTORS = [
  "#account_name_text_field",
  'input[name="accountName"]',
  'input[autocomplete="username"]',
];

const CONTINUE_SELECTORS = ["#sign-in", 'button#sign-in', 'button[type="submit"]'];

function loadCreds() {
  loadEnvFile();
  const appleId = process.env.APPLE_ID || process.env.APPLE_SCRIPT_APPLE_ID || "test@example.com";
  const password = process.env.APPLE_PASSWORD || process.env.APPLE_SCRIPT_PASSWORD || "test-pass";
  return { appleId, password };
}

async function firstContinue(bidi, human) {
  for (const sel of CONTINUE_SELECTORS) {
    const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
    if (found?.nodes?.length) {
      human.setContext(found.context);
      return found;
    }
  }
  return null;
}

async function main() {
  const { appleId, password } = loadCreds();
  const cfg = getBrowserConfig();
  console.log("═══ browser:debug — 分步登录测试 ═══");
  console.log("配置:", cfg);
  console.log(`邮箱: ${appleId.replace(/(.{0,2}).*/, "$1***")}\n`);

  let firefoxProc = null;
  let bidi = null;

  try {
    const launched = await launchFirefox({ width: 1280, height: 960 });
    firefoxProc = launched.process;
    bidi = new BidiClient(ensureLoopbackHost(launched.wsUrl));
    await bidi.connect();
    const human = new HumanInput(bidi, bidi.rootContext);

    await bidi.navigate(ACCOUNT_HOME, bidi.rootContext);
    await sleep(3500);

    let step = await readSignInStep(bidi, human.context);
    console.log("[1] 初始步骤:", step);

    const userField = await waitForVisibleInput(bidi, human, USER_SELECTORS, cfg.emailWaitMs, {
      kind: "email",
      log: true,
    });
    if (!userField) throw new Error("邮箱框未就绪");
    console.log("[2] 邮箱框就绪:", userField.selector);

    await fillInputWithVerify(human, bidi, userField.selector, appleId, "邮箱");
    step = await readSignInStep(bidi, human.context);
    console.log("[3] 填邮箱后步骤:", step);

    const cont = await firstContinue(bidi, human);
    if (!cont) throw new Error("未找到继续按钮");
    await human.clickElement(cont.nodes[0]);
    console.log("[4] 已点继续，等待密码步骤…");

    const t0 = Date.now();
    const passField = await waitForPasswordStepAfterContinue(bidi, human, cfg.passwordWaitMs);
    console.log(`[5] 密码步骤就绪 (+${Date.now() - t0}ms):`, passField?.selector, passField?.state);

    if (!passField) throw new Error("密码步骤超时");

    await fillInputWithVerify(human, bidi, passField.selector, password, "密码");
    const passState = await readInputState(bidi, human.context, passField.selector);
    console.log("[6] 密码读回长度:", passState.value?.length, "interactable:", passState.interactable);

    step = await readSignInStep(bidi, human.context);
    console.log("[7] 填密码后步骤:", step);
    console.log("\n✓ 分步测试完成（未点登录提交）");
    console.log("浏览器将保持 8 秒供目视确认…");
    await sleep(8000);
  } finally {
    if (bidi) await bidi.close().catch(() => {});
    if (firefoxProc) await stopFirefox(firefoxProc);
  }
}

main().catch((e) => {
  console.error("\n[browser:debug 失败]", e.message || e);
  process.exit(1);
});
