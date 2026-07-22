import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "../..");

export function resolveEnvPath() {
  const cwdEnv = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnv)) return cwdEnv;
  return path.join(PACKAGE_ROOT, ".env");
}

export function parseEnvValue(source) {
  const value = String(source ?? "").trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\([\\"])/g, "$1");
  }
  return value;
}

export function loadEnvFile() {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) return envPath;

  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = parseEnvValue(trimmed.slice(eq + 1));
    if (!Object.hasOwn(process.env, key)) process.env[key] = val;
  }
  return envPath;
}

function formatEnvValue(val) {
  if (/[\s#"'\\]/.test(val)) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return val;
}

function upsertEnvLines(lines, entries) {
  const pending = new Map(Object.entries(entries));
  const handled = new Set();
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (Object.hasOwn(entries, key)) {
      if (!handled.has(key)) {
        out.push(`${key}=${formatEnvValue(entries[key])}`);
        handled.add(key);
        pending.delete(key);
      }
    } else {
      out.push(line);
    }
  }

  if (pending.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push("# Apple ID（由脚本自动备份，请勿提交 git）");
    for (const [key, val] of pending) {
      out.push(`${key}=${formatEnvValue(val)}`);
    }
  }

  return out;
}

function readEnvDocument(file) {
  const text = fs.readFileSync(file, "utf-8");
  return {
    lines: text.split(/\r?\n/),
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function writePrivateEnvFile(envPath, lines, lineEnding) {
  const body = lines.join(lineEnding);
  const content = body.endsWith(lineEnding) ? body : `${body}${lineEnding}`;
  if (fs.existsSync(envPath)) fs.chmodSync(envPath, 0o600);
  fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

/**
 * 将账号密码写入 .env（权限 600）
 */
export function saveCredentialsToEnv({ appleId, password }) {
  const envPath = resolveEnvPath();
  let lines = [];
  let lineEnding = "\n";

  if (fs.existsSync(envPath)) {
    ({ lines, lineEnding } = readEnvDocument(envPath));
  } else if (fs.existsSync(path.join(PACKAGE_ROOT, ".env.example"))) {
    ({ lines, lineEnding } = readEnvDocument(path.join(PACKAGE_ROOT, ".env.example")));
  }

  const updated = upsertEnvLines(lines, {
    APPLE_ID: appleId,
    APPLE_PASSWORD: password,
  });
  writePrivateEnvFile(envPath, updated, lineEnding);
  return envPath;
}

function normalizeProfileEnvValue(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

/**
 * Persist only values collected from the authenticated profile page. Callers
 * keep those values out of reports and audit records.
 */
export function saveAppleProfileToEnv({ name, birthday }) {
  const safeName = normalizeProfileEnvValue(name, "profile name", 256);
  const safeBirthday = normalizeProfileEnvValue(birthday, "profile birthday", 128);
  const envPath = resolveEnvPath();
  const { lines, lineEnding } = fs.existsSync(envPath)
    ? readEnvDocument(envPath)
    : { lines: [], lineEnding: "\n" };
  const updated = upsertEnvLines(lines, {
    name: safeName,
    birthday: safeBirthday,
  });
  writePrivateEnvFile(envPath, updated, lineEnding);
  return envPath;
}

async function questionPassword(promptText) {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(promptText);
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    const stdin = input;
    const wasRaw = stdin.isRaw;
    output.write(promptText);

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };

    const onData = (chunk) => {
      const ch = chunk.toString();

      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        cleanup();
        output.write("\n");
        resolve(password);
        return;
      }

      if (ch === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new Error("已取消"));
        return;
      }

      if (ch === "\u007f" || ch === "\b") {
        password = password.slice(0, -1);
        return;
      }

      password += ch;
    };

    stdin.on("data", onData);
  });
}

export function requireAppleCredentials() {
  loadEnvFile();
  const appleId = process.env.APPLE_ID?.trim();
  const password = process.env.APPLE_PASSWORD?.trim();

  if (!appleId || !password) {
    throw new Error("未找到账号密码，请运行 ./run.sh 在终端输入");
  }
  return { appleId, password };
}

export function maskAppleId(appleId) {
  const value = String(appleId ?? "").trim();
  if (!value) return "***";

  const atIndex = value.indexOf("@");
  if (atIndex >= 0) {
    const local = value.slice(0, atIndex);
    const domain = value.slice(atIndex);
    const visible = local.length > 2 ? local.slice(0, 2) : "";
    return `${visible}***${domain}`;
  }

  const visible = value.length > 2 ? value.slice(0, 2) : "";
  return `${visible}***`;
}

export function shouldAutoConfirmAppleCredentials(env = process.env) {
  return env.APPLE_AUTOMATION_SUPERVISED_GUI === "1";
}

/**
 * .env 已有账号时回车确认；否则完整输入并备份
 */
export async function confirmOrPromptAppleCredentials() {
  loadEnvFile();
  const existingId = process.env.APPLE_ID?.trim();
  const existingPw = process.env.APPLE_PASSWORD?.trim();

  if (existingId && existingPw) {
    const masked = maskAppleId(existingId);
    console.log(`已读取 .env 中的账号: ${masked}`);
    if (shouldAutoConfirmAppleCredentials()) {
      console.log(`✓ 受监督验收自动使用 .env 账号 ${masked}\n`);
      return { appleId: existingId, password: existingPw };
    }
    console.log("按回车确认使用该账号，或输入新的 Apple ID 邮箱：");

    const rl = readline.createInterface({ input, output });
    let line;
    try {
      line = (await rl.question("> ")).trim();
    } finally {
      rl.close();
    }

    if (!line) {
      console.log(`✓ 使用 .env 账号 ${masked}\n`);
      return { appleId: existingId, password: existingPw };
    }

    const appleId = line;
    const password = (await questionPassword("Apple ID 密码: ")).trim();
    if (!password) throw new Error("密码不能为空");

    const creds = { appleId, password };
    const envPath = saveCredentialsToEnv(creds);
    console.log(`\n✓ 已更新并备份至 ${envPath}\n`);
    process.env.APPLE_ID = appleId;
    process.env.APPLE_PASSWORD = password;
    return creds;
  }

  return promptAppleCredentials();
}

/**
 * 终端交互输入账号密码，备份至 .env 后返回
 */
export async function promptAppleCredentials() {
  console.log("请在终端输入 Apple ID 账号密码（将自动备份至 .env）\n");

  const rl = readline.createInterface({ input, output });
  let appleId;
  try {
    appleId = (await rl.question("Apple ID（邮箱）: ")).trim();
  } finally {
    rl.close();
  }

  if (!appleId) {
    throw new Error("Apple ID 不能为空");
  }

  const password = (await questionPassword("Apple ID 密码: ")).trim();
  if (!password) {
    throw new Error("密码不能为空");
  }

  const creds = { appleId, password };
  const envPath = saveCredentialsToEnv(creds);
  console.log(`\n✓ 已备份至 ${envPath}\n`);

  process.env.APPLE_ID = appleId;
  process.env.APPLE_PASSWORD = password;

  return creds;
}
