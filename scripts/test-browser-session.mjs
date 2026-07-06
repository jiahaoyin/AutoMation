/**
 * browser-session 单元测试（纯逻辑，不启动浏览器）
 */
import { strict as assert } from "node:assert";

function classifySession(page, loginFormInteractable) {
  if (loginFormInteractable) {
    return { signedIn: false, reason: "login-form-interactable" };
  }
  if (page.onAuthUrl) {
    return { signedIn: false, reason: "redirected-to-auth-url" };
  }
  if (page.hasVisibleEmail || page.hasVisiblePassword) {
    return { signedIn: false, reason: "visible-login-fields" };
  }
  if (page.onManage && (page.signOutCtaCount > 0 || page.manageMarkers)) {
    return { signedIn: true, reason: "manage-page-authenticated" };
  }
  if (page.signInCtaCount > 0) {
    return { signedIn: false, reason: "sign-in-cta-visible" };
  }
  return { signedIn: false, reason: "no-authenticated-manage-access" };
}

// 首页营销文案含「个人信息」但无 manage 权限 → 未登录
const homepageGuest = classifySession(
  {
    path: "/",
    onAuthUrl: false,
    onManage: false,
    hasVisibleEmail: false,
    hasVisiblePassword: false,
    signInCtaCount: 1,
    signOutCtaCount: 0,
    manageMarkers: false,
  },
  false
);
assert.equal(homepageGuest.signedIn, false);
assert.equal(homepageGuest.reason, "sign-in-cta-visible");

// 旧逻辑误判：body 含「个人信息」marketing
const oldFalsePositive = classifySession(
  {
    path: "/",
    onManage: false,
    manageMarkers: false,
    signInCtaCount: 0,
    signOutCtaCount: 0,
    onAuthUrl: false,
    hasVisibleEmail: false,
    hasVisiblePassword: false,
  },
  false
);
assert.equal(oldFalsePositive.signedIn, false);

// 真正已登录
const authed = classifySession(
  {
    path: "/account/manage",
    onManage: true,
    manageMarkers: true,
    signOutCtaCount: 1,
    signInCtaCount: 0,
    onAuthUrl: false,
    hasVisibleEmail: false,
    hasVisiblePassword: false,
  },
  false
);
assert.equal(authed.signedIn, true);

// 跳转登录页
const authWall = classifySession(
  {
    path: "/auth",
    onAuthUrl: true,
    onManage: false,
    manageMarkers: false,
    signInCtaCount: 0,
    signOutCtaCount: 0,
    hasVisibleEmail: false,
    hasVisiblePassword: false,
  },
  false
);
assert.equal(authWall.signedIn, false);

console.log("browser-session logic: ok");
