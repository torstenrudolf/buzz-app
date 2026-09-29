import { openPage, pageChoices } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true });

const home = { version: 1, kind: "home" };
const settings = { version: 1, kind: "settings" };
const address = (origin, target) =>
  `${origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`;
const messages = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });

// Browser-only contract: startup/hash/history share production composition and
// legacy Home links resolve without flashing the retired page or adding a visit.
test("launch opens Messages without exposing Home across responsive navigation, search and history", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() => {
    window.homeFrames = [];
    function observe() {
      const main = document.getElementById("main-content");
      if (main?.textContent.includes("Make yourself at home."))
        window.homeFrames.push(main.textContent);
      requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
  });
  await page.goto(app.origin);
  await expect(messages(page)).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().entry.target),
      )
      .toMatchObject({
        // Local bootstrap now defers mounting ChannelsPage; the old initial
        // disconnected mount could complete this visit before default resolution.
        // The existing resolver keeps the conversation in that same visit.
        kind: "conversation",
        channelId: "alpha",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      });
    await expect(messages(page)).toBeVisible();
    const choices = await pageChoices(page);
    await expect(
      choices.getByRole("option", { name: "Messages", exact: true }),
    ).toBeVisible();
    await expect(
      choices.getByRole("option", { name: "Home", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("launch-messages.png") });
  await page.getByRole("button", { name: "Search Buzz" }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await expect(
    dialog.getByRole("option", { name: "Messages", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option", { name: "Home", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openPage(page, "Projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async (target) => {
    const nav = window.fixtureNavigation;
    const pending = nav.open(target);
    const visit = nav.snapshot().entry.id;
    return { result: await pending, visit, resolved: nav.snapshot().entry.id };
  }, home);
  expect(result.result).toEqual({ status: "opened" });
  expect(result.resolved).toBe(result.visit);
  await expect(messages(page)).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);

  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);
});

test("Channels stays enabled despite saved disabled settings and has no switch", async ({
  page,
  app,
}) => {
  await page.goto(address(app.origin, settings));
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Plugins", exact: true })
      .getByRole("article")
      .filter({ has: page.getByText("Channels", { exact: true }) })
      .getByText("Required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable Channels", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Enable Projects", exact: true }),
  ).toBeVisible();
  // Older disabled preferences cannot turn off the required launch destination.
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const saved = JSON.parse(localStorage.getItem(key)) ?? {
      version: 2,
      enabled: {},
    };
    saved.enabled["buzz.channels"] = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  await page.goto(address(app.origin, settings));
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Plugins", exact: true })
      .getByRole("article")
      .filter({ has: page.getByText("Channels", { exact: true }) })
      .getByText("Required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable Channels", exact: true }),
  ).toHaveCount(0);
  await openPage(page, "Messages");
  await expect(messages(page)).toBeVisible();
});

test("launch retains plugin-configuration recovery without Home", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzzodz.plugins.v1", "invalid"),
  );
  await page.goto(app.origin);
  await expect(
    page.getByRole("heading", { name: "Couldn’t open Buzz", exact: true }),
  ).toBeVisible();
  const recoveryChoices = await pageChoices(page);
  await expect(
    recoveryChoices.getByRole("option", { name: "Home", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page
    .getByRole("button", { name: "Back up & reset settings", exact: true })
    .click();
  const recoveredChoices = await pageChoices(page);
  await expect(
    recoveredChoices.getByRole("option", { name: "Messages", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Retry navigation", exact: true })
    .click();
  await expect(messages(page)).toBeVisible();
});
