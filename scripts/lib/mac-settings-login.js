import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, waitUntil } from "./prompt.js";
import {
  withAccessibilityRetry,
  ensureAutomation,
  checkAutomationGranted,
  openAutomationSettings,
  isAutomationDeniedError,
  getAccessibilityHostApp,
} from "./accessibility.js";
import { ensureMacOS15, getMacOSVersion, openAppleAccountSettings } from "./macos.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGIN_SCPT = path.resolve(__dirname, "../mac-settings-apple-login.applescript");
const SIGNED_IN_SCPT = path.resolve(__dirname, "../mac-settings-signed-in.applescript");
const AUTOMATION_CHECK_SCPT = path.resolve(
  __dirname,
  "../automation-check.applescript"
);

/** 自动化预检：激活系统设置并尝试读取 UI 属性 */
export async function preflightMacSettingsAutomation() {
  const host = getAccessibilityHostApp();
  const check = await checkAutomationGranted();
  if (check.granted) {
    console.log(`[Mac 设置] ✓ 自动化预检通过（${host.name} → 系统设置）`);
    return { ok: true, host: host.name };
  }

  console.warn(`[Mac 设置] 自动化预检未通过: ${check.reason ?? check.code ?? "unknown"}`);
  console.warn(
    `[Mac 设置] 请在 系统设置 → 隐私与安全性 → 自动化 中展开「${host.name}」并勾选「系统设置」`
  );
  openAutomationSettings();

  await ensureAutomation({ quiet: false, timeoutMs: 120_000 });
  return { ok: true, host: host.name };
}

/** Node 分步：激活 → 点击坐标 → 再激活 → 粘贴（每步独立 osascript，避免焦点丢失） */
async function orchestratedCoordinateEmailPaste(appleId) {
  console.log("[Mac 设置] 尝试分步坐标粘贴（Node 编排）…");

  const activate = async () => {
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Settings" to activate',
      "-e",
      "delay 0.6",
      "-e",
      'tell application "System Events" to tell process "System Settings" to set frontmost to true',
    ]);
    await sleep(900);
  };

  const getWindowRect = async () => {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to tell process "System Settings"',
        "-e",
        "set w to window 1",
        "-e",
        "set p to position of w",
        "-e",
        "set s to size of w",
        "-e",
        'return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)',
        "-e",
        "end tell",
      ],
      { timeout: 15_000 }
    );
    const [x, y, w, h] = stdout.trim().split(",").map(Number);
    if (![x, y, w, h].every(Number.isFinite)) {
      throw new Error("无法读取系统设置窗口坐标");
    }
    return { x, y, w, h };
  };

  const clickAt = async (cx, cy) => {
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to click at {' + cx + ", " + cy + "}",
    ]);
    await sleep(600);
  };

  const pasteClipboard = async () => {
    await execFileAsync("osascript", [
      "-e",
      `set the clipboard to ${JSON.stringify(appleId)}`,
      "-e",
      'tell application "System Settings" to activate',
      "-e",
      "delay 0.5",
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
    await sleep(700);
  };

  const focusedContainsId = async () => {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-e",
          'tell application "System Events" to tell process "System Settings"',
          "-e",
          'try',
          "-e",
          'set f to value of attribute "AXFocusedUIElement"',
          "-e",
          "return value of f as text",
          "-e",
          "on error",
          "-e",
          'return ""',
          "-e",
          "end try",
          "-e",
          "end tell",
        ],
        { timeout: 10_000 }
      );
      return stdout.trim().includes(appleId);
    } catch {
      return false;
    }
  };

  await activate();
  const rect = await getWindowRect();
  const gridX = [0.5, 0.52, 0.55, 0.58, 0.62];
  const gridY = [0.38, 0.42, 0.46, 0.5, 0.54, 0.58];

  for (const xf of gridX) {
    for (const yf of gridY) {
      const cx = Math.round(rect.x + rect.w * xf);
      const cy = Math.round(rect.y + rect.h * yf);
      await activate();
      await clickAt(cx, cy);
      await activate();
      await pasteClipboard();
      if (await focusedContainsId()) {
        console.log("[Mac 设置] ✓ 分步坐标粘贴成功（焦点元素含邮箱）");
        return true;
      }
    }
  }
  return false;
}

