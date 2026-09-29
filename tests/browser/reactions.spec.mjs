import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("reaction plus opens a visible emoji-only picker, restores focus and publishes custom emoji", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const root = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const plus = root
    .getByRole("group", { name: "Message actions" })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
  // Every message exposes first-reaction controls, not just previously reacted rows.
  await expect(
    page
      .getByRole("group", { name: "Message actions" })
      .getByRole("button", { name: "Add reaction", exact: true }),
  ).toHaveCount(6);
  await root.hover();
  const shortcut = root.getByRole("button", {
    name: "React with 👍",
    exact: true,
  });
  const neighbor = root.getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  const shortcutBox = await shortcut.boundingBox();
  const neighborBox = await neighbor.boundingBox();
  expect(shortcutBox.width).toBeCloseTo(neighborBox.width, 1);
  expect(shortcutBox.height).toBeCloseTo(neighborBox.height, 1);
  await shortcut.hover();
  const glyph = shortcut.locator('[class*="quickReactionGlyph"]');
  await expect
    .poll(() =>
      glyph.evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return Math.round(Math.hypot(matrix.a, matrix.b) * 1000) / 1000;
      }),
    )
    .toBe(3);
  const rotation = await glyph.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  });
  expect(rotation).toBeGreaterThanOrEqual(-10);
  expect(rotation).toBeLessThanOrEqual(10);
  expect(await shortcut.boundingBox()).toEqual(shortcutBox);
  expect(await neighbor.boundingBox()).toEqual(neighborBox);

  const actions = root.getByRole("group", { name: "Message actions" });
  const actionsBefore = await actions.boundingBox();
  const plusBefore = await plus.boundingBox();
  await plus.click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await expect(search).toBeVisible();
  // Mounting the portaled picker must not introduce another flex gap.
  await expect.poll(() => actions.boundingBox()).toEqual(actionsBefore);
  await expect.poll(() => plus.boundingBox()).toEqual(plusBefore);
  await search.hover();
  await search.focus();
  await expect(root.getByRole("group", { name: "Message actions" })).toHaveCSS(
    "opacity",
    "1",
  );
  const padding = await search.evaluate((input) => {
    const field = input.parentElement.getBoundingClientRect();
    const picker = input
      .getRootNode()
      .querySelector("#root")
      .getBoundingClientRect();
    return {
      top: field.top - picker.top,
      left: field.left - picker.left,
      right: picker.right - field.right,
    };
  });
  expect(padding.top).toBeCloseTo(padding.left, 1);
  expect(padding.top).toBeCloseTo(padding.right, 1);
  await expect(search.locator("..")).toHaveCSS("border-radius", "159984px");
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(plus).toBeFocused();
  await root.hover();
  await plus.click();
  await search.fill("party");
  const custom = page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first();
  await expect(custom).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("reaction-picker.png"),
  });
  await custom.click();
  await expect(search).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  const event = await page.evaluate(
    () => window.emojiFixture.report.publications[0].event,
  );
  expect(event.kind).toBe(7);
  expect(event.content).toBe(":party:");
  expect(event.tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/1.png",
  ]);
  expect(event.tags.filter(([name]) => name === "e")).toHaveLength(1);
  for (const length of [62, 63, 64]) {
    await root.hover();
    await plus.click();
    const boundarySearch = page.locator('em-emoji-picker input[type="search"]');
    const shortcode = "a".repeat(length);
    await boundarySearch.fill(shortcode);
    await page
      .getByRole("button", { name: `:${shortcode}:`, exact: true })
      .click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(4);
  await page.evaluate(() => window.emojiFixture.archive(true));
  await expect(plus).toHaveCount(0);
  await page.evaluate(() => window.emojiFixture.archive(false));
  await expect(plus).toHaveCount(1);
  await root.hover();
  const boundaryEvents = await page.evaluate(() =>
    window.emojiFixture.report.publications.slice(1).map(({ event }) => event),
  );
  expect(boundaryEvents.map(({ content }) => content)).toEqual(
    [62, 63, 64].map((length) => `:${"a".repeat(length)}:`),
  );
  expect(boundaryEvents.every(({ kind }) => kind === 7)).toBe(true);
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await root.hover();
  await plus.click();
  await page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first()
    .click();
  const retry = page.getByRole("button", { name: "Retry reaction" });
  await expect(retry).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remount());
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(5);
  const removal = await page.evaluate(
    () => window.emojiFixture.report.publications[4].event,
  );
  expect(removal.kind).toBe(5);
  expect(removal.tags).toContainEqual(["e", event.id]);
  await expect(
    root.getByRole("button", {
      name: ":party:: 1 person, including you",
      exact: true,
    }),
  ).toHaveCount(0);
  // Joining an old custom-emoji group retains its event-local URL, not the new palette URL.
  await root
    .getByRole("button", { name: ":party:: 1 person", exact: true })
    .click();
  await expect(
    root.getByRole("button", {
      name: ":party:: 2 people, including you",
      exact: true,
    }),
  ).toBeVisible();
  const joined = await page.evaluate(
    () => window.emojiFixture.report.publications.at(-1).event,
  );
  expect(joined.tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/reaction.png",
  ]);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await root.hover();
    const box = await root
      .getByRole("group", { name: "Message actions" })
      .boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  // Empty reaction rows must not change ordinary message spacing; failed first
  // reactions must still expose recovery in the same mounted row.
  const emptyRow = page
    .locator("[data-message-id]")
    .filter({ hasText: "Broken" });
  const reactionRow = emptyRow.locator('[class*="_reactions_"]');
  await expect(reactionRow).toHaveCSS("margin-top", "0px");
  await emptyRow.hover();
  const quick = emptyRow.getByRole("button", { name: /^React with / }).first();
  const chosen = (await quick.getAttribute("aria-label")).replace(
    "React with ",
    "",
  );
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await quick.click();
  const firstRetry = emptyRow.getByRole("button", { name: "Retry reaction" });
  await expect(firstRetry).toBeVisible();
  await expect(emptyRow.getByRole("status")).toHaveCSS("overflow", "visible");
  await firstRetry.click();
  const sole = emptyRow.getByRole("button", {
    name: `${chosen}: 1 person, including you`,
    exact: true,
  });
  await expect(sole).toBeEnabled();
  await sole.focus();
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await sole.press("Enter");
  const stableAction = emptyRow.getByRole("button", {
    name: "More message actions",
  });
  await expect(stableAction).toBeFocused();
  await expect(firstRetry).toBeVisible();
  await expect(sole).toBeVisible();
  await expect(stableAction).toBeFocused();
  await firstRetry.click();
  await expect(sole).toHaveCount(0);
  await expect(reactionRow).toHaveCSS("margin-top", "0px");
  // Repeat the keyboard path on successful removal as well as rollback.
  await emptyRow.hover();
  await emptyRow
    .getByRole("button", { name: `React with ${chosen}`, exact: true })
    .click();
  await expect(sole).toBeEnabled();
  await sole.focus();
  await sole.press("Enter");
  await expect(sole).toHaveCount(0);
  await expect(stableAction).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});

