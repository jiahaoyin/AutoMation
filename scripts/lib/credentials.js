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

export function loadEnvFile() {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) return envPath;

  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
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
    if (pending.has(key)) {
      out.push(`${key}=${formatEnvValue(pending.get(key))}`);
      pending.delete(key);
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

/**
 * 将账号密码写入 .env（权限 600）
 */
export function saveCredentialsToEnv({ appleId, password }) {
  const envPath = resolveEnvPath();
  let lines = [];

  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf-8").split("\n");
  } else if (fs.existsSync(path.join(PACKAGE_ROOT, ".env.example"))) {
    lines = fs.readFileSync(path.join(PACKAGE_ROOT, ".env.example"), "utf-8").split("\n");
  }

  const updated = upsertEnvLines(lines, {
    APPLE_ID: appleId,
    APPLE_PASSWORD: password,
  });
  const body = updated.join("\n");
  fs.writeFileSync(envPath, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
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
    stdout.write(promptText);

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
        stdout.write("\n");
        resolve(password);
        return;
      }

      if (ch === "\u0003") {
        cleanup();
        stdout.write("\n");
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
