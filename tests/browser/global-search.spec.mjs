import { test, expect } from "./fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
test("search arrows traverse the conversation action and recent activity, Enter opens and Escape restores focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = button(page, "Search Buzz");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toHaveAttribute("spellcheck", "false");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toBeFocused();
  const first = dialog
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  const second = dialog
    .getByRole("group", { name: "Recent activity" })
    .getByRole("option")
    .first();
  await expect(second).toBeVisible();
  for (const [key, result] of [
    ["ArrowDown", first],
    ["ArrowDown", second],
    ["ArrowUp", first],
    ["ArrowUp", first],
  ]) {
    await input.press(key);
    await expect(input).toBeFocused();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect(result).toHaveAttribute("data-selected", "true");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await result.getAttribute("id"),
    );
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Alpha");
  const alpha = dialog
    .getByRole("group", { name: "Channels" })
    .getByRole("option", { name: /Alpha/ });
  await expect(alpha).toBeVisible();
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await alpha.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("changing search scope returns focus to the input without clearing the query", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const scopeAction = page
    .getByRole("dialog", { name: "Search Buzz" })
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  await scopeAction.click();

  const scoped = page.getByRole("dialog", { name: "Search this conversation" });
  const scopedInput = scoped.getByRole("combobox", {
    name: "Search this conversation",
  });
  await expect(scopedInput).toBeFocused();
  await page.keyboard.type("hello");
  await expect(scopedInput).toHaveValue("hello");

  const chip = scoped.getByRole("button", {
    name: /Remove .* search scope/,
  });
  await chip.focus();
  await chip.press("Enter");
  const global = page.getByRole("dialog", { name: "Search Buzz" });
  const input = global.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("hello");
  await page.keyboard.press("ArrowDown");
  await expect(
    global
      .getByRole("group", { name: "This conversation" })
      .getByRole("option"),
  ).toHaveAttribute("aria-selected", "true");
});

// Real portal → routed timeline/thread ownership and focus, in both browser engines.
test.describe("public search destination", () => {
  test.use({ openSearch: true, productionBroker: true });
  test("opens a public nonmember exact reply without enabling writes or adding a sidebar row", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect(button(page, "Search Buzz")).toBeVisible();
    for (const mode of ["cold", "warm"]) {
      await button(page, "Search Buzz").click();
      const input = page.getByRole("combobox", { name: "Search Buzz" });
      await input.fill("crew-search");
      const result = page.getByRole("option", {
        name: /crew-search exact public reply/,
      });
      await expect(result).toBeVisible();
      const start = performance.now();
      await result.click();
      const thread = page.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const row = thread.locator(`[data-message-id="${app.searchTarget.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toBeFocused();
      app.report.measurements.push({
        mode,
        clickToFocusedMs: performance.now() - start,
      });
      await expect(
        page.getByText(
          "Read-only preview · You haven’t joined this conversation.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message #open", exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(
        page
          .getByRole("complementary", { name: "Channel sidebar" })
          .getByRole("button", { name: "open", exact: true }),
      ).toHaveCount(0);
    }
    expect(
      app.report.queries
        .filter(({ filter }) => filter.search)
        .every(({ filter }) => !filter["#h"]),
    ).toBe(true);
  });
});

test("keyboard selection follows its action while recent conversations arrive above it", async ({
  page,
  app,
}) => {
  const rail = page.getByRole("button", {
    name: "Switch to Primary",
    exact: true,
  });
  // Hold startup membership before navigation so the channel list arrives after
  // the palette opens. A reload here can retire a live stream while its initial
  // control request is still in flight; that race is unrelated to selection.
  const held = [];
  let holding = true;
  await page.route("**/api/relay/*/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (holding && filters.some(({ kinds }) => kinds?.includes(39002)))
      await new Promise((resolve) => held.push(resolve));
    await route.continue();
  });
  try {
    await page.goto(app.origin);
    await expect(rail).toBeVisible();
    await button(page, "Search Buzz").click();
    const dialog = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    const input = dialog.getByRole("combobox", { name: "Search Buzz" });
    const recent = dialog
      .getByRole("group", { name: "Recent activity" })
      .getByRole("option");
    const projects = dialog
      .getByRole("group", { name: "Actions" })
      .getByRole("option", { name: "Projects", exact: true });
    await expect(projects).toBeVisible();
    // The connected palette is mounted, but its channel list is still held.
    await expect(
      dialog.getByText("Connecting to this community…", { exact: true }),
    ).toHaveCount(0);
    await expect(recent).toHaveCount(0);
    const id = await projects.getAttribute("id");
    while ((await input.getAttribute("aria-activedescendant")) !== id)
      await input.press("ArrowDown");
    const before = await projects.boundingBox();
    holding = false;
    for (const resolve of held.splice(0)) resolve();
    await expect(recent.first()).toBeVisible();
    // The arrivals moved the action; the selection stays with it.
    expect((await projects.boundingBox()).y).toBeGreaterThan(before.y);
    await expect(input).toHaveAttribute("aria-activedescendant", id);
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
  } finally {
    holding = false;
    for (const resolve of held.splice(0)) resolve();
  }
});
