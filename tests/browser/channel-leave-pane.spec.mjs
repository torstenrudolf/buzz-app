import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const panelFor = (page) =>
  page.getByRole("complementary", { name: "Channel settings", exact: true });
const dialogFor = (page) =>
  page.getByRole("dialog", {
    name: "Leave channel: Lifecycle channel",
    exact: true,
  });
async function openSettings(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.locator(`[data-channel-id="${channelId}"]`).click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(panelFor(page)).toBeVisible();
  return sidebar;
}

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "member",
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only boundary: real Settings -> shared native modal, focus, and
// membership purge crossing the sidebar/page owners. Permission/recovery matrices
// remain in mounted and lifecycle domain tests; no live community writes.
test("management Leave restores focus on cancel, holds pending, and completes through the shared sidebar owner", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  const sidebar = await openSettings(page, app);
  const panel = panelFor(page);
  const leave = panel.getByRole("button", {
    name: "Leave channel",
    exact: true,
  });
  await expect(leave).toBeVisible();
  await expect(leave).toHaveAttribute("data-variant", "subtle");
  await leave.focus();
  await page.keyboard.press("Enter");
  const dialog = dialogFor(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Leave channel", exact: true }),
  ).toHaveAttribute("data-variant", "prominent");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveAttribute("data-variant", "subtle");
  await dialog.screenshot({
    path: testInfo.outputPath("leave-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(leave).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await leave.click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(leave).toBeFocused();

  let release;
  let intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  // Hold signing before publication: the real lifecycle operation stays pending.
  const routePattern = "**/api/relay/**/channel-lifecycle-sign";
  await page.route(routePattern, async (route) => {
    intercepted();
    await held;
    await route.continue();
  });
  try {
    await leave.click();
    await dialog
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await seen;
    await expect(
      dialog.getByRole("button", { name: "Leave channel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(
      sidebar.locator(`[data-channel-id="${channelId}"]`),
    ).toBeVisible();
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  } finally {
    release();
  }
  await expect(dialog).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(sidebar.locator(`[data-channel-id="${channelId}"]`)).toHaveCount(
    0,
  );
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator(`[data-channel-id="${channelId}"]`)).toHaveCount(
    0,
  );
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9022,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

test.describe("last visible channel", () => {
  test.use({
    lifecycleVisibility: {
      archived: ["alpha", "beta"],
      hidden: ["22222222-2222-4222-8222-222222222222"],
    },
  });
  test("management completion selects the explicit empty route, not retained membership", async ({
    page,
    app,
  }) => {
    const sidebar = await openSettings(page, app);
    await panelFor(page)
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await dialogFor(page)
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await expect(dialogFor(page)).toHaveCount(0);
    await expect(panelFor(page)).toHaveCount(0);
    await expect(
      page.getByText("Select a channel to read it.", { exact: true }),
    ).toBeVisible();
    await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /^Message #/ })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.closest('[aria-label="Channel sidebar"]') !==
          null,
      ),
    ).toBe(true);
    await page.reload();
    await expect(
      page.getByText("Select a channel to read it.", { exact: true }),
    ).toBeVisible();
    await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9022],
    );
    expect(app.report.unexpected).toEqual([]);
  });
});
