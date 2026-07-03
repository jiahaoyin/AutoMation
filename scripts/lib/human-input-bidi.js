/**
 * Human-like pointer/keyboard input via WebDriver BiDi input.performActions
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function bezierPoint(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u ** 3 * p0 + 3 * u ** 2 * t * p1 + 3 * u * t ** 2 * p2 + t ** 3 * p3;
}

function bezierPath(start, end, steps = 20) {
  const cp1 = {
    x: start.x + (Math.random() - 0.5) * Math.min(180, Math.abs(end.x - start.x) + 80),
    y: start.y + (Math.random() - 0.5) * Math.min(120, Math.abs(end.y - start.y) + 60),
  };
  const cp2 = {
    x: end.x + (Math.random() - 0.5) * Math.min(140, Math.abs(end.x - start.x) + 60),
    y: end.y + (Math.random() - 0.5) * Math.min(100, Math.abs(end.y - start.y) + 50),
  };
  const points = [];
  const count = steps + Math.floor(Math.random() * 8);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push({
      x: bezierPoint(t, start.x, cp1.x, cp2.x, end.x),
      y: bezierPoint(t, start.y, cp1.y, cp2.y, end.y),
    });
  }
  return points;
}

export class HumanInput {
  /**
   * @param {import("./bidi-client.js").BidiClient} bidi
   * @param {string} context browsingContext id
   */
  constructor(bidi, context) {
    this.bidi = bidi;
    this.context = context;
    /** @type {{ width: number, height: number } | null} */
    this.viewport = null;
    /** @type {{x:number,y:number}} */
    this.lastMouse = { x: 200, y: 200 };
    this.pointerId = "human-pointer-1";
    this.keyId = "human-keyboard-1";
  }

  /** @param {string} context */
  setContext(context) {
    this.context = context;
    this.viewport = null;
  }

  async ensureViewport() {
    if (this.viewport) return this.viewport;
    this.viewport = await this.bidi.getViewportSize(this.context);
    const margin = 12;
    this.lastMouse = {
      x: Math.round(this.viewport.width / 2),
      y: Math.round(Math.min(this.viewport.height / 2, this.viewport.height - margin)),
    };
    return this.viewport;
  }

  /** @param {number} x @param {number} y */
  clampPoint(x, y) {
    const vp = this.viewport ?? { width: 980, height: 720 };
    const margin = 8;
    const maxX = Math.max(margin + 1, vp.width - margin);
    const maxY = Math.max(margin + 1, vp.height - margin);
    return {
      x: Math.round(Math.min(maxX, Math.max(margin, x))),
      y: Math.round(Math.min(maxY, Math.max(margin, y))),
    };
  }

  async preActionWander() {
    await this.ensureViewport();
    const vp = this.viewport;
    if (!vp || vp.height < 120) return;

    const moves = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < moves; i++) {
      const spreadX = Math.min(60, vp.width * 0.08);
      const spreadY = Math.min(40, vp.height * 0.08);
      const target = this.clampPoint(
        this.lastMouse.x + randomBetween(-spreadX, spreadX),
        this.lastMouse.y + randomBetween(-spreadY, spreadY)
      );
      await this.moveTo(target.x, target.y, { skipWander: true });
      await sleep(randomBetween(40, 100));
    }
  }

  /** @param {number} x @param {number} y @param {{ skipWander?: boolean }} [opts] */
  async moveTo(x, y, opts = {}) {
    await this.ensureViewport();
    const end = this.clampPoint(x, y);
    const path = bezierPath(this.lastMouse, end);
    const actions = path.map((p) => {
      const c = this.clampPoint(p.x, p.y);
      return {
        type: "pointerMove",
        x: c.x,
        y: c.y,
        duration: Math.round(randomBetween(6, 24)),
      };
    });

    await this.bidi.performActions({
      context: this.context,
      actions: [
        {
          type: "pointer",
          id: this.pointerId,
          parameters: { pointerType: "mouse" },
          actions,
        },
      ],
    });

    this.lastMouse = end;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  async clickAt(x, y) {
    if (Math.random() < 0.35) await this.preActionWander();
    await this.moveTo(x, y);
    await sleep(randomBetween(80, 220));

    await this.bidi.performActions({
      context: this.context,
      actions: [
        {
          type: "pointer",
          id: this.pointerId,
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: Math.round(randomBetween(50, 130)) },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });

    await sleep(randomBetween(180, 420));
  }

  /**
   * Click element by sharedId using random in-box offset.
   * Uses element-relative pointerMove (no absolute wander) to stay inside iframe viewport.
   * @param {{sharedId: string}} node
   */
  async clickElement(node) {
    await this.ensureViewport();
    const offsetX = Math.round(randomBetween(4, 16));
    const offsetY = Math.round(randomBetween(4, 12));

    try {
      await this.bidi.performActions({
        context: this.context,
        actions: [
          {
            type: "pointer",
            id: this.pointerId,
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                origin: { type: "element", element: { sharedId: node.sharedId } },
                x: offsetX,
                y: offsetY,
              },
              { type: "pause", duration: Math.round(randomBetween(80, 200)) },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: Math.round(randomBetween(50, 130)) },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/out of bounds|viewport/i.test(msg)) throw err;
      await this.focusElementByScript(node);
    }

    await sleep(randomBetween(180, 420));
  }

  /** @param {{sharedId: string}} node */
  async focusElementByScript(node) {
    await this.bidi.evaluate(
      `((id) => {
        const el = document.querySelector('[data-shared-id="' + id + '"]')
          || document.activeElement;
        if (el && typeof el.focus === "function") {
          el.focus();
          el.click?.();
          return true;
        }
        return false;
      })(${JSON.stringify(node.sharedId ?? "")})`,
      this.context
    ).catch(() => false);
  }

  /**
   * Focus input via CSS selector fallback (works in iframe context).
   * @param {string} selector
   */
  async focusInputBySelector(selector) {
    await this.bidi.evaluate(
      `((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.focus();
        el.click?.();
        return true;
      })(${JSON.stringify(selector)})`,
      this.context
    );
    await sleep(randomBetween(150, 320));
  }

  /** @param {string} text @param {{ slow?: boolean }} [opts] */
  async typeText(text, opts = {}) {
    const baseMin = opts.slow ? 90 : 55;
    const baseMax = opts.slow ? 220 : 175;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      await this.bidi.performActions({
        context: this.context,
        actions: [
          {
            type: "key",
            id: this.keyId,
            actions: [
              { type: "keyDown", value: char },
              { type: "pause", duration: Math.round(randomBetween(20, 65)) },
              { type: "keyUp", value: char },
            ],
          },
        ],
      });
      let delay = randomBetween(baseMin, baseMax);
      if (Math.random() < 0.1) delay += randomBetween(180, 420);
      if (i > 0 && i % 4 === 0 && Math.random() < 0.15) {
        delay += randomBetween(250, 600);
      }
      await sleep(delay);
    }
  }

  /**
   * Click then type; falls back to selector focus if pointer click fails.
   * @param {{sharedId: string}} node
   * @param {string} selector
   * @param {string} text
   * @param {{ slow?: boolean }} [opts]
   */
  async focusAndTypeElement(node, selector, text, opts = {}) {
    try {
      await this.clickElement(node);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/out of bounds|viewport|Element not found/i.test(msg)) throw err;
      console.warn(`[Firefox] 指针点击失败，改用 focus: ${selector}`);
      await this.focusInputBySelector(selector);
    }
    await sleep(randomBetween(120, 280));
    await this.typeText(text, opts);
  }

  /** @param {{sharedId: string}} node */
  async clearElement(node) {
    await this.clickElement(node);
    await sleep(randomBetween(100, 220));
    const mod = process.platform === "darwin" ? "\uE03D" : "\uE009";
    await this.bidi.performActions({
      context: this.context,
      actions: [
        {
          type: "key",
          id: this.keyId,
          actions: [
            { type: "keyDown", value: mod },
            { type: "keyDown", value: "a" },
            { type: "keyUp", value: "a" },
            { type: "keyUp", value: mod },
            { type: "keyDown", value: "\uE017" },
            { type: "keyUp", value: "\uE017" },
          ],
        },
      ],
    });
    await sleep(randomBetween(120, 280));
  }

  async pressEnter() {
    await this.bidi.performActions({
      context: this.context,
      actions: [
        {
          type: "key",
          id: this.keyId,
          actions: [{ type: "keyDown", value: "\uE007" }, { type: "keyUp", value: "\uE007" }],
        },
      ],
    });
    await sleep(randomBetween(200, 400));
  }

  /**
   * @param {string} selector
   * @param {number} [timeoutMs]
   */
  async waitForSelector(selector, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.bidi.locateNodesInAnyContext(selector).catch(() => null);
      if (found?.nodes?.length) {
        this.setContext(found.context);
        await this.ensureViewport();
        return found.nodes;
      }
      const nodes = await this.bidi.locateNodes(selector, this.context).catch(() => []);
      if (nodes.length) {
        await this.ensureViewport();
        return nodes;
      }
      await sleep(400 + Math.random() * 350);
    }
    throw new Error(`等待元素超时: ${selector}`);
  }

  /** @param {string} selector */
  async clickSelector(selector) {
    const nodes = await this.bidi.locateNodes(selector, this.context);
    if (!nodes.length) throw new Error(`Element not found: ${selector}`);
    await this.clickElement(nodes[0]);
  }

  /** @param {string} selector @param {string} text */
  async focusAndType(selector, text) {
    await this.clickSelector(selector);
    await sleep(randomBetween(120, 280));
    await this.typeText(text);
  }
}

export { sleep, bezierPath, randomBetween };
