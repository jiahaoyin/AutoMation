#!/usr/bin/env node
/**
 * 浏览器登录页输入框定位 + 填值测试（不提交登录）
 * 用法: npm run browser:debug
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BidiClient,
  ensureLoopbackHost,
  launchFirefox,
  stopFirefox,
} from "./lib/bidi-client.js";
import { HumanInput, sleep } from "./lib/human-input-bidi.js";
import {
  fillInputViaScript,
  fillInputWithVerify,
  readInputState,
  waitForVisibleInput,
} from "./lib/browser-input.js";
import { loadEnvFile } from "./lib/credentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_HOME = "https://account.apple.com/";

const USER_SELECTORS = [
  "#account_name_text_field",
  'input[name="accountName"]',
  'input[autocomplete="username"]',
];

const PASS_SELECTORS = [
  "#password_text_field",
  'input[name="password"]',
  'input[type="password"]',
];

function loadCreds() {
  loadEnvFile();
  const appleId = process.env.APPLE_ID || process.env.APPLE_SCRIPT_APPLE_ID || "test@example.com";
  return { appleId };
}

async function dumpFields(bidi, human, label, selectors) {
  console.log(`\n[browser:debug] === ${label} ===`);
  for (const sel of selectors) {
    const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
    if (!found?.nodes?.length) {
      console.log(`  ${sel}: 未找到`);
      continue;
    }
    human.setContext(found.context);
    const state = await readInputState(bidi, found.context, sel);
    const vp = await bidi.getViewportSize(found.context);
    console.log(
      `  ${sel}: found=${state.found} visible=${state.visible} value="${state.value}" ctx=${found.url?.slice(0, 60)}… vp=${vp.width}x${vp.height}`
    );
  }
}

async function main() {
  const { appleId } = loadCreds();
  console.log("═══ browser:debug — 定位 & 填值测试 ═══");
  console.log(`测试邮箱: ${appleId.replace(/(.{2}).+(@.+)/, "$1***$2")}\n`);

  let firefoxProc = null;
  let bidi = null;

  try {
    const launched = await launchFirefox({ width: 1280, height: 960 });
    firefoxProc = launched.process;
    bidi = new BidiClient(ensureLoopbackHost(launched.wsUrl));
    await bidi.connect();
    const context = bidi.rootContext;
    const human = new HumanInput(bidi, context);

    await bidi.navigate(ACCOUNT_HOME, context);
    await sleep(3000);

    await dumpFields(bidi, human, "初始 DOM", [...USER_SELECTORS, ...PASS_SELECTORS]);

    const userField = await waitForVisibleInput(bidi, human, USER_SELECTORS, 25_000);
    if (!userField) throw new Error("未找到可见邮箱框");

    console.log(`\n[browser:debug] 选中邮箱框: ${userField.selector}`);
    await fillInputWithVerify(human, bidi, userField.selector, appleId, "邮箱");

    const afterEmail = await readInputState(bidi, human.context, userField.selector);
    console.log(`[browser:debug] 填后读回: "${afterEmail.value}" visible=${afterEmail.visible}`);

    await dumpFields(bidi, human, "填邮箱后 DOM", PASS_SELECTORS);

    const passField = await waitForVisibleInput(bidi, human, PASS_SELECTORS, 8000);
    if (passField) {
      console.log(`\n[browser:debug] 密码框已可见: ${passField.selector}（未填密码，避免误提交）`);
    } else {
      console.log("\n[browser:debug] 密码框尚未可见（正常：需先点继续）");
    }

    console.log("\n[browser:debug] ✓ 定位与邮箱填值测试完成（未提交登录）");
  } finally {
    if (bidi) await bidi.close().catch(() => {});
    if (firefoxProc) await stopFirefox(firefoxProc);
  }
}

main().catch((e) => {
  console.error("\n[browser:debug 失败]", e.message || e);
  process.exit(1);
});
