import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true });

async function openMove(page, row) {
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const parent = page.getByRole("menuitem", {
    name: "Move channel",
    exact: true,
  });
  await expect(parent).toBeVisible();
  await parent.focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: "Move channel", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}
const rowIn = (page, section) =>
  page.locator(`[data-sidebar-section="${section}"] [data-channel-id="beta"]`);
const sidebar = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
// No saving UI is a completion signal: wait for the final confirmed Star command
// of each move (including no-op Star writes), not merely relay publication.
const confirmations = new WeakMap();
test.beforeEach(async ({ page }) => {
  const state = { completed: 0, expected: 0 };
  confirmations.set(page, state);
  page.on("requestfinished", async (request) => {
    if (
      new URL(request.url()).pathname.endsWith("/sidebar-star") &&
      (await request.response())?.ok()
    )
      state.completed++;
  });
});
async function saved(page, app, publications, moves = 1) {
  const state = confirmations.get(page);
  state.expected += moves;
  await expect.poll(() => state.completed).toBe(state.expected);
  await expect
    .poll(() => app.report.sidebarPublications?.length ?? 0)
    .toBe(publications);
  await expect(
    page.getByText("Saving sidebar changes…", { exact: true }),
  ).toHaveCount(0);
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Browser-owned keyboard nesting, portal geometry, and exclusive row/focus relocation.
// Record ordering, concurrency, bounds and cancellation matrices stay in Vitest.
test("row menu moves and removes a channel optimistically, retaining keyboard navigation and confirmed reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await beta.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions for Beta" });
  await expect(
    actions.getByRole("menuitem", { name: "New session", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: "Move channel", exact: true });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(
    menu.getByRole("menuitemradio", { name: "Work" }),
  ).toHaveAttribute("aria-checked", "true");
  // Checked state renders before Base UI transfers focus into the reopened
  // submenu. Establish keyboard ownership before sending its next command.
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Remove from Work" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Work" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Create new…" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(beta).toHaveCount(0);
  await saved(page, app, 1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});
  await openMove(page, rowIn(page, "channels"));
  await menu.getByRole("menuitemradio", { name: "Work" }).click();
  await expect(beta).toBeFocused();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await saved(page, app, 2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  await page.reload();
  await expect(beta).toBeVisible();

  // Clicking the checked group is the same remove intent, including rollback.
  await openMove(page, beta);
  const selected = menu.getByRole("menuitemradio", {
    name: "Work",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarAssignmentFailures ??= [];
    app.report.sidebarAssignmentFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Group removal failed; retry" }),
    });
  });
  try {
    await selected.click();
    await expect(rowIn(page, "channels")).toBeFocused();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(beta).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(rowIn(page, "channels")).toHaveCount(0);
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 3);
  expect(app.report.sidebarPublications.at(-1).blob.assignments).toEqual({});
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);

  // The built sidebar and broker share one queue: a pending section sort must
  // not conceal an optimistic Move, and both must survive confirmed reload.
  const openSort = async () => {
    await page
      .getByRole("button", { name: "More actions for Channels" })
      .click();
    await page.getByRole("menuitem", { name: "Sort", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    return page.getByRole("menu", { name: "Sort", exact: true });
  };
  const sortHeld = gate(),
    sortStarted = gate();
  await page.route("**/sidebar-sort", async (route) => {
    sortStarted.resolve();
    await sortHeld.promise;
    await route.continue();
  });
  const sorted = page.waitForResponse("**/sidebar-sort");
  const moved = page.waitForResponse("**/sidebar-star");
  try {
    const sortMenu = await openSort();
    await sortMenu.getByRole("menuitemradio", { name: "Recent" }).click();
    await sortStarted.promise;
    const moveMenu = await openMove(page, rowIn(page, "channels"));
    await moveMenu
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(beta).toBeFocused();
    await expect(rowIn(page, "channels")).toHaveCount(0);
    const pendingSort = await openSort();
    await expect(
      pendingSort.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    sortHeld.resolve();
  }
  for (const response of [await sorted, await moved]) {
    expect(response.ok()).toBe(true);
    await response.finished();
  }
  expect(
    app.report.sidebarPublications.find(
      ({ coordinate }) => coordinate === "channel-sort",
    ).blob.groups,
  ).toEqual({ channels: "recent" });
  await page.unroute("**/sidebar-sort");
  await page.reload();
  await expect(beta).toBeVisible();
  const restoredSort = await openSort();
  await expect(
    restoredSort.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("optimistic Star moves close the menu before the write, roll back with visible retry, and remove to Channels after reload", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const starred = rowIn(page, "starred");
  await expect(beta).toBeVisible();
  await page.locator('[data-sidebar-section="starred"] summary').click();
  const menu = await openMove(page, beta);
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "Actions for Beta", exact: true }),
  ).toHaveCSS("opacity", "1");
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: testInfo.outputPath("move-channel-menu.png"),
    clip: { x: 10, y: 50, width: 470, height: 470 },
  });
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-star", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  try {
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(starred).toBeFocused();
    await expect(beta).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(starred).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  // Failures live in the session, not in a menu or mounted Messages page.
  await openPage(page, "Projects");
  await openPage(page, "Messages");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(starred).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 1);
  await openMove(page, starred);
  await menu
    .getByRole("menuitem", { name: "Remove from Starred", exact: true })
    .click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.slice(1).map(({ coordinate }) => coordinate),
  ).toEqual(["channel-sections", "channel-stars"]);
  await page.reload();
  await expect(
    page.locator('[data-sidebar-section="starred"] [data-channel-id="alpha"]'),
  ).toBeVisible();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);
  await openMove(page, rowIn(page, "channels"));
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 4);
  await openMove(page, starred);
  await menu.getByRole("menuitemradio", { name: "Work", exact: true }).click();
  await expect(beta).toBeFocused();
  await saved(page, app, 6);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: { beta: "work" } },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await openMove(page, beta);
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 7);
  await openMove(page, starred);
  const selected = menu.getByRole("menuitemradio", {
    name: "Starred",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  await selected.focus();
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(starred).toHaveCount(0);
  await saved(page, app, 9);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: {} },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await expect(beta).toHaveCount(0); // Never restore the remembered Work assignment.
});

