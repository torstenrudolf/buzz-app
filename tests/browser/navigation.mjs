import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name, { connected = true } = {}) {
  // The community rail appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: "Switch to Primary", exact: true }),
  ).toBeVisible();
  await pageChoices(page);
  await selectPage(page, name, { connected });
}

// Select from an already-open palette, including tests that inspect page order.
export async function selectPage(page, name, { connected = true } = {}) {
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const choice = dialog
    .getByRole("group", { name: "Actions", exact: true })
    .getByRole("option", { name, exact: true });
  // Registered page actions are visible only after the plugin catalog is ready.
  await expect(choice).toBeVisible();
  // Until the community connects, the palette is a placeholder. The connected
  // palette replaces it, which resets selection and option ids, so select only
  // in the final palette. Pass `connected: false` when the test holds or fails
  // the relay session: the placeholder then stays.
  await expect(
    dialog.getByText("Connecting to this community…", { exact: true }),
  ).toHaveCount(connected ? 0 : 1);
  // Conversation groups above Actions arrive with the channel list and move
  // every row below them, so a pointer click can land between rows. Keyboard
  // selection follows the choice itself, not its position.
  const id = await choice.getAttribute("id");
  const limit = await dialog.getByRole("option").count();
  for (
    let step = 0;
    (await input.getAttribute("aria-activedescendant")) !== id;
    step++
  ) {
    // Rows that arrive later are inserted above the selection, so moving down
    // still reaches the choice. The bound only turns a regression into a failure.
    expect(step, `keyboard reaches ${name}`).toBeLessThan(limit + 16);
    await input.press("ArrowDown");
  }
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
}

export async function selectSettingsSection(page, name) {
  await expect(
    page.locator("[data-shell-sidebar-toggle]"),
  ).toHaveAccessibleName(
    page.viewportSize().width <= 650
      ? /^(Show|Hide) navigation$/
      : /^(Show|Hide) Channel sidebar$/,
  );
  const show = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole("complementary", { name: "Settings sidebar", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
}
