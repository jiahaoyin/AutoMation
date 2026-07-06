/**
 * Apple 登录输入：顶层页面操作，避免 iframe XFO；修复 stable 轮询逻辑
 */

import { sleep, randomBetween } from "./human-input-bidi.js";
import { activateFirefoxApp } from "./bidi-client.js";

const INPUT_STATE_SCRIPT = `
(() => {
  const sel = SELECTOR;
  const el = document.querySelector(sel);
  if (!el) return { found: false, selector: sel };

  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const opacity = parseFloat(style.opacity || "1");
  const inViewport =
    rect.width > 2 &&
    rect.height > 2 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth;

  const parentHidden = (() => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = window.getComputedStyle(p);
      if (ps.display === "none" || ps.visibility === "hidden" || parseFloat(ps.opacity || "1") < 0.05) {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  })();

  const ariaHidden = el.getAttribute("aria-hidden") === "true";
  const tabIndex = el.tabIndex;
  const type = (el.type || "").toLowerCase();
  const id = el.id || "";

  const visible =
    inViewport &&
    opacity > 0.1 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    !parentHidden &&
    !ariaHidden &&
    !el.disabled &&
    el.offsetWidth > 0 &&
    el.offsetHeight > 0 &&
    tabIndex !== -1;

  const interactable = visible && !el.readOnly;

  return {
    found: true,
    selector: sel,
    value: el.value ?? "",
    visible,
    interactable,
    type,
    id,
    opacity,
    tabIndex,
    rect: { w: rect.width, h: rect.height, top: rect.top },
    active: document.activeElement === el,
  };
})()
`;

