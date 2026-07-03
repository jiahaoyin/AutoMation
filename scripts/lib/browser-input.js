/**
 * Apple 登录 iframe 输入：JS native setter + 校验（BiDi keystroke 在 iframe 内常无效）
 */

import { sleep, randomBetween } from "./human-input-bidi.js";

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string} selector */
export async function readInputState(bidi, context, selector) {
  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      const style = window.getComputedStyle(el);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !el.disabled &&
        !el.readOnly;
      return {
        found: true,
        value: el.value ?? "",
        visible,
        type: el.type ?? "",
        id: el.id ?? "",
      };
    })())`,
    context
  );
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * @param {import("./bidi-client.js").BidiClient} bidi
 * @param {string} context
 * @param {string} selector
 * @param {string} value
 */
export async function fillInputViaScript(bidi, context, selector, value) {
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
      el.dispatchEvent(new Event("blur", { bubbles: true }));

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
  await human.focusInputBySelector(selector);
  await sleep(randomBetween(150, 350));

  let state = await readInputState(bidi, context, selector);
  if (!state.found) throw new Error(`${label}：未找到元素 ${selector}`);

  console.log(`[Firefox] 填写 ${label}（${selector}）…`);

  let result = await fillInputViaScript(bidi, context, selector, value);
  await sleep(randomBetween(200, 450));
  state = await readInputState(bidi, context, selector);

  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 已填入 (${state.value.length} 字符)`);
    return state;
  }

  console.warn(`[Firefox] JS 填 ${label} 未生效 (读回: "${state.value}")，尝试键盘输入…`);
  await human.focusInputBySelector(selector);
  await human.typeText(value, { slow: true });
  await sleep(randomBetween(300, 500));
  state = await readInputState(bidi, context, selector);

  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 键盘输入成功`);
    return state;
  }

  result = await fillInputViaScript(bidi, context, selector, value);
  state = await readInputState(bidi, context, selector);
  if (state.value === value || (value.length > 3 && state.value.includes(value.slice(0, 3)))) {
    console.log(`[Firefox] ✓ ${label} 二次 JS 填入成功`);
    return state;
  }

  throw new Error(
    `${label} 填入失败：期望 ${value.length} 字符，读回 "${state.value}" (${selector})`
  );
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context @param {string[]} selectors */
export async function waitForVisibleInput(bidi, human, selectors, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const found = await bidi.locateNodesInAnyContext(sel).catch(() => null);
      if (!found?.nodes?.length) continue;
      human.setContext(found.context);
      const state = await readInputState(bidi, found.context, sel);
      if (state.found && state.visible) {
        return { selector: sel, ...found, state };
      }
    }
    await sleep(400 + Math.random() * 300);
  }
  return null;
}
