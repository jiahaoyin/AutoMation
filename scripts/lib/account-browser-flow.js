/**
 * account.apple.com：Firefox BiDi 登录 + macOS 2FA + 采集姓名/生日
 * v1.0.28：iframe 感知、两步登录、反自动化探针、结构化采集
 */

import {
  BidiClient,
  ensureLoopbackHost,
  launchFirefox,
  stopFirefox,
} from "./bidi-client.js";
import { HumanInput, sleep } from "./human-input-bidi.js";
import {
  applyAutomationMitigations,
  assessAutomationRisk,
  humanJitter,
  humanPageSettle,
  humanThinkPause,
  probeAutomationSignals,
} from "./anti-automation.js";
import { isAccessibilityGranted } from "./accessibility.js";
import {
  clickContinueAndWaitForPasswordStep,
  diagnoseLoginFields,
  fillInputWithVerify,
  firstInAnyContext,
  getBrowserConfig,
  readInputState,
  readSignInStep,
  waitForVisibleInput,
} from "./browser-input.js";
import {
  assertBrowserAccountSession,
  evaluatePageSession,
  hasInteractableLoginForm,
  probeBrowserAccountSession,
} from "./browser-session.js";
import { startMac2FAWait } from "./two-fa-sidecar.js";
import { saveScreenshot } from "./report.js";

const ACCOUNT_HOME = "https://account.apple.com/";
const ACCOUNT_MANAGE = "https://account.apple.com/account/manage";
const ACCOUNT_PERSONAL = "https://account.apple.com/account/manage/section/information";
const SIGN_IN_URL = "https://appleid.apple.com/sign-in";

const USER_SELECTORS = [
  "#account_name_text_field",
  'input[name="accountName"]',
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[id*="account"]',
  'input[canfield="accountName"]',
  ".form-textbox-input",
  'input.signin-form-textbox',
];

const PASS_SELECTORS = [
  "#password_text_field",
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
];

const CONTINUE_SELECTORS = [
  "#sign-in",
  'button#sign-in',
  'button[type="submit"]',
  'input[type="submit"]',
];

const CODE_SELECTORS = [
  'input[name="securityCode"]',
  ".form-security-code-input input",
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  ".form-security-code input",
  'input[type="tel"]',
];

const TRUST_SELECTORS = [
  'button[name="trust"]',
  'button[data-test="trust-browser"]',
  'button[type="submit"]',
];

const SIGN_IN_LINK_SELECTORS = [
  'a[href*="sign"]',
  'button[data-test*="sign"]',
  'a[data-test*="sign"]',
];

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string[]} selectors
 * @param {number} [timeoutMs]
 */
async function firstExistingInAnyContext(bidi, human, selectors, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
      if (found?.nodes?.length) {
        human.setContext(found.context);
        return { selector: sel, ...found };
      }
    }
    await sleep(350 + Math.random() * 300);
  }
  return null;
}

/** @param {import("./human-input-bidi.js").HumanInput} human @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
async function clickSignInIfNeeded(human, bidi, context) {
  const loginForm = await hasInteractableLoginForm(bidi, context);
  if (loginForm.yes) return false;

  const page = await evaluatePageSession(bidi, context);
  if (page.onManage && page.manageMarkers) return false;

  for (const sel of SIGN_IN_LINK_SELECTORS) {
    const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
    if (found?.nodes?.length) {
      human.setContext(found.context);
      await humanThinkPause(400, 900);
      await human.clickElement(found.nodes[0]);
      await humanPageSettle("点击登录");
      return true;
    }
  }
  return false;
}

/** @param {import("./human-input-bidi.js").HumanInput} human @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string} code */
async function fillSecurityCode(human, bidi, context, code) {
  human.setContext(context);
  for (const sel of CODE_SELECTORS) {
    try {
      const nodes = await human.waitForSelector(sel, 20_000);
      if (nodes.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await humanJitter(120, 280);
          await human.clickElement(nodes[i]);
          await human.typeText(code[i], { slow: true });
        }
        await humanThinkPause(300, 700);
        await human.pressEnter();
        return;
      }
      if (nodes.length >= 1) {
        await human.clickElement(nodes[0]);
        await human.typeText(code, { slow: true });
        await human.pressEnter();
        return;
      }
    } catch {
      /* next selector */
    }
  }
  throw new Error("未找到网页 2FA 验证码输入框");
}