export function isScriptBlockedError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /XFO_VIOLATION|cross-origin|Permission denied|not allowed to access/i.test(msg);
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} selector @param {string} context */
export async function locateInContext(bidi, selector, context) {
  try {
    const nodes = await bidi.locateNodes(selector, context);
    if (!nodes.length) return null;
    const url = String(await bidi.evaluate("location.href", context).catch(() => ""));
    return { nodes, context, url };
  } catch {
    return null;
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string} selector */
export async function readInputState(bidi, context, selector) {
  const expression = `JSON.stringify(${INPUT_STATE_SCRIPT.replace("SELECTOR", JSON.stringify(selector))})`;
  try {
    const raw = await bidi.evaluate(expression, context);
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { found: false };
  } catch (err) {
    if (isScriptBlockedError(err)) {
      return {
        found: true,
        selector,
        value: "",
        visible: true,
        interactable: true,
        scriptBlocked: true,
      };
    }
    throw err;
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
export async function readSignInStep(bidi, context) {
  try {
    const raw = await bidi.evaluate(
      `JSON.stringify((() => {
        const email = document.querySelector("#account_name_text_field");
        const pass = document.querySelector("#password_text_field");
        const stepOf = (el) => {
          if (!el) return "missing";
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const opacity = parseFloat(style.opacity || "1");
          const inViewport =
            rect.width > 2 &&
            rect.height > 2 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight;
          const parentHidden = (() => {
            let p = el.parentElement;
            while (p && p !== document.body) {
              const ps = window.getComputedStyle(p);
              if (ps.display === "none" || ps.visibility === "hidden" || parseFloat(ps.opacity || "1") < 0.05) {
                return true;
              }
              p = p.parentElement;
            }
            return false;
          })();
          const visible =
            inViewport &&
            opacity > 0.1 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            !parentHidden &&
            el.getAttribute("aria-hidden") !== "true" &&
            !el.disabled &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0 &&
            el.tabIndex !== -1;
          const interactable = visible && !el.readOnly;
          return interactable ? "shown" : "hidden";
        };
        const signInBtn = document.getElementById("sign-in");
        const btnText = (signInBtn?.textContent || "").replace(/\\s+/g, " ").trim();
        return {
          email: stepOf(email),
          password: stepOf(pass),
          submitLabel: btnText,
        };
      })())`,
      context
    );
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch (err) {
    if (isScriptBlockedError(err)) return { email: "unknown", password: "unknown", scriptBlocked: true };
    return {};
  }
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {string[]} selectors
 * @param {number} [timeoutMs]
 */
export async function firstInContext(bidi, context, selectors, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const found = await locateInContext(bidi, sel, context);
      if (found?.nodes?.length) return { selector: sel, ...found };
    }
    await sleep(350);
  }
  return null;
}

function fieldMatchesKind(state, sel, kind) {
  if (kind === "email") {
    if (sel.includes("password") || state.type === "password") return false;
    return true;
  }
  if (kind === "password") {
    return sel.includes("password") || state.type === "password";
  }
  return true;
}

/** BiDi 已定位到节点时，合并 evaluate 状态（邮箱可用；密码框常在 DOM 中隐藏，禁止 locateOnly） */
function mergeFieldState(state, sel, found, kind) {
  if (kind === "password") {
    return state.found ? state : { ...state, found: false };
  }
  if (found?.nodes?.length && (!state.found || (!state.interactable && !state.scriptBlocked))) {
    return {
      found: true,
      interactable: true,
      locateOnly: true,
      scriptBlocked: state.scriptBlocked ?? false,
      type: state.type || "text",
      value: state.value ?? "",
      selector: sel,
    };
  }
  if (state.scriptBlocked && kind === "email") {
    return { ...state, locateOnly: true, interactable: true };
  }
  return state;
}

function passwordStepReady(_step, state) {
  return state.interactable === true;
}

function fieldReady(kind, step, state) {
  if (kind === "password") return passwordStepReady(step, state);
  if (kind === "email") {
    if (state.locateOnly || state.scriptBlocked) return true;
    return state.interactable;
  }
  return state.interactable || state.locateOnly;
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string[]} selectors
 */
export async function diagnoseLoginFields(bidi, selectors) {
  const contexts = await bidi.getAllContexts(12);
  const lines = [`BiDi contexts=${contexts.length}`];
  for (const { context, url } of contexts) {
    lines.push(`  ctx url=${url || "(empty)"}`);
  }
  for (const sel of selectors) {
    let hits = 0;
    for (const { context, url } of contexts) {
      try {
        const nodes = await bidi.locateNodes(sel, context);
        if (nodes.length) {
          lines.push(`  ✓ ${sel} → ${url || context}`);
          hits++;
        }
      } catch {
        /* skip */
      }
    }
    if (!hits) lines.push(`  ✗ ${sel} → 无匹配`);
  }
  return lines.join("\n");
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string[]} selectors
 * @param {number} [timeoutMs]
 */
export async function firstInAnyContext(bidi, selectors, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
      if (found?.nodes?.length) return { selector: sel, ...found };
    }
    await sleep(350);
  }
  return null;
}

const PASSWORD_FIELD_SELECTOR = "#password_text_field";

/** 密码步骤就绪：密码框可交互，或主按钮已变为「登录」（不能仅凭 DOM 中隐藏的密码框） */
export async function isPasswordStepReady(bidi, context) {
  const passState = await readInputState(bidi, context, PASSWORD_FIELD_SELECTOR).catch(() => ({
    interactable: false,
  }));
  if (passState.interactable) return true;

  const btn = await findContinueButtonInfo(bidi, context);
  if (btn.found && /^(登录|登入|sign in)$/i.test(btn.text || "")) return true;

  const step = await readSignInStep(bidi, context);
  if (/^(登录|登入|sign in)$/i.test(step.submitLabel || "")) return true;

  return false;
}

/**
 * 轮询直到密码步骤就绪（邮箱可与密码同屏）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {number} timeoutMs
 */
export async function waitForPasswordStepUi(bidi, context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPasswordStepReady(bidi, context)) {
      return readSignInStep(bidi, context);
    }
    await sleep(300);
  }
  return null;
}

const CONTINUE_SELECTORS = [
  "#sign-in",
  'button#sign-in',
  "button.si-button.signin-button",
  "button.si-button",
  'button[type="submit"]',
  'input[type="submit"]',
];

