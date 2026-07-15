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

const ALLOWED_READY_MODES = new Set([
  "browser",
  "ruyipage-only",
  "protocol-self-test",
  "node-self-test",
  "hang-self-test",
  "ignore-signals-self-test",
]);

const FIXED_ENVIRONMENT_WARNING = "[Firefox] 环境提示: browser environment warning";
const TWO_FACTOR_STATUS_MESSAGES = Object.freeze({
  settings_accessibility:
    "[2FA] 系统设置取码需要辅助功能权限，正在等待授权；请按 macOS 提示完成勾选。",
  manual_allow:
    "[2FA] 自动点击「允许」未成功，请在 Mac 上手动点击「允许」；取码仍在继续。",
  manual_code: "[2FA] 自动取码仍未完成，请在终端隐藏输入 Mac 上显示的 6 位验证码。",
  ocr_permission_missing:
    "[2FA] OCR 需要权限：系统设置 → 隐私与安全性 → 屏幕与系统音频录制；系统设置取码仍在工作。",
  timeout:
    "[2FA] 240 秒内未取得可用验证码。请确认 Mac 已登录同一 Apple ID、允许弹窗已处理，并检查系统设置取码与相关权限。",
});
const TWO_FACTOR_WINNER_MESSAGES = Object.freeze({
  popup: "[2FA] 已从 Apple 验证码弹窗取得验证码。",
  settings: "[2FA] 已从系统设置取得验证码。",
  manual: "[2FA] 已使用终端手动输入的验证码。",
});
const SUPERVISED_TWO_FACTOR_STATUS_PREFIX = "[2FA] status:";
const RUYIPAGE_STARTUP_STATUSES = new Set([
  "broker_credentials_received",
  "browser_url_validated",
  "browser_runtime_imported",
  "browser_constructing",
]);
const RUYIPAGE_FAILURE_STAGES = new Set([
  "not_started",
  "credentials_received",
  "url_validated",
  "runtime_importing",
  "runtime_imported",
  "browser_constructing",
  "browser_ready",
  "login_navigation",
  "login_page_loaded",
  "login_state_detected",
  "email_wait",
  "email_input",
  "email_submit",
  "password_wait",
  "password_input",
  "remember_account",
  "twofa_prepare",
  "password_submit",
  "twofa_page_wait",
  "twofa_code_wait",
  "twofa_input",
  "signed_in",
  "account_information",
]);
const BROWSER_RUN_FAILURE_CODES = new Set([
  "account_home_unconfirmed",
  "backend_cleanup",
  "backend_exit",
  "backend_failed",
  "backend_interrupted",
  "backend_stdin",
  "backend_timeout",
  "broker_connect",
  "broker_connect_timeout",
  "broker_eof",
  "broker_io",
  "collector_cleanup",
  "event_handler",
  "event_handler_timeout",
  "process_state",
  "two_fa_preparation",
  "two_fa_provider",
  "unknown",
]);

export function classifyBrowserRunFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const exact = new Map([
    ["ruyipage browser broker socket closed", "broker_eof"],
    ["ruyipage browser broker socket connection failed", "broker_connect"],
    [
      "ruyipage browser broker socket connection timed out",
      "broker_connect_timeout",
    ],
    ["ruyipage browser broker socket I/O failed", "broker_io"],
    ["ruyipage backend failed", "backend_failed"],
    ["ruyipage backend stdin failed", "backend_stdin"],
    ["ruyipage backend cleanup failed", "backend_cleanup"],
    ["ruyipage backend interrupted", "backend_interrupted"],
    ["ruyipage process state initialization failed", "process_state"],
    ["ruyipage event handler failed", "event_handler"],
    ["ruyipage 2FA preparation failed", "two_fa_preparation"],
    ["ruyipage 2FA code provider failed", "two_fa_provider"],
    [
      "ruyipage backend did not confirm the authenticated Apple account home",
      "account_home_unconfirmed",
    ],
  ]).get(message);
  if (exact) return exact;
  if (/^ruyipage backend exited (?:unknown|\d+)$/.test(message)) {
    return "backend_exit";
  }
  if (/^ruyipage backend timed out after \d+ms$/.test(message)) {
    return "backend_timeout";
  }
  if (
    /^ruyipage onEvent handler timed out for [a-z0-9_]+ after \d+ms$/.test(
      message
    )
  ) {
    return "event_handler_timeout";
  }
  return "unknown";
}

export function readBrowserFailureCode(error) {
  const code = error?.browserFailureCode;
  return BROWSER_RUN_FAILURE_CODES.has(code) ? code : "unknown";
}

function annotateBrowserRunFailure(error, override = null) {
  const code = BROWSER_RUN_FAILURE_CODES.has(override)
    ? override
    : classifyBrowserRunFailure(error);
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "browserFailureCode", {
        configurable: true,
        value: code,
      });
    } catch {
      /* The fixed status line remains sufficient for non-extensible errors. */
    }
  }
  console.log(`[ruyipage] status:node-failure:${code}`);
  return error;
}

function sanitizeReadyMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim() : "";
  return ALLOWED_READY_MODES.has(normalized) ? normalized : "browser";
}

function reportTwoFactorStatus(event) {
  if (!event || typeof event !== "object") return;

  if (process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1") {
    if (
      event.status === "winner" &&
      Object.hasOwn(TWO_FACTOR_WINNER_MESSAGES, event.source)
    ) {
      console.log(`${SUPERVISED_TWO_FACTOR_STATUS_PREFIX}winner:${event.source}`);
    } else if (
      [
        "settings_start",
        "settings_retry",
        "settings_accessibility",
        "manual_allow",
        "manual_code",
        "ocr_permission_missing",
        "timeout",
      ].includes(event.status)
    ) {
      console.log(`${SUPERVISED_TWO_FACTOR_STATUS_PREFIX}${event.status}`);
    }
  }

  if (event.status === "settings_start" && (event.attempt === 1 || event.attempt === 2)) {
    console.log(
      event.attempt === 1
        ? "[2FA] 正在尝试通过系统设置获取验证码（第 1/2 次）..."
        : "[2FA] 正在尝试通过系统设置获取验证码（第 2/2 次）..."
    );
    return;
  }
  if (event.status === "settings_retry" && event.attempt === 2) {
    console.log("[2FA] 系统设置取码失败，5 秒后进行第 2/2 次尝试...");
    return;
  }
  if (event.status === "winner") {
    if (Object.hasOwn(TWO_FACTOR_WINNER_MESSAGES, event.source)) {
      console.log(TWO_FACTOR_WINNER_MESSAGES[event.source]);
    }
    return;
  }

  if (Object.hasOwn(TWO_FACTOR_STATUS_MESSAGES, event.status)) {
    console.log(TWO_FACTOR_STATUS_MESSAGES[event.status]);
  }
}

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
  for (const _warning of summary.warnings) {
    console.log(FIXED_ENVIRONMENT_WARNING);
  }

  const axOk = await checkAccessibility().catch(() => false);
  if (!axOk) {
    console.warn("[2FA] 警告: 辅助功能未授权，macOS 2FA 弹窗取码可能失败");
  }

  const collector = createCollector({
    timeoutMs:
      process.env.APPLE_AUTOMATION_SUPERVISED_GUI === "1" ? 130_000 : 240_000,
    reportDir,
    onStatus: reportTwoFactorStatus,
  });
  let result;
  let runError = null;
  let reportedFailureStage = null;
  try {
    console.log("[ruyipage] status:runtime_resolving");
    const runner = createRunner();
    console.log("[ruyipage] status:backend_starting");
    result = await runner.run({
      creds,
      reportDir,
      onEvent(event) {
        if (event.event === "ready") {
          console.log(`[ruyipage] 浏览器已就绪 (${sanitizeReadyMode(event.mode)})`);
        } else if (
          event.event === "status" &&
          RUYIPAGE_STARTUP_STATUSES.has(event.status)
        ) {
          console.log(`[ruyipage] status:${event.status}`);
        } else if (
          event.event === "status" &&
          event.status === "browser_failure" &&
          RUYIPAGE_FAILURE_STAGES.has(event.failureStage)
        ) {
          if (event.failureStage !== reportedFailureStage) {
            reportedFailureStage = event.failureStage;
            console.log(`[ruyipage] status:failure:${event.failureStage}`);
          }
        } else if (
          event.event === "result" &&
          event.success === false &&
          RUYIPAGE_FAILURE_STAGES.has(event.failureStage)
        ) {
          if (event.failureStage !== reportedFailureStage) {
            reportedFailureStage = event.failureStage;
            console.log(`[ruyipage] status:failure:${event.failureStage}`);
          }
        } else if (event.event === "warning") {
          console.warn("[ruyipage] backend warning");
        } else if (event.event === "prepare_2fa") {
          console.log("[ruyipage] 密码提交前预备 macOS 2FA 监听...");
        } else if (event.event === "need_2fa") {
          console.log("[ruyipage] 页面已确认进入 2FA，等待首个可用验证码...");
        }
      },
      async prepare2FA() {
        await collector.prepare();
      },
      async get2FACode(request) {
        return collector.getCode(request);
      },
    });
  } catch (error) {
    runError = error;
    throw annotateBrowserRunFailure(error);
  } finally {
    try {
      await collector.dispose();
    } catch (error) {
      if (!runError) throw annotateBrowserRunFailure(error, "collector_cleanup");
      console.warn("[2FA] collector cleanup failed");
    }
  }

  if (
    result?.browserLogin?.success !== true ||
    result.browserLogin.backend !== "ruyipage" ||
    result.browserLogin.accountHomeConfirmed !== true
  ) {
    throw annotateBrowserRunFailure(
      new Error("ruyipage backend did not confirm the authenticated Apple account home")
    );
  }

  return {
    browserLogin: result.browserLogin,
    antiAutomation: { backend: "ruyipage", delegated: true },
    personalInfo: result.personalInfo ?? null,
    screenshots: result.screenshots ?? {},
  };
}
