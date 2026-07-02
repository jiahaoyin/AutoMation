/**
 * account.apple.com：Firefox BiDi 登录 + macOS 2FA + 采集姓名/生日
 */

import {
  BidiClient,
  ensureLoopbackHost,
  launchFirefox,
  stopFirefox,
} from "./bidi-client.js";
import { HumanInput, sleep } from "./human-input-bidi.js";
import { startMac2FAWait } from "./two-fa-sidecar.js";
import { saveScreenshot } from "./report.js";

const ACCOUNT_HOME = "https://account.apple.com/";
const ACCOUNT_MANAGE = "https://account.apple.com/account/manage";
const SIGN_IN_URL = "https://appleid.apple.com/sign-in";

const USER_SELECTORS = [
  "#account_name_text_field",
  'input[name="accountName"]',
  'input[autocomplete="username"]',
  'input[type="email"]',
];

const PASS_SELECTORS = [
  "#password_text_field",
  'input[name="password"]',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  "#sign-in",
  'button[type="submit"]',
  'button#sign-in',
];

const CODE_SELECTORS = [
  'input[name="securityCode"]',
  ".form-security-code-input input",
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
];

const SIGN_IN_LINK_SELECTORS = [
  'a[href*="sign"]',
  'button[data-test*="sign"]',
];