export async function isMacSettingsSignedIn() {
  try {
    const { stdout } = await execFileAsync("osascript", [SIGNED_IN_SCPT], { timeout: 15_000 });
    return stdout.trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

/**
 * 打开系统设置 Apple ID 并填入账号密码（手机验证码人工完成）
 * @param {{ appleId: string, password: string }} creds
 */
export async function fillMacSettingsAppleLogin(creds) {
  console.log("\n[Mac 设置] 打开 Apple ID 并填入账号密码…");

  await preflightMacSettingsAutomation();

  const { stdout, stderr } = await withAccessibilityRetry(
    async () => {
      openAppleAccountSettings();
      await sleep(3500);

      try {
        await execFileAsync("osascript", [AUTOMATION_CHECK_SCPT], { timeout: 20_000 });
      } catch (err) {
        const msg = String(err?.stderr ?? err?.message ?? err);
        if (isAutomationDeniedError({ message: msg })) {
          openAutomationSettings();
          throw new Error(
            "缺少自动化权限：请在 系统设置 → 隐私与安全性 → 自动化 中允许当前终端 App 控制「系统设置」，然后重试。"
          );
        }
      }

      return execFileAsync("osascript", [LOGIN_SCPT], {
        timeout: 180_000,
        env: {
          ...process.env,
          APPLE_SCRIPT_APPLE_ID: creds.appleId,
          APPLE_SCRIPT_PASSWORD: creds.password,
          APPLE_SCRIPT_PANE_OPENED: "1",
        },
      });
    },
    { label: "Mac 系统设置填表", maxAttempts: 3 }
  );

  const errText = String(stderr ?? stdout ?? "");
  if (/邮箱未成功填入|粘贴失败|-2700|-1743/.test(errText)) {
    if (/-1743|自动化权限|缺少自动化/.test(errText)) {
      openAutomationSettings();
      throw new Error(
        "缺少自动化权限：请在 系统设置 → 隐私与安全性 → 自动化 中允许当前终端 App 控制「系统设置」，然后重试。"
      );
    }

    console.warn("[Mac 设置] 主 AppleScript 填邮箱可能失败，尝试 Node 分步坐标粘贴…");
    const ok = await orchestratedCoordinateEmailPaste(creds.appleId);
    if (!ok) {
      console.warn(
        "[Mac 设置] 邮箱填入可能失败。请运行 npm run dump:mac-ui 查看 AX 树，并确认自动化权限已授予。"
      );
    }
  }

  if (stderr?.trim()) {
    console.warn("[Mac 设置] AppleScript stderr:", stderr.trim());
  }
  console.log("[Mac 设置] 填表结果:", stdout.trim() || "ok");
}

/**
 * 等待 Mac 设置中 Apple ID 完全登录（手机验证码人工 + 自动轮询 Sign Out / 邮箱）
 */
export async function waitForMacSettingsLoginComplete(options = {}) {
  await waitUntil(
    "[Mac 设置] 请在系统设置中完成手机验证码（人工），脚本将等待直至检测到已登录…",
    async () => isMacSettingsSignedIn(),
    {
      timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
      intervalMs: options.intervalMs ?? 2500,
      manualHint:
        "\n[Mac 设置] 若已确认 Apple ID 在系统设置中登录成功，按 Enter 继续…",
    }
  );

  await sleep(1500);
  const ok = await isMacSettingsSignedIn();
  if (!ok) {
    console.warn("[Mac 设置] 自动检测未确认登录，但已手动继续");
  } else {
    console.log("[Mac 设置] ✓ 已检测到 Apple ID 登录完成");
  }
}

/**
 * @param {{ appleId: string, password: string }} creds
 */
export async function runMacSettingsLoginPhase(creds) {
  const version = ensureMacOS15({ strict: false });
  console.log(
    `[Mac 设置] macOS ${version.productVersion}（目标 macOS 15 Sequoia）`
  );

  const already = await isMacSettingsSignedIn();
  if (already) {
    console.log("[Mac 设置] 检测到已登录 Apple ID，跳过填表");
    return { skipped: true, signedIn: true };
  }

  await fillMacSettingsAppleLogin(creds);
  console.log(
    "\n[Mac 设置] 账号密码已提交。若出现手机验证码，请在系统界面人工输入。"
  );
  await waitForMacSettingsLoginComplete();
  return { skipped: false, signedIn: true };
}
