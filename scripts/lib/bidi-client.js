/**
 * Firefox WebDriver BiDi client (BiDi-only over ws://127.0.0.1:PORT/session)
 * @see https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection
 */

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_FIREFOX =
  process.platform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : "firefox";

const BIDI_URL_RE = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/i;

export function resolveFirefoxExecutable() {
  const fromEnv = process.env.FIREFOX_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(DEFAULT_FIREFOX)) return DEFAULT_FIREFOX;
  return "firefox";
}

export function defaultFirefoxProfileDir() {
  return (
    process.env.FIREFOX_PROFILE_DIR ??
    path.join(ROOT, "data", "firefox-apple-automation")
  );
}

function parseBidiUrl(chunk) {
  const match = chunk.match(BIDI_URL_RE);
  return match?.[1] ?? null;
}

/**
 * @param {object} [options]
 * @param {string} [options.executablePath]
 * @param {string} [options.profileDir]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.launchTimeoutMs]
 */
export async function launchFirefox(options = {}) {
  const executablePath = options.executablePath ?? resolveFirefoxExecutable();
  const profileDir = options.profileDir ?? defaultFirefoxProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    "--profile",
    profileDir,
    "--remote-debugging-port=0",
    "--no-remote",
    `--width=${options.width ?? 1440}`,
    `--height=${options.height ?? 900}`,
  ];

  const child = spawn(executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let wsUrl = null;
  let stderr = "";

  const launchTimeoutMs = options.launchTimeoutMs ?? 45_000;

  wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Firefox BiDi launch timeout (${launchTimeoutMs}ms)\n${stderr}`));
    }, launchTimeoutMs);

    const onData = (buf) => {
      const text = buf.toString();
      stderr += text;
      const found = parseBidiUrl(text);
      if (found) {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        resolve(found.endsWith("/session") ? found : `${found.replace(/\/$/, "")}/session`);
      }
    };

    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (!wsUrl) {
        clearTimeout(timer);
        reject(
          new Error(`Firefox exited before BiDi URL (code=${code})\n${stderr}`)
        );
      }
    });
  });

  return { process: child, wsUrl, profileDir, stderr };
}

/** 系统设置取码后切回 Firefox（避免键盘输入落到错误窗口） */
export async function activateFirefoxApp() {
  if (process.platform !== "darwin") return;
  await execFileAsync("osascript", ["-e", 'tell application "Firefox" to activate']).catch(() => {});
}

export class BidiClient {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl.endsWith("/session") ? wsUrl : `${wsUrl.replace(/\/$/, "")}/session`;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.session = null;
    /** @type {string | null} */
    this.rootContext = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket not initialized"));
      this.ws.onopen = () => resolve(undefined);
      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
    });

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === "error") {
          reject(new Error(msg.message ?? JSON.stringify(msg)));
        } else {
          resolve(msg.result ?? msg);
        }
      }
    };

    const sessionResult = await this.send("session.new", {
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true,
        },
      },
    });

    this.session = sessionResult;
    this.rootContext = sessionResult?.capabilities?.alwaysMatch?.webSocketUrl
      ? null
      : sessionResult?.sessionId ?? null;

    const contexts = await this.send("browsingContext.getTree", { maxDepth: 0 });
    const root = contexts?.contexts?.[0];
    if (root?.context) {
      this.rootContext = root.context;
    }

    return sessionResult;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   */
  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error("BiDi WebSocket is not open"));
    }
    const id = ++this.nextId;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`BiDi timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  /** @param {string} url @param {string} [context] */
  async navigate(url, context = this.rootContext) {
    if (!context) throw new Error("No browsing context");
    return this.send("browsingContext.navigate", {
      context,
      url,
      wait: "complete",
    });
  }

  /** @param {string} [context] */
  async createTab(context = this.rootContext) {
    return this.send("browsingContext.create", {
      type: "tab",
      referenceContext: context,
    });
  }

  /**
   * @param {number} [maxDepth]
   * @returns {Promise<Array<{ context: string, url: string, children?: unknown[] }>>}
   */
  async getContextTree(maxDepth = 8) {
    const result = await this.send("browsingContext.getTree", { maxDepth });
    return result?.contexts ?? [];
  }

  /**
   * @param {unknown[]} nodes
   * @param {Array<{ context: string, url: string }>} [out]
   */
  flattenContexts(nodes, out = []) {
    for (const node of nodes ?? []) {
      if (!node || typeof node !== "object") continue;
      const n = /** @type {{ context?: string, url?: string, children?: unknown[] }} */ (node);
      if (n.context) {
        out.push({ context: n.context, url: n.url ?? "" });
      }
      if (n.children?.length) this.flattenContexts(n.children, out);
    }
    return out;
  }

  /** @param {number} [maxDepth] */
  async getAllContexts(maxDepth = 8) {
    const tree = await this.getContextTree(maxDepth);
    return this.flattenContexts(tree);
  }

  /**
   * @param {string} selector
   * @param {number} [maxDepth]
   * @returns {Promise<{ nodes: object[], context: string, url: string } | null>}
   */
  async locateNodesInAnyContext(selector, maxDepth = 8) {
    const contexts = await this.getAllContexts(maxDepth);
    const ordered = [...contexts].sort((a, b) => {
      const score = (u) =>
        /idmsa|appleid|auth/i.test(u) ? 0 : /account\.apple\.com/i.test(u) ? 1 : 2;
      return score(a.url) - score(b.url);
    });

    for (const { context, url } of ordered) {
      try {
        const nodes = await this.locateNodes(selector, context);
        if (nodes.length) return { nodes, context, url };
      } catch {
        /* try next context */
      }
    }
    return null;
  }

  /**
   * @param {string} selector
   * @param {string} [context]
   */
  async locateNodes(selector, context = this.rootContext) {
    const result = await this.send("browsingContext.locateNodes", {
      context,
      locator: { type: "css", value: selector },
    });
    return result?.nodes ?? [];
  }

  /** @param {string} [context] */
  async captureScreenshot(context = this.rootContext) {
    const result = await this.send("browsingContext.captureScreenshot", {
      context,
    });
    return result?.data ?? null;
  }

  /** @param {string} expression @param {string} [context] */
  async evaluate(expression, context = this.rootContext) {
    const result = await this.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    const r = result?.result;
    if (r && typeof r === "object" && "value" in r) {
      return r.value;
    }
    return r;
  }

  /** @param {string} [context] @returns {Promise<{ width: number, height: number }>} */
  async getViewportSize(context = this.rootContext) {
    const raw = await this.evaluate(
      `JSON.stringify({
        width: Math.max(1, window.innerWidth || document.documentElement?.clientWidth || 800),
        height: Math.max(1, window.innerHeight || document.documentElement?.clientHeight || 600)
      })`,
      context
    );
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return {
        width: Math.max(1, Number(parsed?.width) || 800),
        height: Math.max(1, Number(parsed?.height) || 600),
      };
    } catch {
      return { width: 980, height: 720 };
    }
  }

  /** @param {object} params */
  async performActions(params) {
    return this.send("input.performActions", params);
  }

  async close() {
    try {
      if (this.session?.sessionId) {
        await this.send("session.end", { sessionId: this.session.sessionId });
      }
    } catch {
      /* ignore */
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * @param {import("node:child_process").ChildProcess} proc
 * @param {number} [timeoutMs]
 */
export function stopFirefox(proc, timeoutMs = 5000) {
  if (!proc || proc.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function ensureLoopbackHost(wsUrl) {
  return wsUrl.replace("localhost", "127.0.0.1");
}
