import { append2FAAudit, screenshotPathFor } from "./2fa-audit.js";
import { fetch2FACodeFromSystemSettings } from "./mac-settings-2fa.js";
import { dismissStale2FAPopups, runPopupPhase } from "./mac-2fa-popup.js";
import { waitForAllowClick, readPopupCodeViaAppleScript, probe2FAState } from "./mac-2fa-allow.js";
import { sleep } from "./prompt.js";

function get2FAConfig() {
  const num = (key, fallback) => {
    const v = parseInt(process.env[key] ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    popupFirstMs: num("BROWSER_2FA_POPUP_WAIT_MS", 45_000),
    settingsFallbackAfterMs: num("BROWSER_2FA_SETTINGS_AFTER_MS", 120_000),
    settingsFallback: process.env.BROWSER_2FA_SETTINGS_FALLBACK !== "0",
    pollIntervalMs: num("BROWSER_2FA_POLL_MS", 800),
  };
}

function logCodeResult(code, { source, raw, allowStrategy }) {
  const src = source ? ` 来源=${source}` : "";
  const rawPart = raw ? ` 原文="${String(raw).slice(0, 40)}"` : "";
  const allowPart = allowStrategy ? ` allow=${allowStrategy}` : "";
  console.log(`[2FA] ★ 验证码: ${code}${src}${rawPart}${allowPart}`);
}

/**
 * 等待 2FA：关闭旧窗 → 点允许 → 再读新验证码
 * @param {object} [options]
 */
export async function waitForMac2FACode(options = {}) {
  const cfg = get2FAConfig();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const popupFirstMs = options.popupFirstMs ?? cfg.popupFirstMs;
  const settingsAfterMs = options.settingsFallbackAfterMs ?? cfg.settingsFallbackAfterMs;
  const reportDir = options.reportDir;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
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
    append2FAAudit(reportDir, {
      phase: "dismiss_stale",
      dismissedCount: count,
      dismissedCodes: [...dismissedCodes],
    });
    await sleep(500);
  }

  console.log("[2FA] 阶段 1/2：等待并点击「允许」…");
  let allowClicked = false;
  let allowStrategy = "none";
  let allowSource;

  if (process.platform === "darwin") {
    const allow = await waitForAllowClick({
      timeoutMs: Math.min(deadline - Date.now(), 120_000),
    });
    allowClicked = allow.clicked;
    allowStrategy = allow.strategy ?? (allow.clicked ? "auto" : "none");
    allowSource = allow.source;
    append2FAAudit(reportDir, {
      phase: "wait_allow",
      allowClicked,
      allowStrategy,
      allowSource: allowSource ?? null,
    });
  }

  if (!allowClicked) {
    throw new Error(
      "请先手动点击系统弹窗「允许」，并确认终端已获 System Events 自动化权限（系统设置 → 隐私与安全性 → 自动化）"
    );
  }

  console.log("[2FA] 阶段 2/2：等待 6 位验证码展示…");
  for (let i = 0; i < 40; i++) {
    const asRead = await readPopupCodeViaAppleScript(4);
    if (asRead?.code) {
      if (!dismissedCodes.has(asRead.code)) {
        logCodeResult(asRead.code, {
          source: "popup",
          raw: asRead.raw,
          allowStrategy,
        });
        append2FAAudit(reportDir, {
          phase: "read_popup_fast",
          allowClicked: true,
          allowStrategy,
          code: asRead.code,
          raw: asRead.raw ?? null,
          source: asRead.source ?? "applescript",
        });
        console.log(`[2FA] 已获取 6 位验证码（弹窗 ${asRead.raw ?? asRead.code}）`);
        return asRead.code;
      }
    }
    const state = await probe2FAState(2);
    if (state.code && !dismissedCodes.has(state.code)) {
      logCodeResult(state.code, { source: "popup", raw: state.code, allowStrategy });
      console.log("[2FA] 已获取 6 位验证码（probe）");
      return state.code;
    }
    if (i === 0 || i % 10 === 0) {
      console.log(`[2FA] 等待验证码展示… (${i + 1}/40)`);
    }
    await sleep(500);
  }

  let polls = 0;

  while (Date.now() < deadline) {
    polls += 1;
    const elapsed = Date.now() - startedAt;
    const inPopupPhase = elapsed < popupFirstMs;
    const canTrySettings = elapsed >= settingsAfterMs;

    if (polls === 1 || polls % 8 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const phase = inPopupPhase ? "读码" : allowClicked ? "读码+设置" : "读码";
      console.log(`[2FA] 轮询中（${phase}）… 剩余约 ${left}s`);
    }

    if (process.platform === "darwin") {
      let r = await runPopupPhase("read_code", 10);
      if (!r.code) {
        const asRead = await readPopupCodeViaAppleScript(8);
        if (asRead?.code) {
          r = {
            ok: true,
            action: "read_code",
            code: asRead.code,
            source: asRead.source,
            raw: asRead.raw,
          };
          console.log(`[2FA] AppleScript 读到验证码 ${asRead.code} 原文="${asRead.raw ?? ""}"`);
        }
      }
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
        const popupShot = screenshotPathFor(reportDir, "2fa-popup-code.png");
        logCodeResult(r.code, {
          source: "popup",
          raw: r.raw,
          allowStrategy,
        });
        append2FAAudit(reportDir, {
          phase: "read_popup",
          allowClicked: true,
          allowStrategy,
          code: r.code,
          raw: r.raw ?? null,
          source: r.source ?? "popup",
          screenshot: popupShot ?? null,
        });
        console.log("[2FA] 已获取 6 位验证码（点击允许后）");
        return r.code;
      }
    }

    if (
      cfg.settingsFallback &&
      allowClicked &&
      !settingsTried &&
      canTrySettings &&
      process.platform === "darwin"
    ) {
      const leftMs = deadline - Date.now();
      const popupStill = await probe2FAState(3);
      if (popupStill.action === "has_code_dialog") {
        console.log("[2FA] 弹窗验证码仍在，跳过系统设置回退，继续读弹窗…");
      } else if (leftMs > 25_000) {
        settingsTried = true;
        console.log(
          "[2FA] 弹窗未及时出现，改从 系统设置 → 登录与安全性 → 双重认证 → 获取验证码…"
        );
        try {
          const screenshotPath = screenshotPathFor(reportDir, "2fa-settings-code.png");
          const { code, raw, screenshot } = await fetch2FACodeFromSystemSettings({
            timeoutMs: Math.min(leftMs - 5000, 120_000),
            screenshotPath,
          });
          logCodeResult(code, {
            source: "settings",
            raw,
            allowStrategy,
          });
          if (screenshot) {
            console.log(`[2FA] 系统设置验证码截图已保存: ${screenshot}`);
          }
          append2FAAudit(reportDir, {
            phase: "read_settings",
            allowClicked: true,
            allowStrategy,
            code,
            raw: raw ?? null,
            source: "settings",
            screenshot: screenshot ?? null,
          });
          console.log("[2FA] 已获取 6 位验证码（系统设置）");
          return code;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[2FA] 系统设置获取验证码失败: ${msg}`);
          append2FAAudit(reportDir, {
            phase: "read_settings_failed",
            allowClicked: true,
            error: msg,
          });
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
