import path from "node:path";

import { fetch2FACodeFromSystemSettings } from "./mac-settings-2fa.js";
import { dismissStale2FAPopups, runPopupPhase } from "./mac-2fa-popup.js";
import { sleep } from "./prompt.js";

function get2FAConfig() {
  const num = (key, fallback) => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    popupFirstMs: num("BROWSER_2FA_POPUP_WAIT_MS", 45_000),
    settingsFallback: process.env.BROWSER_2FA_SETTINGS_FALLBACK !== "0",
    pollIntervalMs: num("BROWSER_2FA_POLL_MS", 800),
  };
}

/**
 * 等待 2FA：关闭旧窗 → 点允许 → 再读新验证码
 * @param {object} [options]
 */
export async function waitForMac2FACode(options = {}) {
  const cfg = get2FAConfig();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const popupFirstMs = options.popupFirstMs ?? cfg.popupFirstMs;
  const deadline = Date.now() + timeoutMs;
  let settingsTried = false;

  console.log("[2FA] 分阶段处理系统弹窗（清旧窗 → 允许 → 读码）…");

  /** @type {Set<string>} */
  const dismissedCodes = new Set();

  if (process.platform === "darwin") {
    const { count, codes } = await dismissStale2FAPopups(6);
    for (const c of codes) dismissedCodes.add(c);
    if (count > 0) {
      console.log(`[2FA] 已关闭 ${count} 个残留验证码窗（旧码: ${[...dismissedCodes].join(", ") || "无"}）`);
    } else {
      console.log("[2FA] 已扫描残留窗（未发现可关闭的旧验证码）");
    }
    await sleep(500);
  }

  console.log("[2FA] 阶段 1/2：等待并点击「允许」…");
  let allowClicked = false;
  const allowDeadline = Math.min(deadline, Date.now() + 120_000);
  let allowPolls = 0;

  while (Date.now() < allowDeadline && !allowClicked) {
    allowPolls += 1;
    if (process.platform === "darwin") {
      const r = await runPopupPhase("pre_allow", 3);
      if (r.action === "dismissed_stale") {
        if (r.code) dismissedCodes.add(r.code);
        continue;
      }
      if (r.action === "clicked_allow") {
        allowClicked = true;
        break;
      }
    }
    if (allowPolls === 1 || allowPolls % 6 === 0) {
      console.log("[2FA] 仍在查找「允许」按钮…（请确认终端已获「自动化」权限）");
    }
    await sleep(500);
  }

  if (!allowClicked) {
    console.warn("[2FA] 未自动点到「允许」，继续等待验证码（可能需手动允许）");
  }

  await sleep(allowClicked ? 2200 : 800);

  console.log("[2FA] 阶段 2/2：等待 6 位验证码展示…");
  let polls = 0;

  while (Date.now() < deadline) {
    polls += 1;
    const elapsed = timeoutMs - (deadline - Date.now());
    const inPopupPhase = elapsed < popupFirstMs;

    if (polls === 1 || polls % 8 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const phase = inPopupPhase ? "读码" : "读码+设置";
      console.log(`[2FA] 轮询中（${phase}）… 剩余约 ${left}s`);
    }

    if (process.platform === "darwin") {
      const r = await runPopupPhase("read_code", 10);
      if (r.action === "dismissed_stale") {
        if (r.code) dismissedCodes.add(r.code);
        console.log("[2FA] 读码前关闭残留窗");
        continue;
      }
      if (r.code) {
        if (dismissedCodes.has(r.code)) {
          console.log(`[2FA] 跳过已关闭的旧验证码 ${r.code}，等待本次新码…`);
          await runPopupPhase("dismiss_stale", 2);
          continue;
        }
        const src = r.source ? ` 来源=${r.source}` : "";
        const raw = r.raw ? ` 原文="${String(r.raw).slice(0, 40)}"` : "";
        console.log(`[2FA] ★ 验证码: ${r.code}${src}${raw}`);
        console.log("[2FA] 已获取 6 位验证码（点击允许后）");
        return r.code;
      }
    }

    if (
      cfg.settingsFallback &&
      !settingsTried &&
      !inPopupPhase &&
      process.platform === "darwin"
    ) {
      settingsTried = true;
      const leftMs = deadline - Date.now();
      if (leftMs > 25_000) {
        console.log(
          "[2FA] 弹窗未及时出现，改从 系统设置 → 登录与安全性 → 双重认证 → 获取验证码…"
        );
        try {
          const screenshotPath = options.reportDir
            ? path.join(options.reportDir, "screenshots", "2fa-settings-code.png")
            : undefined;
          const { code, screenshot } = await fetch2FACodeFromSystemSettings({
            timeoutMs: Math.min(leftMs - 5000, 120_000),
            screenshotPath,
          });
          console.log(`[2FA] ★ 验证码: ${code}`);
          if (screenshot) {
            console.log(`[2FA] 系统设置验证码截图已保存: ${screenshot}`);
          }
          if (!allowClicked) {
            console.warn(
              "[2FA] 提示: 未在弹窗点「允许」时，设置里的验证码可能无法用于本次网页登录；请对照截图核对"
            );
          }
          console.log("[2FA] 已获取 6 位验证码（系统设置）");
          return code;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[2FA] 系统设置获取验证码失败: ${msg}`);
          console.log("[2FA] 继续轮询系统弹窗…");
        }
      }
    }

    await sleep(cfg.pollIntervalMs);
  }

  throw new Error(
    "macOS 2FA 验证码获取超时：请确认已点「允许」且验证码窗已出现，并检查辅助功能权限"
  );
}

/**
 * @param {object} [options]
 */
export function startMac2FAWait(options = {}) {
  const promise = waitForMac2FACode(options);
  return {
    promise,
    async getCode() {
      return promise;
    },
  };
}