const FIND_CONTINUE_BUTTON_SCRIPT = `
(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    if (r.width < 2 || r.height < 2) return false;
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity || "1") < 0.1) return false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = window.getComputedStyle(p);
      if (ps.display === "none" || ps.visibility === "hidden") return false;
      p = p.parentElement;
    }
    return true;
  };

  const textOf = (el) =>
    (el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();

  const isDisabled = (el) =>
    el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("disabled");

  const toInfo = (el, reason) => ({
    found: true,
    id: el.id || "",
    selector: el.id ? "#" + el.id : null,
    text: textOf(el),
    tag: el.tagName,
    reason,
    disabled: isDisabled(el),
    visible: isVisible(el),
  });

  const scored = [];

  const byId = document.getElementById("sign-in");
  if (byId && isVisible(byId)) scored.push(toInfo(byId, "id-sign-in"));

  for (const el of document.querySelectorAll(
    "button, input[type=submit], [role=button]"
  )) {
    if (!isVisible(el)) continue;
    const t = textOf(el).toLowerCase();
    if (/^(continue|继续|next|下一步|sign in|登录|登入)$/.test(t)) {
      scored.push(toInfo(el, "text"));
    } else if (el.classList.contains("signin-button") || el.classList.contains("si-button")) {
      scored.push(toInfo(el, "class"));
    }
  }

  scored.sort((a, b) => {
    const rank = (x) =>
      x.reason === "id-sign-in" ? 0 : x.reason === "text" ? 1 : x.reason === "class" ? 2 : 3;
    return rank(a) - rank(b) || Number(a.disabled) - Number(b.disabled);
  });

  if (!scored.length) return { found: false, candidates: 0 };
  return scored[0];
})()
`;

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
async function findContinueButtonInfo(bidi, context) {
  try {
    const raw = await bidi.evaluate(`JSON.stringify(${FIND_CONTINUE_BUTTON_SCRIPT})`, context);
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { found: false };
  } catch {
    return { found: false };
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {number} timeoutMs */
async function waitForContinueButtonReady(bidi, context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await findContinueButtonInfo(bidi, context);
    if (info.found && info.visible && !info.disabled) return info;
    await sleep(400);
  }
  return findContinueButtonInfo(bidi, context);
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
async function diagnoseContinueButtons(bidi, context) {
  try {
    const raw = await bidi.evaluate(
      `JSON.stringify((() => {
        const rows = [];
        for (const el of document.querySelectorAll("button, input[type=submit], #sign-in")) {
          const r = el.getBoundingClientRect();
          rows.push({
            id: el.id || "",
            text: (el.textContent || el.value || "").trim().slice(0, 40),
            disabled: el.disabled,
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
        return rows;
      })())`,
      context
    );
    const rows = typeof raw === "string" ? JSON.parse(raw) : raw;
    return "[Firefox] 继续按钮诊断: " + JSON.stringify(rows);
  } catch (err) {
    return `[Firefox] 继续按钮诊断失败: ${err instanceof Error ? err.message : err}`;
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {object} info */
async function clickContinueViaScript(bidi, context, info) {
  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
      };
      const pick = () => {
        const id = ${JSON.stringify(info.id || "")};
        if (id) {
          const el = document.getElementById(id);
          if (el && isVisible(el)) return el;
        }
        const sel = ${JSON.stringify(info.selector || "")};
        if (sel) {
          const el = document.querySelector(sel);
          if (el && isVisible(el)) return el;
        }
        for (const el of document.querySelectorAll("button, input[type=submit]")) {
          const t = (el.textContent || el.value || "").trim();
          if (/^(继续|Continue|Next|下一步)$/i.test(t) && isVisible(el)) return el;
        }
        const si = document.getElementById("sign-in");
        if (si && isVisible(si)) return si;
        return null;
      };
      const el = pick();
      if (!el) return { ok: false };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.focus();
      el.click();
      return { ok: true, id: el.id, text: (el.textContent || "").trim() };
    })())`,
    context
  );
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  return result?.ok === true;
}

const REMEMBER_ACCOUNT_SELECTORS = [
  "#remember-me",
  "input#remember-me",
  'input[name="rememberMe"]',
  'input[type="checkbox"][id*="remember"]',
];

/**
 * 勾选「记住我的账户」（密码框下方，登录前）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string} context
 */
export async function ensureRememberAccountChecked(bidi, human, context) {
  human.setContext(context);

  const readChecked = async (sel) => {
    try {
      const raw = await bidi.evaluate(
        `JSON.stringify((() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          return { found: true, checked: !!el.checked };
        })())`,
        context
      );
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  };

  for (const sel of REMEMBER_ACCOUNT_SELECTORS) {
    const state = await readChecked(sel);
    if (!state?.found) continue;
    if (state.checked) {
      console.log("[Firefox] ✓ 记住我的账户 已勾选");
      return;
    }

    console.log("[Firefox] 勾选「记住我的账户」…");
    const located = await firstInContext(bidi, context, [sel], 4000);
    if (located?.nodes?.length) {
      await human.clickElement(located.nodes[0]);
    } else {
      await bidi.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); })()`,
        context
      );
    }
    await sleep(350);
    const after = await readChecked(sel);
    if (after?.checked) {
      console.log("[Firefox] ✓ 已勾选「记住我的账户」");
      return;
    }
  }

  try {
    const ok = await bidi.evaluate(
      `(() => {
        for (const lbl of document.querySelectorAll("label")) {
          if (!/记住|remember/i.test(lbl.textContent || "")) continue;
          const id = lbl.getAttribute("for");
          const cb = id ? document.getElementById(id) : lbl.querySelector("input[type=checkbox]");
          if (!cb) continue;
          if (!cb.checked) cb.click();
          return cb.checked;
        }
        return false;
      })()`,
      context
    );
    if (ok) console.log("[Firefox] ✓ 已勾选「记住我的账户」(label)");
    else console.warn("[Firefox] 未找到「记住我的账户」勾选框，继续登录…");
  } catch {
    console.warn("[Firefox] 勾选「记住我的账户」失败，继续登录…");
  }
}