/** @param {import("./human-input-bidi.js").HumanInput} human @param {import("./bidi-client.js").BidiClient} bidi */
async function clickTrustBrowserIfNeeded(human, bidi) {
  for (const sel of TRUST_SELECTORS) {
    const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
    if (!found?.nodes?.length) continue;
    const text = await bidi.evaluate(
      `(el => el?.innerText || el?.value || "")(document.querySelector(${JSON.stringify(sel)}))`,
      found.context
    );
    if (!/trust|信任|continue|继续/i.test(String(text))) continue;
    human.setContext(found.context);
    await humanThinkPause(500, 1200);
    await human.clickElement(found.nodes[0]);
    await humanPageSettle("信任浏览器");
    return true;
  }
  return false;
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
async function scrapePersonalInfo(bidi, context) {
  const urls = [ACCOUNT_PERSONAL, ACCOUNT_MANAGE];
  let lastRaw = null;

  for (const url of urls) {
    await bidi.navigate(url, context);
    await humanPageSettle("个人信息页");

    lastRaw = await bidi.evaluate(
      `JSON.stringify((() => {
        const lines = (document.body?.innerText || "")
          .split(/\\n+/)
          .map((s) => s.trim())
          .filter(Boolean);

        const nameLabels = ["Name", "姓名", "名字", "Full Name", "全名", "First Name"];
        const bdayLabels = ["Birthday", "生日", "Date of Birth", "出生日期", "出生", "Birth date"];

        let fullName = "";
        let birthday = "";

        const pickFromLines = (labels) => {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (labels.some((l) => line === l || line.startsWith(l + " ") || line.endsWith(l))) {
              const next = lines[i + 1];
              if (next && !labels.includes(next)) return next;
            }
          }
          return "";
        };

        fullName = pickFromLines(nameLabels);
        birthday = pickFromLines(bdayLabels);

        if (!fullName) {
          const dt = [...document.querySelectorAll("dt, th, label, h3, span")].find((el) =>
            nameLabels.some((l) => el.textContent?.trim() === l)
          );
          if (dt) {
            const sib = dt.nextElementSibling || dt.parentElement?.querySelector("dd, p, span");
            fullName = sib?.textContent?.trim() || "";
          }
        }

        if (!birthday) {
          const dt = [...document.querySelectorAll("dt, th, label, h3, span")].find((el) =>
            bdayLabels.some((l) => el.textContent?.trim() === l || el.textContent?.includes(l))
          );
          if (dt) {
            const sib = dt.nextElementSibling || dt.parentElement?.querySelector("dd, p, span");
            birthday = sib?.textContent?.trim() || "";
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
      const parsed = typeof lastRaw === "string" ? JSON.parse(lastRaw) : lastRaw ?? {};
      if (parsed.fullName || parsed.birthday) return parsed;
    } catch {
      /* try next url */
    }
  }

  try {
    return typeof lastRaw === "string" ? JSON.parse(lastRaw) : lastRaw ?? {};
  } catch {
    return { fullName: null, birthday: null, parseError: true };
  }
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {{ appleId: string, password: string }} creds
 */
async function runWebLogin(bidi, human, creds) {
  const cfg = getBrowserConfig();
  const root = bidi.rootContext;
  if (!root) throw new Error("无 root browsing context");

  console.log(`[Firefox] 打开顶层登录页: ${cfg.signInUrl}`);
  await bidi.navigate(cfg.signInUrl, root);
  human.setContext(root);
  await humanPageSettle("顶层登录页");

  // 登录控件常在 iframe 内：全 context 搜索（BiDi locateNodes），填表用指针+键盘避 XFO
  const userField = await waitForVisibleInput(bidi, human, USER_SELECTORS, cfg.emailWaitMs, {
    kind: "email",
    stablePolls: 2,
    log: true,
  });
  if (!userField) {
    const diag = await diagnoseLoginFields(bidi, USER_SELECTORS);
    console.error("[Firefox] 诊断:\n" + diag);
    throw new Error("未找到邮箱输入框。登录页可能仍在加载 iframe，或网络受限");
  }

  console.log(
    `[Firefox] 邮箱框: ${userField.selector} ctx=${userField.url?.slice(0, 70) || "root"} ` +
      `locateOnly=${!!userField.state?.locateOnly}`
  );
  const stepBefore = await readSignInStep(bidi, human.context);
  console.log(`[Firefox] 登录步骤(填邮箱前): email=${stepBefore.email} password=${stepBefore.password}`);
  const vp = await human.ensureViewport();
  console.log(`[Firefox] 视口: ${vp.width}x${vp.height}`);

  await humanThinkPause(600, 1400);
  const emailResult = await fillInputWithVerify(
    human,
    bidi,
    userField.selector,
    creds.appleId,
    "邮箱",
    userField.nodes[0]
  );
  await humanThinkPause(500, 1100);

  if (!emailResult.value && !emailResult.bidiOnly && !emailResult.scriptBlocked) {
    throw new Error(`邮箱校验失败：读回 "${emailResult.value ?? ""}"`);
  }

  await humanThinkPause(400, 900);
  const { context: passCtx } = await clickContinueAndWaitForPasswordStep(
    bidi,
    human,
    userField.context,
    { emailSelector: userField.selector, emailNode: userField.nodes[0] }
  );

  const passField = await waitForVisibleInput(bidi, human, PASS_SELECTORS, cfg.passwordWaitMs, {
    kind: "password",
    stablePolls: Math.max(cfg.stablePolls, 3),
    log: true,
    contextOnly: passCtx,
  });
  if (!passField) throw new Error("密码步骤 UI 已出现但未找到可交互密码框");

  const stepAfter = await readSignInStep(bidi, passCtx);
  const passState = await readInputState(bidi, passCtx, passField.selector);
  console.log(
    `[Firefox] 登录步骤(填密码前): email=${stepAfter.email} password=${stepAfter.password} ` +
      `btn="${stepAfter.submitLabel || ""}" interactable=${!!passState.interactable}`
  );
  if (!passState.interactable) {
    throw new Error(`密码框不可交互 (email=${stepAfter.email} password=${stepAfter.password})`);
  }

  const twoFa = startMac2FAWait({ timeoutMs: 240_000 });

  await humanThinkPause(600, 1400);
  const passResult = await fillInputWithVerify(
    human,
    bidi,
    passField.selector,
    creds.password,
    "密码",
    passField.nodes[0]
  );
  await humanThinkPause(600, 1200);

  if (!passResult.value && !passResult.bidiOnly && !passResult.scriptBlocked) {
    throw new Error(`密码校验失败：读回长度 ${passResult.value?.length ?? 0}`);
  }

  const submitBtn = await firstInAnyContext(bidi, CONTINUE_SELECTORS, 8000);
  if (submitBtn) {
    human.setContext(submitBtn.context);
    await human.clickElement(submitBtn.nodes[0]);
  } else {
    await human.pressEnter();
  }

  console.log("[Firefox] 已提交密码，等待 macOS 2FA 弹窗…");

  const code = await twoFa.getCode();
  console.log("[Firefox] 已获取 2FA 验证码，填入网页…");

  await humanPageSettle("2FA 输入框");
  await fillSecurityCode(human, bidi, human.context, code);
  await humanPageSettle("2FA 提交后");

  await clickTrustBrowserIfNeeded(human, bidi);

  console.log("[Firefox] 校验登录会话…");
  await assertBrowserAccountSession(bidi, human.context);
  console.log("[Firefox] ✓ account 会话有效");
}

/**
 * @param {object} params
 * @param {{ appleId: string, password: string }} params.creds
 * @param {string} params.reportDir
 */
export async function runAccountBrowserPhase({ creds, reportDir }) {
  console.log("\n[Firefox] 启动独立 Profile + WebDriver BiDi…");

  const axOk = await isAccessibilityGranted().catch(() => false);
  if (!axOk) {
    console.warn("[2FA] 警告: 辅助功能未授权，macOS FollowUpUI 2FA 可能失败");
  }

  let firefoxProc = null;
  let bidi = null;

  const report = {
    browserLogin: { success: false },
    antiAutomation: null,
    personalInfo: null,
    screenshots: {},
  };

  try {
    const launched = await launchFirefox({ width: 1280, height: 960 });
    firefoxProc = launched.process;
    const wsUrl = ensureLoopbackHost(launched.wsUrl);
    console.log(`[Firefox] BiDi: ${wsUrl}`);

    bidi = new BidiClient(wsUrl);
    await bidi.connect();
    const context = bidi.rootContext;
    if (!context) throw new Error("无 browsing context");

    const human = new HumanInput(bidi, context);

    await bidi.navigate(ACCOUNT_HOME, context);
    await humanPageSettle("首页加载");

    await applyAutomationMitigations(bidi, context);
    const signals = await probeAutomationSignals(bidi, context);
    const risk = assessAutomationRisk(signals);
    report.antiAutomation = { signals, risk };
    console.log(
      `[反自动化] 探针: webdriver=${signals.webdriver}, plugins=${signals.pluginsCount}` +
        (risk.warnings.length ? ` 警告: ${risk.warnings.join("; ")}` : " ✓")
    );

    report.screenshots.home = saveScreenshot(
      reportDir,
      "01-account-home",
      await bidi.captureScreenshot(context)
    );

    console.log("[Firefox] 探测 account 会话（访问 /account/manage）…");
    const session = await probeBrowserAccountSession(bidi, context);
    report.browserLogin.sessionProbe = {
      signedIn: session.signedIn,
      reason: session.reason,
      href: session.page?.href,
    };
    console.log(
      `[Firefox] 会话探测: ${session.signedIn ? "已登录" : "未登录"} (${session.reason})`
    );

    if (!session.signedIn) {
      await runWebLogin(bidi, human, creds);
      const afterLogin = await probeBrowserAccountSession(bidi, context);
      report.browserLogin.postLoginProbe = {
        signedIn: afterLogin.signedIn,
        reason: afterLogin.reason,
      };
      if (!afterLogin.signedIn) {
        throw new Error(`网页登录后会话仍无效: ${afterLogin.reason}`);
      }
      report.browserLogin.success = true;
      report.screenshots.afterLogin = saveScreenshot(
        reportDir,
        "02-after-login",
        await bidi.captureScreenshot(context)
      );
    } else {
      console.log("[Firefox] 已有有效浏览器会话，跳过网页登录");
      report.browserLogin.success = true;
      report.browserLogin.skipped = true;
    }

    if (!report.browserLogin.sessionProbe?.signedIn && !report.browserLogin.success) {
      throw new Error("未完成网页登录且无可用的 account 会话");
    }

    const personalInfo = await scrapePersonalInfo(bidi, context);
    report.personalInfo = personalInfo;

    report.screenshots.manage = saveScreenshot(
      reportDir,
      "03-account-manage",
      await bidi.captureScreenshot(context)
    );

    const hasName = !!personalInfo?.fullName;
    const hasBirthday = !!personalInfo?.birthday;
    console.log("[Firefox] 采集结果:", {
      fullName: personalInfo.fullName ?? "(未解析)",
      birthday: personalInfo.birthday ?? "(未解析)",
    });

    if (!hasName && !hasBirthday) {
      report.personalInfo.partial = true;
      console.warn("[Firefox] 警告: 姓名/生日均未解析，请查看截图与 report.json");
    } else {
      report.personalInfo.partial = !(hasName && hasBirthday);
    }

    return report;
  } finally {
    if (bidi) await bidi.close().catch(() => {});
    if (firefoxProc) await stopFirefox(firefoxProc);
  }
}
