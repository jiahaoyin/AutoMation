/**
 * Apple 登录输入：顶层页面操作，避免 iframe XFO；修复 stable 轮询逻辑
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

/** BiDi 已定位到节点时，合并 evaluate 状态（iframe / XFO 时 evaluate 可能不可用） */
function mergeFieldState(state, sel, found) {
  if (found?.nodes?.length && (!state.found || (!state.interactable && !state.scriptBlocked))) {
    return {
      found: true,
      interactable: true,
      locateOnly: true,
      scriptBlocked: state.scriptBlocked ?? false,
      type: sel.includes("password") ? "password" : state.type || "text",
      value: state.value ?? "",
      selector: sel,
    };
  }
  if (state.scriptBlocked) return { ...state, locateOnly: true, interactable: true };
  return state;
}

function fieldReady(kind, step, state) {
  if (state.locateOnly || state.scriptBlocked) return true;
  if (kind === "password") return passwordStepReady(step, state);
  return state.interactable;
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

function passwordStepReady(step, state) {
  const emailHidden = step.email === "hidden" || step.email === "missing" || step.scriptBlocked;
  const passShown = step.password === "shown" || step.scriptBlocked;
  if (step.scriptBlocked) return state.interactable;
  return (passShown || emailHidden) && state.interactable;
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
      state = mergeFieldState(state, sel, found);
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

export { PASS_SELECTORS };
