import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { settle, wheel, anchor, expectAnchor } from "./timeline.mjs";

// Setup only: callers hold image responses until navigation has finished, then
// release them and assert stability without any corrective scrolling.
async function navigate(page, direction) {
  const feed = page.getByRole("region", { name: "Channel message history" });
  const remaining = () =>
    feed.evaluate(
      (el, direction) =>
        direction < 0
          ? el.scrollTop - (el.scrollHeight - el.clientHeight) / 3
          : el.scrollHeight - el.clientHeight - el.scrollTop,
      direction,
    );
  await feed.hover();
  // Read inside the current scroll extent, clear of both clamped edges.
  // Traverse to the setup condition, not a fixed wheel-count budget. WebKit and
  // virtualized remeasurement can apply only part of a requested displacement.
  // The existing test deadline bounds traversal; every gesture must make settled
  // progress. This runs only while image responses are held, never during the
  // preservation assertions that follow their release.
  while (true) {
    const before = await remaining();
    if (before < 4) break;
    await wheel(page, direction * Math.min(2000, before));
    expect(
      before - (await remaining()),
      "image navigation retains progress after settling",
    ).toBeGreaterThan(0);
  }
  expect(await remaining(), "image navigation reaches its setup").toBeLessThan(
    4,
  );
}

async function fixtureServer() {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  return server;
}

test("delayed and failed images preserve bottom and reading anchors across remounts", async ({
  page,
}, testInfo) => {
  const pending = new Set();
  const requests = new Map();
  let held = true;
  async function release() {
    held = false;
    const waiting = [...pending];
    pending.clear();
    await Promise.all(waiting.map((resume) => resume()));
  }
  await page.route("https://image.test/**", async (route) => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    if (held) await new Promise((resolve) => pending.add(resolve));
    // Routing deliberately disables HTTP cache: each remount can load late.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill(
      url.endsWith("/56.svg")
        ? { status: 404, body: "missing" }
        : {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="orange"/></svg>',
          },
    );
  });
  const feed = page.getByRole("region", { name: "Channel message history" });
  const gap = () =>
    feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  const loaded = () =>
    expect
      .poll(() =>
        feed.locator('a[aria-label="Open image attachment"] img').evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every((img) => {
              const rect = img.getBoundingClientRect();
              const feed = img
                .closest("[data-channel-timeline]")
                .getBoundingClientRect();
              return (
                rect.bottom <= feed.top ||
                rect.top >= feed.bottom ||
                img.complete
              );
            }),
        ),
      )
      .toBe(true);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/image-scroll.html`,
    );
    await expect.poll(() => pending.size).toBeGreaterThan(0);
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    await expect(feed.locator("canvas").last()).toBeVisible();
    const before = await feed.evaluate((el) => el.scrollHeight);
    await release();
    await loaded();
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    expect(await feed.evaluate((el) => el.scrollHeight)).toBe(before);
    const failedImage = feed.locator('img[src="https://image.test/56.svg"]');
    await expect(failedImage).toHaveCSS("visibility", "hidden");
    await expect(failedImage.locator("..").locator("canvas")).toBeVisible();
    // Reading above bottom survives decode; this must not be a force-bottom fix.
    held = true;
    pending.clear();
    await navigate(page, -1);
    await expect.poll(() => pending.size).toBeGreaterThan(0);
    await settle(page);
    expect(await feed.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await gap()).toBeGreaterThan(
      await feed.evaluate((el) => el.clientHeight),
    );
    const reading = await anchor(page);
    await release();
    await loaded();
    await settle(page);
    await expectAnchor(page, reading);
    for (let i = 0; i < 3; i++) {
      held = true;
      await navigate(page, 1);
      await release();
      await loaded();
      await settle(page);
      expect(await gap()).toBeLessThan(4);
      held = true;
      await navigate(page, -1);
      await release();
      await loaded();
      await settle(page);
    }
    held = true;
    await navigate(page, 1);
    await release();
    await loaded();
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    expect(
      [...requests.values()].some((count) => count > 1),
      "images actually remounted and reloaded",
    ).toBe(true);
    expect(
      [...requests.keys()].every((url) =>
        /^https:\/\/image.test\/\d+\.svg$/.test(url),
      ),
    ).toBe(true);
    await testInfo.attach("original-only-request-ledger", {
      body: JSON.stringify([...requests], null, 2),
      contentType: "application/json",
    });
    // Responsive reservation stays bounded, including missing-metadata fallback.
    await page.setViewportSize({ width: 420, height: 950 });
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    const bounds = await feed
      .locator('a[aria-label="Open image attachment"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          width: link.getBoundingClientRect().width,
          parent: link.parentElement.getBoundingClientRect().width,
          height: link.getBoundingClientRect().height,
        })),
      );
    expect(bounds.length).toBeGreaterThan(0);
    for (const box of bounds) {
      expect(box.width).toBeLessThanOrEqual(box.parent);
      expect(box.height).toBeLessThanOrEqual(320);
      expect(box.height).toBeGreaterThan(0);
    }
  } finally {
    try {
      await release();
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

// Isolate the setup helper from image loading: partial input must converge, but
// blocked input must fail instead of turning the preservation checks into retries.
test("image navigation handles partial gestures and rejects blocked input", async ({
  page,
}) => {
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="height:700px;overflow:auto"><div style="height:14000px"></div></section>
  `);
  // Install the fixture's input policy before hover commits WebKit's wheel
  // event regions; adding the first listener immediately before input can lose it.
  await page.getByRole("region").evaluate((element) => {
    element.addEventListener(
      "wheel",
      (event) => {
        if (element.hasAttribute("data-block-wheel")) event.preventDefault();
      },
      { passive: false },
    );
  });
  const wheel = page.mouse.wheel.bind(page.mouse);
  let gestures = 0;
  page.mouse.wheel = (x, y) => {
    gestures++;
    return wheel(x, Math.sign(y) * Math.min(400, Math.abs(y)));
  };
  try {
    await navigate(page, 1);
    expect(gestures).toBeGreaterThan(8);
    gestures = 0;
    await navigate(page, -1);
    expect(gestures).toBeGreaterThan(8);
    await page.getByRole("region").evaluate((element) => {
      element.setAttribute("data-block-wheel", "");
    });
    gestures = 0;
    await expect(navigate(page, 1)).rejects.toThrow(
      "timeline wheel gesture completes",
    );
    expect(gestures).toBe(1);
  } finally {
    page.mouse.wheel = wheel;
  }
});

