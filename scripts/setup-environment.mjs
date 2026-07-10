#!/usr/bin/env node
/**
 * 环境检测与自动安装
 *   node scripts/setup-environment.mjs           # 检测并自动安装缺失项
 *   node scripts/setup-environment.mjs --check-only
 *   node scripts/setup-environment.mjs --quiet
 */

import { checkEnvironment, ensureEnvironment } from "./lib/env-setup.js";

const checkOnly = process.argv.includes("--check-only");
const quiet = process.argv.includes("--quiet");
const skipFirefox = process.argv.includes("--skip-firefox");
const skipRuyiPage = process.argv.includes("--skip-ruyipage");
const skipAccessibility = process.argv.includes("--skip-accessibility");
const skipAutomation = process.argv.includes("--skip-automation");
const installRuyiPage = process.argv.includes("--install-ruyipage");

async function main() {
  if (checkOnly) {
    const result = await checkEnvironment({
      quiet,
      skipFirefox,
      skipRuyiPage,
      skip2FAAutomation: skipFirefox && skipRuyiPage,
    });
    process.exit(result.ok ? 0 : 1);
  }

  await ensureEnvironment({
    quiet,
    skipFirefox,
    skipRuyiPage,
    skipAccessibility,
    skipAutomation,
    installRuyiPage,
  });
  const result = await checkEnvironment({
    quiet,
    skipFirefox,
    skipRuyiPage,
    skip2FAAutomation: skipFirefox && skipRuyiPage,
  });
  if (!result.ok && result.issues.some((i) => !i.includes(".env"))) {
    console.warn("警告: 仍有未解决项:", result.issues.join("; "));
  }
}

main().catch((e) => {
  console.error("[setup]", e.message || e);
  process.exit(1);
});
