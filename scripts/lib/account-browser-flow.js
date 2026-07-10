/**
 * account.apple.com browser phase orchestration.
 *
 * Node owns credentials, reporting, and the macOS 2FA sidecar. Browser launch,
 * navigation, page reads, screenshots, and interaction are delegated to ruyiPage.
 */

import { isAccessibilityGranted } from "./accessibility.js";
import { getBrowserEnvironmentSummary } from "./env-setup.js";
import { createRuyiPageBackendRunner } from "./ruyipage-backend-runner.js";
import { startMac2FAWait } from "./two-fa-sidecar.js";

/**
 * @param {object} params
 * @param {{ appleId: string, password: string }} params.creds
 * @param {string} params.reportDir
 */
export async function runAccountBrowserPhase({ creds, reportDir }) {
  const summary = getBrowserEnvironmentSummary();
  console.log(`[Firefox] 浏览器后端: ${summary.backend} (${summary.backendReason})`);
  for (const warning of summary.warnings) {
    console.log(`[Firefox] 环境提示: ${warning}`);
  }

  const axOk = await isAccessibilityGranted().catch(() => false);
  if (!axOk) {
    console.warn("[2FA] 警告: 辅助功能未授权，macOS 2FA 弹窗取码可能失败");
  }

  let twoFa = null;
  const runner = createRuyiPageBackendRunner();
  const result = await runner.run({
    creds,
    reportDir,
    onEvent(event) {
      if (event.event === "ready") {
        console.log(`[ruyipage] 浏览器已就绪 (${event.mode || "browser"})`);
      } else if (event.event === "warning") {
        console.warn(`[ruyipage] ${event.message || "warning"}`);
      } else if (event.event === "need_2fa") {
        console.log("[ruyipage] 页面已确认进入 2FA，等待 macOS 验证码…");
      }
    },
    async get2FACode() {
      if (!twoFa) {
        twoFa = startMac2FAWait({ timeoutMs: 240_000, reportDir });
      }
      return twoFa.getCode();
    },
  });

  return {
    browserLogin: result.browserLogin ?? { success: true, backend: "ruyipage" },
    antiAutomation: { backend: "ruyipage", delegated: true },
    personalInfo: result.personalInfo ?? null,
    screenshots: result.screenshots ?? {},
  };
}