/**
 * 点击「登录」提交（#sign-in 在密码步骤文案为登录）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string} context
 */
export async function clickLoginSubmitButton(bidi, human, context) {
  human.setContext(context);

  const info = await findContinueButtonInfo(bidi, context);
  const step = await readSignInStep(bidi, context);
  const label = (info?.text || step.submitLabel || "").trim();

  if (!/^(登录|登入|sign in)$/i.test(label)) {
    throw new Error(`登录按钮未就绪，当前主按钮文案: "${label}"`);
  }

  console.log(`[Firefox] JS 点击登录 ${info?.selector || "#sign-in"}…`);
  const jsOk = await clickContinueViaScript(bidi, context, info || { id: "sign-in", selector: "#sign-in" });
  if (!jsOk) throw new Error("JS 点击登录失败");

  await sleep(randomBetween(400, 800));

  const located = await firstInContext(bidi, context, ["#sign-in", "button#sign-in"], 3000);
  if (located?.nodes?.length) {
    await human.clickElement(located.nodes[0]).catch(() => {});
  }

  console.log("[Firefox] ✓ 已点击登录");
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string} emailSelector */
async function nudgeEmailValidation(bidi, context, emailSelector) {
  try {
    await bidi.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(emailSelector)});
        if (!el) return false;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      })()`,
      context
    );
  } catch {
    /* ignore */
  }
}

/**
 * 点击「继续」并等待密码步骤 UI 出现（禁止在 email 步骤填密码）
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string} emailContext 邮箱所在 browsing context
 * @param {{ emailSelector?: string, emailNode?: {sharedId: string}, continueSelectors?: string[] }} [opts]
 */
export async function clickContinueAndWaitForPasswordStep(
  bidi,
  human,
  emailContext,
  opts = {}
) {
  const emailSelector = opts.emailSelector ?? "#account_name_text_field";
  const emailNode = opts.emailNode ?? null;

  human.setContext(emailContext);
  await nudgeEmailValidation(bidi, emailContext, emailSelector);

  const btnInfo = await waitForContinueButtonReady(bidi, emailContext, 12_000);
  if (btnInfo?.found) {
    console.log(
      `[Firefox] 继续按钮: ${btnInfo.selector || btnInfo.id || btnInfo.reason} ` +
        `text="${btnInfo.text || ""}" enabled=${!btnInfo.disabled}`
    );
  } else {
    console.warn("[Firefox] 未探测到可见继续按钮");
    console.warn(await diagnoseContinueButtons(bidi, emailContext));
  }

  const tryFinish = async (label) => {
    const passState = await readInputState(bidi, emailContext, PASSWORD_FIELD_SELECTOR).catch(() => ({
      interactable: false,
    }));
    if (!(await isPasswordStepReady(bidi, emailContext))) return null;
    const step = await readSignInStep(bidi, emailContext);
    console.log(
      `[Firefox] ✓ ${label}（password interactable=${!!passState.interactable} ` +
        `btn="${step.submitLabel || ""}"）`
    );
    return { context: emailContext, step };
  };

  const already = await tryFinish("已在密码步骤");
  if (already) return already;

  const clickContinueJs = async () => {
    const info = await findContinueButtonInfo(bidi, emailContext);
    if (!info?.found || !/^(继续|continue|next|下一步)$/i.test(info.text || "")) {
      console.warn("[Firefox] 无「继续」按钮可点");
      return false;
    }
    console.log(`[Firefox] JS 点击继续 ${info.selector || info.id}…`);
    return clickContinueViaScript(bidi, emailContext, info);
  };

  const submitEmailEnter = async () => {
    console.log("[Firefox] 邮箱框 Enter 提交…");
    if (emailNode) {
      await human.clickElement(emailNode).catch(() => human.focusInputBySelector(emailSelector));
    } else {
      await human.focusInputBySelector(emailSelector);
    }
    await sleep(randomBetween(200, 450));
    await human.pressEnter();
    return true;
  };

  const clickContinuePointer = async () => {
    const info = await findContinueButtonInfo(bidi, emailContext);
    if (!info?.found) return false;
    const selectors = [info.selector, info.id ? `#${info.id}` : null, "#sign-in"].filter(Boolean);
    const located = await firstInContext(bidi, emailContext, selectors, 4000);
    if (!located?.nodes?.length) return false;
    console.log(`[Firefox] 指针点击继续 (${located.selector})…`);
    await human.clickElement(located.nodes[0]);
    return true;
  };

  const strategies = [
    { name: "JS 点击继续", run: clickContinueJs },
    { name: "Enter 提交邮箱", run: submitEmailEnter },
    { name: "指针点击继续", run: clickContinuePointer },
  ];

  for (const { name, run } of strategies) {
    await run();
    const step = await waitForPasswordStepUi(bidi, emailContext, 12_000);
    if (step) {
      const done = await tryFinish(name + "后");
      if (done) return done;
    }
    console.warn(`[Firefox] ${name} 后密码步骤未就绪，尝试下一策略…`);
  }

  const step = await readSignInStep(bidi, emailContext);
  const passState = await readInputState(bidi, emailContext, PASSWORD_FIELD_SELECTOR).catch(() => ({}));
  console.warn(await diagnoseContinueButtons(bidi, emailContext));
  throw new Error(
    `点击继续后仍未进入密码步骤 (password interactable=${!!passState.interactable} ` +
      `email=${step.email} password=${step.password} btn="${step.submitLabel || ""}")`
  );
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string[]} selectors
 * @param {number} [timeoutMs]
 * @param {{ kind?: "email" | "password", stablePolls?: number, log?: boolean, contextOnly?: string }} [opts]
 */
