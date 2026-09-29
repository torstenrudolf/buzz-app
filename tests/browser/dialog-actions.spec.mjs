import { test, expect } from "./fixture.mjs";

// Real font metrics, footer overflow and native focus scrolling require browsers.
test.use({ historyCounts: { alpha: 0, beta: 0 } });

test("community dialog keeps oversized actions intact, reachable and keyboard operable", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    localStorage.setItem("buzz-appearance.v1", "dark");
  });
  await page.route("**/api/relay/secondary/info", (route) =>
    route.fulfill({ json: { name: "Secondary", policy: null } }),
  );
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Add a community", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Relay URL", exact: true })
    .fill("wss://secondary.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Your profile in Secondary",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Updated profile");
  const action = dialog.getByRole("button", {
    name: "Publish profile & open",
    exact: true,
  });
  const actions = dialog.locator(".buzz-dialog-actions");
  await expect(action).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);

  for (const [scale, mode] of [
    [1, "light"],
    [2, "light"],
    [2, "dark"],
  ]) {
    // Exercise the host's supported cross-window preference restore, not a CSS override.
    await page.evaluate(
      ({ scale, mode }) => {
        localStorage.setItem("buzz-font-scale.v1", String(scale));
        localStorage.setItem("buzz-appearance.v1", mode);
        window.dispatchEvent(
          new StorageEvent("storage", { key: null, storageArea: localStorage }),
        );
      },
      { scale, mode },
    );
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1280, 800, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(action).toHaveCSS("font-size", `${14 * scale}px`);
      await expect
        .poll(() =>
          action.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(
              button.querySelector(".buzz-button-label"),
            );
            const lines = [...range.getClientRects()];
            return (
              lines.length === 1 &&
              lines.every(
                (line) =>
                  line.left >= box.left &&
                  line.right <= box.right &&
                  line.top >= box.top &&
                  line.bottom <= box.bottom,
              )
            );
          }),
        )
        .toBe(true);
    }
  }
  await expect
    .poll(() => actions.evaluate((node) => node.scrollWidth > node.clientWidth))
    .toBe(true);
  await actions.scrollIntoViewIfNeeded();
  for (const edge of ["start", "end"]) {
    await actions.evaluate((node, edge) => {
      node.scrollLeft = edge === "start" ? 0 : node.scrollWidth;
    }, edge);
    await expect
      .poll(() =>
        action.evaluate((button, edge) => {
          const box = button.getBoundingClientRect();
          const footer = button.closest(".buzz-dialog-actions");
          const bounds = footer.getBoundingClientRect();
          const dialog = footer
            .closest('[role="dialog"]')
            .getBoundingClientRect();
          return (
            bounds.left >= dialog.left &&
            bounds.right <= dialog.right &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            (edge === "start"
              ? box.left >= bounds.left - 1
              : box.right <= bounds.right + 1)
          );
        }, edge),
      )
      .toBe(true);
    await actions.screenshot({
      path: info.outputPath(`dialog-actions-320-200-dark-${edge}.png`),
    });
  }
  // Tab through the real footer, not programmatically focusing the submit action.
  await dialog
    .getByRole("textbox", {
      name: "Profile description (optional)",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  await expect
    .poll(() =>
      action.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const bounds = button
          .closest(".buzz-dialog-actions")
          .getBoundingClientRect();
        return (
          box.right > bounds.left &&
          box.left < bounds.right &&
          box.top >= 0 &&
          box.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  const published = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/relay/secondary/profile") &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await published).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Switch to Secondary", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});