test("one active reaction picker preserves target and focus when switching or unmounting", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const rows = page.locator("[data-message-id]");
  // Open the lower row first so its popup does not cover the next trigger.
  const firstRow = rows.nth(1);
  const secondRow = rows.nth(0);
  const first = firstRow
    .getByRole("group", { name: "Message actions" })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
  const second = secondRow
    .getByRole("group", { name: "Message actions" })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
  const search = page.locator('em-emoji-picker input[type="search"]');
  await firstRow.hover();
  await first.click();
  await expect(search).toBeVisible();
  await secondRow.hover();
  await second.click();
  await expect(search).toHaveCount(1);
  await expect(search).toBeVisible();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await first.focus();
  await first.press("Enter");
  await expect(search).toBeVisible();
  await second.focus();
  await second.press("Enter");
  await expect(search).toHaveCount(1);
  await expect(search).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.press("Enter");
  await expect(search).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remount());
  await expect(search).toHaveCount(0);
  await firstRow.hover();
  await first.click();
  await expect(search).toBeVisible();
  await page.evaluate(() => window.emojiFixture.archive(true));
  await expect(search).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add reaction", exact: true }),
  ).toHaveCount(0);
});

// Browser-only: the documented gallery owns a separate root/iframe, so app-level
// provider coverage cannot prove that its portaled clipboard feedback is wired.
test("standalone message gallery hosts clipboard success and failure toasts", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (++attempts === 1) throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await page.goto("/tests/fixtures/message-gallery.html");
  const row = page.locator("[data-message-id]").first();
  const notifications = page.getByRole("region", {
    name: "App notifications",
  });
  const copy = async () => {
    await row.hover();
    await row
      .getByRole("button", { name: "More message actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Copy message", exact: true })
      .click();
  };
  await copy();
  await expect(
    notifications.getByText("Couldn’t copy. Try again from the message menu.", {
      exact: true,
    }),
  ).toBeVisible();
  await copy();
  await expect(
    notifications.getByText("Message copied", { exact: true }),
  ).toBeVisible();
  await expect(row).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
