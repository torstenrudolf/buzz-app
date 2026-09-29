import {
  openPage,
  pageChoices,
  selectPage,
  selectSettingsSection,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { wheel, anchor, settle, upper, expectAnchor } from "./timeline.mjs";

const scroll = test.extend({ historyCounts: { alpha: 20, beta: 1 } });
// Resize tests must not enter the fixture’s deliberately held paging path.
const readingTest = test.extend({
  tallMessages: true,
  // Keep the old restored row visible when wheel input selects another row.
  historyCounts: { alpha: 24, beta: 1 },
});
async function expectNonPaging(page, app) {
  expect(
    await page
      .getByRole("region", { name: "Channel message history" })
      .evaluate((el) => el.scrollTop - Math.max(3000, el.clientHeight * 4)),
    "resize reading position stays outside older-page prefetch",
  ).toBeGreaterThan(0);
  expect(
    app.report.queries.filter(({ filter }) => filter.until !== undefined),
  ).toHaveLength(0);
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const companionLauncher = (page, name) =>
  button(page, name).and(page.locator("button[aria-expanded]"));
// The fixture's active plugin pages, in shell order, lead the channel sidebar.
// Sidebar rows are the primary pages; Messages and Sessions stay in search only.
const destinationTitles = [
  "Inbox",
  "Bestie",
  "Projects",
  "Agents",
  "Workflows",
];
const sidebarDestinations = (page, options = {}) =>
  page
    .getByRole("complementary", { name: "Channel sidebar", ...options })
    .getByRole("navigation", { name: "Pages", ...options })
    .getByRole("button", options);
const box = async (locator) => {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
};
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThan(2);
const panel = (page) =>
  page.getByRole("complementary", { name: "GitHub", exact: true });

async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}
async function link(page, app, target) {
  await page.route("https://api.github.com/repos/block/buzz/pulls/*", (route) =>
    route.fulfill({
      json: {
        title: "A useful change",
        state: "open",
        user: { login: "Fixture Reader" },
        body: "Public fixture content.\n".repeat(100),
      },
    }),
  );
  // A return from a compose route can still be restoring the timeline.
  await settle(page);
  app.append("primary", "alpha", `Please review ${target}`);
  const trigger = page.getByRole("link", { name: target, exact: true });
  await expect(trigger).toBeVisible();
  await settle(page);
  await trigger.scrollIntoViewIfNeeded();
  // Appending and bringing an offscreen link into view can both scroll Virtua.
  // These are panel-layout checks, not clicks during an in-flight correction.
  await settle(page);
  await expect(
    page.getByRole("region", { name: "Channel message history" }).locator("ol"),
  ).toHaveCSS("pointer-events", "auto");
  await trigger.click();
  await expect(
    panel(page).getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
}
async function shellFits(page, width) {
  if (width <= 650)
    await expect(
      page.locator("[data-shell-sidebar-toggle]"),
    ).toHaveAccessibleName(/^(Show|Hide) navigation$/);
  const disclosure = button(page, "Show navigation");
  const collapsed = await disclosure.isVisible();
  if (collapsed) await disclosure.click();
  const inSettings = await page
    .getByRole("region", { name: "Settings", exact: true })
    .isVisible();
  const destinations = inSettings
    ? page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button")
    : sidebarDestinations(page);
  if (inSettings) await expect(destinations.first()).toBeVisible();
  else await expect(destinations).toHaveText(destinationTitles);
  const sidebar = await box(
    page.getByRole("complementary", {
      name: inSettings ? "Settings sidebar" : "Channel sidebar",
    }),
  );
  const first = await box(destinations.first());
  const last = await box(destinations.last());
  for (const destination of [first, last]) {
    expect(destination.x).toBeGreaterThanOrEqual(sidebar.x);
    expect(destination.x + destination.width).toBeLessThanOrEqual(
      sidebar.x + sidebar.width,
    );
  }
  const channels = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const section = channels.locator("[data-sidebar-section]").first();
  if (await section.count()) {
    // Primary destinations lead the roster rather than overlapping its sections.
    expect(last.y + last.height).toBeLessThanOrEqual((await box(section)).y);
    expect((await box(channels)).height).toBeGreaterThan(40);
  }
  // At short heights destinations scroll with the roster and remain reachable.
  await destinations.last().scrollIntoViewIfNeeded();
  await expect(destinations.last()).toBeInViewport();
  if (await channels.count())
    await channels.evaluate((element) => {
      element.scrollTop = 0;
    });
  // The header keeps its launchers; sidebar destinations are not duplicated
  // there. Bestie's header button is its companion launcher, not a page row.
  await expect(
    page.locator(".shell-header").getByRole("button", {
      name: new RegExp(
        `^(${destinationTitles.filter((title) => title !== "Bestie").join("|")})$`,
      ),
      includeHidden: true,
    }),
  ).toHaveCount(0);
  const actions = await box(page.locator(".shell-actions"));
  const communities = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  expect(actions.x + actions.width).toBeLessThanOrEqual(width);
  expect(communities.x + communities.width).toBeLessThan(actions.x);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(width);
  if (width > 700) {
    // The compact rail meets the sidebar edge without overlapping it.
    expect(communities.x + communities.width).toBeLessThanOrEqual(sidebar.x);
  }
  if (collapsed) await button(page, "Hide navigation").click();
}

scroll(
  "page overscroll is disabled while message history still scrolls",
  async ({ page, app }) => {
    await open(page, app);
    // Headless wheel input does not reproduce macOS trackpad rubber-banding.
    // Check the viewport policy as well as real panel scrolling and shell bounds.
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior", "none");
    const shell = page.locator(".shell-background");
    const bounds = await box(shell);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await settle(page);
    const initialOffset = await history.evaluate((el) => el.scrollTop);
    await history.hover();
    await wheel(page, -300);
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeLessThan(initialOffset - 100);
    await settle(page);
    expect(await box(shell)).toEqual(bounds);

    // Projects has no overflowing content: gestures must leave the shell in place.
    await openPage(page, "Projects");
    await page.getByRole("heading", { name: "Projects", exact: true }).hover();
    for (const [x, y] of [
      [0, -600],
      [0, 600],
      [-600, 0],
      [600, 0],
    ]) {
      await page.mouse.wheel(x, y);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await box(shell)).toEqual(bounds);
      expect(
        await page.evaluate(() => [window.scrollX, window.scrollY]),
      ).toEqual([0, 0]);
    }
  },
);

test("bento surfaces, sidebar pages, real link panel and compact community navigation", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await shellFits(page, 1280);
  const sidebar = await box(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const before = await box(conversation);
  const rail = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  near(rail.width, 48);
  near(sidebar.x, rail.x + rail.width);
  near(before.x - sidebar.x - sidebar.width, 8);
  near(before.y, 48);
  near(before.height, 768);
  const background = await page
    .locator(".shell-background")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(background).toContain("radial-gradient");
  // The full-bleed backdrop is now the shared gradient rather than a bitmap.
  const gradient = await page.locator(".shell-background").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundImage = "var(--bg-app)";
    el.append(probe);
    const value = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return value;
  });
  expect(background).toBe(gradient);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Layout draft");
  await page.screenshot({ path: testInfo.outputPath("bento-no-panel.png") });
  await link(page, app, "https://github.com/block/buzz/pull/1");
  const main = await box(conversation);
  const dock = await box(panel(page));
  near(dock.y, main.y);
  near(dock.height, main.height);
  near(dock.x - main.x - main.width, 8);
  near(dock.x + dock.width, 1264);
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  await expect(composer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("bento-one-panel.png") });
  const timeline = page.getByRole("region", {
    name: "Channel message history",
  });
  const offset = await timeline.evaluate((el) => el.scrollTop);
  await panel(page).getByRole("heading", { name: "A useful change" }).hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() =>
      panel(page)
        .locator("[class*='root']")
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(100);
  near(await timeline.evaluate((el) => el.scrollTop), offset);
  await button(page, "Close channel panel").click();
  await expect(panel(page)).toHaveCount(0);
  near((await box(conversation)).width, before.width);
  await link(page, app, "https://github.com/block/buzz/pull/2");
  await button(page, "Beta").click();
  await expect(panel(page)).toHaveCount(0);
  await button(page, "Alpha").click();
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  const railButtons = page.getByRole("navigation", {
    name: "Communities",
    exact: true,
  });
  await expect(
    railButtons.getByRole("button", { name: "Personal space" }),
  ).toBeVisible();
  const add = railButtons.getByRole("button", { name: "Add a community" });
  await add.click();
  await expect(
    page.getByRole("heading", { name: "Add a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  await railButtons
    .getByRole("button", { name: "Switch to Secondary" })
    .click();
  await expect(composer).toHaveJSProperty("value", "");
  await railButtons.getByRole("button", { name: "Switch to Primary" }).click();
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  for (const [width, height] of [
    [1200, 800],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(composer).toBeInViewport();
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Settings", exact: true }),
    ).toBeVisible();
    if (width <= 650) await button(page, "Show navigation").click();
    await openPage(page, "Messages");
    await expect(composer).toHaveJSProperty("value", "Layout draft");
    await expect(page.locator("[data-message-id]").last()).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("bento-narrow.png") });
  await link(page, app, "https://github.com/block/buzz/pull/3");
  await expect(button(page, "Close channel panel")).toBeInViewport();
  const narrow = await box(panel(page));
  const narrowConversation = await box(conversation);
  near(narrow.x, narrowConversation.x);
  near(narrow.width, narrowConversation.width);
  await button(page, "Close channel panel").click();
  await expect(composer).toBeInViewport();
  await openPage(page, "Projects");
  // Search selection and the sidebar share page state, so Projects is current.
  // Projects moves focus to its heading once the directory opens.
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  const hiddenDestinations = sidebarDestinations(page, { includeHidden: true });
  await expect(hiddenDestinations).toHaveText(destinationTitles);
  await expect(
    hiddenDestinations.and(page.locator("[aria-current]")),
  ).toHaveText(["Projects"]);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await selectSettingsSection(page, "Plugins");
  // Channels has no off switch; use another page to exercise UI activation.
  const projects = page.getByRole("switch", {
    name: "Enable Projects",
    exact: true,
  });
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const expectProjectsChoice = async (count) => {
    const choices = await pageChoices(page);
    // Messages proves the Pages group rendered before counting Projects.
    await expect(
      choices.getByRole("option", { name: "Messages", exact: true }),
    ).toBeVisible();
    await expect(
      choices.getByRole("option", { name: "Projects", exact: true }),
    ).toHaveCount(count);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "false");
  await expectProjectsChoice(0);
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "true");
  await expectProjectsChoice(1);
});

