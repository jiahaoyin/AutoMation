/**
 * account.apple.com 浏览器会话探测（严格模式，禁止首页文案误判）
 */

import { readInputState } from "./browser-input.js";
import { sleep } from "./human-input-bidi.js";

export const ACCOUNT_MANAGE_URL = "https://account.apple.com/account/manage";

const LOGIN_FIELD_SELECTORS = ["#account_name_text_field", "#password_text_field"];

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 */
export async function evaluatePageSession(bidi, context) {
  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const href = location.href;
      const path = location.pathname || "";

      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        const op = parseFloat(s.opacity || "1");
        return (
          r.width > 2 &&
          r.height > 2 &&
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          op > 0.1 &&
          el.tabIndex !== -1
        );
      };

      const emailEl = document.querySelector("#account_name_text_field");
      const passEl = document.querySelector("#password_text_field");

      const ctas = [...document.querySelectorAll("a, button")].filter(isVisible);
      const signInCta = ctas.filter((el) =>
        /^(sign in|登录|登入)$/i.test((el.textContent || "").trim())
      );
      const signOutCta = ctas.filter((el) =>
        /^(sign out|退出|log out)$/i.test((el.textContent || "").trim())
      );

      const onAuthUrl = /idmsa\\.apple\\.com|appleid\\.apple\\.com\\/sign-in|authorize\\/signin/i.test(href);
      const onManage = /\\/account\\/manage/i.test(path);

      const body = document.body?.innerText?.slice(0, 2500) || "";
      const manageMarkers =
        onManage &&
        /account settings|账户设置|personal information|个人信息|subscriptions|订阅|sign out|退出/i.test(
          body
        );

      return {
        href,
        path,
        onAuthUrl,
        onManage,
        hasVisibleEmail: isVisible(emailEl),
        hasVisiblePassword: isVisible(passEl),
        signInCtaCount: signInCta.length,
        signOutCtaCount: signOutCta.length,
        manageMarkers,
      };
    })())`,
    context
  );

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch {
    return { href: "", path: "", parseError: true };
  }
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} [context]
 */
export async function hasInteractableLoginForm(bidi, context) {
  for (const sel of LOGIN_FIELD_SELECTORS) {
    const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
    if (!found?.nodes?.length) continue;
    const state = await readInputState(bidi, found.context, sel);
    if (state.interactable) {
      return { yes: true, selector: sel, context: found.context, state };
    }
  }
  return { yes: false };
}

/**
 * 通过访问受保护页面探测是否已登录（唯一可靠方式）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {{ settleMs?: number }} [opts]
 */
export async function probeBrowserAccountSession(bidi, context, opts = {}) {
  const settleMs = opts.settleMs ?? 2800;

  await bidi.navigate(ACCOUNT_MANAGE_URL, context);
  await sleep(settleMs);

  const page = await evaluatePageSession(bidi, context);
  const loginForm = await hasInteractableLoginForm(bidi, context);

  if (loginForm.yes) {
    return {
      signedIn: false,
      reason: `login-form-interactable:${loginForm.selector}`,
      page,
      loginForm,
    };
  }

  if (page.onAuthUrl) {
    return { signedIn: false, reason: "redirected-to-auth-url", page, loginForm };
  }

  if (page.hasVisibleEmail || page.hasVisiblePassword) {
    return { signedIn: false, reason: "visible-login-fields", page, loginForm };
  }

  if (page.onManage && (page.signOutCtaCount > 0 || page.manageMarkers)) {
    return { signedIn: true, reason: "manage-page-authenticated", page, loginForm };
  }

  if (page.signInCtaCount > 0) {
    return { signedIn: false, reason: "sign-in-cta-visible", page, loginForm };
  }

  // 首页或营销页：无登录证明 → 未登录
  return { signedIn: false, reason: "no-authenticated-manage-access", page, loginForm };
}

/**
 * 登录完成后的严格校验（必须能访问 manage 且无登录表单）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 */
export async function assertBrowserAccountSession(bidi, context) {
  const session = await probeBrowserAccountSession(bidi, context);
  if (!session.signedIn) {
    throw new Error(`account 会话无效: ${session.reason}`);
  }
  return session;
}
