import { test, expect } from "./source-fixture.mjs";

// Requires real CSS inheritance, pseudo states, portals and Tailwind layers.
// The viewer composes production controls; it is not product-flow acceptance.
const viewer = "/tests/fixtures/design-system.html#/design/floating-surfaces";
const transparent = "rgba(0, 0, 0, 0)";

for (const mode of ["light", "dark"]) {
  test(`surface contexts preserve controls and nested resets in ${mode}`, async ({
    page,
  }) => {
    await page.goto(viewer);
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const color =
      mode === "dark"
        ? {
            panel: "rgb(51, 51, 51)",
            fill: "rgb(64, 64, 64)",
            hover: "rgb(89, 89, 89)",
            pressed: "rgb(115, 115, 115)",
            selected: "rgb(64, 64, 64)",
            row: "rgb(89, 89, 89)",
            border: "rgb(128, 128, 128)",
            inset: "rgb(16, 16, 16)",
            ordinaryHover: "rgb(64, 64, 64)",
          }
        : {
            panel: "rgb(245, 245, 246)",
            fill: "rgb(245, 245, 246)",
            hover: "rgb(239, 239, 240)",
            pressed: "rgb(218, 218, 218)",
            selected: "rgb(218, 218, 218)",
            row: "rgb(232, 232, 232)",
            border: "rgb(128, 128, 128)",
            inset: "rgb(245, 245, 246)",
            ordinaryHover: "rgb(239, 239, 240)",
          };
    const panel = page.getByRole("region", {
      name: "Interaction panel",
      exact: true,
    });
    await expect(
      panel.getByRole("button", { name: "Secondary action", exact: true }),
    ).toHaveCSS("background-color", color.panel);
    for (const kind of ["dialog", "popover"]) {
      await page
        .getByRole("button", { name: `Open interaction ${kind}` })
        .click();
      const surface = page.getByRole("dialog", {
        name: `Interaction ${kind}`,
        exact: true,
      });
      await expect(surface).toBeVisible();
      // Finish the actual container entrance before retaining mouse coordinates.
      await surface.evaluate(async (el) => {
        await Promise.all(
          el.getAnimations().map((animation) => animation.finished),
        );
      });
      const action = surface.getByRole("button", {
        name: "Secondary action",
        exact: true,
      });
      await expect(action).toHaveCSS("background-color", color.fill);
      await action.hover();
      await expect(action).toHaveCSS("background-color", color.hover);
      await page.mouse.down();
      try {
        await expect(action).toHaveCSS("background-color", color.pressed);
      } finally {
        await page.mouse.up();
      }
      const ghost = surface.getByRole("button", {
        name: "Ghost action",
        exact: true,
      });
      await expect(ghost).toHaveCSS("background-color", transparent);
      await ghost.hover();
      await expect(ghost).toHaveCSS("background-color", color.hover);
      await expect(
        surface.getByRole("button", { name: "Outline action" }),
      ).toHaveCSS("box-shadow", `${color.border} 0px 0px 0px 1px inset`);
      const row = surface.getByRole("button", {
        name: "Interactive row Supporting detail",
      });
      const selected = surface.getByRole("button", {
        name: "Selected row Supporting detail",
      });
      await row.hover();
      await expect(row).toHaveCSS("background-color", color.row);
      await expect(row.locator(".text-metadata")).toHaveCSS(
        "color",
        mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      );
      await expect(selected).toHaveCSS("background-color", color.selected);
      await selected.hover();
      await expect(selected).toHaveCSS("background-color", color.selected);
      await surface.getByRole("button", { name: "Disabled row" }).hover();
      await expect(
        surface.getByRole("button", { name: "Disabled row" }),
      ).toHaveCSS("background-color", transparent);
      await expect(surface.getByRole("button", { name: "Saving" })).toHaveCSS(
        "background-color",
        color.fill,
      );
      await expect(
        surface.getByRole("button", { name: "Unavailable" }),
      ).toBeDisabled();
      await expect(
        surface.getByRole("button", { name: "Nested panel action" }),
      ).toHaveCSS("background-color", color.panel);
      const input = surface.getByRole("textbox", { name: "Name", exact: true });
      await input.focus();
      await expect(input).toHaveCSS("background-color", color.inset);
      await expect(input).toHaveCSS("border-top-color", color.border);
      const invalid = surface.getByRole("textbox", { name: "Required name" });
      const error = await invalid.evaluate(
        (el) => getComputedStyle(el).borderTopColor,
      );
      await invalid.focus();
      await expect(invalid).toHaveCSS("border-top-color", error);
      const clear = surface.getByRole("button", { name: "Clear search" });
      await clear.hover();
      await expect(clear).toHaveCSS("background-color", color.ordinaryHover);
      await clear.click();
      await expect(
        surface.getByRole("searchbox", { name: "Search" }),
      ).toBeFocused();
      const checkbox = surface.getByRole("checkbox", {
        name: "Include replies",
      });
      await expect(checkbox).toHaveCSS("border-top-color", color.border);
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(
        surface.getByRole("checkbox", { name: "Partially selected" }),
      ).toHaveAttribute("aria-checked", "mixed");
      await expect(
        surface.getByRole("checkbox", { name: "Disabled choice" }),
      ).toBeDisabled();
      const toggleChoice = surface.getByRole("switch", {
        name: "Notify me",
        exact: true,
      });
      await expect(toggleChoice).not.toBeChecked();
      await expect(toggleChoice).toHaveCSS(
        "background-color",
        color.ordinaryHover,
      );
      await toggleChoice.focus();
      await page.keyboard.press("Space");
      await expect(toggleChoice).toBeChecked();
      await expect(toggleChoice).toHaveCSS(
        "background-color",
        mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      );
      const radio = surface.getByRole("radio", { name: "Team", exact: true });
      await expect(radio).toBeChecked();
      await expect(radio.locator("..")).toHaveCSS(
        "background-color",
        color.selected,
      );
      await expect(
        radio.locator("..").locator(".buzz-choice-description"),
      ).toHaveCSS(
        "color",
        mode === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      );
      await surface
        .getByRole("radio", { name: "Invited", exact: true })
        .click();
      await expect(radio).not.toBeChecked();
      const select = surface.getByRole("combobox", { name: "Notifications" });
      await select.focus();
      await select.press("ArrowDown");
      const option = page.getByRole("option", { name: "Mentions only" });
      await expect(
        page.getByRole("option", { name: "All messages", exact: true }),
      ).toBeFocused();
      // Base UI ignores zero-delta pointer moves on WebKit. Playwright's
      // WebKit backend reports zero even while coordinates change, so exercise
      // the real keyboard highlight in both engines, not synthetic data attrs.
      await page.keyboard.press("End");
      await expect(option).toBeFocused();
      await expect(option).toHaveAttribute("data-highlighted");
      await expect(option).toHaveCSS("background-color", color.row);
      await page.keyboard.press("Enter");
      await expect(select).toContainText("Mentions only");
      await page.keyboard.press("Escape");
      await expect(surface).not.toBeVisible();
    }
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByRole("button", { name: "Open interaction dialog" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Interaction dialog" });
      await expect(
        dialog.getByRole("button", { name: "Secondary action", exact: true }),
      ).toHaveCSS("background-color", color.fill);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
    }
  });
}
