import { test as base, expect } from "./fixture.mjs";
import { streamEvidence } from "./stream-evidence.mjs";
import { open } from "./timeline.mjs";

// Preserve the failing handoff and capture original-reader delivery on Linux.
const test = base.extend({
  streamEvidence: [streamEvidence, { auto: true }],
});
test.use({
  productionBroker: true,
  readState: true,
  largeSidebar: true,
  sidebarUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
});
const sidebar = (page) =>
  page.getByRole("complementary", { name: "Channel sidebar", exact: true });
const list = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
const cue = (page, edge) =>
  sidebar(page).locator(`button[data-edge="${edge}"]`);
const row = (page, id) =>
  list(page).locator(`button[data-channel-id="${id.toLowerCase()}"]`);
const removeDm = async (page, id) => {
  const dm = row(page, id);
  await dm.click({ button: "right" });
  const menu = page.getByRole("menu", { name: /Actions for / });
  const remove = menu.getByRole("menuitem", {
    name: "Remove from Messages",
    exact: true,
  });
  await expect(remove).toBeVisible();
  await remove.click();
};
const scroll = (page, top) =>
  list(page).evaluate((el, top) => {
    el.scrollTop = top;
  }, top);
const scrollRowAbove = (page, id) =>
  row(page, id).evaluate((el) => {
    const viewport = el.closest("nav");
    if (!viewport) throw new Error("Channel row is outside the channel list");
    const rowRect = el.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    viewport.scrollTop += rowRect.bottom - viewportRect.top + 1;
  });
const inView = (page, id) =>
  row(page, id).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const viewport = el.closest("nav").getBoundingClientRect();
    return (
      rect.height > 0 &&
      rect.top >= viewport.top &&
      rect.bottom <= viewport.bottom
    );
  });
const heads = (app) =>
  app.report.queries.filter(
    ({ filter }) => filter.kinds?.includes(9) && filter["#h"]?.length === 1,
  );

test("DM hide control removes a row and a new message restores it", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const dm = row(page, "dm-030");
  await expect(dm).toBeVisible();
  const badge = dm.locator("[data-channel-unread]");
  await expect(badge).toBeVisible();
  const badgePosition = () =>
    dm.evaluate((button) => {
      const badge = button.querySelector("[data-channel-unread]");
      if (!badge) throw new Error("DM unread indicator is missing");
      const row = button.getBoundingClientRect();
      const marker = badge.getBoundingClientRect();
      return { x: marker.x - row.x, y: marker.y - row.y };
    });
  const before = await badgePosition();
  const container = dm.locator("xpath=ancestor::*[@data-channel-sidebar-row]");
  await container.screenshot({ path: info.outputPath("dm-row-default.png") });
  await dm.hover();
  await container.screenshot({ path: info.outputPath("dm-row-hover.png") });
  const after = await badgePosition();
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  await removeDm(page, "dm-030");
  await expect(dm).toHaveCount(0);
  await expect(list(page).locator("button[data-channel-id]:focus")).toHaveCount(
    1,
  );
  await page.reload();
  await expect(row(page, "dm-031")).toBeVisible();
  await expect(dm).toHaveCount(0);

  // Cached paint is intentionally earlier than fresh live subscription ownership.
  await expect.poll(() => app.relay.hasRoute("primary", "dm-030")).toBe(true);
  app.append("primary", "dm-030", "A new live DM", true, false);
  await expect(dm).toBeVisible();
  await dm.hover();
  await removeDm(page, "dm-030");
  await expect(dm).toHaveCount(0);
  app.append("primary", "dm-030", "A DM missed while closed", false, false);
  await page.reload();
  await expect(row(page, "dm-031")).toBeVisible();
  await expect(dm).toBeVisible();
});

