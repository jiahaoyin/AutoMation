/**
 * account.apple.com browser phase orchestration.
 *
 * Node owns credentials, reporting, and the macOS 2FA sidecar. Browser launch,
 * navigation, page reads, screenshots, and interaction are delegated to ruyiPage.
 */

import { isAccessibilityGranted } from "./accessibility.js";
import { getBrowserEnvironmentSummary } from "./env-setup.js";
import { createRuyiPageBackendRunner } from "./ruyipage-backend-runner.js";
import { createMac2FACollector } from "./two-fa-sidecar.js";

/**
 * @param {object} params
 * @param {{ appleId: string, password: string }} params.creds
 * @param {string} params.reportDir
 * @param {object} [runtime]
 */
export async function runAccountBrowserPhase({ creds, reportDir }, runtime = {}) {
  const getEnvironmentSummary =
    runtime.getBrowserEnvironmentSummary ?? getBrowserEnvironmentSummary;
  const checkAccessibility = runtime.isAccessibilityGranted ?? isAccessibilityGranted;
  const createRunner =
    runtime.createRuyiPageBackendRunner ?? createRuyiPageBackendRunner;
  const createCollector = runtime.createMac2FACollector ?? createMac2FACollector;

  const summary = getEnvironmentSummary();
  console.log(`[Firefox] 浏览器后端: ${summary.backend} (${summary.backendReason})`);
  for (const warning of summary.warnings) {
    console.log(`[Firefox] 环境提示: ${warning}`);
  }

  const axOk = await checkAccessibility().catch(() => false);
  if (!axOk) {
    console.warn("[2FA] 警告: 辅助功能未授权，macOS 2FA 弹窗取码可能失败");
  }

  const collector = createCollector({ timeoutMs: 240_000, reportDir });
  let result;
  let runError = null;
  try {
    const runner = createRunner();
    result = await runner.run({
      creds,
      reportDir,
      onEvent(event) {
        if (event.event === "ready") {
          console.log(`[ruyipage] 浏览器已就绪 (${event.mode || "browser"})`);
        } else if (event.event === "warning") {
          console.warn(`[ruyipage] ${event.message || "warning"}`);
        } else if (event.event === "prepare_2fa") {
          console.log("[ruyipage] 密码提交前预备 macOS 2FA 监听…");
        } else if (event.event === "need_2fa") {
          console.log("[ruyipage] 页面已确认进入 2FA，等待首个可用验证码…");
        }
      },
      async prepare2FA() {
        await collector.prepare();
      },
      async get2FACode() {
        return collector.getCode();
      },
    });
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await collector.dispose();
    } catch (error) {
      if (!runError) throw error;
      console.warn(`[2FA] collector 清理失败: ${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    browserLogin: result.browserLogin ?? { success: true, backend: "ruyipage" },
    antiAutomation: { backend: "ruyipage", delegated: true },
    personalInfo: result.personalInfo ?? null,
    screenshots: result.screenshots ?? {},
  };
}
