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

import {
  readBrowserFailureCode,
  runAccountBrowserPhase,
} from "./lib/account-browser-flow.js";
import { confirmOrPromptAppleCredentials, maskAppleId } from "./lib/credentials.js";
import { runMacSettingsLoginPhase } from "./lib/mac-settings-login.js";
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

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log(" Apple ID 流程：Mac 系统设置 → Firefox account");
  console.log("═══════════════════════════════════════════\n");

  if (!skipSetup) {
    await ensureEnvironment({
      quiet: false,
      skipFirefox: skipBrowser,
      skipRuyiPage: skipBrowser,
      skipAutomation: skipMac,
    });
    console.log("");
  }

  const creds = await confirmOrPromptAppleCredentials();
  const reportDir = createReportDir("apple-id-flow");
  const flowAudit = createFlowAudit(reportDir, {
    secrets: [creds.appleId, creds.password],
    onWriteFailure() {
      console.warn("[报告] 统一诊断日志写入失败");
    },
  });
  console.log(`[报告] 统一诊断日志: ${flowAudit.path}`);
  flowAudit.write("flow", "started", {
    skipMac,
    skipBrowser,
    skipSetup,
  });
  const report = {
    runAt: new Date().toISOString(),
    appleId: maskAppleId(creds.appleId),
    phases: {},
  };
  let reportFile = null;

  try {
    if (!skipMac) {
      try {
        flowAudit.write("mac_settings", "started");
        report.phases.macSettings = await runMacSettingsLoginPhase(creds);
        flowAudit.write("mac_settings", "completed", { success: true });
      } catch (e) {
        flowAudit.writeError("mac_settings", "failed", e);
        report.phases.macSettings = {
          success: false,
          error: "Mac Settings phase failed",
        };
        throw e;
      }
    } else {
      console.log("[Mac 设置] --skip-mac：跳过系统设置登录阶段\n");
      report.phases.macSettings = { skipped: true };
      flowAudit.write("mac_settings", "skipped");
    }

    if (!skipBrowser) {
      try {
        flowAudit.write("account_browser", "started");
        report.phases.accountBrowser = await runAccountBrowserPhase({
          creds,
          reportDir,
          flowAudit,
        });
        flowAudit.write("account_browser", "completed", { success: true });
      } catch (e) {
        flowAudit.writeError("account_browser", "failed", e, {
          failureCode: readBrowserFailureCode(e),
        });
        report.phases.accountBrowser = {
          success: false,
          error: "Account browser phase failed",
          failureCode: readBrowserFailureCode(e),
        };
        throw e;
      }
    } else {
      console.log("[Firefox] --skip-browser：跳过浏览器阶段\n");
      report.phases.accountBrowser = { skipped: true };
      flowAudit.write("account_browser", "skipped");
    }

    reportFile = writeReport(reportDir, report);
    flowAudit.write("flow", "report_written", { file: "report.json" });
    if (report.phases.accountBrowser?.browserLogin?.accountHomeConfirmed === true) {
      writeAccountHomeAcceptanceMarker();
      console.log("[验收] REAL_ACCOUNT_HOME_CONFIRMED");
    }
    flowAudit.write("flow", "completed", { success: true });
  } catch (e) {
    report.error = "Apple ID flow failed";
    reportFile = writeReport(reportDir, report);
    flowAudit.writeError("flow", "failed", e, {
      reportFile: "report.json",
    });
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

main().catch(() => {
  console.error("\n[failed] Apple ID flow failed");
  process.exitCode = 1;
});
