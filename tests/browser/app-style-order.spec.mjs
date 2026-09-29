import { test, expect } from "./source-fixture.mjs";

// A browser must resolve the real app's CSS cascade; source import order and
// jsdom cannot prove that the shared control still owns its hover treatment.
test("app startup preserves shared search control styling and interaction", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("button", { name: "Search Buzz", exact: true });
  await expect(search).toBeVisible();
  // Deliberately vary the shared role: a copied feature-level color must fail.
  await page.locator("html").evaluate((element) => {
    element.style.setProperty("--bg-glass-primary-hover", "rgb(123, 45, 67)");
  });
  await search.hover();
  await expect(search).toHaveCSS("background-color", "rgb(123, 45, 67)");
  await search.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await expect(
    dialog.getByRole("combobox", { name: "Search Buzz" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(search).toBeFocused();
});