// Native keyboard activation and focus after disclosure/roster changes need a browser.
test("dismissing a failed move restores keyboard focus to its placement or a surviving row", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move" });
  await page.route("**/sidebar-star", async (route) => {
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  const failMove = async () => {
    const menu = await openMove(page, beta);
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await expect(error).toContainText("Relay request failed (502)");
    await expect(beta).toBeVisible();
  };
  const dismiss = async () => {
    await error.getByRole("button", { name: "Dismiss", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(error).toHaveCount(0);
  };
  await failMove();
  await page.locator('[data-sidebar-section="group:work"] summary').click();
  await expect(beta).toBeHidden();
  await dismiss();
  await expect(beta).toBeFocused();
  await expect(beta).toBeVisible();

  await failMove();
  // Upstream roster omission, not direct client-state injection.
  app.omitChannel("beta");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  await expect(beta).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await dismiss();
  await expect(
    sidebar(page).locator('[data-channel-id="alpha"]'),
  ).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
});

// Menu → native dialog → optimistic new-section focus must be checked in browsers.
test("Create new supports cancel, moves before publication, and retries the same section after partial failure", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await openMove(page, beta);
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(dialog.locator("p")).toHaveText("Move Beta into a new section.");
  await expect(dialog.locator("label")).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create and move" }),
  ).toBeDisabled();
  await field.fill("Cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(beta).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await openMove(page, beta);
  await page
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(rowIn(page, "starred")).toBeFocused();
  await saved(page, app, 1);
  await openMove(page, rowIn(page, "starred"));
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  await expect(field).toBeFocused();
  await field.fill("Launch");
  await dialog.screenshot({ path: testInfo.outputPath("create-section.png") });
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    await route.continue();
  });
  await page.route("**/sidebar-star", async (route) => {
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  let sectionId;
  try {
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await started.promise;
    await expect(dialog).toHaveCount(0);
    const createdGroup = sidebar(page)
      .locator("[data-sidebar-section]")
      .filter({ has: page.locator("summary", { hasText: /^Launch$/ }) });
    await expect(
      createdGroup.locator('[data-channel-id="beta"]'),
    ).toBeFocused();
    sectionId = (await createdGroup.getAttribute("data-sidebar-section")).slice(
      "group:".length,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications).toHaveLength(1); // No section write yet.
    await expect(rowIn(page, "starred")).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(rowIn(page, "starred")).toBeVisible();
  await expect(rowIn(page, `group:${sectionId}`)).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  const destination = rowIn(page, `group:${sectionId}`);
  await expect(destination).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.filter(
      ({ coordinate }) => coordinate === "channel-sections",
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(destination).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await sidebar(page).screenshot({
    path: testInfo.outputPath("created-section-reloaded.png"),
  });

  // A saved-group row can create another group directly; while that save is
  // held, the moved row can immediately move again to a different saved group.
  const nextHeld = gate(),
    nextStarted = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    nextStarted.resolve();
    await nextHeld.promise;
    await route.continue();
  });
  let followup;
  try {
    await openMove(page, destination);
    await page.getByRole("menuitem", { name: "Create new…" }).click();
    await field.fill("Follow-up");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await nextStarted.promise;
    const nextGroup = sidebar(page)
      .locator("[data-sidebar-section]")
      .filter({
        has: page.locator("summary", { hasText: /^Follow-up$/ }),
      });
    followup = rowIn(
      page,
      await nextGroup.getAttribute("data-sidebar-section"),
    );
    await expect(followup).toBeFocused();
    await expect(destination).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    const moving = await openMove(page, followup);
    await moving
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(beta).toBeFocused();
    await expect(followup).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    expect(app.report.sidebarPublications).toHaveLength(3);
  } finally {
    nextHeld.resolve();
  }
  await saved(page, app, 5, 2);
  await page.unroute("**/sidebar-assignment");
  await page.reload();
  await expect(beta).toBeVisible();
  // Existing group → another existing group needs no intermediate removal.
  const moving = await openMove(page, beta);
  await moving
    .getByRole("menuitemradio", { name: "Follow-up", exact: true })
    .click();
  await expect(followup).toBeFocused();
  await saved(page, app, 6);
  await page.reload();
  await expect(followup).toBeVisible();
  await expect(beta).toHaveCount(0);
});

// A modal can outlive the preference snapshot that admitted its launching menu.
// Real focus/modal behavior and retained user input need a browser regression.
test("Create new retains its draft when preferences fail before submission and recovers in place", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await beta.click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  const held = gate(),
    started = gate();
  const failLegacy = async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarPreferenceFailures ??= [];
    app.report.sidebarPreferenceFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Preferences unavailable" }),
    });
  };
  await page.route("**/sidebar-preferences", failLegacy);
  try {
    await page
      .getByRole("button", { name: "Refresh groups and stars", exact: true })
      .click();
    await started.promise;
    await openMove(page, beta);
    await page.getByRole("menuitem", { name: "Create new…" }).click();
    const dialog = page.getByRole("dialog", { name: "Create new section" });
    const field = dialog.getByRole("textbox", { name: "Section name" });
    await field.fill("Retained launch");
    const failed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/sidebar-preferences") &&
        r.status() === 502,
    );
    held.resolve();
    await failed;
    await expect(
      page.getByRole("dialog", {
        name: "Saved sidebar preferences couldn’t refresh",
      }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue("Retained launch");
    await expect(dialog.getByRole("alert")).toContainText("Retry preferences");
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    // Another failed recovery must keep both the draft and recovery action.
    const retryFailed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/sidebar-preferences") &&
        response.status() === 502,
    );
    await dialog
      .getByRole("button", { name: "Retry preferences", exact: true })
      .click();
    await retryFailed;
    await expect(
      dialog.getByRole("button", { name: "Retry preferences", exact: true }),
    ).toBeEnabled();
    await expect(field).toHaveValue("Retained launch");
    await page.unroute("**/sidebar-preferences", failLegacy);
    await dialog
      .getByRole("button", { name: "Retry preferences", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(field).toHaveValue("Retained launch");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).toHaveCount(0);
    const destination = sidebar(page)
      .locator("[data-sidebar-section]")
      .filter({
        has: page.locator("summary", { hasText: /^Retained launch$/ }),
      })
      .locator('[data-channel-id="beta"]');
    await expect(destination).toBeFocused();
    await saved(page, app, 1);
    await page.reload();
    await expect(destination).toBeVisible();
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
  } finally {
    held.resolve();
    await page.unroute("**/sidebar-preferences", failLegacy);
  }
});

