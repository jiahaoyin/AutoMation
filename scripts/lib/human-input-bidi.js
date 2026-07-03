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
    x: start.x + (Math.random() - 0.5) * 280,
    y: start.y + (Math.random() - 0.5) * 180,
  };
  const cp2 = {
    x: end.x + (Math.random() - 0.5) * 200,
    y: end.y + (Math.random() - 0.5) * 150,
  };
  const points = [];
  const count = steps + Math.floor(Math.random() * 12);
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
    /** @type {{x:number,y:number}} */
    this.lastMouse = {
      x: 400 + Math.random() * 200,
      y: 280 + Math.random() * 160,
    };
    this.pointerId = "human-pointer-1";
    this.keyId = "human-keyboard-1";
  }

  /** @param {string} context */
  setContext(context) {
    this.context = context;
  }

  async preActionWander() {
    const moves = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < moves; i++) {
      const x = this.lastMouse.x + randomBetween(-90, 90);
      const y = this.lastMouse.y + randomBetween(-60, 60);
      await this.moveTo(
        Math.max(20, Math.min(1400, x)),
        Math.max(20, Math.min(860, y))
      );
      await sleep(randomBetween(40, 120));
    }
  }

  async moveTo(x, y) {
    const path = bezierPath(this.lastMouse, { x, y });
    const actions = path.map((p) => ({
      type: "pointerMove",
      x: Math.round(p.x),
      y: Math.round(p.y),
      duration: Math.round(randomBetween(6, 28)),
    }));

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

    this.lastMouse = { x, y };
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  async clickAt(x, y) {
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
   * @param {{sharedId: string}} node
   */
  async clickElement(node) {
    await this.preActionWander();
    const offsetX = Math.round(randomBetween(3, 18));
    const offsetY = Math.round(randomBetween(3, 14));

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
    await sleep(randomBetween(180, 420));
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
        return found.nodes;
      }
      const nodes = await this.bidi.locateNodes(selector, this.context).catch(() => []);
      if (nodes.length) return nodes;
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
