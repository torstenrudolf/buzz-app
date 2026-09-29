import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
  largeSidebar: true,
  pluginFixtures: true, // Observe the real navigation completion, not reply mount timing.
});
test.describe("mentioned reply priority", () => {
  test.use({ threadUnreadMentions: true });

  test("a mention and broadcast remain distinguishable in Activity", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const alpha = page.locator('button[data-channel-id="alpha"]');
    await expect(
      alpha.getByRole("img", { name: /unread threads?/ }),
    ).toBeVisible();
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    await expect(popover).toBeVisible();
    const items = popover.getByRole("button", {
      name: /Open unread thread from/,
    });
    await expect(items).toHaveCount(2);
    const names = await items.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label")),
    );

    expect(
      names.every((name) => name?.startsWith("Open unread thread from ")),
    ).toBe(true);
    expect(new Set(names.map((name) => name?.split(": ").at(-1)))).toEqual(
      new Set(["Broadcast reply", "Unread reply 1"]),
    );
  });
});

test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  // Reading needs a 750ms dwell (use-reading.ts). The clock runs that deadline
  // exactly where the test proves that something is not reading.
  await page.clock.install();
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) =>
    control.locator('span[title^="Observed unread replies"]');
  await expect(first).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(other).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/Observed unread replies/);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const activity = alpha.getByRole("img", { name: /unread threads?/ });
  await expect(activity).toBeVisible();
  await expect(alpha.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "600",
  );
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(
    alpha.getByRole("img", { name: /Marked unread on this device only/ }),
  ).toBeAttached();
  await expect(activity).toHaveAccessibleName(/unread threads?/);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await alpha.hover();
  const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popover).toBeVisible();
  await expect(
    popover.getByText("Activity in Alpha", { exact: true }),
  ).toHaveCount(0);
  await popover.screenshot({
    path: testInfo.outputPath("activity-popover.png"),
  });
  await expect(
    popover.getByRole("button", { name: /Open unread thread from/ }),
  ).toHaveCount(1);
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely displaying buttons never fetches threads.
  // The sibling context trigger must not steal the activity button's props or
  // focus. Exercise the real portals while unread activity is still present.
  await alpha.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions for Alpha" });
  await expect(
    actions.getByRole("menuitem", { name: "New session" }),
  ).toBeVisible();
  // Leave the hover trigger while the context menu still owns focus. Otherwise
  // its delayed hover close can overlap the later keyboard-open assertion.
  await page.mouse.move(0, 0);
  await expect(popover).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await alpha.press("Shift+F10");
  await expect(actions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await expect(popover).toHaveCount(0);
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const item = popover
    .getByRole("button", {
      name: /Open unread thread from/,
    })
    .first();
  await item.focus();
  await expect(item).toBeFocused();
  await item.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(alpha).toBeFocused();
  const beforeRect = await first.boundingBox();
  await first.hover();
  const afterRect = await first.boundingBox();
  expect(afterRect).not.toBeNull();
  expect(beforeRect).not.toBeNull();
  expect(afterRect.width).toBe(beforeRect.width);
  expect(afterRect.height).toBe(beforeRect.height);
  await expect(first).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await first.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, radius: s.borderTopLeftRadius };
  });
  expect(hover.border).toBe("0px");
  expect(hover.radius).not.toBe("0px");
  await first.screenshot({
    path: testInfo.outputPath("thread-button-hover.png"),
  });
  // WebKit's macOS tab policy skips buttons; keyboard input still selects
  // focus-visible modality, then focus the actual control in both engines.
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-width", "2px");
  await broadcast.focus();
  const previousAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await broadcast.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(
    panel.getByText("Unread reply 0", { exact: true }),
  ).toBeVisible();
  // Content visibility precedes the navigation's deferred reveal/focus. Finish
  // that owner before testing composer-only dwell; faster reads expose the race.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          messageId: entry.target.messageId,
          freshAttempt: attempt.id !== previous,
        };
      }, previousAttempt),
    )
    .toEqual({
      status: "opened",
      freshAttempt: true,
      messageId: app.histories
        .get("primary/alpha")
        .find((row) => row.content === "Broadcast reply").id,
    });
  const replyComposer = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await replyComposer.focus();
  await page.clock.runFor(750);
  await expect(replyComposer).toBeFocused();
  await expect(first).toHaveAccessibleName(/Observed unread replies/); // Click/composer focus is not reading.
  await history.focus();
  // Finish a real read of a visible sibling before checking the hidden child.
  // Loaded history is not read evidence: collapsed descendants stay unread.
  const directId = await panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" })
    .getAttribute("data-message-id");
  await expect
    .poll(
      () =>
        app.report.readPublications.some(({ blob }) =>
          Object.hasOwn(blob.contexts, `msg:${directId}`),
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await panel.getByRole("button", { name: /^View 1 reply/ }).click();
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toBeInViewport();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/Observed unread replies/); // No channel-wide shortcut.
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  const own = app.reply(roots[0].id, true);
  // Barrier: the session has indexed the reply, so its unread effect is final.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id),
        own.id,
      ),
    )
    .toMatchObject({ status: "ineligible", unread: false });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await first.click();
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  const savedEntry = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry,
  );
  const beforeReload = app.report.queries.length;
  await page.reload();
  // Reload restores this visit itself. Reopening Messages through Search races
  // startup results and could hide a broken restoration by starting a new visit.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.fixtureNavigation?.snapshot();
        return snapshot && { status: snapshot.status, entry: snapshot.entry };
      }),
    )
    .toEqual({ status: "opened", entry: savedEntry });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  // Restoring a joined conversation waits for initial membership discovery;
  // it must not publish an early one-channel roster through exact resolution.
  expect(
    app.report.queries
      .slice(beforeReload)
      .filter(
        ({ filter }) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes("alpha"),
      ),
  ).toEqual([]);
});

// Browser focus plus actual controller/React wiring: a same-target open must not
// leave the timeline's trigger installed merely because the history entry is reused.
test("same-thread sidebar activity replaces timeline focus return", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const alpha = page.locator('button[data-channel-id="alpha"]');
  await expect(
    alpha.getByRole("img", { name: /unread threads?/ }),
  ).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    ) {
      requested = true;
      await held;
    }
    await route.continue().catch(() => {});
  });
  try {
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await expect(trigger).toHaveCSS("pointer-events", "auto");
    await trigger.click();
    await expect.poll(() => requested).toBe(true);
    const before = await page.evaluate(() => {
      const { entry, attempt } = window.fixtureNavigation.snapshot();
      return { entry: entry.id, attempt: attempt.id };
    });
    await alpha.hover();
    const activity = page.getByRole("dialog", { name: "Activity in Alpha" });
    await activity
      .getByRole("button", { name: /Open unread thread from.*Broadcast reply/ })
      .click();
    await expect
      .poll(() =>
        page.evaluate((before) => {
          const { entry, attempt } = window.fixtureNavigation.snapshot();
          return {
            sameEntry: entry.id === before.entry,
            freshAttempt: attempt.id !== before.attempt,
          };
        }, before),
      )
      .toEqual({ sameEntry: true, freshAttempt: true });
    release();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(alpha).toBeFocused();
  } finally {
    release();
  }
});