// Control decode completion rather than just HTTP completion: an original must
// not cover the preview until decoded, and retired promises must do nothing.
async function holdDecodes(page, holdVisibility = false) {
  await page.addInitScript(
    ({ holdVisibility }) => {
      const realDecode = HTMLImageElement.prototype.decode;
      const pending = new Map();
      const paints = [];
      const realPaint = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function (...args) {
        paints.push({ width: args[0].width, height: args[0].height });
        return realPaint.apply(this, args);
      };
      HTMLImageElement.prototype.decode = async function () {
        await realDecode.call(this);
        if (!this.src.startsWith("https://image.test/")) return;
        const key = this.src;
        await new Promise((resolve, reject) => {
          const list = pending.get(key) ?? [];
          list.push({ resolve, reject });
          pending.set(key, list);
        });
      };
      const observers = [];
      // Record native observe() calls on canvases so a test can wait for the
      // product's passive effect to register before adding its own observer.
      const observedCanvases = new WeakSet();
      const realObserve = IntersectionObserver.prototype.observe;
      IntersectionObserver.prototype.observe = function (target) {
        if (target instanceof HTMLCanvasElement) observedCanvases.add(target);
        return realObserve.call(this, target);
      };
      if (holdVisibility) {
        window.IntersectionObserver = class {
          constructor(callback) {
            this.callback = callback;
            observers.push(this);
          }
          observe(target) {
            this.target = target;
          }
          disconnect() {}
        };
      }
      window.imageTest = {
        paints,
        observed: (canvas) => observedCanvases.has(canvas),
        waiting: (name) => pending.has(`https://image.test/${name}.svg`),
        release(name) {
          const key = `https://image.test/${name}.svg`;
          for (const item of pending.get(key) ?? []) item.resolve();
          pending.delete(key);
        },
        reject(name) {
          const key = `https://image.test/${name}.svg`;
          for (const item of pending.get(key) ?? [])
            item.reject(new Error("held decode rejected"));
          pending.delete(key);
        },
        intersect() {
          for (const observer of observers)
            observer.callback([
              { isIntersecting: true, target: observer.target },
            ]);
        },
      };
    },
    { holdVisibility },
  );
}

const frame = (page) =>
  page.getByRole("link", { name: "Open image attachment" });
const shown = (page) =>
  expect(frame(page).locator("img")).toHaveCSS("visibility", "visible");
const waiting = (page, name) =>
  expect
    .poll(() => page.evaluate((name) => window.imageTest.waiting(name), name))
    .toBe(true);
const releaseDecode = (page, name) =>
  page.evaluate((name) => window.imageTest.release(name), name);

async function routeOriginals(page, requests) {
  await page.route("https://image.test/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill(
      route.request().url().endsWith("/failed.svg")
        ? { status: 404, body: "missing" }
        : {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10" fill="orange"/></svg>',
          },
    );
  });
}

