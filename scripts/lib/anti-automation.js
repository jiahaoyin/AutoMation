/**
 * 反自动化检测与缓解：页面探针 + 随机等待策略
 */

import { randomBetween, sleep } from "./human-input-bidi.js";

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
export async function probeAutomationSignals(bidi, context) {
  const raw = await bidi.evaluate(
    `JSON.stringify((() => {
      const ua = navigator.userAgent || "";
      return {
        webdriver: !!navigator.webdriver,
        automationControlled: !!window.navigator.webdriver,
        pluginsCount: navigator.plugins?.length ?? 0,
        languages: navigator.languages?.slice(0, 3) ?? [],
        headlessHint: /Headless|PhantomJS/i.test(ua),
        chromeRuntime: typeof window.chrome !== "undefined",
        permissionsQuery: typeof navigator.permissions?.query === "function",
        userAgent: ua.slice(0, 120),
      };
    })())`,
    context
  );

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  } catch {
    return { parseError: true };
  }
}

/** @param {import("./bidi-client.js").BidiClient} bidi @param {string} context */
export async function applyAutomationMitigations(bidi, context) {
  await bidi.evaluate(
    `(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
      } catch (_) {}
      try {
        window.chrome = window.chrome || { runtime: {} };
      } catch (_) {}
    })()`,
    context
  );
}

/**
 * @param {Record<string, unknown>} signals
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function assessAutomationRisk(signals) {
  const warnings = [];
  if (signals.webdriver) warnings.push("navigator.webdriver=true");
  if (signals.headlessHint) warnings.push("UA 含 Headless 特征");
  if (signals.pluginsCount === 0) warnings.push("plugins 为空（常见于自动化环境）");
  return { ok: warnings.length === 0, warnings };
}

/** 页面加载后的人类化等待 */
export async function humanPageSettle(label = "") {
  const ms = Math.round(randomBetween(1200, 2800));
  if (label) console.log(`[反自动化] ${label} 等待 ${ms}ms…`);
  await sleep(ms);
}

/** 操作间随机停顿 */
export async function humanThinkPause(minMs = 350, maxMs = 1100) {
  await sleep(Math.round(randomBetween(minMs, maxMs)));
}

/** 短 jitter */
export async function humanJitter(minMs = 80, maxMs = 220) {
  await sleep(Math.round(randomBetween(minMs, maxMs)));
}