export async function waitForVisibleInput(bidi, human, selectors, timeoutMs = 30_000, opts = {}) {
  const kind = opts.kind ?? "any";
  const stablePolls = opts.stablePolls ?? getBrowserConfig().stablePolls;
  const log = opts.log ?? false;
  const contextOnly = opts.contextOnly ?? null;
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const ctx = contextOnly ?? human.context;
    const step = await readSignInStep(bidi, ctx).catch(() => ({}));

    /** @type {object | null} */
    let matched = null;

    for (const sel of selectors) {
      const found = contextOnly
        ? await locateInContext(bidi, sel, contextOnly)
        : await bidi.locateNodesInAnyContext(sel).catch(() => null);
      if (!found?.nodes?.length) continue;

      human.setContext(found.context);
      let state = await readInputState(bidi, found.context, sel).catch(() => ({
        found: false,
      }));
      state = mergeFieldState(state, sel, found, kind);
      if (!fieldMatchesKind(state, sel, kind)) continue;
      if (!fieldReady(kind, step, state)) continue;

      matched = { selector: sel, ...found, state, step };
      break;
    }

    if (matched) {
      stable += 1;
      if (log && Date.now() - lastLog > 1500) {
        console.log(
          `[Firefox] 等待${kind === "password" ? "密码" : "邮箱"}框: stable=${stable}/${stablePolls} ` +
            `email=${step.email} password=${step.password} ctx=${matched.url?.slice(0, 50) || "root"}`
        );
        lastLog = Date.now();
      }
      if (stable >= stablePolls) return matched;
    } else {
      stable = 0;
    }

    await sleep(getBrowserConfig().pollIntervalMs + Math.random() * 200);
  }
  return null;
}

/** 点击继续后等待密码步骤 */
export async function waitForPasswordStepAfterContinue(bidi, human, _context, timeoutMs) {
  const cfg = getBrowserConfig();
  console.log(`[Firefox] 继续后最少等待 ${cfg.minAfterContinueMs}ms…`);
  await sleep(cfg.minAfterContinueMs);

  return waitForVisibleInput(bidi, human, PASS_SELECTORS, timeoutMs, {
    kind: "password",
    stablePolls: cfg.stablePolls,
    log: true,
  });
}

export function getBrowserConfig() {
  const num = (key, fallback) => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    pollIntervalMs: num("BROWSER_POLL_MS", 400),
    stablePolls: num("BROWSER_STABLE_POLLS", 2),
    minAfterContinueMs: num("BROWSER_AFTER_CONTINUE_MS", 2500),
    pageSettleMinMs: num("BROWSER_PAGE_SETTLE_MIN_MS", 3500),
    pageSettleMaxMs: num("BROWSER_PAGE_SETTLE_MAX_MS", 5500),
    passwordWaitMs: num("BROWSER_PASSWORD_WAIT_MS", 45_000),
    emailWaitMs: num("BROWSER_EMAIL_WAIT_MS", 45_000),
    signInUrl: process.env.BROWSER_SIGN_IN_URL || "https://appleid.apple.com/sign-in",
  };
}

const PASS_SELECTORS = [
  "#password_text_field",
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
];

