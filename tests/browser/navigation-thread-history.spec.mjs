import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 20 },
});

test("Back restores each thread visit before the previous channel", async ({
  page,
  app,
}) => {
  const beta = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator('button[data-channel-id="beta"]');
  // Intent preparation can supply the same badge as the held unread batch.
  // Gate both sources; focus explicitly instead of relying on roster warming.
  let releaseHead;
  let sawHead;
  const headHeld = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const headStarted = new Promise((resolve) => {
    sawHead = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.top_level && filter["#h"]?.includes("beta"))
    ) {
      sawHead();
      await headHeld;
    }
    await route.continue().catch(() => {});
  });
  app.relay.holdUnread();
  try {
    await open(page, app);
    await beta.focus(); // Prepare without selecting or adding a navigation visit.
    await headStarted;
    await expect.poll(() => app.report.unreadHolds.length).toBe(1);
    await expect(beta).toHaveAccessibleName("Beta");
  } finally {
    releaseHead();
    app.relay.releaseUnread();
  }
  // Unread evidence changes the accessible name independently of navigation.
  await expect(beta.getByRole("img")).toHaveAccessibleName(
    "20 observed unread messages. Not an exact total.",
  );
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const threadButton = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });

  await threadButton(roots[0]).click();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await threadButton(roots[1]).click();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const openThread = await panel
    .getByRole("region", { name: "Thread messages", exact: true })
    .elementHandle();
  await threadButton(roots[1]).click();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  expect(await openThread.evaluate((node) => node.isConnected)).toBe(true);
  await beta.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const threadPanel = await panel.elementHandle();
  await page.goBack();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  expect(
    await threadPanel.evaluate(
      (node) => node === document.querySelector('aside[aria-label="Thread"]'),
    ),
  ).toBe(true);
});

for (const reading of [false, true]) {
  test(`ordinary reply-count opening ${reading ? "preserves intervening reading" : "finishes at the bottom"} after held pagination`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    let last;
    for (let i = 0; i < 120; i++) last = app.reply(root.id, false, false);
    await open(page, app);
    const region = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    const routePattern = "**/api/relay/**/query";
    await page.route(routePattern, async (route) => {
      if (
        !requested &&
        route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter.depth_limit && filter.thread_cursor !== undefined,
          )
      ) {
        requested = true;
        await held;
      }
      await route.continue();
    });
    try {
      const trigger = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      // Virtua can retain its pointer lock after geometry stops moving. Wait
      // for input readiness before Playwright tries alternate scroll alignments.
      await expect(trigger).toHaveCSS("pointer-events", "auto");
      await trigger.click();
      await expect.poll(() => requested).toBe(true);
      // One of the 50 loaded replies is a collapsed descendant.
      await expect(region.locator("[data-message-id]")).toHaveCount(50);
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toHaveCount(0);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      // The panel is presented even while bounded history is still pending.
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      let position = 0;
      if (reading) {
        await region.hover();
        await page.mouse.wheel(0, 500);
        await expect
          .poll(() => region.evaluate((node) => node.scrollTop))
          .toBe(500);
        position = await region.evaluate((node) => node.scrollTop);
      }
      release();
      await expect(region.locator("[data-message-id]")).toHaveCount(123);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("Jump to latest");
      } else {
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        await expect(
          region.locator(`[data-message-id="${last.id}"]`),
        ).toBeInViewport();
        await expect(
          page.getByRole("button", { name: "Close thread", exact: true }),
        ).toBeFocused();
      }
      const live = app.reply(root.id);
      await expect(
        region.locator(`[data-message-id="${live.id}"]`),
      ).toBeVisible();
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Space");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(0);
        await region.hover();
        await page.mouse.wheel(0, -500);
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeGreaterThan(80);
        const nextLive = app.reply(root.id);
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Enter");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${nextLive.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(0);
      } else {
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
      }
      // Expansion changes visibility, not the loaded-history count.
      await region.getByRole("button", { name: /^View 1 reply/ }).click();
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toBeInViewport();
      await expect(region.locator("[data-message-id]")).toHaveCount(
        reading ? 126 : 125,
      );
    } finally {
      release();
      await page.unroute(routePattern);
    }
  });
}