async function firstExisting(human, selectors) {
  for (const sel of selectors) {
    try {
      const nodes = await human.waitForSelector(sel, 8000);
      if (nodes.length) return { selector: sel, nodes };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function isAccountSignedIn(bidi, context) {
  const href = await bidi.evaluate("location.href", context);
  if (String(href).includes("/account/manage")) return true;
  const text = await bidi.evaluate(
    `document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : ""`,
    context
  );
  return /sign out|退出|manage your account|管理您的账户/i.test(String(text));
}

async function clickSignInIfNeeded(human, bidi, context) {
  if (await isAccountSignedIn(bidi, context)) return false;

  for (const sel of SIGN_IN_LINK_SELECTORS) {
    try {
      const nodes = await bidi.locateNodes(sel, context);
      if (nodes.length) {
        await human.clickElement(nodes[0]);
        await sleep(2000);
        return true;
      }
    } catch {
      /* continue */
    }
  }
  return false;
}

async function fillSecurityCode(human, bidi, context, code) {
  for (const sel of CODE_SELECTORS) {
    try {
      const nodes = await human.waitForSelector(sel, 15_000);
      if (nodes.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await human.clickElement(nodes[i]);
          await human.typeText(code[i]);
          await sleep(randomPause());
        }
        await human.pressEnter();
        return;
      }
      if (nodes.length >= 1) {
        await human.clickElement(nodes[0]);
        await human.typeText(code);
        await human.pressEnter();
        return;
      }
    } catch {
      /* next selector */
    }
  }
  throw new Error("未找到网页 2FA 验证码输入框");
}

function randomPause() {
  return 80 + Math.random() * 120;
}

async function scrapePersonalInfo(bidi, context) {
  await bidi.navigate(ACCOUNT_MANAGE, context);
  await sleep(3000);

  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const lines = (document.body?.innerText || "")
        .split(/\\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const nameLabels = ["Name", "姓名", "名字", "Full Name", "全名"];
      const bdayLabels = ["Birthday", "生日", "Date of Birth", "出生日期", "出生"];
      let fullName = "";
      let birthday = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!fullName && nameLabels.some((l) => line === l || line.startsWith(l))) {
          fullName = lines[i + 1] || "";
        }
        if (!birthday && bdayLabels.some((l) => line === l || line.startsWith(l))) {
          birthday = lines[i + 1] || "";
        }
      }
      return {
        fullName: fullName || null,
        birthday: birthday || null,
        url: location.href,
        title: document.title,
      };
    })())`,
    context
  );

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch {
    return { fullName: null, birthday: null, parseError: true };
  }
}

/**
 * @param {object} params
 * @param {{ appleId: string, password: string }} params.creds
 * @param {string} params.reportDir
 */
export async function runAccountBrowserPhase({ creds, reportDir }) {
  console.log("\n[Firefox] 启动独立 Profile + WebDriver BiDi…");

  let firefoxProc = null;
  let bidi = null;

  const report = {
    browserLogin: { success: false },
    personalInfo: null,
    screenshots: {},
  };

  try {
    const launched = await launchFirefox();
    firefoxProc = launched.process;
    const wsUrl = ensureLoopbackHost(launched.wsUrl);
    console.log(`[Firefox] BiDi: ${wsUrl}`);

    bidi = new BidiClient(wsUrl);
    await bidi.connect();
    const context = bidi.rootContext;
    if (!context) throw new Error("无 browsing context");

    const human = new HumanInput(bidi, context);

    await bidi.navigate(ACCOUNT_HOME, context);
    await sleep(randomPause() + 1500);

    report.screenshots.home = saveScreenshot(
      reportDir,
      "01-account-home",
      await bidi.captureScreenshot(context)
    );

    if (!(await isAccountSignedIn(bidi, context))) {
      await clickSignInIfNeeded(human, bidi, context);
      await sleep(2000);

      let onSignInPage = false;
      for (const url of [SIGN_IN_URL, ACCOUNT_HOME]) {
        try {
          await bidi.navigate(url, context);
          await sleep(2000);
          const found = await firstExisting(human, USER_SELECTORS);
          if (found) {
            onSignInPage = true;
            break;
          }
        } catch {
          /* continue */
        }
      }
      if (!onSignInPage) {
        await bidi.navigate(SIGN_IN_URL, context);
        await sleep(2500);
      }

      const userField = await firstExisting(human, USER_SELECTORS);
      if (!userField) throw new Error("未找到 Apple ID 输入框");

      const passField = await firstExisting(human, PASS_SELECTORS);
      if (!passField) throw new Error("未找到密码输入框");

      const twoFa = startMac2FAWait({ timeoutMs: 240_000 });

      await human.clickElement(userField.nodes[0]);
      await sleep(randomPause());
      await human.typeText(creds.appleId);
      await sleep(randomPause());

      const submitAfterUser = await firstExisting(human, SUBMIT_SELECTORS);
      if (submitAfterUser) {
        await human.clickElement(submitAfterUser.nodes[0]);
        await sleep(1500);
      }

      await human.clickElement(passField.nodes[0]);
      await sleep(randomPause());
      await human.typeText(creds.password);
      await sleep(randomPause());

      const submitBtn = await firstExisting(human, SUBMIT_SELECTORS);
      if (submitBtn) {
        await human.clickElement(submitBtn.nodes[0]);
      } else {
        await human.pressEnter();
      }

      console.log("[Firefox] 已提交密码，等待 macOS 2FA 弹窗与网页验证码框…");

      const code = await twoFa.getCode();
      await sleep(1000);
      await fillSecurityCode(human, bidi, context, code);
      await sleep(4000);

      report.screenshots.afterLogin = saveScreenshot(
        reportDir,
        "02-after-login",
        await bidi.captureScreenshot(context)
      );
    } else {
      console.log("[Firefox] 检测到 account 已登录，跳过网页登录");
    }

    const personalInfo = await scrapePersonalInfo(bidi, context);
    report.personalInfo = personalInfo;
    report.browserLogin.success = true;

    report.screenshots.manage = saveScreenshot(
      reportDir,
      "03-account-manage",
      await bidi.captureScreenshot(context)
    );

    console.log("[Firefox] 采集结果:", {
      fullName: personalInfo.fullName ?? "(未解析)",
      birthday: personalInfo.birthday ?? "(未解析)",
    });

    return report;
  } finally {
    if (bidi) await bidi.close().catch(() => {});
    if (firefoxProc) await stopFirefox(firefoxProc);
  }
}
