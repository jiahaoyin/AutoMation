/**
 * Vision OCR reads a verified native Apple code dialog when AX text is unavailable.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNativeHelperPath } from "./native-helper-path.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCR_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-ocr.swift");
const OCR_BIN = resolveNativeHelperPath(
  path.resolve(__dirname, "../bin"),
  "mac-2fa-popup-ocr"
);
const OCR_CAPABILITIES = new Set([
  "available",
  "permission_missing",
  "unavailable",
]);
const defaultCapabilityCache = {};

function needsRecompile(sourcePath, binaryPath) {
  if (!fs.existsSync(sourcePath)) return true;
  if (!fs.existsSync(binaryPath)) return true;
  return fs.statSync(sourcePath).mtimeMs > fs.statSync(binaryPath).mtimeMs;
}

function binaryIsExecutable(binaryPath, options = {}) {
  const statSync = options.statSync ?? fs.statSync;
  const accessSync = options.accessSync ?? fs.accessSync;
  try {
    if (!statSync(binaryPath).isFile()) return false;
    accessSync(binaryPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compileOcrHelper(sourcePath, binaryPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCompiler = options.spawnSync ?? spawnSync;
  if (platform !== "darwin" || !fs.existsSync(sourcePath)) return false;

  const temporaryBin = `${binaryPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const r = runCompiler(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        "-o",
        temporaryBin,
        sourcePath,
        "-framework",
        "ApplicationServices",
        "-framework",
        "AppKit",
        "-framework",
        "Vision",
        "-framework",
        "CoreGraphics",
        "-framework",
        "ScreenCaptureKit",
      ],
      { encoding: "utf-8" }
    );
    if (r.status !== 0 || !binaryIsExecutable(temporaryBin, options)) {
      if (options.quiet !== true) console.warn("[2FA] Vision OCR 编译失败");
      return false;
    }
    fs.renameSync(temporaryBin, binaryPath);
    return binaryIsExecutable(binaryPath, options);
  } catch {
    if (options.quiet !== true) console.warn("[2FA] Vision OCR 编译失败");
    return false;
  } finally {
    try {
      if (fs.existsSync(temporaryBin)) fs.unlinkSync(temporaryBin);
    } catch {
      /* best-effort cleanup of one failed compiler output */
    }
  }
}

export function is2FAOcrHelperAvailable(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourcePath = options.sourcePath ?? OCR_SRC;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  if (platform !== "darwin") return false;
  if (needsRecompile(sourcePath, binaryPath)) {
    return compileOcrHelper(sourcePath, binaryPath, options);
  }
  return binaryIsExecutable(binaryPath, options);
}

export function parseOcrResult(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (parsed.ok !== true || typeof parsed.code !== "string") return null;
    if (!/^\d{6}$/.test(parsed.code)) return null;
    return {
      code: parsed.code,
      source: parsed.source ? String(parsed.source) : "vision",
    };
  } catch {
    return null;
  }
}

export function parseOcrCapability(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/).pop() || "";
  try {
    const parsed = JSON.parse(line);
    if (parsed.ok !== true || !OCR_CAPABILITIES.has(parsed.capability)) {
      return "unavailable";
    }
    return parsed.capability;
  } catch {
    return "unavailable";
  }
}

export async function get2FAOcrCapability(options = {}) {
  const capabilityCache = options.capabilityCache ?? defaultCapabilityCache;
  if (capabilityCache.capability === "permission_missing") {
    return "permission_missing";
  }

  const isHelperAvailable =
    options.isHelperAvailable ?? is2FAOcrHelperAvailable;
  if (!isHelperAvailable(options)) return "unavailable";

  const runHelper = options.execFileAsync ?? execFileAsync;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  let capability = "unavailable";
  try {
    const { stdout } = await runHelper(
      binaryPath,
      ["--preflight-screen-capture"],
      { timeout: 5_000, maxBuffer: 64 * 1024 }
    );
    capability = parseOcrCapability(stdout);
  } catch (err) {
    const stdout =
      err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) capability = parseOcrCapability(stdout);
  }

  if (capability === "permission_missing") {
    capabilityCache.capability = capability;
  }
  return capability;
}

function unavailableOcrResult(capability) {
  return { code: null, source: "vision", capability };
}

/**
 * @param {number} [timeoutSec]
 * @param {object} [options]
 * @returns {Promise<{ code: string, source: string }|null>}
 */
export async function readPopupCodeViaOcr(timeoutSec = 10, options = {}) {
  const capability = await get2FAOcrCapability(options);
  if (capability !== "available") return unavailableOcrResult(capability);

  const runHelper = options.execFileAsync ?? execFileAsync;
  const binaryPath = options.binaryPath ?? OCR_BIN;
  const args = ["--timeout", String(timeoutSec)];
  try {
    const { stdout, stderr } = await runHelper(binaryPath, args, {
      timeout: (timeoutSec + 15) * 1000,
      maxBuffer: 256 * 1024,
    });
    if (stderr?.trim()) {
      console.log("[2FA] Vision OCR helper reported diagnostics");
    }
    return parseOcrResult(stdout) ?? unavailableOcrResult("available");
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) {
      return parseOcrResult(stdout) ?? unavailableOcrResult("available");
    }
  }
  return unavailableOcrResult("unavailable");
}