export async function fillInputViaScript(bidi, context, selector, value) {
  const state = await readInputState(bidi, context, selector);
  if (state.scriptBlocked) return { ok: false, reason: "script-blocked", state };
  if (!state.interactable) return { ok: false, reason: "not interactable", state };

  try {
    const raw = await bidi.evaluate(
      `JSON.stringify((() => {
        const sel = ${JSON.stringify(selector)};
        const text = ${JSON.stringify(value)};
        const el = document.querySelector(sel);
        if (!el) return { ok: false, reason: "element not found" };

        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.focus();
        el.click?.();

        const proto = window.HTMLInputElement?.prototype;
        const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) {
          desc.set.call(el, "");
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        } else {
          el.value = "";
        }

        if (desc?.set) {
          desc.set.call(el, text);
        } else {
          el.value = text;
        }

        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        return { ok: true, value: el.value ?? "" };
      })())`,
      context
    );
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { ok: false };
  } catch (err) {
    if (isScriptBlockedError(err)) return { ok: false, reason: "script-blocked" };
    throw err;
  }
}

/**
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} selector
 * @param {string} value
 * @param {string} label
 * @param {{sharedId: string}} [node]
 */
export async function fillInputWithVerify(human, bidi, selector, value, label, node) {
  const context = human.context;
  let state = await readInputState(bidi, context, selector);

  if (!state.found && !node) throw new Error(`${label}：未找到元素 ${selector}`);

  console.log(`[Firefox] 填写 ${label}（${selector}）…`);

  const inputNode = node ?? (await locateInContext(bidi, selector, context))?.nodes?.[0];
  if (!inputNode) throw new Error(`${label}：无 BiDi 节点 ${selector}`);

  await human.clickElement(inputNode);
  await sleep(randomBetween(250, 500));

  if (!state.scriptBlocked) {
    const js = await fillInputViaScript(bidi, context, selector, value);
    await sleep(randomBetween(300, 600));
    state = await readInputState(bidi, context, selector);
    if (state.value === value || (value.length > 3 && state.value?.includes(value.slice(0, 3)))) {
      console.log(`[Firefox] ✓ ${label} 已填入 (${state.value.length} 字符)`);
      return state;
    }
    if (js.ok && js.value === value) {
      console.log(`[Firefox] ✓ ${label} JS 填入成功`);
      return { ...state, value: js.value };
    }
  }

  console.log(`[Firefox] 使用 BiDi 键盘输入 ${label}…`);
  await human.clickElement(inputNode);
  await human.typeText(value, { slow: true });
  await sleep(randomBetween(400, 700));

  if (!state.scriptBlocked) {
    state = await readInputState(bidi, context, selector);
    if (state.value === value || (value.length > 3 && state.value?.includes(value.slice(0, 3)))) {
      console.log(`[Firefox] ✓ ${label} 键盘输入成功 (${state.value?.length} 字符)`);
      return state;
    }
    throw new Error(`${label} 填入失败：读回 "${state.value ?? ""}"`);
  }

  console.log(`[Firefox] ✓ ${label} 已通过 BiDi 输入 (${value.length} 字符，XFO 环境无法读回校验)`);
  return { ...state, value, bidiOnly: true };
}

const SECURITY_CODE_SELECTORS = [
  ".form-security-code-input input",
  "input.form-security-code-input",
  'input[autocomplete="one-time-code"]',
  'input[name="securityCode"]',
  'input[inputmode="numeric"]',
  ".form-security-code input",
  'input[type="tel"]',
  'input[pattern="[0-9]*"]',
];

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {string} selector
 * @param {string} digits
 */
