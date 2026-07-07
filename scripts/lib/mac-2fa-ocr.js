/**
 * Vision OCR 读取弹窗验证码（AX/AppleScript 失败时）
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCR_SRC = path.resolve(__dirname, "../swift/mac-2fa-popup-ocr.swift");
const OCR_BIN = path.resolve(__dirname, "../bin/mac-2fa-popup-ocr");

function ensureOcrBin() {
  if (process.platform !== "darwin" || !fs.existsSync(OCR_SRC)) return false;
  const needs =
    !fs.existsSync(OCR_BIN) ||
    fs.statSync(OCR_SRC).mtimeMs > fs.statSync(OCR_BIN).mtimeMs;
  if (!needs) return true;
  fs.mkdirSync(path.dirname(OCR_BIN), { recursive: true });
  const r = spawnSync(
    "swiftc",
    [
      "-O",
      "-o",
      OCR_BIN,
      OCR_SRC,
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "-framework",
      "Vision",
      "-framework",
      "CoreGraphics",
    ],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    console.warn("[2FA] Vision OCR 编译失败:", r.stderr?.trim() || r.error);
    return false;
  }
  try {
    fs.chmodSync(OCR_BIN, 0o755);
  } catch {
    /* ignore */
  }
  return true;
}

function looksLikeFormattedRaw(raw) {
  if (!raw || typeof raw !== "string") return false;
  const s = raw.trim();
  return /^\d{3}[\s\u00a0\u2009]\d{3}$/.test(s);
}

function normalizeCode(code) {
  return String(code ?? "").replace(/\D/g, "").slice(0, 6);
}

/**
 * @param {number} [timeoutSec]
 * @param {{ debugDir?: string, requireFormattedRaw?: boolean }} [options]
 * @returns {Promise<{ code: string, raw: string|null, source: string }|null>}
 */
export async function readPopupCodeViaOcr(timeoutSec = 10, options = {}) {
  if (!ensureOcrBin()) return null;
  const args = ["--timeout", String(timeoutSec)];
  if (options.debugDir) {
    args.push("--debug-dir", options.debugDir);
  }
  try {
    const { stdout, stderr } = await execFileAsync(OCR_BIN, args, {
      timeout: (timeoutSec + 15) * 1000,
      maxBuffer: 256 * 1024,
    });
    if (stderr?.trim()) {
      for (const line of stderr.trim().split("\n")) {
        console.log(`[2FA] ${line}`);
      }
    }
    const parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
    if (parsed.ok && parsed.code) {
      const code = normalizeCode(parsed.code);
      const raw = parsed.raw ?? null;
      if (code.length === 6) {
        if (options.requireFormattedRaw !== false && !looksLikeFormattedRaw(raw)) {
          console.log(`[2FA] OCR 跳过非 NNN NNN 格式: 原文="${raw ?? ""}"`);
          return null;
        }
        return { code, raw, source: parsed.source ?? "vision" };
      }
    }
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout || "") : "";
    if (stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (parsed.ok && parsed.code) {
          const code = normalizeCode(parsed.code);
          const raw = parsed.raw ?? null;
          if (code.length === 6) {
            if (options.requireFormattedRaw !== false && !looksLikeFormattedRaw(raw)) {
              return null;
            }
            return { code, raw, source: parsed.source ?? "vision" };
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