test("narrow link panels begin after the rendered sidebar", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await page
    .getByRole("separator", { name: "Resize channel sidebar" })
    .press("End");
  await page.setViewportSize({ width: 800, height: 600 });
  await link(page, app, "https://github.com/block/buzz/pull/7");

  const sidebar = await box(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const conversation = await box(
    page.getByRole("article", { name: "Conversation", exact: true }),
  );
  const dock = await box(panel(page));
  near(conversation.x - sidebar.x - sidebar.width, 8);
  near(dock.x, conversation.x);
  expect(dock.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
  // Separate stacking contexts: assert actual hit testing, not unrelated z-index numbers.
  const close = button(page, "Close channel panel");
  expect(
    await close.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await close.click();
  await expect(panel(page)).toHaveCount(0);
});

readingTest(
  "panel resizing preserves bottom follow and the visible reading anchor",
  async ({ page, app }) => {
    // Virtua ends an imperative scroll on a 150ms timer. The clock lets the
    // test expire it exactly, instead of sleeping past it on wall time.
    await page.clock.install();
    await open(page, app);
    await settle(page);
    await link(page, app, "https://github.com/block/buzz/pull/4");
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const expectBottom = () =>
      expect
        .poll(() =>
          history.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(4);
    await settle(page);
    await expectBottom();
    const received = app.append("primary", "alpha");
    await expect(
      page.locator(`[data-message-id="${received.id}"]`),
    ).toBeInViewport();
    await button(page, "Close channel panel").click();
    await settle(page);
    await expectBottom();
    // Late layout-only reflow must not need another message or viewport resize.
    // Expire Virtua's 150ms imperative-scroll scheduler first. Change actual
    // row layout, not scroll methods/metrics or the production observer callback.
    await page.clock.runFor(150);
    const lateLayout = await page.addStyleTag({
      content: `[data-message-id="${received.id}"] p { padding-bottom: 120px; }`,
    });
    await settle(page);
    await expectBottom();
    await page.clock.runFor(150);
    await lateLayout.evaluate((element) => element.remove());
    await settle(page);
    await expectBottom();
    // Reopen by keyboard without browser click-to-scroll changing the saved position.
    const target = "https://github.com/block/buzz/pull/4";
    // Keep the offscreen opener within the virtualizer's mounted buffer after
    // focus moves to the panel; this tests restoration to a mounted trigger.
    await history.hover();
    await wheel(page, -200);
    const saved = await anchor(page);
    await expectNonPaging(page, app);
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await settle(page);
    await expectAnchor(page, saved);
    // A panel can return focus to a mounted but offscreen link. Observe the
    // native focus call itself: eventual anchor recovery can hide a scroll jump.
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => {
        const focus = el.focus;
        el.focus = function (options) {
          const history = el.closest("[data-channel-timeline]");
          const before = history.scrollTop;
          focus.call(this, options);
          window.panelFocusScrollDelta = history.scrollTop - before;
        };
      });
    await button(page, "Close channel panel").focus();
    await expect(
      page.getByRole("link", { name: target, exact: true }),
    ).not.toBeInViewport();
    await button(page, "Close channel panel").click();
    const trigger = page.getByRole("link", { name: target, exact: true });
    await settle(page);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.panelFocusScrollDelta)).toBe(0);
    await expectAnchor(page, saved);
    // Reflow can arrive after Virtua's 150ms imperative-scroll scheduler ends.
    // Keep the selected reading anchor, not the partially clipped row above it.
    await page.clock.runFor(150);
    const preceding = await history.evaluate((element, id) => {
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const index = rows.findIndex((row) => row.dataset.messageId === id);
      return rows[index - 1]?.dataset.messageId;
    }, saved.id);
    expect(preceding).toBeTruthy();
    const delayedReflow = await page.addStyleTag({
      content: `[data-message-id="${preceding}"] p { padding-bottom: 52px; }`,
    });
    await settle(page);
    await expectAnchor(page, saved);
    await delayedReflow.evaluate((element) => element.remove());
    await settle(page);
    await expectAnchor(page, saved);
    await page.setViewportSize({ width: 1200, height: 700 });
    await settle(page);
    await expectAnchor(page, saved);
    await expectNonPaging(page, app);
  },
);

