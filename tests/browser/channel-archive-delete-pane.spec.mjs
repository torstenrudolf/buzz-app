import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const panelFor = (page) =>
  page.getByRole("complementary", { name: "Channel settings", exact: true });

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Two distinct browser boundaries: archive changes visibility while retaining
// membership; delete purges access while the pane unmounts. Both reuse the native
// modal/focus handoff. Permission and recovery matrices stay below the browser.
for (const action of ["archive", "delete"]) {
  test.describe(`management ${action}`, () => {
    const label = action === "archive" ? "Archive channel" : "Delete channel";
    if (action === "delete")
      test.use({
        lifecycleVisibility: {
          archived: ["alpha", "beta"],
          hidden: ["22222222-2222-4222-8222-222222222222"],
        },
      });
    test("cancels to its pane trigger, locks pending, and preserves the confirmed destination on reload", async ({
      page,
      app,
    }, testInfo) => {
      await page.addInitScript(() => {
        localStorage.setItem("buzz-appearance.v1", "dark");
      });
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      const row = sidebar.locator(`[data-channel-id="${channelId}"]`);
      await row.click();
      await expect(
        page.getByRole("textbox", {
          name: "Message #Lifecycle channel",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .click();
      const panel = panelFor(page);
      const trigger = panel.getByRole("button", { name: label, exact: true });
      await expect(trigger).toBeVisible();
      const variant = action === "delete" ? "destructive" : "subtle";
      await expect(trigger).toHaveAttribute("data-variant", variant);
      await expect(
        panel.getByRole("button", { name: "Leave channel", exact: true }),
      ).toHaveCount(0);
      await panel.screenshot({
        path: testInfo.outputPath("management-actions.png"),
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: `${label}: Lifecycle channel`,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: label, exact: true }),
      ).toHaveAttribute(
        "data-variant",
        action === "delete" ? "destructive" : "prominent",
      );
      await dialog.screenshot({
        path: testInfo.outputPath(`${action}-confirmation.png`),
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
      await trigger.click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(trigger).toBeFocused();

      let release;
      let intercepted;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const seen = new Promise((resolve) => {
        intercepted = resolve;
      });
      await page.route(
        "**/api/relay/**/channel-lifecycle-sign",
        async (route) => {
          intercepted();
          await held;
          await route.continue();
        },
      );
      try {
        await trigger.click();
        const confirm = dialog.getByRole("button", {
          name: label,
          exact: true,
        });
        await expect(confirm).toBeEnabled();
        await expect(dialog.getByRole("textbox")).toHaveCount(0);
        await confirm.click();
        await seen;
        await expect(confirm).toBeDisabled();
        await expect(
          dialog.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await expect(dialog).toBeVisible();
        await expect(row).toBeVisible();
        expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
      } finally {
        release();
      }
      await expect(dialog).toHaveCount(0);
      await expect(panel).toHaveCount(0);
      await expect(row).toHaveCount(0);
      const destination =
        action === "archive"
          ? page.getByRole("textbox", { name: "Message #Alpha", exact: true })
          : page.getByText("Select a channel to read it.", { exact: true });
      await expect(destination).toBeVisible();
      if (action === "archive")
        await expect(
          sidebar.getByRole("button", { name: "Alpha", exact: true }),
        ).toBeFocused();
      else {
        await expect(sidebar.locator("button[data-channel-id]")).toHaveCount(0);
        await expect(
          page.getByRole("textbox", { name: /^Message #/ }),
        ).toHaveCount(0);
      }
      await page.reload();
      await expect(destination).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(
        app.report.lifecyclePublications.map((event) => event.kind),
      ).toEqual([action === "archive" ? 9002 : 9008]);
      expect(app.report.unexpected).toEqual([]);
    });
  });
}

// Production composition must apply owner-agent eligibility in both surfaces.
// Profile/role permutations and signing races stay in the lifecycle unit tests.
test.describe("owner-role agent without direct ownership", () => {
  test.use({ lifecycleRole: "admin", lifecycleOwnerAgent: true });
  test("offers Delete in both surfaces, retains a rejected channel, then confirms removal", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
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
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", {
      name: "Actions for Lifecycle channel",
    });
    // Visible permitted actions are the completion barrier for negative assertions.
    await expect(
      menu.getByRole("menuitem", { name: "Archive channel", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "Delete channel", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Delete channel: Lifecycle channel",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    const panel = panelFor(page);
    await expect(
      panel.getByRole("button", { name: "Archive channel", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Leave channel", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Delete channel", exact: true }),
    ).toBeVisible();
    const trigger = panel.getByRole("button", {
      name: "Delete channel",
      exact: true,
    });
    await trigger.click();
    // A signed profile and the relay's persisted ownership may disagree. Model
    // the exact negative delivery receipt at the host boundary, not a UI error.
    await page.route(
      "**/api/relay/**/channel-lifecycle-publish",
      async (route) => {
        const event = route.request().postDataJSON();
        expect(event.kind).toBe(9008);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accepted: false,
            event_id: event.id,
            message: "Only the channel owner can delete",
          }),
        });
      },
      { times: 1 },
    );
    await dialog
      .getByRole("button", { name: "Delete channel", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Only the channel owner can delete",
    );
    await expect(row).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Delete channel", exact: true }),
    ).toBeEnabled();
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Delete channel", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual(
      [9008],
    );
    expect(app.report.unexpected).toEqual([]);
  });
});

// Real browser focus retention when a Base UI button becomes busy and then
// unmounts; role/permission permutations remain in the component tests.
test.describe("owner-profile retry focus", () => {
  test.use({ lifecycleRole: "admin", lifecycleOwnerAgent: true });
  test("keeps keyboard recovery in Settings without stealing moved focus", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Lifecycle channel", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Lifecycle channel",
        exact: true,
      }),
    ).toBeVisible();
    let outcome = "failure";
    let gate;
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        !filters.some(
          (filter) => filter.kinds?.includes(0) && filter.limit === 1,
        )
      )
        return route.continue();
      const current = gate;
      current?.seen.resolve();
      if (current) await current.release.promise;
      if (outcome === "failure")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      if (outcome === "forbidden")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      return route.continue();
    });
    const panel = panelFor(page);
    const retry = panel.getByRole("button", {
      name: "Retry Delete check",
      exact: true,
    });
    const close = panel.getByRole("button", {
      name: "Close channel settings",
      exact: true,
    });
    const open = async () => {
      outcome = "failure";
      gate = undefined;
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .click();
      await expect(retry).toBeVisible();
    };
    const attempt = async (result, moveFocus = false) => {
      outcome = result;
      gate = {
        seen: Promise.withResolvers(),
        release: Promise.withResolvers(),
      };
      await retry.focus();
      await page.keyboard.press("Enter");
      try {
        await gate.seen.promise;
        await expect(retry).toBeFocused();
        await expect(retry).toHaveAttribute("aria-busy", "true");
        await expect(
          panel.getByRole("button", {
            name: /^(Leave|Archive|Delete) channel$/,
          }),
        ).toHaveCount(0);
        if (moveFocus) await close.focus();
      } finally {
        gate.release.resolve();
      }
      if (result === "failure") {
        await expect(retry).not.toHaveAttribute("aria-busy", "true");
        await expect(retry).toBeFocused();
      } else {
        const target = panel.getByRole("button", {
          name: result === "forbidden" ? "Leave channel" : "Delete channel",
          exact: true,
        });
        await expect(target).toBeVisible();
        await expect(moveFocus ? close : target).toBeFocused();
        await expect(retry).toHaveCount(0);
        if (result === "forbidden")
          await expect(
            panel.getByRole("button", { name: "Delete channel", exact: true }),
          ).toHaveCount(0);
      }
    };
    await open();
    await attempt("failure");
    await attempt("forbidden");
    await close.click();
    await open();
    await attempt("success", true);
    await close.click();
    await open();
    await attempt("success");
    expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