test("channel establishment preserves an in-flight unread batch and its sidebar badges", async ({
  page,
  app,
}) => {
  const alphaHeads = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter["#h"]?.[0] === "alpha" &&
        filter.top_level === true &&
        filter.until === undefined,
    );
  const evidence = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter.kinds?.includes(9) &&
        filter["#h"]?.length &&
        filter.top_level === undefined &&
        filter.depth_limit === undefined &&
        filter.until === undefined,
    );
  app.relay.holdEose("alpha");
  app.relay.holdUnread();
  try {
    await open(page, app);
    await expect.poll(() => app.report.unreadHolds.length).toBe(1);
    expect(evidence()[0].filter["#h"]).toContain("alpha");
    expect(evidence()[0].filter["#h"]).toContain("dm-090");
    expect(alphaHeads()).toHaveLength(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(0);

    // Establish only after unread is in flight; observe the real finite catch-up
    // before releasing evidence. No sleep or scheduler luck creates the overlap.
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
    expect(app.report.unreadHolds).toEqual([{ pending: true, aborted: false }]);
    app.relay.releaseUnread();
    await expect(row(page, "dm-030").getByRole("img")).toHaveCount(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
    await expect(cue(page, "below")).toBeVisible();
    await expect.poll(() => evidence().length).toBe(2); // 130 IDs, not retries.
    expect(evidence().map(({ filter }) => filter["#h"].length)).toEqual([
      128, 2,
    ]);
    expect(app.report.unreadHolds).toEqual([
      { pending: false, aborted: false },
    ]);
    expect(app.report.readPublications).toEqual([]);
  } finally {
    app.relay.releaseEose("alpha");
    app.relay.releaseUnread();
  }
});

test("edge pills follow scroll and reveal the nearest unread without selection or reads; focus retains existing preparation", async ({
  page,
  app,
}, info) => {
  // Visible rows can precede the post-establishment catch-up. Force that late
  // ordering, then account for its head read before measuring cue-triggered work.
  app.relay.holdEose("alpha");
  try {
    await open(page, app);
    const alphaHeads = () =>
      heads(app).filter(
        ({ community, filter }) =>
          community === "primary" &&
          filter["#h"][0] === "alpha" &&
          filter.top_level === true &&
          filter.until === undefined,
      );
    expect(alphaHeads()).toHaveLength(1);
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
  } finally {
    app.relay.releaseEose("alpha");
  }
  const ordinary = row(page, "alpha");
  await expect(ordinary).toHaveAttribute("aria-current", "page");
  const ordinaryState = ordinary.locator("[data-channel-unread]");
  const directed = row(page, "dm-090").locator("[data-channel-priority]");
  await expect(ordinaryState).toHaveAttribute("data-priority", "false");
  await expect(ordinaryState).toHaveAttribute(
    "aria-label",
    /observed unread messages/,
  );
  await expect(ordinary.locator("[data-channel-priority]")).toHaveCount(0);
  await expect(ordinary.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "600",
  );
  await expect(directed).toBeVisible();
  await expect(directed).toHaveCSS("width", "6px");
  await expect(
    row(page, "dm-090").locator("[data-channel-unread]"),
  ).toHaveAttribute("data-priority", "true");
  await expect(
    row(page, "dm-090").locator("[data-channel-dm-avatar]"),
  ).toHaveCount(0);
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await sidebar(page).screenshot({
    path: info.outputPath("sidebar-unread-hierarchy.png"),
  });
  await expect(cue(page, "below")).toBeVisible();
  await expect(cue(page, "below")).toHaveText("Unread");
  await expect(cue(page, "below")).toHaveAccessibleName("Unread below");
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  const transitionProperties = await cue(page, "below").evaluate((el) =>
    getComputedStyle(el).transitionProperty.split(", "),
  );
  expect(transitionProperties).toEqual(["background-color", "color"]);
  await expect(cue(page, "above")).toHaveCount(0);
  // Keep actionable DMs below while moving only ordinary unread above: priority
  // is derived from the destinations on each edge, not from the whole roster.
  await scrollRowAbove(page, "alpha");
  await expect.poll(() => inView(page, "alpha")).toBe(false);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "above")).toHaveText("Unread");
  await expect(cue(page, "above")).toHaveAccessibleName("Unread above");
  await expect(cue(page, "above")).toHaveAttribute("data-attention", "false");
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await scroll(page, 0);
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await scroll(page, 1800);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "below")).toBeVisible();
  const before = heads(app).length;
  const size = await list(page).boundingBox();
  await sidebar(page).screenshot({
    path: info.outputPath("sidebar-unread-both.png"),
  });
  await cue(page, "above").focus();
  await cue(page, "above").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  await expect(row(page, "dm-030")).not.toHaveAttribute("aria-current");
  // The edge cue reveals and focuses without changing the selected conversation.
  await expect(list(page).locator('[aria-current="page"]')).toHaveAttribute(
    "data-channel-id",
    "alpha",
  );
  // Barrier: focusing the revealed row prepares it and requests its head.
  // The owner allows one speculative read with no backlog, so the next reveal
  // may legitimately skip its own read while this one is in flight.
  await expect
    .poll(() =>
      heads(app)
        .slice(before)
        .map(({ filter }) => filter["#h"][0]),
    )
    .toContain("dm-030");
  await cue(page, "below").focus();
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-090")).toBe(true);
  await expect(cue(page, "below")).toHaveCount(0);
  expect(await list(page).boundingBox()).toEqual(size); // Overlay never resizes the list.
  const warmed = heads(app)
    .slice(before)
    .map(({ filter }) => filter["#h"][0]);
  // A revealed channel is read at most once. Scroll and cue interactions never
  // add a repeated read.
  expect(new Set(warmed).size).toBe(warmed.length);
  expect(app.report.readPublications).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("buzz-read-state-v1", 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("partitions", "readonly");
            const read = tx.objectStore("partitions").getAll();
            read.onsuccess = () => resolve(read.result[0].state.frontiers);
            tx.oncomplete = () => db.close();
          };
        }),
    ),
  ).toEqual({});
  // Use the real wheel, too; programmatic reveal and direct gestures share updates.
  await list(page).hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, -10000);
  await expect(cue(page, "above")).toHaveCount(0);
  await expect(cue(page, "below")).toBeVisible();
  await page.getByRole("button", { name: "Search Buzz", exact: true }).focus();
  await page.keyboard.press("Tab"); // Set keyboard modality from visible chrome, not an offscreen row.
  await cue(page, "below").focus();
  await expect(cue(page, "below")).toHaveCSS("outline-width", "2px");
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  if (info.project.name === "chromium") {
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: /Actions for / });
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row(page, "dm-030")).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(row(page, "dm-030")).toHaveAttribute("aria-current", "page");
});