readingTest(
  "a focused message stays mounted until focus leaves the timeline",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const target = "https://example.com/focused-message";
    const previous = await page
      .locator("[data-message-id]")
      .last()
      .getAttribute("data-message-id");
    const message = app.append("primary", "alpha", `Keep focus on ${target}`);
    const trigger = page.getByRole("link", { name: target, exact: true });
    await expect(trigger).toBeInViewport();
    await settle(page);
    await trigger.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(trigger).toBeFocused();
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    await page.mouse.wheel(0, -3500);
    // The adjacent unpinned row proves that real virtualization has evicted this
    // range; a timeout or a mocked virtualizer would not establish that boundary.
    await expect(page.locator(`[data-message-id="${previous}"]`)).toHaveCount(
      0,
    );
    await settle(page);
    await expect(trigger).toBeFocused();
    await expect(trigger).not.toBeInViewport();
    await history.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(history).toBeFocused();
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(
      0,
    );
  },
);

test("Bestie owns the launcher and the reusable companion card across pages and disable", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  const bestie = page.getByRole("complementary", {
    name: "Bestie",
    exact: true,
  });
  const launch = companionLauncher(page, "Bestie");
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await expect(bestie).toBeVisible();
  await expect(bestie).toContainText("Agent chat isn’t connected yet");
  await expect(launch).toHaveAttribute("aria-expanded", "true");
  await launch.click();
  await expect(bestie).toHaveCount(0);
  await expect(launch).toHaveAttribute("aria-expanded", "false");
  await expect(launch).toBeFocused();
  await launch.click();
  await button(page, "Close Bestie panel").click();
  await expect(launch).toBeFocused();
  await launch.click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  await expect(bestie).toHaveCount(1);
  const enabled = page.getByRole("switch", {
    name: "Enable Bestie",
    exact: true,
  });
  await enabled.click();
  await expect(launch).toHaveCount(0);
  await expect(bestie).toHaveCount(0);
  await expect(enabled).toBeFocused();
  await enabled.click();
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Companion draft");
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  near((await box(bestie)).height, (await box(conversation)).height);
  await link(page, app, "https://github.com/block/buzz/pull/5");
  const top = await box(panel(page)),
    bottom = await box(bestie),
    main = await box(conversation);
  near(top.height, bottom.height);
  near(top.y, main.y);
  near(bottom.y - top.y - top.height, 4);
  near(bottom.y + bottom.height, main.y + main.height);
  near(top.x, bottom.x);
  await page.screenshot({ path: testInfo.outputPath("bestie-two-panels.png") });
  // Simulate a management update observed while Messages remains mounted.
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const settings = JSON.parse(localStorage.getItem(key));
    settings.enabled["buzz.bestie"] = false;
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await expect(launch).toHaveCount(0);
  await expect(bestie).toHaveCount(0);
  await expect(panel(page)).toHaveCount(1);
  near((await box(panel(page))).height, (await box(conversation)).height);
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const settings = JSON.parse(localStorage.getItem(key));
    settings.enabled["buzz.bestie"] = true;
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await expect(composer).toHaveJSProperty("value", "Companion draft");
  await button(page, "Close Bestie panel").click();
  near((await box(panel(page))).height, (await box(conversation)).height);
  await launch.click();
  await button(page, "Close channel panel").click();
  near((await box(bestie)).height, (await box(conversation)).height);
  await button(page, "Beta").click();
  await expect(bestie).toHaveCount(1);
  await button(page, "Alpha").click();
  await expect(composer).toHaveJSProperty("value", "Companion draft");
  await button(page, "Personal space").click();
  await expect(
    page.getByRole("heading", { name: "Your channels, one conversation." }),
  ).toBeVisible();
  await expect(bestie).toHaveCount(1);
  await button(page, "Close Bestie panel").click();
  await launch.click();
  await expect(bestie).toHaveCount(1);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  await expect(bestie).toHaveCount(1);
  for (const [width, height] of [
    [800, 600],
    [480, 400],
    [390, 844],
    [390, 400],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(button(page, "Close Bestie panel")).toBeInViewport();
  }
  await button(page, "Close Bestie panel").click();
  await expect(bestie).toHaveCount(0);
  await expect(launch).toHaveAttribute("aria-expanded", "false");
  await expect(launch).toBeFocused();

  // Plugin catalogs can outgrow the viewport. Closing restores the launcher,
  // not a Settings row: reach the toggle with real input, not scrollIntoView.
  // Settings details own scrolling independently of the sidebar.
  const settingsPage = page
    .getByRole("region", { name: "Settings", exact: true })
    .locator(":scope > div");
  await expect(enabled).not.toBeInViewport();
  const viewport = await box(settingsPage);
  await page.mouse.move(
    viewport.x + viewport.width / 2,
    viewport.y + viewport.height / 2,
  );
  const visibleTop = Math.max(viewport.y, 0);
  const visibleBottom = Math.min(viewport.y + viewport.height, 400);
  for (let gesture = 0; gesture < 30; gesture++) {
    const toggle = await box(enabled);
    if (
      toggle.y >= visibleTop + 8 &&
      toggle.y + toggle.height <= visibleBottom - 8
    )
      break;
    const distance =
      toggle.y < visibleTop + 8
        ? toggle.y - visibleTop - 8
        : toggle.y + toggle.height - visibleBottom + 8;
    const before = await settingsPage.evaluate((el) => el.scrollTop);
    await wheel(
      page,
      Math.sign(distance) * Math.max(Math.abs(distance), 24),
      settingsPage,
    );
    await expect
      .poll(() => settingsPage.evaluate((el) => el.scrollTop), {
        message: "Settings wheel input makes progress toward the plugin toggle",
      })
      .toBeGreaterThan(before);
  }
  await expect(enabled).toBeInViewport({ ratio: 1 });
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(enabled).toBeFocused();
  await expect(launch).toHaveCount(0);
});