function buildUniversal2FAFillScript(digits) {
  return `JSON.stringify((() => {
    const digits = ${JSON.stringify(digits)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      const op = parseFloat(s.opacity || "1");
      return (
        r.width > 2 &&
        r.height > 2 &&
        r.bottom > 0 &&
        r.top < window.innerHeight &&
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        op > 0.1 &&
        !el.disabled &&
        el.tabIndex !== -1
      );
    };
    const byPos = (arr) =>
      arr.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.top - rb.top || ra.left - rb.left;
      });
    const allInputs = byPos([...document.querySelectorAll("input")].filter(visible));
    const singles = allInputs.filter((el) => el.maxLength === 1 || el.getAttribute("maxlength") === "1");
    const on2FAPage = /双重|验证码|verification|security code/i.test(document.body?.innerText || "");
    let targets = singles.length >= 6 ? singles.slice(0, 6) : null;
    if (!targets) {
      const sec = byPos(
        allInputs.filter(
          (el) =>
            /security|code|otp/i.test(
              (el.className || "") + (el.name || "") + (el.id || "") + (el.autocomplete || "")
            ) || el.getAttribute("inputmode") === "numeric"
        )
      );
      if (sec.length >= 6) targets = sec.slice(0, 6);
      else if (sec.length === 1) {
        const el = sec[0];
        el.focus();
        el.click();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (desc?.set) desc.set.call(el, digits);
        else el.value = digits;
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: digits, inputType: "insertFromPaste" })
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, mode: "single-security", value: el.value };
      }
    }
    if (!targets && on2FAPage) {
      const numeric = allInputs.filter(
        (el) => el.type !== "password" && el.type !== "email" && el.type !== "checkbox"
      );
      if (numeric.length >= 6) targets = numeric.slice(0, 6);
    }
    if (!targets || targets.length < 6) {
      return { ok: false, reason: "no-six-inputs", count: allInputs.length, on2FAPage };
    }
    const fire = (el, ch) => {
      el.focus();
      el.click();
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: ch, code: "Digit" + ch, bubbles: true, cancelable: true })
      );
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (desc?.set) desc.set.call(el, ch);
      else el.value = ch;
      el.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch })
      );
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: "Digit" + ch, bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    for (let i = 0; i < 6; i++) fire(targets[i], digits[i]);
    const values = targets.map((el) => el.value);
    const filled = values.join("").replace(/\\D/g, "");
    return { ok: filled.length === 6, mode: "universal-six", values, filled };
  })())`;
}