test("resizing, collapsed groups and new unread evidence update only the displayed roster", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  await expect(cue(page, "below")).toBeVisible();
  // Messages are hidden behind a visible section summary: not below the scroll fold.
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .click();
  // Channels are collapsed, but unread DMs remain eligible and keep the cue.
  await expect(cue(page, "below")).toBeVisible();
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .click();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  // Collapse the preceding group without scrolling it into view first.
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .evaluate((el) => el.click());
  await expect(cue(page, "above")).toBeVisible();
  await cue(page, "above").click();
  await expect.poll(() => inView(page, "Beta")).toBe(true);
  await expect(list(page).locator("details").first()).toHaveAttribute(
    "open",
    "",
  );
  const controlledContent = await list(page)
    .locator("details")
    .first()
    .locator("summary")
    .getAttribute("aria-controls");
  await expect(page.locator(`[id="${controlledContent}"]`)).not.toHaveAttribute(
    "inert",
  );
  await expect(row(page, "Beta")).toBeFocused();
  await expect(row(page, "Beta")).toBeEnabled();
  const channelsSummary = list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  await channelsSummary.focus();
  await page.keyboard.press("Tab");
  await expect(
    list(page).getByRole("button", { name: "More actions for Channels" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  // Disabled header actions are skipped; traversal still reaches rows only
  // after the available header controls.
  await expect(row(page, "Alpha")).toBeFocused();
  // A tall viewport makes every row visible; shrinking restores the bottom cue.
  await scroll(page, 0);
  await page.setViewportSize({ width: 1440, height: 6000 });
  await expect(cue(page, "below")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(cue(page, "below")).toBeVisible();
  await cue(page, "below").click();
  await cue(page, "below").click();
  await expect(cue(page, "below")).toHaveCount(0);
  app.append("primary", "dm-127", "New offscreen unread", false, false);
  // Non-active channels have no live content route. Discover the new evidence
  // through the existing bounded refresh, not by inventing a subscription.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page.getByText("Unread status", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh unread observations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(cue(page, "below")).toBeVisible();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-127")).toBe(true);
  // Source badges disappear on an explicit read, and the edge cue follows.
  await row(page, "dm-127").click();
  await expect(
    page.getByText("New offscreen unread", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect(row(page, "dm-127").getByRole("img")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await scroll(page, 2700);
  await expect(cue(page, "below")).toHaveCount(0);
});

test("session changes discard the previous sidebar targets and manual unread still participates", async ({
  page,
  app,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pendingRoutes = [];
  await page.route("**/api/relay/secondary/sidebar-preferences", (route) => {
    const pending = held.then(() => route.continue());
    pendingRoutes.push(pending);
    return pending;
  });
  try {
    await open(page, app);
    await expect(cue(page, "below")).toBeVisible();
    await page
      .getByRole("button", { name: "Switch to Secondary", exact: true })
      .click();
    await expect(
      page.getByText(/secondary alpha message/).first(),
    ).toBeVisible();
    await expect(cue(page, "below")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await page.getByText("Diagnostics", { exact: true }).click();
    await page
      .getByRole("button", { name: "Mark unread on this device", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await expect.poll(() => pendingRoutes.length).toBeGreaterThan(0);
    const panel = page.getByRole("complementary", { name: "Channel sidebar" });
    await expect(panel).toHaveAttribute("aria-busy", "true");
    // A new session reveals its roster after the bounded startup wait even if
    // preferences are still blocked. Scrolling the empty loading view is a no-op.
    await expect(row(page, "alpha")).toBeVisible();
    await expect(
      page.getByText("Updating sidebar details…", { exact: true }),
    ).toHaveCount(0);
    await scroll(page, 1800);
    await expect(cue(page, "above")).toBeVisible();
    // Completing delayed preferences must not replace the user's newer viewport.
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/relay/secondary/sidebar-preferences") &&
        response.ok(),
    );
    release();
    await refreshed;
    await expect(panel).not.toHaveAttribute("aria-busy", "true");
    expect(await list(page).evaluate((element) => element.scrollTop)).toBe(
      1800,
    );
    await cue(page, "above").click();
    await expect.poll(() => inView(page, "alpha")).toBe(true);
    await expect(
      row(page, "alpha").locator(
        '[data-channel-unread][data-priority="false"]',
      ),
    ).toBeAttached();
  } finally {
    release();
    await Promise.all(pendingRoutes);
    await page.unroute("**/api/relay/secondary/sidebar-preferences");
  }
});

test("priority dots stay aligned and use semantic primary color in both modes", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const dot = row(page, "dm-030").locator("[data-channel-priority]");
  await expect(dot).toBeAttached();
  // Browser layout must center the visible dot, reserve label space, and keep
  // it inside the inset row highlight at both supported sidebar widths.
  for (const width of [260, 220]) {
    await sidebar(page).evaluate((element, width) => {
      element.closest(".shell-sidebar").style.width = `${width}px`;
    }, width);
    await expect
      .poll(() =>
        dot.evaluate((element) => {
          const button = element.closest("button[data-channel-id]");
          const row = element.closest("[data-channel-sidebar-row]");
          const marker = element.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          const fill = getComputedStyle(row, "::before");
          const label = button
            .querySelector(".navigation-item-label")
            .getBoundingClientRect();
          return {
            centered:
              Math.abs(
                marker.top + marker.height / 2 - bounds.top - bounds.height / 2,
              ) < 0.5,
            inset:
              row.getBoundingClientRect().right -
                Number.parseFloat(fill.right) -
                marker.right ===
              10,
            separated: marker.left - label.right >= 6,
          };
        }),
      )
      .toEqual({ centered: true, inset: true, separated: true });
    await row(page, "dm-030").screenshot({
      path: info.outputPath(`priority-dot-${width}.png`),
    });
  }
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    const primary = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.backgroundColor = root.getPropertyValue("--primary");
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(dot).toHaveCSS("background-color", primary);
  }
});
