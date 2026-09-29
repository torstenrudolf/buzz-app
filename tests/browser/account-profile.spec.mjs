import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// The unavailable body has no focus effect; exercise the card fallback through
// real menu close handling and Escape routing after a failed connection.
test("first opening an unavailable account profile focuses the panel", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/session", (route) => {
    app.report.startupFailures ??= [];
    app.report.startupFailures.push(route.request().url());
    return route.fulfill({
      status: 502,
      json: { error: "Connection unavailable" },
    });
  });
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Open Settings", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Settings", exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("Enter");
  const menu = page.getByRole("menu");
  const viewProfile = menu.getByRole("menuitem", { name: "View your profile" });
  await expect(viewProfile).toBeFocused();
  await viewProfile.press("Enter");
  await expect(menu).toHaveCount(0);
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(panel).toContainText(
    "Connect to a community to view this profile.",
  );
  await expect(panel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// Real menu focus handoff and Escape routing need browser keyboard behavior.
test("reopening the account profile focuses the retained panel", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const menu = page.getByRole("menu");
  const viewProfile = menu.getByRole("menuitem", { name: "View your profile" });
  await trigger.click();
  await viewProfile.click();
  await expect(menu).toHaveCount(0);
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(
    panel.getByRole("region", { name: "Profile details" }),
  ).toBeFocused();
  const channels = panel.getByRole("tab", { name: "Channels", exact: true });
  await channels.click();

  for (const keyboard of [false, true]) {
    if (keyboard) {
      await trigger.focus();
      await trigger.press("Enter");
      await expect(viewProfile).toBeFocused();
      await viewProfile.press("Enter");
    } else {
      await trigger.click();
      await viewProfile.click();
    }
    await expect(menu).toHaveCount(0);
    await expect(panel).toBeFocused();
    await expect(channels).toHaveAttribute("aria-selected", "true");
  }

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
