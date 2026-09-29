import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

const fixtureImage = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#666"/></svg>`;

function fixtureMediaPlugin() {
  return {
    name: "messages-fixture-media",
    configureServer(server) {
      server.middlewares.use("/api/relay/media", (req, res, next) => {
        if (req.method !== "GET") return next();
        const url = new URL(req.url ?? "", "http://fixture.local");
        const target = url.searchParams.get("url") ?? "";
        if (!target.startsWith("https://fixture.test/media/")) return next();
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(fixtureImage),
        });
        res.end(fixtureImage);
      });
    },
  };
}

function createMessagesServer() {
  return createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [fixtureMediaPlugin(), react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
}

async function withMessagesFixture(page, run) {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await run();
  } finally {
    await server.close();
  }
}

async function visibleBox(locator) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box && box.width > 0 && box.height > 0;
    })
    .toBeTruthy();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected nonzero layout box");
  return box;
}

function containedWithin(inner, outer) {
  const epsilon = 1;
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - epsilon);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - epsilon);
  expect(inner.x + inner.width).toBeLessThanOrEqual(
    outer.x + outer.width + epsilon,
  );
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    outer.y + outer.height + epsilon,
  );
}

test("media review stage contains portrait video and image media", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => {
      const styles = window.messagesFixture.styles;
      const host = document.createElement("div");
      host.dataset.testid = "portrait-video-harness";
      host.style.cssText =
        "position:fixed;inset:0;padding:24px;display:grid;grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:auto minmax(0,1fr);";
      host.innerHTML = `
        <div style="grid-column:1 / -1;height:48px"></div>
        <div data-testid="portrait-video-stage" class="${styles.mediaReviewStage}">
          <video data-testid="portrait-video" style="aspect-ratio:9 / 16"></video>
        </div>
        <aside></aside>
      `;
      document.body.append(host);
    });
    const stage = page.getByTestId("portrait-video-stage");
    const video = page.getByTestId("portrait-video");
    containedWithin(await visibleBox(video), await visibleBox(stage));
    await page
      .getByTestId("portrait-video-harness")
      .evaluate((host) => host.remove());

    await page
      .getByRole("button", { name: "Review image", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    const reviewStage = dialog.locator('[class*="mediaReviewStage"]');
    const imageStage = dialog.locator('[class*="imageReviewStage"]');
    const image = imageStage.locator("img");
    await expect(image).toHaveJSProperty("complete", true);
    containedWithin(
      await visibleBox(imageStage),
      await visibleBox(reviewStage),
    );
    containedWithin(await visibleBox(image), await visibleBox(imageStage));
  });
});

test("inline video controls hide only while playing off-hover on fine pointers", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    await page.evaluate(() => {
      const styles = window.messagesFixture.styles;
      const host = document.createElement("div");
      host.dataset.testid = "video-controls-harness";
      host.style.cssText = "position:fixed;left:32px;top:32px;";
      host.innerHTML = `
        <div data-testid="playing-preview" class="${styles.mediaPreview}" data-playing="true" style="--media-ratio:16 / 9;width:320px">
          <video class="${styles.mediaVideo}"></video>
          <span data-testid="playing-play" class="${styles.mediaPlay}"><button type="button">Play</button></span>
          <span data-testid="playing-time" class="${styles.mediaTime}">0:01</span>
          <span data-testid="playing-expand" class="${styles.mediaExpand}"><button type="button">Expand</button></span>
        </div>
        <div data-testid="idle-preview" class="${styles.mediaPreview}" style="--media-ratio:16 / 9;width:320px;margin-top:24px">
          <video class="${styles.mediaVideo}"></video>
          <span data-testid="idle-play" class="${styles.mediaPlay}"><button type="button">Play</button></span>
          <span data-testid="idle-time" class="${styles.mediaTime}">0:00</span>
          <span data-testid="idle-expand" class="${styles.mediaExpand}"><button type="button">Expand</button></span>
        </div>
      `;
      document.body.append(host);
    });
    const finePointer = await page.evaluate(
      () => matchMedia("(hover: hover) and (pointer: fine)").matches,
    );
    test.skip(
      !finePointer,
      "Browser project does not expose a hover-capable fine pointer.",
    );
    // Expand fades the button itself so its backdrop can sample video throughout
    // the transition; the positioning wrapper deliberately stays opaque.
    const controls = (state) => [
      page.getByTestId(`${state}-play`),
      page.getByTestId(`${state}-time`),
      page.getByTestId(`${state}-expand`).getByRole("button"),
    ];
    const preview = page.getByTestId("playing-preview");
    await visibleBox(preview);
    for (const control of controls("playing")) {
      await expect(control).toHaveCSS("opacity", "0");
    }
    await preview.hover();
    for (const control of controls("playing")) {
      await expect(control).toHaveCSS("opacity", "1");
    }
    await page.mouse.move(1, 1);
    for (const control of controls("playing")) {
      await expect(control).toHaveCSS("opacity", "0");
    }
    await page.getByTestId("playing-play").getByRole("button").focus();
    for (const control of controls("playing")) {
      await expect(control).toHaveCSS("opacity", "1");
    }
    await page.getByRole("button", { name: "First root" }).focus();
    for (const control of controls("playing")) {
      await expect(control).toHaveCSS("opacity", "0");
    }
    for (const control of controls("idle")) {
      await expect(control).toHaveCSS("opacity", "1");
    }
  });
});

