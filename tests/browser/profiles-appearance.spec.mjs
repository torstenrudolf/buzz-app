import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
for (const mode of ["light", "dark"]) {
  test(`Profiles uses shared styles and host keyboard focus in ${mode} mode`, async ({
    page,
    app,
    browserName,
  }, info) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    // Virtua mounts overscan outside the viewport. Pin a visible row instead
    // of letting an arbitrary first avatar trigger automation-driven scrolling.
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const messageId = await history.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const avatar = Array.from(
        element.querySelectorAll(
          'button[aria-label="View Fixture Reader profile"]',
        ),
      ).find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      if (!avatar) throw new Error("No fully visible profile avatar");
      return avatar.closest("[data-message-id]").dataset.messageId;
    });
    const avatar = history
      .locator(`[data-message-id="${messageId}"]`)
      .getByRole("button", {
        name: "View Fixture Reader profile",
        exact: true,
      });
    await expect(avatar).toBeInViewport({ ratio: 1 });
    await avatar.click();
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    const region = panel.getByRole("region", { name: "Profile details" });
    const copy = panel.getByRole("button", { name: "Copy npub", exact: true });
    const key = panel.locator("code");
    await expect(region).toHaveAttribute("data-buzz-ui", "");
    await expect(region).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(255, 255, 255)" : "rgb(26, 26, 26)",
    );
    await expect(region).toHaveCSS(
      "color",
      mode === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
    );
    await expect(region).toHaveCSS("font-size", "14px");
    await expect(
      panel.getByRole("heading", { name: "Fixture Reader", exact: true }),
    ).toHaveCSS("font-size", "24px");
    await expect(key).toHaveCSS("font-size", "12px");
    await expect(key).toHaveCSS("font-family", /JetBrains Mono/);
    await expect(copy).toHaveCSS("height", "32px");
    const pill = await copy.evaluate((el) => ({
      radius: parseFloat(getComputedStyle(el).borderRadius),
      height: el.getBoundingClientRect().height,
    }));
    expect(pill.radius).toBeGreaterThanOrEqual(pill.height / 2);
    await copy.hover();
    await expect(copy).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(239, 239, 240)" : "rgb(64, 64, 64)",
    );
    await page.keyboard.press(
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab",
    );
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy).toHaveCSS("outline-width", "2px");
    await page.mouse.click(2, 2);
    await copy.focus();
    await expect(copy).toHaveCSS("outline-style", "none");
    // Text controls can grow beyond their minimum to contain enlarged type.
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+=`);
    await expect(region).toHaveCSS("font-size", "15.4px");
    await expect(key).toHaveCSS("font-size", "13.2px");
    await expect(copy).toHaveCSS("min-height", "32px");
    await expect
      .poll(() =>
        copy.evaluate((element) => {
          const button = element.getBoundingClientRect();
          const label = element
            .querySelector(".buzz-button-label")
            .getBoundingClientRect();
          return (
            button.height >= 32 &&
            label.top >= button.top &&
            label.bottom <= button.bottom &&
            label.left >= button.left &&
            label.right <= button.right
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press(`${modifier}+0`);
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(key).toBeVisible();
      const bounds = await region.boundingBox();
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await region.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(false);
      expect(await key.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      // The human profile has no Memories tab; keyboard navigation stays
      // confined to the available tabs, including at narrow widths.
      const tabs = region.getByRole("tablist", { name: "Profile sections" });
      const infoTab = tabs.getByRole("tab", { name: "Info", exact: true });
      const channels = tabs.getByRole("tab", {
        name: "Channels",
        exact: true,
      });
      await expect(tabs.getByRole("tab", { name: "Memories" })).toHaveCount(0);
      await infoTab.focus();
      await infoTab.press("End");
      await expect(channels).toBeFocused();
      await expect(channels).toBeInViewport({ ratio: 1 });
      await channels.press("Enter");
      await expect(channels).toHaveAttribute("aria-selected", "true");
      await channels.press("Home");
      await infoTab.press("Enter");
      await expect(infoTab).toHaveAttribute("aria-selected", "true");
      await copy.scrollIntoViewIfNeeded();
      await expect(copy).toBeInViewport({ ratio: 1 });
      await panel.screenshot({
        path: info.outputPath(`profile-${mode}-${width}.png`),
      });
    }
  });
}