async function fill2FAViaScript(bidi, context, selector, digits) {
  try {
    const raw = await bidi.evaluate(
      `JSON.stringify((() => {
        const digits = ${JSON.stringify(digits)};
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
        };
        const inputs = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(visible);
        const setVal = (el, ch) => {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (desc?.set) desc.set.call(el, ch);
          else el.value = ch;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (inputs.length >= 6) {
          for (let i = 0; i < 6; i++) setVal(inputs[i], digits[i]);
          return { ok: true, mode: "six-box", values: inputs.slice(0, 6).map((el) => el.value) };
        }
        if (inputs.length >= 1) {
          setVal(inputs[0], digits);
          return { ok: true, mode: "single", value: inputs[0].value };
        }
        return { ok: false };
      })())`,
      context
    );
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
    return result?.ok === true ? result : null;
  } catch (err) {
    if (isScriptBlockedError(err)) return null;
    throw err;
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} digits */
async function fill2FAUniversalInAnyContext(bidi, digits) {
  const contexts = await bidi.getAllContexts(8);
  const ordered = [...contexts].sort((a, b) => {
    const score = (u) =>
      /idmsa|appleid|auth/i.test(u) ? 0 : /account\.apple\.com/i.test(u) ? 1 : 2;
    return score(a.url) - score(b.url);
  });

  for (const { context, url } of ordered) {
    try {
      const raw = await bidi.evaluate(buildUniversal2FAFillScript(digits), context);
      const result = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (result?.ok) return { ...result, context, url };
    } catch (err) {
      if (!isScriptBlockedError(err)) throw err;
    }
  }
  return null;
}

/**
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 */
async function submit2FAStep(human, bidi, context) {
  human.setContext(context);
  await sleep(300);
  await human.pressEnter();
  await sleep(400);
  try {
    await bidi.evaluate(
      `(() => {
        const btn = document.querySelector("#sign-in, button[type=submit], button.si-button");
        if (btn) btn.click();
      })()`,
      context
    );
  } catch {
    /* ignore */
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi */
async function discover2FAInputs(bidi) {
  const contexts = await bidi.getAllContexts(8);
  const ordered = [...contexts].sort((a, b) => {
    const score = (u) =>
      /idmsa|appleid|auth/i.test(u) ? 0 : /account\.apple\.com/i.test(u) ? 1 : 2;
    return score(a.url) - score(b.url);
  });

  for (const sel of SECURITY_CODE_SELECTORS) {
    for (const { context, url } of ordered) {
      try {
        const nodes = await bidi.locateNodes(sel, context);
        if (nodes.length >= 6 || nodes.length === 1) {
          return { selector: sel, nodes, context, url, count: nodes.length };
        }
      } catch {
        /* try next */
      }
    }
  }

  const probe = `JSON.stringify((() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
    };
    const singles = [...document.querySelectorAll('input[maxlength="1"], input[maxLength="1"]')].filter(visible);
    const on2FA = /双重|验证码|verification code|security code/i.test(document.body?.innerText || "");
    if (on2FA && singles.length >= 6) {
      return { ok: true, selector: 'input[maxlength="1"]', count: singles.length };
    }
    return { ok: false };
  })())`;

  for (const { context, url } of ordered) {
    try {
      const raw = await bidi.evaluate(probe, context);
      const hit = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!hit?.ok) continue;
      const nodes = await bidi.locateNodes(hit.selector, context);
      if (nodes.length >= 6) {
        return { selector: hit.selector, nodes: nodes.slice(0, 6), context, url, count: 6 };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** @param {import("./bidi-client.js").BidiClient} bidi */
async function probe2FAPageState(bidi) {
  const contexts = await bidi.getAllContexts(8);
  let on2FAPage = false;
  let errorText = null;
  let trustBrowser = false;

  for (const { context } of contexts) {
    try {
      const raw = await bidi.evaluate(
        `JSON.stringify((() => {
          const body = document.body?.innerText || "";
          return {
            err: /不正确|错误|无效|incorrect|invalid|try again|doesn.?t match/i.test(body),
            twofa: /双重|验证码|verification code|security code/i.test(body),
            trust: /信任此浏览器|trust this browser|trust.*browser/i.test(body),
            snippet: body.slice(0, 400),
          };
        })())`,
        context
      );
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (s?.trust) trustBrowser = true;
      if (s?.twofa) on2FAPage = true;
      if (s?.err) {
        errorText =
          s.snippet?.match(/[^\n]{0,60}(不正确|错误|incorrect|invalid)[^\n]{0,60}/i)?.[0] ||
          "验证码被拒绝";
      }
    } catch {
      /* ignore */
    }
  }

  return { on2FAPage, errorText, trustBrowser };
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {number} [timeoutMs]
 */
async function waitFor2FAOutcome(bidi, timeoutMs = 22_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await probe2FAPageState(bidi);
    if (state.errorText) {
      return { ok: false, reason: state.errorText };
    }
    if (state.trustBrowser) {
      return { ok: true, phase: "trust" };
    }
    if (!state.on2FAPage) {
      return { ok: true, phase: "left-2fa" };
    }
    await sleep(500);
  }
  const final = await probe2FAPageState(bidi);
  if (final.errorText) return { ok: false, reason: final.errorText };
  if (!final.on2FAPage || final.trustBrowser) return { ok: true, phase: "timeout-assume-ok" };
  return { ok: false, reason: "2FA 页未跳转（可能未成功提交）" };
}

/**
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {{ selector: string, nodes: object[], context: string, url?: string }} fieldset
 * @param {string} digits
 */
async function fill2FAViaKeyboard(human, bidi, fieldset, digits) {
  human.setContext(fieldset.context);
  const inputs = fieldset.nodes.slice(0, 6);

  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i++) {
      await human.clickElement(inputs[i]);
      await sleep(60);
      await human.typeText(digits[i], { fast: true });
      await sleep(40);
    }
    console.log(`[Firefox] ✓ 2FA 键盘逐格填入 (${fieldset.selector})`);
    await sleep(300);
    await human.pressEnter();
    return;
  }

  await human.clickElement(inputs[0]);
  await sleep(100);
  await human.typeText(digits, { fast: true });
  await sleep(300);
  await human.pressEnter();
  console.log(`[Firefox] ✓ 2FA 键盘单框填入 (${fieldset.selector})`);
}

/**
 * 尽快将 6 位 2FA 填入网页（BiDi 真实键盘，避免 JS 只改 DOM 不更新 React 状态）
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} code
 */
export async function fillWebSecurityCode(human, bidi, code) {
  const digits = String(code).replace(/\D/g, "").slice(0, 6);
  if (digits.length !== 6) throw new Error(`2FA 验证码格式错误: ${code}`);

  console.log(`[Firefox] 立即填入 2FA（键盘）: ${digits}`);
  await activateFirefoxApp();
  await sleep(200);

  const deadline = Date.now() + 15_000;
  let fieldset = null;
  while (Date.now() < deadline) {
    fieldset = await discover2FAInputs(bidi);
    if (fieldset) break;
    await sleep(250);
  }
  if (!fieldset) {
    throw new Error("未找到网页 2FA 验证码输入框（请确认浏览器仍在双重认证页）");
  }

  console.log(
    `[Firefox] 2FA 框: ${fieldset.selector} ×${fieldset.count} ctx=${fieldset.url?.slice(0, 55) || "root"}`
  );

  await fill2FAViaKeyboard(human, bidi, fieldset, digits);

  const outcome = await waitFor2FAOutcome(bidi);
  if (!outcome.ok) {
    throw new Error(`2FA 提交失败: ${outcome.reason}（已填 ${digits}，请核对弹窗原文是否一致）`);
  }

  console.log(`[Firefox] ✓ 2FA 已通过 (${outcome.phase})`);
  return { context: fieldset.context, digits, method: "keyboard", phase: outcome.phase };
}

export { PASS_SELECTORS };
