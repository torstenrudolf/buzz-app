import { test, expect } from "./fixture.mjs";
import { open, end } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});
test("Messages receives scoped typing through authenticated live traffic and expires it without publishing", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect
    .poll(() =>
      app.report.liveRequests.some((r) =>
        r.filters.some((filter) => filter["#h"]?.includes("alpha")),
      ),
    )
    .toBe(true);
  const indicator = page.getByRole("status", { name: "Typing activity" });
  app.activity({ age: 9 });
  await expect(indicator).toHaveCount(0);
  app.activity();
  await expect(indicator).toContainText("is typing…");
  app.activity({ author: 1 });
  await expect(indicator).toContainText("are typing…");
  await page.screenshot({ path: testInfo.outputPath("messages-typing.png") });
  app.activity({ kind: 9 });
  await expect(indicator).toContainText("is typing…");
  app.activity({ kind: 9, author: 1 });
  await expect(indicator).toHaveCount(0);
  app.activity(); // same-second late pulse cannot resurrect completion
  await expect(indicator).toHaveCount(0);
  // Typing completion precedes the appended messages' virtual-list layout.
  await expect(
    page.getByText("Fixture completion", { exact: true }),
  ).toHaveCount(2);
  await end(page);
  const root = app.histories
    .get("primary/alpha")
    .find((e) => e.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  app.activity({ root: root.id });
  await expect(
    thread.getByRole("status", { name: "Typing activity" }),
  ).toContainText("is typing…");
  await expect(indicator).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("messages-thread-typing.png"),
  });
  // Real browser timer, signed timestamp TTL, no polling transport or fixture cleanup.
  await expect(indicator).toHaveCount(0, { timeout: 10000 });
  expect(app.report.publications).toEqual([]);
});

for (const scope of ["channel", "thread"]) {
  test(`${scope} typing preserves viewport bounds and the visible bottom through completion and expiry`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() =>
        app.report.liveRequests.some((r) =>
          r.filters.some((filter) => filter["#h"]?.includes("alpha")),
        ),
      )
      .toBe(true);
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    if (scope === "thread") {
      // Seed enough signed upstream replies to exercise a genuinely scrolling thread.
      for (let i = 0; i < 30; i++) app.reply(root.id);
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      // One nested descendant is collapsed; the root plus 32 direct replies mount.
      await expect(
        page
          .getByRole("region", { name: "Thread messages", exact: true })
          .locator("[data-message-id]"),
      ).toHaveCount(33);
    } else {
      await end(page);
    }
    const history = page.getByRole("region", {
      name: scope === "thread" ? "Thread messages" : "Channel message history",
      exact: true,
    });
    const composer = page.getByRole("form", {
      name: scope === "thread" ? "Reply to thread" : "Send a message to Alpha",
      exact: true,
    });
    const indicator = composer.getByRole("status", { name: "Typing activity" });
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    if (scope === "thread") {
      // Opening can race the final signed fixture replies under parallel load.
      // Establish the bottom-reading precondition with real browser input before
      // capturing geometry; the assertions below verify typing keeps it there.
      await history.hover();
      await page.mouse.wheel(0, Math.max(1, await gap()));
    }
    await expect.poll(gap).toBeLessThan(2);
    expect(
      await history.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeGreaterThan(100);
    const idle = await history.boundingBox();
    const idleComposer = await composer.boundingBox();
    const stable = async () => {
      expect(await history.boundingBox()).toEqual(idle);
      expect(await composer.boundingBox()).toEqual(idleComposer);
      await expect.poll(gap).toBeLessThan(2);
      const tail = await history
        .locator("[data-message-id]")
        .last()
        .boundingBox();
      expect(tail.y).toBeGreaterThanOrEqual(idle.y - 2);
      expect(tail.y + tail.height).toBeLessThanOrEqual(
        idle.y + idle.height + 2,
      );
    };
    await expect(indicator).toHaveCount(0);
    const target = scope === "thread" ? { root: root.id } : {};
    app.activity(target);
    await expect(indicator).toContainText("is typing…");
    await stable();
    app.activity({ ...target, kind: 9 });
    await expect(indicator).toHaveCount(0);
    await stable();
    // A different signer is outside the first signer's quiet period.
    app.activity({ ...target, author: 1 });
    await expect(indicator).toContainText("is typing…");
    await stable();
    await expect(indicator).toHaveCount(0, { timeout: 10000 });
    await stable();
    expect(app.report.publications).toEqual([]);
  });
}
