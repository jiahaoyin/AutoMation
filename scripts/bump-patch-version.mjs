#!/usr/bin/env node
/**
 * 将根 package.json 的 patch 版本 +1（1.0.0 → 1.0.1）
 *   node scripts/bump-patch-version.mjs
 *   node scripts/bump-patch-version.mjs --print   # 仅打印新版本，不写文件
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = path.join(ROOT, "package.json");

export function bumpPatchVersion(version) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(.*)?$/);
  if (!m) {
    throw new Error(`无法解析版本号: ${version}`);
  }
  const patch = parseInt(m[3], 10) + 1;
  return `${m[1]}.${m[2]}.${patch}${m[4] ?? ""}`;
}

export function readPkgVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
  return pkg.version ?? "0.0.0";
}

export function writePkgVersion(nextVersion) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
  const prev = pkg.version ?? "0.0.0";
  pkg.version = nextVersion;
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  return { prev, next: nextVersion };
}

function main() {
  const printOnly = process.argv.includes("--print");
  const current = readPkgVersion();
  const next = bumpPatchVersion(current);

  if (printOnly) {
    console.log(next);
    return;
  }

  const { prev } = writePkgVersion(next);
  console.log(`版本: ${prev} → ${next}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