// Independent source consumer proves safe ordinary-prop reuse, with real React,
// thread reader and durable outbox. No developer env, broker, credentials or relay.
test("media review hands off the thread draft, contains focus and keeps narrow controls reachable", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const draft = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await draft.fill("Draft handoff");
    const trigger = page.getByRole("button", {
      name: "Review image",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    await expect(thread).toHaveCount(0);
    const reviewDraft = dialog.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reviewDraft).toHaveText("Draft handoff");
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(
      dialog.getByRole("button", { name: "Next image" }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("link", { name: "Download image" }),
    ).toBeInViewport();
    await dialog
      .getByRole("link", { name: "Open image attachment" })
      .last()
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      dialog.getByRole("region", { name: "Media comments" }),
    ).toBeVisible();
    const activeDraft = dialog.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await activeDraft.press("Enter");
    await expect(activeDraft).toHaveText("");
    const close = dialog.getByRole("button", {
      name: "Close fullscreen viewer",
    });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(
      page
        .getByRole("complementary", { name: "Thread", exact: true })
        .getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toHaveText("");
  } finally {
    await server.close();
  }
});

test("shared thread UI auto-loads, follows live replies, retries and isolates retargeted drafts", async ({
  page,
}, testInfo) => {
  const server = await createMessagesServer();
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.extensionsActive()),
      )
      .toContain("custom");
    const feed = page.getByRole("region", { name: "Channel message history" });
    await expect(
      feed.getByRole("heading", { name: "Channel Markdown", level: 2 }),
    ).toBeVisible();
    await expect(
      feed.getByText("Virtualized channel row", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    const feedIndentation = await feed.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "channel nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing channel nested ordered list");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(feedIndentation.nested).toBeGreaterThan(feedIndentation.outer + 8);
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const feedAuthorAvatar = feed.locator(
      '[data-message-id="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] [data-avatar-shape]',
    );
    await expect(feedAuthorAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    const draft = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const choose = (name) =>
      page.getByRole("button", { name, exact: true }).click();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect(history.locator("[data-message-id]")).toHaveCount(62);
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Load more replies", exact: true }),
    ).toHaveCount(0);
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      history.getByRole("heading", { name: "Markdown reply", level: 2 }),
    ).toBeVisible();
    await expect(history.getByText("Bold", { exact: true })).toHaveCSS(
      "font-weight",
      /^(650|700)$/,
    );
    await expect(history.getByText("italic", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await expect(history.locator("del")).toHaveText("done");
    await expect(
      history
        .getByText("unordered one", { exact: true })
        .locator("xpath=ancestor::ul[1]"),
    ).toHaveCSS("list-style-type", "disc");
    const indentation = await history.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing nested ordered list");
      if (getComputedStyle(nested.parentElement).listStyleType !== "decimal")
        throw new Error("Nested ordered list lost its marker style");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(indentation.nested).toBeGreaterThan(indentation.outer + 8);
    await expect(history.getByAltText(":_lead:")).toBeVisible();
    await expect(history.getByAltText(":trail_:")).toBeVisible();
    await expect(
      history.getByRole("heading", { name: "Agent Markdown", level: 3 }),
    ).toBeVisible();
    const threadAgentAvatar = history
      .getByRole("heading", { name: "Agent Markdown" })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadAgentAvatar).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    const threadHumanAvatar = history
      .getByText("First root", { exact: true })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadHumanAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const evidence = testInfo.outputPath("human-agent-thread-avatars.png");
    const humanBox = await threadHumanAvatar.boundingBox();
    const agentBox = await threadAgentAvatar.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!humanBox || !agentBox || !panelBox)
      throw new Error("Missing avatar evidence bounds");
    const top = Math.max(0, Math.min(humanBox.y, agentBox.y) - panelBox.y - 36);
    const bottom =
      Math.max(humanBox.y + humanBox.height, agentBox.y + agentBox.height) -
      panelBox.y +
      72;
    await panel.screenshot({
      path: evidence,
      clip: { x: 0, y: top, width: 440, height: bottom - top },
    });
    await testInfo.attach("human-agent-thread-avatars", {
      path: evidence,
      contentType: "image/png",
    });
    await expect(
      history.getByText("Rendered from an agent envelope", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    await expect(
      history.locator("code").filter({ hasText: "agent-code" }),
    ).toBeVisible();
    // A <br> count misses a second line box caused by inherited pre-wrap.
    // Measure the actual first/second text baselines in both shared surfaces.
    for (const surface of [feed, history]) {
      const paragraph = surface
        .locator("p")
        .filter({ hasText: /^first\s+second$/ });
      await expect(paragraph.locator("br")).toHaveCount(1);
      const geometry = await paragraph.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const tops = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const word of ["first", "second"]) {
            const start = node.textContent.indexOf(word);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            tops.push(range.getBoundingClientRect().top);
          }
        }
        return {
          tops,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        };
      });
      expect(geometry.tops).toHaveLength(2);
      expect(
        Math.abs(geometry.tops[1] - geometry.tops[0] - geometry.lineHeight),
      ).toBeLessThan(1);
      expect(Math.abs(geometry.height - 2 * geometry.lineHeight)).toBeLessThan(
        1,
      );
    }
    await expect(history.locator("pre code")).toHaveCSS("white-space", "pre");
    await expect(history.locator("table")).toContainText("wide-column-one-");
    await expect(history.locator("pre code")).toContainText("wide-content-");
    // Exercise native popup navigation without depending on a public website.
    await page.context().route("https://example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>External destination</p>",
      }),
    );
    const safeLink = history.getByRole("link", { name: "Safe link" });
    await expect(safeLink).toHaveAttribute("href", "https://example.com/path");
    await expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
    const pagesBefore = page.context().pages().length;
    await safeLink.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.links.at(-1)),
      )
      .toBe("https://example.com/path");
    expect(page.context().pages()).toHaveLength(pagesBefore);
    const unhandled = history.getByRole("link", { name: "Unhandled link" });
    const popup = page.waitForEvent("popup");
    await unhandled.click();
    const external = await popup;
    await external.waitForLoadState("domcontentloaded");
    expect(external.url()).toBe("https://example.com/unhandled");
    await external.close();
    // Observe after React's delegated handler, then suppress only the browser's
    // cross-origin background tab (which crashes headless Chromium). Native
    // unhandled navigation is exercised above; here we verify modifier ownership.
    const stopObserving = await safeLink.evaluateHandle((link) => {
      const observe = (event) => {
        if (!event.composedPath().includes(link)) return;
        link.dataset.modifiedClick = JSON.stringify({
          prevented: event.defaultPrevented,
          modified: event.ctrlKey || event.metaKey,
        });
        event.preventDefault();
      };
      document.addEventListener("click", observe);
      return () => document.removeEventListener("click", observe);
    });
    try {
      await safeLink.click({ modifiers: ["ControlOrMeta"] });
      await expect(safeLink).toHaveAttribute(
        "data-modified-click",
        JSON.stringify({ prevented: false, modified: true }),
      );
      expect(
        await page.evaluate(() => window.messagesFixture.report.links.length),
      ).toBe(2);
    } finally {
      await stopObserving.evaluate((stop) => stop());
      await stopObserving.dispose();
    }
    await history.evaluate((element) => {
      for (const selector of ["pre", "table"]) {
        const item = element.querySelector(selector);
        if (!(item instanceof HTMLElement))
          throw new Error(`Missing ${selector}`);
        if (
          item.getBoundingClientRect().right >
          element.getBoundingClientRect().right + 1
        )
          throw new Error(`${selector} overflows the thread`);
        if (item.scrollWidth <= item.clientWidth)
          throw new Error(
            `${selector} does not provide local horizontal scrolling`,
          );
      }
    });
    await history.evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => window.messagesFixture.live());
    await expect(history.locator("[data-message-id]")).toHaveCount(63);
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
    await draft.fill("keep first draft");
    await choose("Second root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(history.locator("[data-message-id]")).toHaveCount(61);
    await expect.poll(gap).toBeLessThan(2);
    await draft.fill("reject second reply");
    await draft.press("Enter");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      panel.getByText("Couldn’t send this message.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByText("reject second reply", { exact: true }),
    ).toHaveCount(1);
    // Retry removes its control while queued; wait for the actual second publish.
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const delivery = await page.evaluate(() => window.messagesFixture.report);
    expect(delivery.signings).toHaveLength(1);
    expect(delivery.publications).toHaveLength(2);
    expect(delivery.publications[0]).toEqual(delivery.publications[1]);
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await page
      .getByRole("textbox", { name: "Message #one", exact: true })
      .fill("keep channel draft");
    await choose("Other channel root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      page.getByRole("textbox", { name: "Message #two", exact: true }),
    ).toHaveJSProperty("value", "");
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await expect(
      page.getByRole("textbox", { name: "Message #one", exact: true }),
    ).toHaveJSProperty("value", "keep channel draft");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    for (const [index, kind] of [9, 40002].entries()) {
      await page.evaluate((value) => window.messagesFixture.deep(value), kind);
      await expect(history.locator("[data-message-id]")).toHaveCount(
        64 + index,
      );
      const literal = history
        .getByText("literal deep message", { exact: false })
        .last();
      await expect(literal).toBeVisible();
      await expect(literal).toHaveCSS("white-space", "pre-wrap");
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: real hit testing must reject suggestions painted behind the modal.
// DOM visibility alone cannot prove the listbox is visible or pointer-accessible.
test("media review completions stay visible and preserve modal keyboard ownership", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    const trigger = page.getByRole("button", {
      name: "Review image",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    const input = dialog.getByRole("textbox", { name: "Reply to thread" });
    const topmost = (option) =>
      option.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      });
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await input.fill("@Fixture");
      const mention = page
        .getByRole("listbox", {
          name: "Mention suggestions",
        })
        .getByRole("option")
        .first();
      await expect(mention).toContainText("Fixture Reader");
      await expect.poll(() => topmost(mention)).toBe(true);
      await mention.click();
      await expect(input).toHaveJSProperty("value", "@Fixture Reader ");
      await expect(input).toBeFocused();
      await expect(input.locator(".inline-chip")).toContainText(
        "Fixture Reader",
      );
      for (const key of ["Enter", "Tab"]) {
        await input.fill(":smile");
        const emoji = page
          .getByRole("listbox", {
            name: "Emoji suggestions",
          })
          .getByRole("option")
          .first();
        await expect(emoji).toContainText(":smile:");
        await expect.poll(() => topmost(emoji)).toBe(true);
        await input.press(key);
        await expect(input).toHaveJSProperty("value", "😄");
        await expect(input).toBeFocused();
        await expect(page.getByRole("listbox")).toHaveCount(0);
      }
    }
    await input.fill(":smile");
    await expect(page.getByRole("option").first()).toBeVisible();
    await input.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(() => window.messagesFixture.report.publications),
    ).toEqual([]);
  } finally {
    await server.close();
  }
});

