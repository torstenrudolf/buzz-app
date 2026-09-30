import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only contract: actual app consumers, CSS Modules, inherited custom
// properties, portal boundaries and pointer states. No live account mutations.
test.use({
  productionBroker: true,
  readState: true,
  sessionChannels: ["alpha"],
  sessionParents: { alpha: "11111111-1111-4111-8111-111111111111" },
});

async function resolvedColor(locator, expression) {
  return locator.evaluate((element, value) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = value;
    element.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, expression);
}

for (const mode of ["light", "dark"]) {
  test(`availability retains semantic state fills in ${mode}`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(app.origin);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    const account = page.getByRole("menu", {
      name: "Fixture Reader",
      exact: true,
    });
    await expect(account).toBeVisible();
    const availability = page.getByRole("button", { name: /^Availability:/ });
    // Drive real presence preferences against the isolated modeled relay, not
    // data-status or inline-style injection into the consumer under test.
    for (const status of ["Online", "Away", "Offline"]) {
      if (status !== "Online") {
        await availability.click();
        await page
          .getByRole("menuitemradio", { name: status, exact: true })
          .click();
        await page.keyboard.press("Escape");
      }
      await expect(availability).toHaveAccessibleName(
        `Availability: ${status}`,
      );
      await expect(availability).toHaveAttribute("aria-expanded", "false");
      const tint =
        status === "Online"
          ? "--status-availability-online"
          : status === "Away"
            ? "--status-away"
            : "--text-subtle";
      const backdrop =
        status === "Away" ? "transparent" : "var(--surface-inset)";
      const expected = async (percent) =>
        resolvedColor(
          account,
          `color-mix(in srgb, var(${tint}) ${percent}%, ${backdrop})`,
        );
      const text = await resolvedColor(
        account,
        `var(${status === "Away" ? "--text-warning" : tint})`,
      );
      await page.mouse.move(1, 1);
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(12),
      );
      await expect(availability).toHaveCSS("color", text);
      await availability.hover();
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(18),
      );
      await page.mouse.down();
      try {
        await expect(availability).toHaveCSS(
          "background-color",
          await expected(24),
        );
      } finally {
        await page.mouse.up();
      }
      await expect(availability).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("menuitemradio", { name: status, exact: true }),
      ).toHaveCSS(
        "color",
        mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      );
      await page.mouse.move(1, 1);
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(24),
      );
      await page.keyboard.press("Escape");
      await expect(availability).toHaveAttribute("aria-expanded", "false");
      await expect(availability).toBeFocused();
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(12),
      );
    }
  });

  test(`sidebar session selection stays quiet in ${mode}`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const child = sidebar.locator('[data-channel-id="alpha"]');
    const parent = sidebar.locator(
      '[data-channel-id="11111111-1111-4111-8111-111111111111"]',
    );
    await child.click();
    await page.mouse.move(1, 1);
    const selected = mode === "dark" ? "rgb(51, 51, 51)" : "rgb(245, 245, 246)";
    await expect(child).toHaveAttribute("aria-current", "page");
    await expect(child).toHaveCSS("background-color", selected);
    await child.hover();
    await expect(child).toHaveCSS("background-color", selected);
    await parent.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "New session", exact: true })
      .click();
    const draft = sidebar.getByRole("button", { name: /New session draft in/ });
    await expect(draft).toHaveAttribute("aria-current", "page");
    await page.mouse.move(1, 1);
    await expect(draft).toHaveCSS("background-color", selected);
    await draft.hover();
    await expect(draft).toHaveCSS("background-color", selected);
    await expect(child).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await child.hover();
    await expect(child).toHaveCSS(
      "background-color",
      await resolvedColor(sidebar, "var(--affordance-navigation-quiet)"),
    );
    await parent.click();
    await page.mouse.move(1, 1);
    const parentRow = parent.locator(
      "xpath=ancestor::*[@data-channel-sidebar-row]",
    );
    await expect
      .poll(() =>
        parentRow.evaluate(
          (element) => getComputedStyle(element, "::before").backgroundColor,
        ),
      )
      .toBe(selected);
  });
}