const todosOverlapTest = test.extend({
  threadUnread: true,
  readState: true,
  historyCounts: { alpha: 3, beta: 1 },
});
todosOverlapTest(
  "Todos stacks beside threads and linked panels in either opening order",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await open(page, app);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await selectSettingsSection(page, "Plugins");
    await page
      .getByRole("switch", { name: "Enable Todos", exact: true })
      .click();
    await openPage(page, "Messages");
    const todos = page.getByRole("region", {
      name: "Todos panel",
      exact: true,
    });
    const toggle = button(page, "Toggle channel todos");
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const linked = panel(page);
    const settings = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    const bestie = page.getByRole("complementary", {
      name: "Bestie",
      exact: true,
    });
    const stacked = async (primary) => {
      await expect(primary).toBeVisible();
      await expect(todos).toBeVisible();
      const top = await box(primary);
      const bottom = await box(todos);
      near(top.x, bottom.x);
      near(top.width, bottom.width);
      near(bottom.y - top.y - top.height, 4);
      const conversation = await box(
        page.getByRole("article", {
          name: "Conversation",
          exact: true,
        }),
      );
      near(bottom.y + bottom.height, conversation.y + conversation.height);
    };
    const openThread = async () => {
      const root = app.histories
        .get("primary/alpha")
        .find((event) => event.content === "Thread root 0");
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(thread).toBeVisible();
    };

    await toggle.click();
    await openThread();
    await stacked(thread);
    await button(page, "Close thread").click();
    await button(page, "Hide todos").click();
    await openThread();
    await toggle.click();
    await stacked(thread);
    await button(page, "Close thread").click();

    await link(page, app, "https://github.com/block/buzz/pull/6");
    await stacked(linked);
    await button(page, "Close channel panel").click();
    await button(page, "Hide todos").click();
    await link(page, app, "https://github.com/block/buzz/pull/7");
    await toggle.click();
    await stacked(linked);
    await button(page, "Channel settings").click();
    await expect(settings).toBeVisible();
    await expect(todos).toHaveCount(0); // Settings intentionally retires the drawer.
    await button(page, "Close channel settings").click();
    await expect(linked).toBeVisible();
    await companionLauncher(page, "Bestie").click();
    await expect(bestie).toBeVisible();
    await expect(linked).toBeVisible();
    near(
      (await box(bestie)).y -
        (await box(linked)).y -
        (await box(linked)).height,
      4,
    );
    await button(page, "Close Bestie panel").click();
  },
);

