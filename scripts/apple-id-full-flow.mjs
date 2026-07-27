#!/usr/bin/env node
/**
 * Apple ID 完整流程：
 * 1) macOS 系统设置登录（自动填账号密码，手机验证码人工，等待登录完成）
 * 2) ruyiPage 控制 Firefox 访问 account.apple.com（拟人输入 + macOS 2FA Sidecar）
 * 3) 采集姓名、生日，输出 report.json + 截图
 *
 * 用法:
 *   node scripts/apple-id-full-flow.mjs
 *   # 启动后终端输入 Apple ID / 密码，自动备份至 .env
 *   node scripts/apple-id-full-flow.mjs --skip-mac    # 仅浏览器阶段（Mac 已登录）
 *   node scripts/apple-id-full-flow.mjs --skip-browser # 仅 Mac 设置阶段
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readBrowserAccountHomeConfirmed,
  readBrowserFailureCode,
  readBrowserFailureStage,
  runAccountBrowserPhase,
} from "./lib/account-browser-flow.js";
import { confirmOrPromptAppleCredentials } from "./lib/credentials.js";
import { runMacSettingsLoginPhase } from "./lib/mac-settings-login.js";
import { captureMacSettingsSmsRuntimeEnv } from "./lib/mac-settings-sms-provider.js";
import {
  createReportDir,
  writeAccountHomeAcceptanceMarker,
  writeReport,
} from "./lib/report.js";
import { ensureEnvironment } from "./lib/env-setup.js";
import { createFlowAudit } from "./lib/flow-audit.js";

const skipMac = process.argv.includes("--skip-mac");
const skipBrowser = process.argv.includes("--skip-browser");
const skipSetup = process.argv.includes("--skip-setup");
const FAILURE_TOKEN_RE = /^[a-z0-9_]{1,96}$/;
const POST_LOGIN_FINALIZATION_CLASSES = new Set([
  "completed",
  "browser_connection_lost",
  "browser_quit_failed",
  "backend_cleanup_failed",
  "runner_post_login_failed",
  "collector_dispose_failed",
  "unknown",
]);
const POST_LOGIN_FINALIZATION_PARTIAL_CLASSES = new Set([
  "browser_connection_lost",
  "browser_quit_failed",
  "backend_cleanup_failed",
  "runner_post_login_failed",
  "collector_dispose_failed",
]);

function failureToken(value) {
  return typeof value === "string" && FAILURE_TOKEN_RE.test(value) ? value : "unknown";
}

function finalizationClassToken(value) {
  return POST_LOGIN_FINALIZATION_CLASSES.has(value) ? value : "unknown";
}

function finalizationClassRequiresPartial(value) {
  return POST_LOGIN_FINALIZATION_PARTIAL_CLASSES.has(value);
}

export function createFlowFailureEnvelope(failureStage, failureCode, failedAt = new Date()) {
  return {
    failureStage: failureToken(failureStage),
    failureCode: failureToken(failureCode),
    failedAt: failedAt.toISOString(),
    auditFile: "flow-audit.jsonl",
  };
}

export function createFlowReport(runAt = new Date()) {
  return {
    runAt: runAt.toISOString(),
    phases: {},
  };
}

export function recordAccountHomeAcceptanceMarker(
  accountHomeConfirmed,
  {
    writeMarker = writeAccountHomeAcceptanceMarker,
    flowAudit = null,
    logger = console,
  } = {}
) {
  if (accountHomeConfirmed !== true) {
    flowAudit?.write?.("flow", "acceptance_marker_skipped", {
      accountHomeConfirmed: false,
    });
    logger.log("[apple-automation] status:acceptance_marker_skipped:home:0");
    return "skipped";
  }
  try {
    writeMarker();
    flowAudit?.write?.("flow", "acceptance_marker_completed", {
      accountHomeConfirmed: true,
    });
    logger.log("[验收] REAL_ACCOUNT_HOME_CONFIRMED");
    return "completed";
  } catch {
    flowAudit?.write?.("flow", "acceptance_marker_partial", {
      accountHomeConfirmed: true,
    });
    logger.warn("[apple-automation] status:acceptance_marker_partial:home:1");
    return "partial";
  }
}

export function summarizeAccountBrowserCompletion(accountBrowser) {
  const source = accountBrowser && typeof accountBrowser === "object" ? accountBrowser : {};
  const browserLogin =
    source.browserLogin && typeof source.browserLogin === "object" ? source.browserLogin : {};
  const profileCapture =
    source.postLoginProfileCapture && typeof source.postLoginProfileCapture === "object"
      ? source.postLoginProfileCapture
      : null;
  const finalization =
    source.postLoginFinalization && typeof source.postLoginFinalization === "object"
      ? source.postLoginFinalization
      : null;
  const skipped = source.skipped === true;
  const accountHomeConfirmed = browserLogin.accountHomeConfirmed === true;
  const finalizationClass = finalization
    ? finalizationClassToken(finalization.finalizationClass)
    : null;
  const classRequiresPartial = finalizationClassRequiresPartial(finalizationClass);
  const backendCleanupCompleted = finalization
    ? finalization.backendCleanupCompleted !== false &&
      finalizationClass !== "backend_cleanup_failed"
    : null;
  const collectorDisposed = finalization
    ? finalization.collectorDisposed !== false &&
      finalizationClass !== "collector_dispose_failed"
    : null;
  const browserFinalizationCompleted = finalization
    ? finalization.browserFinalizationCompleted === true &&
      finalizationClass !== "browser_connection_lost" &&
      finalizationClass !== "browser_quit_failed"
    : null;
  const browserPreservationRequested = finalization
    ? finalization.browserPreservationRequested === true
    : null;
  const browserSessionPreserved = finalization
    ? finalization.browserSessionPreserved === true
    : null;
  const browserPreservationSatisfied =
    browserPreservationRequested !== true || browserSessionPreserved === true;
  return {
    accountHomeConfirmed,
    profileCaptureState: skipped
      ? "skipped"
      : profileCapture?.success === true
        ? "succeeded"
        : accountHomeConfirmed
          ? "partial"
          : "unknown",
    postLoginFinalizationState: skipped
      ? "skipped"
      : !finalization
        ? "unknown"
        : backendCleanupCompleted &&
            !classRequiresPartial &&
            collectorDisposed &&
            browserFinalizationCompleted &&
            browserPreservationSatisfied
          ? "completed"
          : "partial",
    backendCleanupCompleted,
    collectorDisposed,
    browserFinalizationCompleted,
    browserPreservationRequested,
    browserSessionPreserved,
    finalizationClass,
  };
}

function addSmsRuntimeSecrets(flowAudit, smsEnv) {
  flowAudit.addSecrets([
    smsEnv.APPLE_AUTOMATION_SMS_PHONE,
    smsEnv.APPLE_AUTOMATION_SMS_API_URL,
    smsEnv.APPLE_AUTOMATION_MANUAL_SMS_CODE,
  ]);
}

const SMS_PROVIDER_ENV_KEYS = [
  "APPLE_AUTOMATION_SMS_PHONE",
  "APPLE_AUTOMATION_SMS_API_URL",
];

export function mergeMacSettingsSmsRuntimeEnv(initialEnv = {}, persistedEnv = {}) {
  const persisted = { ...persistedEnv };
  if (SMS_PROVIDER_ENV_KEYS.some((key) => Object.hasOwn(initialEnv, key))) {
    for (const key of SMS_PROVIDER_ENV_KEYS) delete persisted[key];
  }
  return { ...persisted, ...initialEnv };
}

export async function main() {
  let smsRuntimeEnv = captureMacSettingsSmsRuntimeEnv();
  console.log("[apple-automation] stage:flow_main_started");
  console.log("═══════════════════════════════════════════");
  console.log(" Apple ID 流程：Mac 系统设置 → Firefox account");
  console.log("═══════════════════════════════════════════\n");

  const reportDir = createReportDir("apple-id-flow");
  const flowAudit = createFlowAudit(reportDir, {
    onWriteFailure() {
      console.warn("[报告] 统一诊断日志写入失败");
    },
  });
  addSmsRuntimeSecrets(flowAudit, smsRuntimeEnv);
  console.log(`[报告] 统一诊断日志: ${flowAudit.path}`);
  const report = createFlowReport();
  let reportFile = null;
  let creds = null;
  let failureStage = "unknown";
  let failureCode = "unknown";

  try {
    flowAudit.write("flow", "started", {
      skipMac,
      skipBrowser,
      skipSetup,
    });

    if (!skipSetup) {
      failureStage = "environment_setup";
      failureCode = "environment_setup_failed";
      try {
        await ensureEnvironment({
          quiet: false,
          skipFirefox: skipBrowser,
          skipRuyiPage: skipBrowser,
          skipAutomation: skipMac,
        });
      } catch (error) {
        flowAudit.write("flow", "environment_setup_failed", {
          failureStage,
          failureCode,
        });
        throw error;
      }
      console.log("");
    }

    failureStage = "credential_resolution";
    failureCode = "credential_resolution_failed";
    try {
      creds = await confirmOrPromptAppleCredentials();
      const persistedSmsRuntimeEnv = captureMacSettingsSmsRuntimeEnv();
      smsRuntimeEnv = mergeMacSettingsSmsRuntimeEnv(smsRuntimeEnv, persistedSmsRuntimeEnv);
      addSmsRuntimeSecrets(flowAudit, smsRuntimeEnv);
    } catch (error) {
      flowAudit.write("flow", "credential_resolution_failed", {
        failureStage,
        failureCode,
      });
      throw error;
    }
    flowAudit.addSecrets([creds.appleId, creds.password]);
    console.log("[apple-automation] stage:credentials_ready");
    if (!skipMac) {
      failureStage = "mac_settings";
      failureCode = "mac_settings_failed";
      try {
        flowAudit.write("mac_settings", "started");
        report.phases.macSettings = await runMacSettingsLoginPhase(creds, { smsEnv: smsRuntimeEnv });
        flowAudit.write("mac_settings", "completed", { success: true });
      } catch (e) {
        flowAudit.write("mac_settings", "failed", { failureStage, failureCode });
        report.phases.macSettings = {
          success: false,
          error: "Mac Settings phase failed",
          failureStage,
          failureCode,
        };
        throw e;
      }
    } else {
      console.log("[Mac 设置] --skip-mac：跳过系统设置登录阶段\n");
      report.phases.macSettings = { skipped: true };
      flowAudit.write("mac_settings", "skipped");
    }

    if (!skipBrowser) {
      failureStage = "unknown";
      failureCode = "account_browser_failed";
      try {
        flowAudit.write("account_browser", "started");
        report.phases.accountBrowser = await runAccountBrowserPhase({
          creds,
          reportDir,
          flowAudit,
        });
        const browserCompletion = summarizeAccountBrowserCompletion(
          report.phases.accountBrowser
        );
        const profileCapture = report.phases.accountBrowser?.postLoginProfileCapture;
        flowAudit.write("account_browser", "completed", {
          success: true,
          ...browserCompletion,
        });
        console.log(
          `[apple-automation] status:account_browser_completed:home:${browserCompletion.accountHomeConfirmed ? 1 : 0}:profile:${browserCompletion.profileCaptureState}:finalization:${browserCompletion.postLoginFinalizationState}`
        );
        if (browserCompletion.profileCaptureState === "partial") {
          flowAudit.write("account_browser", "profile_capture_partial", {
            failureStage: profileCapture?.failureStage,
            failureClass: profileCapture?.failureClass,
            browserAlive: profileCapture?.browserAlive === true,
            browserPreserved: profileCapture?.browserPreserved === true,
          });
          console.warn(
            `[apple-automation] status:browser_login_succeeded_profile_capture_partial:stage:${profileCapture?.failureStage ?? "unknown"}:class:${profileCapture?.failureClass ?? "unknown"}:preserved:${profileCapture?.browserPreserved === true ? 1 : 0}`
          );
        }
        if (browserCompletion.postLoginFinalizationState === "partial") {
          flowAudit.write("account_browser", "post_login_finalization_partial", {
            backendCleanupCompleted: browserCompletion.backendCleanupCompleted,
            collectorDisposed: browserCompletion.collectorDisposed,
            browserFinalizationCompleted: browserCompletion.browserFinalizationCompleted,
            browserPreservationRequested: browserCompletion.browserPreservationRequested,
            browserSessionPreserved: browserCompletion.browserSessionPreserved,
            finalizationClass: browserCompletion.finalizationClass,
          });
          console.warn(
            `[apple-automation] status:browser_login_succeeded_post_login_finalization_partial:backend_cleanup:${browserCompletion.backendCleanupCompleted ? 1 : 0}:collector_disposed:${browserCompletion.collectorDisposed ? 1 : 0}:browser_finalized:${browserCompletion.browserFinalizationCompleted ? 1 : 0}:preserve_requested:${browserCompletion.browserPreservationRequested ? 1 : 0}:preserved:${browserCompletion.browserSessionPreserved ? 1 : 0}:class:${browserCompletion.finalizationClass}`
          );
        }
      } catch (e) {
        failureStage = readBrowserFailureStage(e);
        failureCode = readBrowserFailureCode(e);
        flowAudit.write("account_browser", "failed", {
          failureStage,
          failureCode,
        });
        const accountHomeConfirmed = readBrowserAccountHomeConfirmed(e);
        report.phases.accountBrowser = {
          success: false,
          error: "Account browser phase failed",
          failureStage,
          failureCode,
          ...(accountHomeConfirmed
            ? {
                browserLogin: {
                  success: true,
                  backend: "ruyipage",
                  accountHomeConfirmed: true,
                },
              }
            : {}),
        };
        throw e;
      }
    } else {
      console.log("[Firefox] --skip-browser：跳过浏览器阶段\n");
      report.phases.accountBrowser = { skipped: true };
      flowAudit.write("account_browser", "skipped");
      console.log("[apple-automation] status:account_browser_skipped");
    }

    failureStage = "report_write";
    failureCode = "report_write_failed";
    reportFile = writeReport(reportDir, report);
    flowAudit.write("flow", "report_written", { file: "report.json" });
    const acceptanceMarkerState = recordAccountHomeAcceptanceMarker(
      report.phases.accountBrowser?.browserLogin?.accountHomeConfirmed === true,
      { flowAudit }
    );
    const browserCompletion = summarizeAccountBrowserCompletion(report.phases.accountBrowser);
    flowAudit.write("flow", "completed", {
      success: true,
      ...browserCompletion,
      acceptanceMarkerState,
    });
    console.log(
      `[apple-automation] status:flow_completed:profile:${browserCompletion.profileCaptureState}:finalization:${browserCompletion.postLoginFinalizationState}:acceptance_marker:${acceptanceMarkerState}`
    );
  } catch (e) {
    report.error = "Apple ID flow failed";
    report.failure = createFlowFailureEnvelope(failureStage, failureCode);
    reportFile = writeReport(reportDir, report);
    flowAudit.write("flow", "failed", {
      failureStage: report.failure.failureStage,
      failureCode: report.failure.failureCode,
      reportFile: "report.json",
    });
    console.error(`[apple-automation] failure_stage:${report.failure.failureStage}`);
    console.error(`[apple-automation] failure_code:${report.failure.failureCode}`);
    console.error(`[apple-automation] failed_at:${report.failure.failedAt}`);
    console.error(`[apple-automation] report_path:${reportFile}`);
    console.error(`[apple-automation] audit_path:${flowAudit.path}`);
    console.error(`\n[报告] 失败报告已保存: ${reportFile}`);
    console.error(`[报告] 统一诊断日志: ${flowAudit.path}`);
    throw e;
  } finally {
    flowAudit.close();
  }

  console.log("\n═══════════════════════════════════════════");
  console.log(" 完成");
  console.log(` 报告: ${reportFile}`);
  console.log(` 日志: ${flowAudit.path}`);
  console.log(` 截图: ${reportDir}/screenshots/`);
  console.log("═══════════════════════════════════════════\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch(() => {
    console.error("\n[failed] Apple ID flow failed");
    process.exitCode = 1;
  });
}
