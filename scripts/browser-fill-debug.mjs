#!/usr/bin/env node
/**
 * 浏览器登录分步测试：顶层 appleid 登录页 → 邮箱 → 继续 → 密码
 * 用法: npm run browser:debug
 */

import {
  BidiClient,
  ensureLoopbackHost,
  launchFirefox,
  stopFirefox,
} from "./lib/bidi-client.js";
import { HumanInput, sleep } from "./lib/human-input-bidi.js";
import { humanPageSettle } from "./lib/anti-automation.js";
import {
  fillInputWithVerify,
  firstInAnyContext,
  getBrowserConfig,
  readSignInStep,
  waitForPasswordStepAfterContinue,
  waitForVisibleInput,
} from "./lib/browser-input.js";
import { probeBrowserAccountSession } from "./lib/browser-session.js";
import { loadEnvFile } from "./lib/credentials.js";

const USER_SELECTORS = ["#account_name_text_field", 'input[name="accountName"]'];
const CONTINUE_SELECTORS = ["#sign-in", 'button#sign-in', 'button[type="submit"]'];

function loadCreds() {
  loadEnvFile();
  return {
    appleId: process.env.APPLE_ID || "test@example.com",
    password: process.env.APPLE_PASSWORD || "test-pass",
  };
}

async function main() {
  const { appleId, password } = loadCreds();
  const cfg = getBrowserConfig();
  console.log("═══ browser:debug ═══", cfg);

  let firefoxProc = null;
  let bidi = null;

  try {
    const launched = await launchFirefox({ width: 1280, height: 960 });
    firefoxProc = launched.process;
    bidi = new BidiClient(ensureLoopbackHost(launched.wsUrl));
    await bidi.connect();
    const root = bidi.rootContext;
    const human = new HumanInput(bidi, root);

    const session = await probeBrowserAccountSession(bidi, root);
    console.log("[0] 会话:", session.signedIn, session.reason);

    console.log(`[1] 打开 ${cfg.signInUrl}`);
    await bidi.navigate(cfg.signInUrl, root);
    human.setContext(root);
    await humanPageSettle("顶层登录页");

    const userField = await waitForVisibleInput(bidi, human, USER_SELECTORS, cfg.emailWaitMs, {
      kind: "email",
      log: true,
    });
    if (!userField) throw new Error("邮箱框未就绪");
    console.log("[2] 邮箱框:", userField.selector);

    await fillInputWithVerify(human, bidi, userField.selector, appleId, "邮箱", userField.nodes[0]);
    console.log("[3] 步骤:", await readSignInStep(bidi, root));

    const cont = await firstInAnyContext(bidi, CONTINUE_SELECTORS);
    if (!cont) throw new Error("无继续按钮");
    await human.clickElement(cont.nodes[0]);
    console.log("[4] 已点继续");

    const passField = await waitForPasswordStepAfterContinue(bidi, human, human.context, cfg.passwordWaitMs);
    if (!passField) throw new Error("密码框超时");
    console.log("[5] 密码框:", passField.selector);

    await fillInputWithVerify(human, bidi, passField.selector, password, "密码", passField.nodes[0]);
    console.log("\n✓ 完成（未提交登录），浏览器保持 8s…");
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