readingTest(
  "companion resize preserves the timeline anchor and both cards at narrow sizes",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const saved = await upper(page);
    await expectNonPaging(page, app);
    await companionLauncher(page, "Bestie").click();
    await settle(page);
    await expectAnchor(page, saved);
    await button(page, "Close Bestie panel").click();
    await settle(page);
    await expectAnchor(page, saved);
    await link(page, app, "https://github.com/block/buzz/pull/6");
    await companionLauncher(page, "Bestie").click();
    for (const [width, height] of [
      [1440, 950],
      [800, 600],
      [480, 400],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const top = await box(panel(page));
      const bottom = await box(
        page.getByRole("complementary", { name: "Bestie", exact: true }),
      );
      near(top.height, bottom.height);
      near(bottom.y - top.y - top.height, 4);
      await expect(button(page, "Close channel panel")).toBeInViewport();
      await expect(button(page, "Close Bestie panel")).toBeInViewport();
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .evaluate((element) => element.click());
      const settings = page.getByRole("complementary", {
        name: "Channel settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
      const covered = await box(settings);
      const retainedCompanion = await box(
        page.getByRole("complementary", { name: "Bestie", exact: true }),
      );
      near(covered.height, top.height);
      near(retainedCompanion.height, bottom.height);
      near(retainedCompanion.y, bottom.y);
      await button(page, "Close channel settings").click();
      await expect(button(page, "Close channel panel")).toBeInViewport();
    }
  },
);

readingTest(
  "panel restoration yields to a new wheel reading position",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const original = await upper(page);
    await companionLauncher(page, "Bestie").click();
    await settle(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    // A tall row above the anchor can exceed one wheel step, and a tall
    // paragraph need not fit wholly in the narrowed viewport. Keep making real
    // progress until the visible reading row (including the production
    // clipped-row fallback) belongs to another message; never repeat a read
    // until an immobile timeline happens to pass.
    let reading = original;
    for (
      let gesture = 0;
      gesture < 6 && reading.id === original.id;
      gesture++
    ) {
      const before = await history.evaluate((el) => el.scrollTop);
      await wheel(page, -300);
      await expect
        .poll(() => history.evaluate((el) => el.scrollTop))
        .toBeLessThan(before);
      await settle(page);
      reading = await anchor(page);
    }
    expect(reading.id).not.toBe(original.id);
    // An offscreen restored row is ignored even if gesture() fails to clear it.
    // Keep that row intersecting so the final assertion detects a stale anchor.
    await expect(
      history.locator(`[data-message-id="${original.id}"]`),
    ).toBeInViewport();
    await button(page, "Close Bestie panel").click();
    await settle(page);
    await expectAnchor(page, reading);
    await expectNonPaging(page, app);
  },
);

test("Projects directory fits the workspace and page navigation survives plugin re-enable order", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  // Header search owns page navigation, including while narrow Settings
  // collapses the sidebar; its Pages group must preserve plugin ordering.
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const titles = [
    "Messages",
    "Inbox",
    "Bestie",
    "Projects",
    "Agents",
    "Sessions",
    "Workflows",
  ];
  const expectPageOrder = async (expected) => {
    const choices = await pageChoices(page);
    await expect(choices.getByRole("option")).toHaveText([
      ...expected,
      "Settings",
    ]);
    return choices;
  };
  const closeSearch = async () => {
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };
  await expectPageOrder(titles);
  await selectPage(page, "Projects");
  const surface = page.getByRole("region", { name: "Projects", exact: true });
  const title = surface.getByRole("heading", {
    name: "Projects",
    level: 1,
    exact: true,
  });
  await expect(title).toBeVisible();
  const directory = surface.locator(".projects-page");
  const subtitle = surface.getByText("Recent projects and repositories", {
    exact: true,
  });
  const empty = surface.getByText("No recent projects or repositories found.", {
    exact: true,
  });
  await expect(subtitle).toBeVisible();
  await expect(empty).toBeVisible();
  await expect(title).toBeFocused();
  for (const [width, height] of [
    [1280, 832],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const bounds = await box(surface);
    const workspace = await box(surface.locator("..").locator(".."));
    const heading = await box(title);
    near(bounds.x, workspace.x);
    near(bounds.y, workspace.y);
    near(bounds.width, workspace.width);
    near(bounds.height, workspace.height);
    const padding = await directory.evaluate((element) => ({
      left: Number.parseFloat(getComputedStyle(element).paddingLeft),
      top: Number.parseFloat(getComputedStyle(element).paddingTop),
    }));
    near(heading.x, bounds.x + padding.left);
    near(heading.y, bounds.y + padding.top);
    const description = await box(subtitle);
    const emptyState = await box(empty);
    expect(description.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    expect(emptyState.y).toBeGreaterThanOrEqual(
      description.y + description.height,
    );
    await expect(empty).toBeInViewport();
    await expect(directory).toHaveCSS("overflow", "auto");
    await expect(surface).toHaveCSS("overflow", "hidden");
    await shellFits(page, width);
    await page.screenshot({
      path: testInfo.outputPath(`projects-${width}.png`),
    });
  }
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  const projects = page.getByRole("switch", {
    name: "Enable Projects",
    exact: true,
  });
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "false");
  await expectPageOrder([
    "Messages",
    "Inbox",
    "Bestie",
    "Agents",
    "Sessions",
    "Workflows",
  ]);
  await closeSearch();
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "true");
  // Re-enabled Projects registered last; navigation surfaces must still sort it.
  await expectPageOrder(titles);
  await selectPage(page, "Projects");
  await expect(title).toBeVisible();
  // The narrow drawer is closed here, but the sidebar keeps the same order
  // for its primary rows.
  await expect(sidebarDestinations(page, { includeHidden: true })).toHaveText(
    destinationTitles,
  );
});

// Real App navigation must retire page-local targets, without closing the
// independently owned companion intent. Each return stays in Channels.
const sidebarActions = test.extend({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 1 },
});
sidebarActions(
  "sidebar activity and compose routes retire local link panels, not companion intent",
  async ({ page, app }) => {
    await open(page, app);
    const bestie = page.getByRole("complementary", {
      name: "Bestie",
      exact: true,
    });
    await companionLauncher(page, "Bestie").click();
    await expect(bestie).toBeVisible();
    const alpha = page.locator('button[data-channel-id="alpha"]');
    for (const [index, action] of [
      "activity",
      "message",
      "session",
    ].entries()) {
      await link(page, app, `https://github.com/block/buzz/pull/${20 + index}`);
      if (action === "activity") {
        await alpha.hover();
        await page
          .getByRole("dialog", { name: "Activity in Alpha" })
          .getByRole("button", { name: /Open unread thread from/ })
          // Unlike the broadcast row, this reply cannot be marked read by the
          // visible main timeline while Playwright is moving the pointer.
          .filter({ hasText: "Unread reply 1" })
          .click();
        await expect(
          page.getByRole("complementary", { name: "Thread", exact: true }),
        ).toBeVisible();
      } else if (action === "message") {
        const sidebar = page.getByRole("navigation", {
          name: "Subscribed channels",
        });
        await sidebar
          .locator("summary", { hasText: /^Direct messages$/ })
          .hover();
        await sidebar
          .getByRole("button", { name: "New message", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New message", exact: true }),
        ).toBeVisible();
      } else {
        await alpha.hover();
        await alpha.click({ button: "right" });
        await page
          .getByRole("menuitem", { name: "New session", exact: true })
          .click();
        await expect(
          page.getByRole("region", {
            name: "New session in Alpha",
            exact: true,
          }),
        ).toBeVisible();
      }
      await expect(panel(page)).toHaveCount(0);
      await expect(companionLauncher(page, "Bestie")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await button(page, "Go back").click();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      await expect(bestie).toBeVisible();
    }
  },
);
