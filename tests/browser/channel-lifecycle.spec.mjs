import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
async function openLifecycle(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
}

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Native modal focus/escape and real menu -> modal handoff require a browser.
// Role/type/signing/cancellation matrices remain in domain and mounted tests.
test("archive confirmation returns focus on cancel and navigates after confirmed removal", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  // Hold the real permission request: the composed row menu must have no
  // orphan divider or unchecked actions.
  let release;
  let intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const permissionRoute = async (route) => {
    const filters = route.request().postDataJSON();
    if (
      !filters.some(
        (filter) =>
          filter.kinds?.includes(39001) &&
          filter["#d"]?.includes("11111111-1111-4111-8111-111111111111"),
      )
    )
      return route.continue();
    intercepted();
    await held;
    await route.continue();
  };
  await page.route("**/api/relay/**/query", permissionRoute);
  const menu = page.getByRole("menu", {
    name: "Actions for Lifecycle channel",
  });
  try {
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await seen;
    await expect(menu).toBeVisible();
    // Attention actions remain usable while lifecycle permissions are held;
    // existing separators belong to Move and attention, not pending lifecycle.
    await expect(menu.getByRole("separator")).toHaveCount(2);
    await expect(menu.getByRole("menuitem")).toHaveText([
      "New session",
      "Move channel",
      "Mute",
      "Mark as Unread",
    ]);
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    menu.getByRole("menuitem", { name: "Archive channel", exact: true }),
  ).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(3);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "New session",
    "Move channel",
    "Mute",
    "Mark as Unread",
    "Archive channel",
    "Delete channel",
  ]);
  await expect(
    page.getByRole("button", { name: /More options for/ }),
  ).toHaveCount(0);
  for (const name of ["Archive channel", "Delete channel"]) {
    await expect(
      menu
        .getByRole("menuitem", { name, exact: true })
        .locator(".buzz-menu-icon svg"),
    ).toHaveCount(1);
  }
  await page.unroute("**/api/relay/**/query", permissionRoute);
  await expect(
    menu.getByRole("menuitem", { name: /^Leave channel/ }),
  ).toHaveCount(0);
  await expect(
    menu.getByText("Transfer ownership before leaving the channel."),
  ).toHaveCount(0);
  await menu.screenshot({ path: testInfo.outputPath("lifecycle-menu.png") });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Archive channel: Lifecycle channel",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.screenshot({
    path: testInfo.outputPath("lifecycle-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await openPage(page, "Projects");
  await row.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await row.click();
  await row.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(app.report.lifecyclePublications).toHaveLength(1);
  expect(app.report.lifecyclePublications[0].kind).toBe(9002);
  expect(app.report.unexpected).toEqual([]);
});

// The production page must project the separate per-viewer visibility snapshot
// after remount/reload, while membership/authorized channel reads remain intact.
test("DM hide is per-viewer visibility, survives reload and never sends Leave or Delete", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.locator(
    '[data-channel-id="22222222-2222-4222-8222-222222222222"]',
  );
  await expect(row).toBeVisible();
  await row.click();
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await expect(composer).toBeVisible();
  const composerName = await composer.getAttribute("aria-label");
  const conversationUrl = page.url();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Hide conversation", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
  ).toHaveCount(0);
  await menu
    .getByRole("menuitem", { name: "Hide conversation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Hide conversation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  // Wait for the actual visibility read to complete before asserting absence.
  await expect
    .poll(
      () =>
        app.report.queries.filter((query) =>
          JSON.stringify(query).includes("30622"),
        ).length,
    )
    .toBeGreaterThan(1);
  await expect(row).toHaveCount(0);
  // A hidden row is not an access denial. Exact navigation still opens its messages.
  await page.goto(conversationUrl);
  await expect(
    page.getByRole("textbox", { name: composerName, exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    41012,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Delete takes the access-purge route (archive does not), across the real broker,
// session, native dialog and navigation. Role permutations remain below the browser.
test("delete confirmation without typing purges the selected channel and survives reload", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete channel: Lifecycle channel",
  });
  const confirm = dialog.getByRole("button", {
    name: "Delete channel",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
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
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9008,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Last-row removal crosses sidebar/page ownership. Keep retained membership in
// the fixture so an ordinary saved/first-channel fallback cannot look correct.
for (const action of ["archive", "hide"]) {
  test.describe(`last visible row: ${action}`, () => {
    const channel = "11111111-1111-4111-8111-111111111111";
    const dm = "22222222-2222-4222-8222-222222222222";
    const id = action === "archive" ? channel : dm;
    const label =
      action === "archive" ? "Archive channel" : "Hide conversation";
    test.use({
      lifecycleVisibility: {
        archived: ["alpha", "beta", ...(action === "hide" ? [channel] : [])],
        hidden: action === "archive" ? [dm] : [],
      },
    });
    test("completion stays neutral with archived and hidden membership, including reload", async ({
      page,
      app,
    }) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const rows = sidebar.locator("button[data-channel-id]");
      await expect(rows).toHaveCount(1);
      const row = sidebar.locator(`button[data-channel-id="${id}"]`);
      await row.click();
      const composer = page.getByRole("textbox", { name: /^Message #/ });
      await expect(composer).toBeVisible();
      const composerName = await composer.getAttribute("aria-label");
      const exactUrl = page.url();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByText("Select a channel to read it.", { exact: true }),
      ).toBeVisible();
      await expect(rows).toHaveCount(0);
      await expect(composer).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByText("Select a channel to read it.", { exact: true }),
      ).toBeVisible();
      await expect(rows).toHaveCount(0);
      await expect(composer).toHaveCount(0);
      expect(
        app.report.lifecyclePublications.map((event) => event.kind),
      ).toEqual([action === "archive" ? 9002 : 41012]);
      if (action === "hide") {
        // Empty intent must not turn visibility into an access restriction.
        await page.goto(exactUrl);
        await expect(
          page.getByRole("textbox", { name: composerName, exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(0);
      }
      expect(app.report.unexpected).toEqual([]);
    });
  });
}

// Native Escape dispatch precedes cancel and bubbles through the navigation
// disclosure. A DOM emulator cannot prove visibility or modal inertness here.
test("pending modal Escape in narrow navigation preserves visible recovery after uncertainty", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  await page.setViewportSize({ width: 600, height: 800 });
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const row = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Archive channel: Lifecycle channel",
  });
  const { promise: held, resolve: release } = Promise.withResolvers();
  const { promise: seen, resolve: intercepted } = Promise.withResolvers();
  await page.route(
    "**/api/relay/**/channel-lifecycle-publish",
    async (route) => {
      intercepted();
      await held;
      // An unbound receipt is uncertain. Do not publish to the fixture relay.
      await route.fulfill({
        json: { accepted: true, event_id: "wrong-event" },
      });
    },
  );
  try {
    await dialog
      .getByRole("button", { name: "Archive channel", exact: true })
      .click();
    await seen;
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    // Disabled submit controls can drop focus to body. Clicking the modal's
    // explanation restores native dialog focus and exercises ancestor bubbling.
    await dialog
      .getByText("Archive this channel for everyone", { exact: false })
      .click();
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#shell-navigation")).toHaveAttribute(
      "data-expanded",
      "true",
    );
    expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
      true,
    );
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText(
    "The request may have taken effect.",
  );
  await expect(
    dialog.getByRole("button", { name: "Archive channel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  // Recovery must leave the page usable, not silently inert under a hidden modal.
  await page
    .getByRole("button", { name: "Hide navigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Show navigation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  expect(app.report.unexpected).toEqual([]);
});