test("exact reply media keeps its selected attachment and canonical thread", async ({
  page,
}) => {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    await page
      .getByRole("button", { name: "Review exact reply image" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    const comments = dialog.getByRole("region", { name: "Media comments" });
    await expect(comments).toContainText("Reply with image");
    const exactReplyId = await page.evaluate(
      () => window.messagesFixture.report.exactReplyId,
    );
    const reply = comments.locator(`[data-message-id="${exactReplyId}"]`);
    const commentDate = await reply.locator("time").evaluate((time) =>
      new Date(time.dateTime).toLocaleDateString(undefined, {
        year: "numeric",
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    );
    await expect(
      comments.getByText(commentDate, { exact: true }).first(),
    ).toBeVisible();
    await reply.hover();
    const addReaction = reply.getByTestId("reaction-row").getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
    await expect(addReaction).toBeVisible();
    await addReaction.click();
    const search = page.locator('em-emoji-picker input[type="search"]');
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(1);
    const reaction = await page.evaluate(
      () => window.messagesFixture.report.publications[0],
    );
    expect(reaction.kind).toBe(7);
    expect(reaction.content).toBe("😀");
    expect(reaction.tags).toContainEqual(["e", exactReplyId]);
    const draft = dialog.getByRole("textbox", { name: "Reply to thread" });
    await draft.fill("Canonical exact feedback");
    await draft.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const publication = await page.evaluate(
      () => window.messagesFixture.report.publications[1],
    );
    const rootId = await page.evaluate(
      () => window.messagesFixture.report.rootId,
    );
    expect(publication.tags).toContainEqual(["e", rootId, "", "reply"]);
  } finally {
    await server.close();
  }
});
