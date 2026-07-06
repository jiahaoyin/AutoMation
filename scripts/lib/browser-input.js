/**
 * Apple 登录 iframe 输入状态检测与分步等待
 */

import { sleep, randomBetween } from "./human-input-bidi.js";

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

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string} selector */
export async function readInputState(bidi, context, selector) {
  const expression = `JSON.stringify(${INPUT_STATE_SCRIPT.replace("SELECTOR", JSON.stringify(selector))})`;
  const raw = await bidi.evaluate(expression, context);
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { found: false };
  } catch {
    return { found: false };
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
export async function readSignInStep(bidi, context) {
  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const email = document.querySelector("#account_name_text_field");
      const pass = document.querySelector("#password_text_field");
      const stepOf = (el) => {
        if (!el) return "missing";
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const op = parseFloat(s.opacity || "1");
        const shown =
          r.width > 2 &&
          r.height > 2 &&
          op > 0.1 &&
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          el.tabIndex !== -1 &&
          el.getAttribute("aria-hidden") !== "true";
        return shown ? "shown" : "hidden";
      };
      return {
        email: stepOf(email),
        password: stepOf(pass),
        bodySnippet: (document.body?.innerText || "").slice(0, 200),
      };
    })())`,
    context
  );
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch {
    return {};
  }
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {string[]} selectors
 * @param {number} [timeoutMs]
 * @param {{ kind?: "email" | "password", stablePolls?: number, log?: boolean }} [opts]
 */
export async function waitForVisibleInput(bidi, human, selectors, timeoutMs = 30_000, opts = {}) {
  const kind = opts.kind ?? "any";
  const stablePolls = opts.stablePolls ?? getBrowserConfig().stablePolls;
  const log = opts.log ?? false;
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const step = await readSignInStep(bidi, human.context).catch(() => ({}));

    for (const sel of selectors) {
      const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
      if (!found?.nodes?.length) continue;
      human.setContext(found.context);
      const state = await readInputState(bidi, found.context, sel);

      if (kind === "email" && state.type === "password") continue;
      if (kind === "password" && state.type !== "password" && !sel.includes("password")) continue;

      if (kind === "password") {
        const emailHidden = step.email === "hidden" || step.email === "missing";
        const passShown = step.password === "shown";
        if (!passShown && !emailHidden) {
          stable = 0;
          continue;
        }
        if (!state.interactable) {
          stable = 0;
          continue;
        }
      } else if (!state.interactable) {
        stable = 0;
        continue;
      }

      stable += 1;
      if (log && Date.now() - lastLog > 2000) {
        console.log(
          `[Firefox] 等待${kind === "password" ? "密码" : "邮箱"}框: stable=${stable}/${stablePolls} ` +
            `email=${step.email} password=${step.password} interactable=${state.interactable}`
        );
        lastLog = Date.now();
      }

      if (stable >= stablePolls) {
        return { selector: sel, ...found, state, step };
      }
    }

    stable = 0;
    await sleep(getBrowserConfig().pollIntervalMs + Math.random() * 200);
  }
  return null;
}

/** 点击继续后等待密码步骤真正展示 */
export async function waitForPasswordStepAfterContinue(bidi, human, timeoutMs) {
  const cfg = getBrowserConfig();
  const minWait = cfg.minAfterContinueMs;
  console.log(`[Firefox] 继续后最少等待 ${minWait}ms，再检测密码步骤…`);
  await sleep(minWait);

  const field = await waitForVisibleInput(bidi, human, PASS_SELECTORS, timeoutMs, {
    kind: "password",
    stablePolls: cfg.stablePolls,
    log: true,
  });
  return field;
}

export function getBrowserConfig() {
  const num = (key, fallback) => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    pollIntervalMs: num("BROWSER_POLL_MS", 500),
    stablePolls: num("BROWSER_STABLE_POLLS", 4),
    minAfterContinueMs: num("BROWSER_AFTER_CONTINUE_MS", 2500),
    pageSettleMinMs: num("BROWSER_PAGE_SETTLE_MIN_MS", 2000),
    pageSettleMaxMs: num("BROWSER_PAGE_SETTLE_MAX_MS", 4000),
    passwordWaitMs: num("BROWSER_PASSWORD_WAIT_MS", 45_000),
    emailWaitMs: num("BROWSER_EMAIL_WAIT_MS", 25_000),
  };
}

const PASS_SELECTORS = [
  "#password_text_field",
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
];

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {string} selector
 * @param {string} value
 */
export async function fillInputViaScript(bidi, context, selector, value) {
  const state = await readInputState(bidi, context, selector);
  if (!state.interactable) {
    return { ok: false, reason: "not interactable", state };
  }

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

      return {
        ok: true,
        value: el.value ?? "",
        active: document.activeElement === el,
      };
    })())`,
    context
  );

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { ok: false };
  } catch {
    return { ok: false, reason: "parse error" };
  }
}

/**
 * @param {import("./human-input-bidi.js").HumanInput} human
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} selector
 * @param {string} value
 * @param {string} label
 */
export async function fillInputWithVerify(human, bidi, selector, value, label) {
  const context = human.context;

  let state = await readInputState(bidi, context, selector);
  if (!state.found) throw new Error(`${label}：未找到元素 ${selector}`);
  if (!state.interactable) {
    throw new Error(
      `${label}：输入框不可交互 (visible=${state.visible} opacity=${state.opacity} tabIndex=${state.tabIndex})`
    );
  }

  console.log(`[Firefox] 填写 ${label}（${selector}）…`);
  await human.focusInputBySelector(selector);
  await sleep(randomBetween(200, 450));

  await fillInputViaScript(bidi, context, selector, value);
  await sleep(randomBetween(300, 600));
  state = await readInputState(bidi, context, selector);

  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 已填入 (${state.value.length} 字符)`);
    return state;
  }

  console.warn(`[Firefox] JS 填 ${label} 未生效 (读回: "${state.value}")，尝试键盘输入…`);
  await human.focusInputBySelector(selector);
  await human.typeText(value, { slow: true });
  await sleep(randomBetween(400, 700));
  state = await readInputState(bidi, context, selector);

  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 键盘输入成功`);
    return state;
  }

  await fillInputViaScript(bidi, context, selector, value);
  state = await readInputState(bidi, context, selector);
  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 二次 JS 填入成功`);
    return state;
  }

  throw new Error(
    `${label} 填入失败：期望 ${value.length} 字符，读回 "${state.value}" (${selector})`
  );
}

export { PASS_SELECTORS };