test("blurhash visibility, decode swap, failure and retired source lifetimes", async ({
  page,
}, testInfo) => {
  const requests = [];
  await holdDecodes(page);
  await routeOriginals(page, requests);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    // Mounted but offscreen (as in a long thread) must not spend pixel work.
    // The product observes the canvas in a passive effect, so wait for that
    // registration first. Barrier: an IntersectionObserver created after the
    // product's delivers its first notification in the same or a later task,
    // so the product's initial visibility callback has already run.
    await expect
      .poll(() =>
        frame(page)
          .locator("canvas")
          .evaluate((canvas) => window.imageTest.observed(canvas)),
      )
      .toBe(true);
    await frame(page)
      .locator("canvas")
      .evaluate(
        (canvas) =>
          new Promise((resolve) => {
            const observer = new IntersectionObserver(() => {
              observer.disconnect();
              resolve();
            });
            observer.observe(canvas);
          }),
      );
    expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.imageTest.paints.length))
      .toBe(1);
    const bounds = await frame(page).boundingBox();
    await waiting(page, "first");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    expect(
      await frame(page)
        .locator("canvas")
        .evaluate((canvas) =>
          [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data].some(
            (x) => x > 0,
          ),
        ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("held-blurhash.png") });
    await releaseDecode(page, "first");
    await shown(page);
    // Transparent/small original must expose only the frame, never old colors.
    await expect(frame(page).locator("canvas")).toHaveCount(0);
    await expect(frame(page).locator("img")).toHaveCSS(
      "object-fit",
      "scale-down",
    );
    expect(await frame(page).boundingBox()).toEqual(bounds);
    await page.screenshot({
      path: testInfo.outputPath("transparent-original.png"),
    });
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Fail original", exact: true })
      .click();
    await expect
      .poll(() =>
        frame(page)
          .locator("img")
          .evaluate((img) => img.complete),
      )
      .toBe(true);
    await releaseDecode(page, "next"); // late callback for a retired source
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    expect(await frame(page).boundingBox()).toEqual(bounds);
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await releaseDecode(page, "next"); // late callback after unmount
    await expect(frame(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle mount", exact: true })
      .click();
    await waiting(page, "next");
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await releaseDecode(page, "next");
    await shown(page);
    expect(
      await page.evaluate(() =>
        window.imageTest.paints.every((p) => p.width === 32 && p.height === 32),
      ),
    ).toBe(true);
    expect(
      requests.every((url) =>
        /^https:\/\/image.test\/(first|next|failed)\.svg$/.test(url),
      ),
    ).toBe(true);
    await testInfo.attach("original-only-request-ledger", {
      body: JSON.stringify(requests, null, 2),
      contentType: "application/json",
    });
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

test("original ready first cannot regress on late visibility; missing and invalid hashes still load", async ({
  page,
}) => {
  await holdDecodes(page, true);
  await routeOriginals(page, []);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await waiting(page, "first");
    await releaseDecode(page, "first");
    await shown(page);
    await page.evaluate(() => window.imageTest.intersect());
    expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
    await expect(frame(page).locator("canvas")).toHaveCount(0);
    for (const name of ["No hash", "Invalid hash"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await waiting(page, "first");
      await expect(frame(page).locator("canvas")).toHaveCount(0);
      await releaseDecode(page, "first");
      await shown(page);
    }
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

test("original decode rejection retains blur and the next source still recovers", async ({
  page,
}) => {
  await holdDecodes(page);
  await routeOriginals(page, []);
  const server = await fixtureServer();
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
    );
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.imageTest.paints.length))
      .toBe(1);
    await waiting(page, "first");
    await page.evaluate(() => window.imageTest.reject("first"));
    await expect(frame(page).locator("img")).toHaveCSS("visibility", "hidden");
    await expect(frame(page).locator("canvas")).toHaveCount(1);
    await page.getByRole("button", { name: "Retarget", exact: true }).click();
    await waiting(page, "next");
    await releaseDecode(page, "next");
    await shown(page);
    await expect(frame(page).locator("canvas")).toHaveCount(0);
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await server.close();
    }
  }
});

for (const unavailable of ["canvas", "visibility"]) {
  test(`unavailable ${unavailable} keeps the placeholder and original loading`, async ({
    page,
  }) => {
    await holdDecodes(page);
    await page.addInitScript((unavailable) => {
      if (unavailable === "canvas")
        HTMLCanvasElement.prototype.getContext = () => null;
      else window.IntersectionObserver = undefined;
    }, unavailable);
    await routeOriginals(page, []);
    const server = await fixtureServer();
    try {
      await server.listen();
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/attachment-image.html`,
      );
      await page.getByRole("button", { name: "Reveal", exact: true }).click();
      await waiting(page, "first");
      expect(await page.evaluate(() => window.imageTest.paints)).toEqual([]);
      await expect(frame(page).locator("img")).toHaveCSS(
        "visibility",
        "hidden",
      );
      await releaseDecode(page, "first");
      await shown(page);
      await expect(frame(page).locator("canvas")).toHaveCount(0);
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await server.close();
      }
    }
  });
}
