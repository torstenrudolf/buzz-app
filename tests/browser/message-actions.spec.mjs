import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Browser-only contracts: actual hover/coarse-pointer layout, portal focus return,
// and opening a real thread then focusing its real editor. Clipboard failures and
// mention matrices live in colocated unit tests, not a browser scenario matrix.
test("message actions reveal, copy, restore focus and reply across responsive layouts", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.copiedMessages = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessages.push(text);
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Message actions browser check");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  const trigger = row.getByRole("button", { name: "More message actions" });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Copy message", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Message copied", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.copiedMessages)).toEqual([
    event.content,
  ]);
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessages.at(-1));
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const root = panel.locator(`[data-message-id="${event.id}"]`);
  await expect(root).toBeVisible();
  await root.hover();
  await root
    .getByRole("button", { name: "React with 👍", exact: true })
    .click();
  await expect(
    root.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await root
    .getByRole("button", { name: "👍: 1 person, including you", exact: true })
    .click();
  await expect(root.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  const replyBox = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await replyBox.fill("Keep this reply draft");
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
  await expect(replyBox).toHaveText("Keep this reply draft");
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Reply", exact: true }),
  ).toBeFocused();

  // A broadcast reply must open its owning thread for composition, not reveal
  // the selected reply and steal focus back from the editor.
  const broadcast = app.histories
    .get("primary/alpha")
    .find((item) => item.content === "Broadcast reply");
  if (!broadcast) throw new Error("Expected broadcast reply fixture");
  const broadcastRow = page.locator(
    `[data-channel-timeline] [data-message-id="${broadcast.id}"]`,
  );
  await broadcastRow.hover();
  await broadcastRow
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(replyBox).toBeFocused();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await broadcastRow.getByRole("button", { name: /^View thread:/ }).click();
  await expect(
    panel.locator(`[data-message-id="${broadcast.id}"]`),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  for (const width of [900, 603, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.mouse.click(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(
      row.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  }
  await page.screenshot({
    path: test.info().outputPath("message-actions-narrow.png"),
  });
});

// Browser-only: clipboard -> rendered Markdown -> cross-conversation navigation
// must finish with the actual virtual row visible and focused.
test("copied Buzz links and the desktop alias reveal their destination from a conversation", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessageLink = text;
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Shared destination");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessageLink);
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  const sharedConversation = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true });
  await sharedConversation.click();
  const sharedChannel = await page
    .locator("[data-channel-timeline]")
    .getAttribute("data-channel-timeline");
  app.append(
    "primary",
    sharedChannel,
    `${copiedLink}\n\n[Desktop alias](buzz://channel/alpha/${event.id})`,
  );
  for (const href of [copiedLink, `buzz://channel/alpha/${event.id}`]) {
    await sharedConversation.click();
    await page.locator(`[data-channel-timeline] a[href="${href}"]`).click();
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
  }
});

test("DM actions open the correct reply thread", async ({ page, app }) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const event = app.append("primary", channel, "DM menu check");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "React with 👍", exact: true }).click();
  await expect(
    row.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await row
    .getByRole("button", { name: "👍: 1 person, including you", exact: true })
    .click();
  await expect(row.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await row.hover();
  await row.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .locator(`[data-message-id="${event.id}"]`),
  ).toBeVisible();
  const replyBox = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 850 } });
  test("opens the message menu without hover", async ({ page, app }) => {
    await open(page, app);
    const event = app.append("primary", "alpha", "Touch menu check");
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const actions = row.getByRole("group", { name: "Message actions" });
    await expect(actions).toHaveCSS("opacity", "1");
    await row.getByRole("button", { name: "More message actions" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Copy message", exact: true }),
    ).toBeVisible();
  });
});

// Native geometry and hit testing protect prose/link access while controls reveal.
test("narrow timeline continuation actions never cover prose or move adjacent rows", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 900, height: 950 });
  await open(page, app);
  app.append("primary", "alpha", "Start a compact group");
  const event = app.append(
    "primary",
    "alpha",
    "Read [this reference](https://example.com/reference)",
  );
  const next = app.append("primary", "alpha", "Next message");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const following = page.locator(
    `[data-channel-timeline] [data-message-id="${next.id}"]`,
  );
  await expect(row.locator('[data-layout="continuation"]')).toBeVisible();
  await expect(following).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  const link = row.getByRole("link", { name: /this reference/ });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await settle(page);
  const baseline = await following.boundingBox();
  for (const mode of ["hover", "focus"]) {
    if (mode === "hover") await row.hover();
    else {
      await page.mouse.move(0, 0);
      await row.getByRole("button", { name: "More message actions" }).focus();
    }
    await expect(actions).toHaveCSS("opacity", "1");
    const prose = await row.locator("p").first().boundingBox();
    const toolbar = await actions.boundingBox();
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(prose.y);
    await expect(actions).toHaveCSS("position", "absolute");
    expect((await following.boundingBox()).y).toBe(baseline.y);
    await expect
      .poll(() =>
        link.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
  }
});

test("historical single-day DMs and their threads expose dates without hover", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const event = app.append("primary", channel, "Historical message");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await expect(row).toBeVisible();
  const date = await page.evaluate(
    (seconds) =>
      new Date(seconds * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    event.created_at,
  );
  await page.mouse.move(0, 0);
  await expect(timeline.getByText(date, { exact: true })).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Load older messages" }),
  ).toHaveCount(0);
  const reply = row.getByRole("button", { name: "Reply", exact: true });
  await reply.focus();
  await reply.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread.getByText(date, { exact: true })).toBeVisible();
});