test.use({
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 1 },
});
test("Projects → Messages keeps saved groups, selected channel, and scroll on every visible frame without re-decoding", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect(
    sidebar.locator("summary", { hasText: /Starred$/ }),
  ).toBeVisible();
  await sidebar.locator('button[data-channel-id="beta"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = 1000;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await openPage(page, "Projects");
  await expect(sidebar).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let decodes = 0;
  await page.route("**/sidebar-preferences", async (route) => {
    decodes++;
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.sidebarFrames = [];
    window.captureSidebar = true;
    const frame = () => {
      const list = document.querySelector(
        'nav[aria-label="Subscribed channels"]',
      );
      if (list)
        window.sidebarFrames.push({
          top: list.scrollTop,
          groups: Array.from(list.querySelectorAll("summary"), (el) =>
            el.textContent.replace("★", "").trim(),
          ),
        });
      if (window.captureSidebar) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  try {
    await openPage(page, "Messages");
    await expect(sidebar).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    // Wall time does not guarantee RAF callbacks on a busy runner. Wait for
    // samples, not correct samples: every earlier frame stays in the assertion.
    // The decode path stays held until finally, across all sampled frames.
    await page.waitForFunction(() => window.sidebarFrames.length > 3);
    const frames = await page.evaluate(() => {
      window.captureSidebar = false;
      return window.sidebarFrames;
    });
    expect(frames.length).toBeGreaterThan(3);
    expect(
      frames.filter(
        (frame) =>
          !frame.groups.includes("Work") ||
          !frame.groups.includes("Starred") ||
          Math.abs(frame.top - scroll) > 1,
      ),
      "No fallback grouping or top-of-list frame on warm return",
    ).toEqual([]);
    expect(
      decodes,
      "Page return must reuse the engine snapshot, not fetch/decode again",
    ).toBe(0);
  } finally {
    release();
    await page.unroute("**/sidebar-preferences");
  }
});

// Proves menu/dialog -> real encrypted recipe writer -> sidebar/reload integration.
// Source switches and failure matrices remain in session tests.
test.describe("new personal schema", () => {
  test.use({ personalSidebar: true, largeSidebar: false });
  // A healthy personal catalog must not depend on the unused legacy group decoder.
  // Exercise actual page projection, menu gating and explicit recovery together.
  test("personal groups survive cold and retained legacy failures without enabling moves", async ({
    page,
    app,
  }) => {
    let personalDecoded = false;
    page.on("response", async (response) => {
      if (
        new URL(response.url()).pathname.endsWith("/channel-kit-decode") &&
        response.ok()
      ) {
        const rows = await response.json();
        if (rows.some((row) => row.record?.value?.type === "groups"))
          personalDecoded = true;
      }
    });
    const failLegacy = async (route) => {
      app.report.sidebarPreferenceFailures ??= [];
      app.report.sidebarPreferenceFailures.push(route.request().url());
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid sidebar group head" }),
      });
    };
    await page.route("**/sidebar-preferences", failLegacy);
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect.poll(() => personalDecoded).toBe(true);
    const id = "11111111-1111-4111-8111-111111111111";
    const personal = page.locator(
      `[data-sidebar-section="group:personal-work"] [data-channel-id="${id}"]`,
    );
    const failure = page.getByRole("dialog", {
      name: "Saved sidebar preferences couldn’t refresh",
    });
    await expect(failure).toBeVisible();
    await expect(personal).toBeVisible();
    await expect(
      page.locator('[data-sidebar-section="group:personal-work"] summary'),
    ).toContainText("Personal work");
    await personal.focus();
    await page.keyboard.press("Shift+F10");
    await expect(
      page.getByRole("menuitem", { name: "Move channel", exact: true }),
    ).toHaveCount(0);
    // Sessions remains independently eligible when group writes are unavailable.
    const actions = page.getByRole("menu", { name: `Actions for ${id}` });
    await expect(
      actions.getByRole("menuitem", { name: "New session", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    await page.unroute("**/sidebar-preferences", failLegacy);
    await failure.getByRole("button", { name: "Retry", exact: true }).click();
    const alpha = page.locator(
      '[data-sidebar-section="starred"] [data-channel-id="alpha"]',
    );
    // Retry removes the toast while the read is still loading. Restored stars
    // prove that the successful snapshot (and writable row wrapper) has rendered.
    await expect(alpha).toBeVisible();
    await openMove(page, personal);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.route("**/sidebar-preferences", failLegacy);
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await page.getByText("Diagnostics", { exact: true }).click();
    await page
      .getByRole("button", { name: "Refresh groups and stars", exact: true })
      .click();
    await expect(failure).toBeVisible();
    await expect(personal).toBeVisible();
    await expect(alpha).toBeVisible(); // Retain last-confirmed stars, not an empty successful read.
    await personal.focus();
    await page.keyboard.press("Shift+F10");
    await expect(
      page.getByRole("menuitem", { name: "Move channel", exact: true }),
    ).toHaveCount(0);
    // Sessions remains independently eligible when group writes are unavailable.
    const retainedActions = page.getByRole("menu", {
      name: `Actions for ${id}`,
    });
    await expect(
      retainedActions.getByRole("menuitem", {
        name: "New session",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(retainedActions).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    await page.unroute("**/sidebar-preferences", failLegacy);
    await failure.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Refresh groups and stars",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(failure).toHaveCount(0);
    await page.getByRole("button", { name: "Close channel settings" }).click();
    const menu = await openMove(page, personal);
    await menu
      .getByRole("menuitem", { name: "Remove from Personal work", exact: true })
      .click();
    await saved(page, app, 1);
    await page.reload();
    await expect(
      page.locator(
        `[data-sidebar-section="channels"] [data-channel-id="${id}"]`,
      ),
    ).toBeVisible();
    expect(
      app.report.sidebarPublications.every(
        ({ coordinate }) => coordinate !== "channel-sections",
      ),
    ).toBe(true);
  });
  test("Move/Create/Star use the displayed personal store and retain its schema", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const id = "11111111-1111-4111-8111-111111111111";
    const row = () => sidebar(page).locator(`[data-channel-id="${id}"]`);
    const placed = (key) =>
      page.locator(`[data-sidebar-section="${key}"] [data-channel-id="${id}"]`);
    await expect(placed("group:personal-work")).toBeVisible();
    await expect(
      page.locator('[data-sidebar-section="group:personal-work"] summary'),
    ).toContainText("Personal work");
    // Legacy beta placement must not leak into the active group.
    await expect(rowIn(page, "channels")).toBeVisible();
    let menu = await openMove(page, row());
    await menu.getByRole("menuitem", { name: "Create new…" }).click();
    const dialog = page.getByRole("dialog", { name: "Create new section" });
    const name = dialog.getByRole("textbox");
    await expect(name).toHaveAttribute("maxlength", "120");
    await name.fill("Personal launch");
    await dialog
      .getByRole("button", { name: "Create and move", exact: true })
      .click();
    await expect(row()).toBeFocused();
    await saved(page, app, 1);
    const publication = app.report.sidebarPublications[0];
    expect(publication.coordinate).toContain("buzz-channel-kit-v1:");
    const record = publication.blob.value;
    expect(record.groups[0]).toEqual({
      id: "personal-work",
      name: "Personal work",
      defaultTemplateId: "template",
    });
    const created = record.groups.find(
      (group) => group.name === "Personal launch",
    );
    expect(created).toEqual({
      id: expect.any(String),
      name: "Personal launch",
      defaultTemplateId: "",
    });
    await expect(placed(`group:${created.id}`)).toBeVisible();
    await page.reload();
    await expect(placed(`group:${created.id}`)).toBeVisible();
    menu = await openMove(page, row());
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await expect(placed("starred")).toBeFocused();
    await saved(page, app, 2);
    // Personal records are second-granularity replaceable events. Control the
    // next save's clock rather than depending on reload/interaction taking >1s.
    await page.clock.setFixedTime(
      new Date((publication.event.created_at + 2) * 1000),
    );
    menu = await openMove(page, row());
    await menu.getByRole("menuitem", { name: "Remove from Starred" }).click();
    await expect(placed("channels")).toBeFocused();
    await saved(page, app, 4);
    expect(
      app.report.sidebarPublications.some(
        ({ coordinate }) => coordinate === "channel-sections",
      ),
    ).toBe(false);
    await page.reload();
    await expect(placed("channels")).toBeVisible();
    await expect(row()).toHaveCount(1);
  });
});

// Browser-owned integration: app-level plugin toggles, the persistent sidebar's
// menu/dialog portals, and encrypted saves while Messages is not mounted.
test("Move and Create stay available on Projects with Sessions disabled", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page
    .getByRole("region", { name: "Plugins", exact: true })
    .getByRole("switch", { name: "Enable Sessions", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await openPage(page, "Projects");
  const projects = page.getByRole("heading", { name: "Projects", exact: true });
  await expect(projects).toBeVisible();
  const node = await sidebar(page).elementHandle();
  const menu = await openMove(page, rowIn(page, "group:work"));
  const actions = page.getByRole("menu", {
    name: "Actions for Beta",
    exact: true,
  });
  await expect(
    actions.getByRole("menuitem", { name: "New session", exact: true }),
  ).toHaveCount(0);
  await expect(
    actions.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await menu
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  await dialog.getByRole("textbox").fill("Off-page group");
  await dialog
    .getByRole("button", { name: "Create and move", exact: true })
    .click();
  await saved(page, app, 1);
  const section = app.report.sidebarPublications[0].blob.sections.find(
    ({ name }) => name === "Off-page group",
  );
  await expect(rowIn(page, `group:${section.id}`)).toBeFocused();
  await expect(projects).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await page.reload();
  await expect(projects).toBeVisible();
  await expect(rowIn(page, `group:${section.id}`)).toBeVisible();
});
