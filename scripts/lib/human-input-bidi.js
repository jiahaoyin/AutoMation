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

  /** @param {string} text */
  async typeText(text) {
    for (const char of text) {
      await this.bidi.performActions({
        context: this.context,
        actions: [
          {
            type: "key",
            id: this.keyId,
            actions: [
              { type: "keyDown", value: char },
              { type: "keyUp", value: char },
            ],
          },
        ],
      });
      await sleep(randomBetween(60, 180) + (Math.random() < 0.08 ? 300 : 0));
    }
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
      const nodes = await this.bidi.locateNodes(selector, this.context).catch(() => []);
      if (nodes.length) return nodes;
      await sleep(500);
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
